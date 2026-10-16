'use strict';
/**
 * 自更新的**纯逻辑**：选方案、校验、算要删的清单。
 * 不碰 fs、不碰网络、不 require electron —— 所以能在 smoke 里直接跑，
 * 也能被 scripts/verify-update.mjs 拿去做离线端到端验证。
 * 真正的下载/落盘/进程切换在 updater.js 里，只做"照着这里的结果执行"。
 *
 * 决策的形状（用户要的"智能识别"）：
 *   ① 有对应我这个版本的差量清单吗？      没有 → 全量
 *   ② 差量包占全量比例 ≤ 60% 吗？         不满足 → 全量
 *   ③ 本地基准文件逐个对得上旧清单吗？    对不上 → 全量（被改过/版本不符）
 *   全部满足才走增量。**任何一条不满足都自动退回全量，绝不让用户卡在"更新失败"。**
 *   ★ 判据是**占比**，不是"文件大不大"：实测里 245 MB 的文件只差 64 KiB。
 */
const vcdiff = require('./vcdiff.js');
const { isProtectedPath } = require('./datadir.js');

/** 差的默认阈值：差量包超过全量的 60% 就不值得折腾，直接下全量 */
const DELTA_LIMIT = 0.6;

/** 清单自检：形状不对就当"没有可用清单"，让上层退全量，而不是猜 */
function validManifest(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.schema !== 1) return null;
  if (!m.version || !m.full || !m.full.asset || !m.full.sha256) return null;
  if (!Array.isArray(m.files)) return null;
  if (m.patches !== undefined && !Array.isArray(m.patches)) return null;
  return m;
}

function byPathOf(localFiles) {
  const m = new Map();
  for (const f of localFiles || []) m.set(f.path, f);
  return m;
}

/**
 * 挑一个更新方案。
 * @param {object} manifest update.json
 * @param {string} myVersion 本机版本（app.getVersion()）
 * @param {{path:string,size:number,sha256:string}[]} localFiles 本机程序目录的实测结果
 * @param {{limit?:number}} [opts]
 * @returns {{mode:'delta'|'full', patch?:object, reason:string, limit:number}}
 */
function selectPlan(manifest, myVersion, localFiles, opts = {}) {
  const limit = typeof opts.limit === 'number' ? opts.limit : DELTA_LIMIT;
  const m = validManifest(manifest);
  if (!m) return { mode: 'full', reason: '更新清单不可用（缺失或格式不符）', limit };
  if (!myVersion) return { mode: 'full', reason: '本机版本未知', limit };

  const cands = (m.patches || []).filter(p => p && p.from === myVersion);
  if (!cands.length) {
    return { mode: 'full', reason: `没有 ${myVersion} → ${m.version} 的差量清单`, limit };
  }
  const p = cands[0];

  if (!p.asset || !p.sha256 || !p.plan || !Array.isArray(p.plan.olds)) {
    return { mode: 'full', reason: '差量清单字段不全', limit };
  }
  if (p.plan.version !== 1) {
    return { mode: 'full', reason: `不认识的差量格式 version=${p.plan.version}`, limit };
  }
  if (!vcdiff.shouldUseDelta(Number(p.size) || 0, m.full.size, limit)) {
    const pct = ((Number(p.size) || 0) / m.full.size * 100).toFixed(1);
    return { mode: 'full', reason: `差量占全量 ${pct}%，超过 ${Math.round(limit * 100)}% 阈值`, limit };
  }

  const local = byPathOf(localFiles);
  const missing = p.plan.olds.filter(o => !local.has(o.path));
  if (missing.length) {
    return { mode: 'full', reason: `本机缺少 ${missing.length} 个基准文件（例如 ${missing[0].path}）`, limit };
  }
  const differ = p.plan.olds.filter(o => {
    const l = local.get(o.path);
    return l.size !== o.size || l.sha256 !== o.sha256;
  });
  if (differ.length) {
    return {
      mode: 'full',
      reason: `${differ.length} 个本地文件与旧版本清单不符（被改动过或版本不符），例如 ${differ[0].path}`,
      limit,
    };
  }
  return { mode: 'delta', patch: p, reason: '可以走增量', limit };
}

/** 受保护路径绝不允许被更新器写或删 */
function assertSafePaths(paths, label) {
  const bad = (paths || []).filter(isProtectedPath);
  if (bad.length) {
    throw new Error(`${label} 里出现受保护路径（运行时数据），已中止：${bad.slice(0, 3).join(', ')}`);
  }
  return paths;
}

/**
 * 用差量补丁算出所有需要写盘的文件。
 * @param {object} manifest
 * @param {object} patch selectPlan 返回的 patch
 * @param {Buffer} pack 补丁包内容（调用方已下载）
 * @param {Map<string,Buffer>} localByPath 本机文件的原始字节
 */
function applyDelta(manifest, patch, pack, localByPath) {
  const m = validManifest(manifest);
  if (!m) throw new Error('更新清单不可用');
  assertSafePaths(patch.plan.files.map(f => f.path), '差量清单');
  const produced = vcdiff.applyDirPatch(localByPath, patch.plan, pack);
  // 补丁产出必须落在目标清单里，且哈希一致（applyDirPatch 已逐文件校验，
  // 这里再确认一次"产出的路径确实是这个版本该有的"）
  const want = new Map(m.files.map(f => [f.path, f.sha256]));
  for (const f of produced) {
    if (!want.has(f.path)) throw new Error(`补丁产出了清单之外的文件：${f.path}`);
  }
  return produced;
}

/**
 * 校验一份"完整的程序目录"是否就是目标版本。
 * 全量下载解包之后**必须**走这一步：只看 zip 的哈希只能证明包没坏，
 * 证不了解出来的东西对不对（zip 有可能本身就被替换过）。
 * @returns {{ok:boolean, missing:string[], differ:string[], extra:string[], checked:number}}
 */
function verifyDir(manifest, files) {
  const m = validManifest(manifest);
  if (!m) return { ok: false, missing: [], differ: ['<清单不可用>'], extra: [], checked: 0 };
  const have = byPathOf(files);
  const wantPaths = new Set();
  const missing = [], differ = [];
  for (const w of m.files) {
    wantPaths.add(w.path);
    const h = have.get(w.path);
    if (!h) { missing.push(w.path); continue; }
    if (h.size !== w.size || h.sha256 !== w.sha256) differ.push(w.path);
  }
  // 多出来的文件不算失败（用户自己放的文件、或旧版本残留），但要报出来 ——
  // 只报不改：更新器绝不主动删它看不懂的文件。
  const extra = [...have.keys()].filter(p => !wantPaths.has(p));
  return { ok: missing.length === 0 && differ.length === 0, missing, differ, extra, checked: m.files.length };
}

/** 差量方案下要删掉的文件（旧版本有、新版本没有）。受保护路径直接排除，不报错也不删。 */
function removalList(patch) {
  const removed = (patch && patch.plan && patch.plan.removed) || [];
  const bad = removed.filter(isProtectedPath);
  return {
    paths: removed.filter(p => !isProtectedPath(p)),
    skipped: bad,     // 只报告，绝不删
  };
}

/** 给界面/日志用的一句话摘要 */
function summarize(manifest) {
  const m = validManifest(manifest);
  if (!m) return '更新清单不可用';
  const patches = (m.patches || []).map(p => `${p.from}→${m.version} ${(p.size / 1048576).toFixed(2)}MiB`);
  return `v${m.version}｜全量 ${(m.full.size / 1048576).toFixed(1)}MiB｜差量 ${patches.length ? patches.join('、') : '无'}`;
}

module.exports = {
  DELTA_LIMIT, validManifest, selectPlan, applyDelta, verifyDir, removalList,
  summarize, assertSafePaths,
};

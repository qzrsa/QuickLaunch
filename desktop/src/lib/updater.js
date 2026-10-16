'use strict';
/**
 * 自更新的**执行层**：取清单 → 挑方案 → 下补丁 → 摊进暂存区 → 交接给"退出后运行"的助手。
 *
 * 与 updater-core 的分工（刻意分开，别混）：
 *   updater-core  纯判断，不碰 fs / 网络 → 能离线穷举所有分支
 *   updater.js    只负责"照着判断去动手" → fs / 网络 / 子进程都在这里
 *   updater-apply 生成退出后要跑的那段脚本（纯字符串拼装，无副作用）
 *
 * ★★ 所有外部依赖（fs / 传输 / 进程）一律从 opts 注入：
 *    整条链路（含"下载失败""清单损坏""补丁打不上"）都能在 smoke 里离线跑完，
 *    不需要联网，也不会碰真实的程序目录。
 *
 * ★★ 为什么不引入 electron-updater：见 `探针手册.md`。一句话 —— 安装版与绿色版的目录
 *    形状完全一样（`QuickLaunch.exe` + `resources/`），同一个 update.json 天然覆盖两者，
 *    而受保护路径（`data/`）只留一份实现就少一个"更新器删掉用户数据"的机会。
 */

const nodeFs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');
const nodeHttps = require('https');
const nodeHttp = require('http');

const vcdiff = require('./vcdiff.js');
const core = require('./updater-core.js');
const unzip = require('./unzip.js');
const { PROTECTED_TOP, isProtectedPath } = require('./datadir.js');

/* ------------------------------------------------------------------ 常量 */

const REPO = Object.freeze({ owner: 'qzrsa', repo: 'QuickLaunch' });

/** 暂存目录名。★ 已加进 datadir 的 PROTECTED_TOP —— 于是"打绿版 zip / 生成清单 /
 *  更新器删除"三处会同时排除它，不用各写一遍判断。 */
const STAGE_DIR = '.update';

const MANIFEST_ASSET = 'update.json';
const USER_AGENT = 'QuickLaunch-Updater';

/** 清单最大 8 MiB：正常只有几十 KB（差量计划里的指令表），给足余量又能挡住被喂垃圾。 */
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

/** 跟随的重定向上限。GitHub 的 release 资产一定会 302 到 objects.githubusercontent.com。 */
const MAX_REDIRECTS = 5;

const DEFAULT_BASE = `https://github.com/${REPO.owner}/${REPO.repo}/releases/latest/download`;

/* ------------------------------------------------------------------ 小工具 */

const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function sha256File(p, fs = nodeFs) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const BUF = 1 << 20;                       // 1 MiB：245 MB 的 exe 也不会占内存
    const b = Buffer.allocUnsafe(BUF);
    let n;
    while ((n = fs.readSync(fd, b, 0, BUF, null)) > 0) h.update(b.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function humanBytes(n) {
  if (!(n >= 0)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
  return (n / 1048576).toFixed(2) + ' MiB';
}

/**
 * 归一化更新源。
 * 默认是 GitHub 的 `releases/latest/download` —— 它会把请求 302 到最新 Release 的资产。
 * ★ 允许用户把它换成镜像/代理（`设置 → 软件更新 → 更新源`）：本机实测国内直连 GitHub
 *   资产常常断流，而"更新器只能用某个镜像"是最容易被忽略的失败原因，所以做成显式配置项。
 */
function normalizeBase(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return DEFAULT_BASE;
  if (!/^https?:\/\//i.test(s)) throw new Error('更新源必须是 http(s):// 开头的地址');
  return s.replace(/\/+$/, '');
}

const feedUrl = (base) => normalizeBase(base) + '/' + MANIFEST_ASSET;

/* ------------------------------------------------------------------ 传输层 */

/**
 * 带进度、带上限、跟随重定向的 GET。
 * @param {string} url
 * @param {{onChunk?:(got:number,total:number)=>void, maxBytes?:number, ua?:string}} [opts]
 * @returns {Promise<Buffer>}
 */
function httpGetBuffer(url, opts = {}) {
  return httpGetTo(url, null, opts);
}

/**
 * @param {string|null} destPath 传 null 就返回 Buffer；传路径就**边收边写盘**（大文件用）
 */
function httpGetTo(url, destPath, opts = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error('更新源地址不合法: ' + url)); return; }
    const mod = u.protocol === 'http:' ? nodeHttp : nodeHttps;
    const req = mod.get(u, { headers: { 'User-Agent': opts.ua || USER_AGENT, Accept: '*/*' } }, (res) => {
      const code = res.statusCode || 0;

      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) { reject(new Error('重定向次数过多: ' + url)); return; }
        const next = new URL(res.headers.location, u).toString();
        httpGetTo(next, destPath, opts, redirects + 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        res.resume();
        const e = new Error(`HTTP ${code}`);
        e.status = code;
        reject(e);
        return;
      }

      const total = Number(res.headers['content-length']) || 0;
      const max = opts.maxBytes || 0;
      if (max && total > max) { res.resume(); reject(new Error(`响应过大（${humanBytes(total)}）`)); return; }

      const fs = opts.fs || nodeFs;
      let fd = null, chunks = null, got = 0;
      try {
        if (destPath) fd = fs.openSync(destPath, 'w'); else chunks = [];
      } catch (e) { res.resume(); reject(e); return; }

      const fail = (e) => {
        res.destroy();
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* noop */ } }
        reject(e);
      };

      res.on('data', (c) => {
        got += c.length;
        if (max && got > max) { fail(new Error(`响应过大（超过 ${humanBytes(max)}）`)); return; }
        if (fd !== null) {
          try { fs.writeSync(fd, c); } catch (e) { fail(e); }
        } else chunks.push(c);
        if (opts.onChunk) { try { opts.onChunk(got, total); } catch { /* 进度回调不许搞崩下载 */ } }
      });
      res.on('end', () => {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch { /* noop */ }
          resolve({ path: destPath, size: got, total });
        } else resolve(Buffer.concat(chunks, got));
      });
      res.on('error', fail);
    });
    req.on('error', reject);
    if (opts.timeout) req.setTimeout(opts.timeout, () => req.destroy(new Error('请求超时')));
  });
}

async function getJson(url, opts = {}) {
  const get = opts.getBuffer || httpGetBuffer;
  const buf = await get(url, { ...opts, maxBytes: opts.maxBytes || MAX_MANIFEST_BYTES });
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { throw new Error('更新清单不是合法 JSON: ' + e.message); }
}

/* ------------------------------------------------------------------ 本机扫描 */

/**
 * 扫"本机程序目录"，产出 update.json 里 files 的同构清单。
 * ★ 受保护目录（data / .probe-shot / .tmpdata / .update）**整棵跳过**：
 *   它们一旦进了清单，更新器就会把用户私人配置当程序文件去校验/覆盖。
 *   这里的判断直接来自 datadir.js —— 全项目唯一那份定义。
 * ★ 代价要说清楚：这一步会把整个程序目录读一遍算 sha256（解压后约 500 MB）。
 *   所以 **check() 只在"确实存在对应本机版本的差量"时才调它** —— 别在启动路径上无脑调。
 */
function scanProgramDir(dir, opts = {}) {
  const fs = opts.fs || nodeFs;
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? rel + '/' + e.name : e.name;
      // 只在顶层判一次：PROTECTED_TOP 是顶层目录名
      if (!rel && PROTECTED_TOP.includes(e.name)) continue;
      const childAbs = nodePath.join(abs, e.name);
      if (e.isDirectory()) { walk(childAbs, childRel); continue; }
      if (!e.isFile()) continue;                   // 符号链接 / 设备文件一概不碰
      let st;
      try { st = fs.statSync(childAbs); } catch { continue; }
      out.push({ path: childRel, size: st.size, sha256: sha256File(childAbs, fs) });
    }
  };
  walk(dir, '');
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/* ------------------------------------------------------------------ 检查更新 */

/**
 * @param {object} o
 * @param {string} o.myVersion            app.getVersion()
 * @param {string} o.programDir           本机程序目录
 * @param {string} [o.base]               更新源（默认 GitHub latest）
 * @param {number} [o.limit]              差量占比阈值
 * @param {object} [o.fs]
 * @param {(url:string,opts:object)=>Promise<Buffer>} [o.getBuffer] 注入传输（离线测试用）
 * @returns {Promise<{ok:boolean, available:boolean, reason:string, myVersion:string,
 *                   manifest?:object, plan?:object, scanned?:number}>}
 */
async function check(o) {
  const fs = o.fs || nodeFs;
  const get = o.getBuffer || httpGetBuffer;
  const base = normalizeBase(o.base);
  const myVersion = o.myVersion;

  let manifest;
  try {
    manifest = await getJson(feedUrl(base), { fs, getBuffer: get });
  } catch (e) {
    // ★ 404 是**预期内**的正常情况：更新器刚上线时，历史 Release 上根本没有 update.json。
    //   把它当成"没有可用更新"而不是错误 —— 否则用户一启动就看到一条红色报错。
    if (e.status === 404) return { ok: true, available: false, myVersion, reason: '更新源还没有发布更新清单' };
    return { ok: false, available: false, myVersion, reason: '取更新清单失败：' + e.message };
  }

  const m = core.validManifest(manifest);
  if (!m) return { ok: false, available: false, myVersion, reason: '更新清单格式不认识（可能更新源不是本程序的）' };

  if (m.channel !== 'green' && m.channel !== 'installed' && m.channel !== 'any') {
    return { ok: true, available: false, myVersion, reason: `清单渠道是 ${m.channel}，与本形态不符` };
  }
  if (!isNewer(m.version, myVersion)) {
    return { ok: true, available: false, myVersion, manifest: m, reason: '已是最新版本' };
  }

  // ★ 只有"存在对应本机版本的差量"时才去扫本机目录。扫一次要把整个程序目录读一遍
  //   （解压后约 500 MB），而这个判断 99% 的时候是"否" —— 启动时的检查不能为此变慢。
  const hasCandidate = (m.patches || []).some(p => p && p.from === myVersion);
  const localFiles = hasCandidate ? scanProgramDir(o.programDir, { fs }) : [];
  const plan = core.selectPlan(m, myVersion, localFiles, { limit: o.limit });

  return {
    ok: true,
    available: true,
    myVersion,
    manifest: m,
    plan,
    scanned: localFiles.length,
    reason: plan.reason,
    base,
  };
}

/**
 * 版本比较：只认 "1.2.3" 这种三段数字（本项目的版本号规则），不引入 semver 依赖。
 * ★ 解析不出来时一律返回 false（"不算新"）：假报"有更新"会让用户去下一个可能并不存在的
 *   资产、拿到一个莫名其妙的失败；漏报一次更新只是晚一天知道，代价小得多。
 */
function isNewer(a, b) {
  const pa = parseVer(a), pb = parseVer(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}
function parseVer(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

/* ------------------------------------------------------------------ 下载 */

/**
 * 下资产到文件并校验。
 * @param {object} o
 * @param {string} o.base      资产所在基址（= 清单的基址，两者同属一个 Release）
 * @param {string} o.asset     资产文件名
 * @param {number} o.size      期望字节数
 * @param {string} o.sha256    期望 sha256
 * @param {string} o.dest      落盘路径
 * @returns {Promise<{ok:boolean, path?:string, reason?:string}>}
 */
async function downloadAsset(o) {
  const fs = o.fs || nodeFs;
  const get = o.getBuffer || httpGetBuffer;
  const url = o.base + '/' + encodeURIComponent(o.asset);
  try {
    await get(url, {
      fs, destPath: o.dest, onChunk: o.onChunk, timeout: o.timeout || 120000,
      // 给 8 MiB 余量：声明的大小是权威，但传输层多收一点不该直接崩
      maxBytes: o.size ? o.size + 8 * 1024 * 1024 : 0,
    });
  } catch (e) {
    try { fs.unlinkSync(o.dest); } catch { /* noop */ }
    return { ok: false, reason: `下载 ${o.asset} 失败：${e.message}` };
  }

  let st;
  try { st = fs.statSync(o.dest); } catch (e) { return { ok: false, reason: '下载后读不到文件：' + e.message }; }
  if (o.size && st.size !== o.size) {
    try { fs.unlinkSync(o.dest); } catch { /* noop */ }
    return { ok: false, reason: `${o.asset} 大小不符（期望 ${humanBytes(o.size)}，实际 ${humanBytes(st.size)}）` };
  }
  if (o.sha256) {
    const got = sha256File(o.dest, fs);
    if (got !== o.sha256) {
      try { fs.unlinkSync(o.dest); } catch { /* noop */ }
      return { ok: false, reason: `${o.asset} 校验失败（sha256 不符），已丢弃` };
    }
  }
  return { ok: true, path: o.dest };
}

/* ------------------------------------------------------------------ 暂存 */

/** 惰性本机文件表：applyDirPatch 通过 `.get(path)` 取基准文件。
 *  ★ 绝不预读全部 —— 76 个文件解压后约 500 MB；按需读且**不缓存**，峰值只有一个文件。 */
function lazyLocalStore(programDir, fs = nodeFs) {
  return {
    get(p) {
      const abs = nodePath.join(programDir, p);
      const buf = fs.readFileSync(abs);
      return buf;
    },
    has(p) {
      try { fs.statSync(nodePath.join(programDir, p)); return true; } catch { return false; }
    },
  };
}

function stageDirOf(programDir, version) {
  return nodePath.join(programDir, STAGE_DIR, String(version));
}

/**
 * ★ 唯一写 apply.json / state.json 的地方 —— 差量与全量两条路都从这里出去。
 *   两处各写一份的话，一边加了字段另一边迟早忘（这个项目已经在别的地方吃过这个亏）。
 *   受保护路径的最后一道闸也在这里，所以不可能有哪条路绕过去。
 */
function writeApply(o, { stage, writes, deletes, mode }) {
  const fs = o.fs || nodeFs;
  const manifest = o.manifest || {};

  const bad = writes.map(w => w.path).concat(deletes).filter(isProtectedPath);
  if (bad.length) return { ok: false, reason: `更新涉及受保护路径，已中止：${bad.slice(0, 3).join(', ')}` };

  const apply = {
    schema: 1,
    app: manifest.app || 'QuickLaunch',
    from: o.myVersion || '',
    to: String(o.version || manifest.version),
    programDir: o.programDir,
    stageDir: stage,
    exe: o.exePath || '',
    restart: !!o.restart,
    mode,
    // ★ 助手会拿这份名单**再挡一次**（纵深防御）。名单本身来自 datadir.PROTECTED_TOP，
    //   不是在这里另写一份，所以不会漂移。
    protectedTop: PROTECTED_TOP.slice(),
    writes: writes.map(w => ({ path: w.path, size: w.size, sha256: w.sha256 })),
    deletes: deletes.slice(),
  };

  try {
    fs.writeFileSync(nodePath.join(stage, 'apply.json'), JSON.stringify(apply, null, 2) + '\n');
    fs.writeFileSync(nodePath.join(o.programDir, STAGE_DIR, 'state.json'),
      JSON.stringify({ state: 'staged', to: apply.to, from: apply.from, at: Date.now() }, null, 2) + '\n');
  } catch (e) {
    return { ok: false, reason: '写 apply.json 失败：' + e.message };
  }
  return { ok: true, stage, plan: apply };
}

/**
 * 差量路径：字节已经在内存里（`applyDirPatch` 刚还原出来），落盘即可。
 * @returns {{ok:boolean, reason?:string, stage?:string, plan?:object}}
 */
function stage(o) {
  const fs = o.fs || nodeFs;
  const manifest = o.manifest;
  const stageRoot = stageDirOf(o.programDir, o.version || manifest.version);

  let writes, deletes = [];
  if (o.mode === 'delta') {
    let produced;
    try {
      produced = core.applyDelta(manifest, o.patch, o.pack, lazyLocalStore(o.programDir, fs));
    } catch (e) {
      // 打不上就是打不上：交给上层退回全量，绝不硬写出一个半残的程序
      return { ok: false, reason: '差量补丁无法应用：' + e.message };
    }
    writes = produced.map(f => ({ path: f.path, data: f.data }));
    deletes = core.removalList(o.patch).paths;
  } else {
    writes = (o.files || []).map(f => ({ path: f.path, data: f.data }));
  }

  // ★ 受保护路径**先挡一次**，别白写一堆字节到磁盘上再拒绝（writeApply 里还会挡一次）
  const bad0 = writes.map(f => f.path).concat(deletes).filter(isProtectedPath);
  if (bad0.length) return { ok: false, reason: `更新涉及受保护路径，已中止：${bad0.slice(0, 3).join(', ')}` };

  const filesRoot = nodePath.join(stageRoot, 'files');
  try {
    fs.mkdirSync(filesRoot, { recursive: true });
  } catch (e) {
    return { ok: false, reason: '暂存区创建失败（磁盘或权限）：' + e.message };
  }

  const planWrites = [];
  for (const w of writes) {
    // ★ size 与 sha256 一律**从真正写下去的字节现算**，不从调用方接 ——
    //   两个人各传一份迟早对不上（重构时就断过一次：差量那边只给了 data）。
    //   助手换文件前会拿这里的 sha256 再校一遍，所以它必须是"磁盘上那份"的哈希。
    if (!Buffer.isBuffer(w.data)) return { ok: false, reason: `内部错误：${w.path} 没有字节内容` };
    const dest = nodePath.join(filesRoot, ...String(w.path).split('/'));
    try {
      fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, w.data);
    } catch (e) {
      return { ok: false, reason: `暂存 ${w.path} 失败：${e.message}` };
    }
    planWrites.push({ path: w.path, size: w.data.length, sha256: sha256hex(w.data) });
  }

  return writeApply(o, { stage: stageRoot, writes: planWrites, deletes, mode: o.mode || 'full' });
}

/** 暂存目录整棵删掉（失败或无事可做时清场，别把几百 MB 留在用户盘上） */
function dropStage(dir, fs = nodeFs) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉也不能盖住原始原因 */ }
}

/**
 * 全量回退：下绿色版 zip → 解开 → 逐文件对清单 → **只摊真正变了的文件**。
 *
 * ★ 为什么"全量"也摊进暂存区而不是就地解压：下载完就地解压等于改到一半就开始覆盖运行中的
 *   文件。摊进暂存区、由退出后的助手统一换，才能保证"要么全换要么全不换"。
 * ★ 只摊变了的文件（下载已经是全量 160 MB，没必要再写 500 MB）：所以要先扫一遍本机目录比对。
 * ★ deletes 恒为空：全量包只知道"新版本该有什么"，不知道"本机多出来的那些是什么" ——
 *   更新器**绝不主动删它看不懂的文件**（那可能是用户自己放的）。
 * ★ 内存：解包**直接解到暂存区**（不是先解进内存），峰值只有那个 zip 本身（约 160 MB）。
 */
async function stageFull(o) {
  const fs = o.fs || nodeFs;
  const get = o.getBuffer || httpGetBuffer;
  const manifest = o.manifest;
  const stageRoot = stageDirOf(o.programDir, o.version || manifest.version);
  const filesRoot = nodePath.join(stageRoot, 'files');

  try { fs.mkdirSync(stageRoot, { recursive: true }); } catch (e) {
    return { ok: false, reason: '暂存区创建失败：' + e.message };
  }

  // 1. 下 zip（落在暂存区里 —— 那里是受保护目录，不会被当成程序文件）
  const zipPath = nodePath.join(stageRoot, manifest.full.asset);
  const dl = await downloadAsset({
    base: o.base, asset: manifest.full.asset,
    size: manifest.full.size, sha256: manifest.full.sha256,
    dest: zipPath, fs, getBuffer: get, onChunk: o.onChunk, timeout: o.timeout,
  });
  if (!dl.ok) { dropStage(stageRoot, fs); return { ok: false, reason: dl.reason }; }

  // 2. 解包（unzip 里自带 zip slip / 受保护路径守卫 + 逐条 CRC）
  let all;
  try {
    const buf = fs.readFileSync(zipPath);
    all = unzip.extractToDir(buf, filesRoot, { fs, isProtected: isProtectedPath });
  } catch (e) {
    dropStage(stageRoot, fs);
    return { ok: false, reason: '绿色版包解不开：' + e.message };
  }
  try { fs.unlinkSync(zipPath); } catch { /* 删除失败不影响（它在受保护目录里） */ }

  // 3. 从**磁盘上的字节**算清单（不是从解包返回值里抄），再整包对一遍
  const staged = scanProgramDir(filesRoot, { fs });
  const vr = core.verifyDir(manifest, staged);
  if (!vr.ok) {
    dropStage(stageRoot, fs);
    return {
      ok: false,
      reason: `绿色版包与更新清单不符（缺 ${vr.missing.length} 个 / 内容不一致 ${vr.differ.length} 个）`,
    };
  }
  void all;

  // 4. 本机已经跟目标一模一样的文件不必再换一遍
  const local = new Map(scanProgramDir(o.programDir, { fs }).map(f => [f.path, f]));
  const need = [];
  for (const f of staged) {
    const cur = local.get(f.path);
    if (cur && cur.size === f.size && cur.sha256 === f.sha256) {
      try { fs.unlinkSync(nodePath.join(filesRoot, ...f.path.split('/'))); } catch { /* noop */ }
      continue;
    }
    need.push(f);
  }

  if (!need.length) {
    dropStage(stageRoot, fs);
    return { ok: true, nothingToDo: true, reason: '本机文件已与目标版本逐一致，无需替换' };
  }

  return writeApply(o, { stage: stageRoot, writes: need, deletes: [], mode: 'full' });
}

/** 更新只支持这两种形态：便携版是**单文件 exe**，自己就是数据源，只能整份换，不做自更新。 */
function canSelfUpdate(form) {
  if (form === 'installed' || form === 'green') return { ok: true, reason: '' };
  if (form === 'portable') {
    return { ok: false, reason: '便携版是单文件 exe，无法在运行中替换自己 —— 请到 Release 页面下载新版' };
  }
  return { ok: false, reason: '开发模式不做自更新' };
}

module.exports = {
  REPO, STAGE_DIR, MANIFEST_ASSET, DEFAULT_BASE, MAX_MANIFEST_BYTES,
  sha256hex, sha256File, humanBytes,
  normalizeBase, feedUrl,
  httpGetBuffer, httpGetTo, getJson,
  scanProgramDir,
  check, isNewer, parseVer,
  downloadAsset,
  lazyLocalStore, stageDirOf, stage, stageFull, writeApply, dropStage,
  canSelfUpdate,
};

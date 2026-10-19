'use strict';
/**
 * 清理无效项：找出「路径确实已经不在了」的启动项。
 *
 * ★ 本模块只**判断**与**备份**，不直接删任何东西；真正落盘删由 main.js 按 id 执行，
 *   而且执行前会用同一个 classify() **再判一遍**（渲染层传来的 id 不可信）。
 *
 * 安全分级（"千万不要清理错了"就是这么落地的）：
 *   ok      —— 不用管
 *   certain —— **确定失效**：绝对路径 + 所在磁盘当前在 + statSync 明确回 ENOENT/ENOTDIR
 *   unsure  —— **存疑**：没填路径 / 环境变量没展开 / 网络位置 / 磁盘当前没接入 /
 *              没权限确认 / 相对路径 / PATH 里找不到的裸命令
 *   只有 certain 会被删；unsure 只列出来给人看，默认**不勾选**。
 *
 * 为什么不追 .lnk 的目标：UWP / Store 应用的快捷方式目标不是路径（是 AppUserModelID），
 * 追下去会把一堆正常项判成失效。宁可漏判，不可错删。
 *
 * fs / env 全部可注入 —— 单测不用真建文件，也不会被本机目录结构影响。
 */

const path = require('path');
const fs = require('fs');
const resolveLib = require('./resolve');

/** 网址类：没有本地文件可查 */
const URL_RE = /^https?:\/\//i;

/** `%VAR%` 还留在字符串里 = 没展开成功 */
const UNEXPANDED_RE = /%[^%\\/]+%/;

function unquote(v) {
  const s = String(v == null ? '' : v).trim();
  return /^".*"$/.test(s) ? s.slice(1, -1).trim() : s;
}

/** 展开 `%VAR%` 与开头的 `~`（测试时 env / home 都能注入） */
function expand(p, env, home) {
  let s = unquote(p);
  if (!s) return '';
  if (s.startsWith('~')) s = path.join(home || env.USERPROFILE || env.HOME || '', s.slice(1));
  s = s.replace(/%([^%\\/]+)%/g, (m, name) => {
    const v = env[name] || env[name.toUpperCase()] || env[name.toLowerCase()];
    return v === undefined ? m : v;
  });
  return s;
}

/**
 * 看一眼这个绝对路径现在的状态。**要区分"确实不在"与"看不到"**：
 * existsSync 在 EACCES 这类错误上同样回 false，拿它当"失效"就是误删的来源。
 */
function statOf(p, fsi) {
  try {
    fsi.statSync(p);
    return { exists: true };
  } catch (e) {
    const code = (e && e.code) || 'UNKNOWN';
    // 只有这两个码能证明"路径本身不存在"；其余（EPERM/EACCES/EBUSY/ELOOP…）都算看不到
    if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false, missing: true, code };
    return { exists: false, missing: false, code };
  }
}

function driveRootOf(p) {
  const m = String(p).match(/^([A-Za-z]):([\\/]|$)/);
  return m ? m[1].toUpperCase() + ':\\' : '';
}

/**
 * 给单个启动项定性。
 * @returns {{level:'ok'|'certain'|'unsure', reason:string}}
 */
function classify(item, opts) {
  opts = opts || {};
  const fsi = opts.fs || fs;
  const env = opts.env || process.env;
  const home = opts.home;

  const type = (item && item.type) || 'app';
  const raw = String((item && item.path) || '').trim();

  // 网址、整行命令：本来就没有"本地路径"这回事，永远不参与清理
  if (type === 'url' || type === 'cmd') return { level: 'ok', reason: '网址 / 命令，无需路径' };
  if (URL_RE.test(raw)) return { level: 'ok', reason: '网址' };

  if (!raw) return { level: 'unsure', reason: '没有填路径' };

  const p = expand(raw, env, home);
  if (!p) return { level: 'unsure', reason: '路径展开后是空的' };
  // ★ 展开**之后**还留着 %VAR%，说明这个变量在这台机器上不存在；这时算出来的路径不作数
  if (UNEXPANDED_RE.test(p)) {
    return { level: 'unsure', reason: '路径里有没展开的环境变量（' + p.match(UNEXPANDED_RE)[0] + '）' };
  }

  // 网络位置：连不上很常见（NAS 关机、VPN 没连），绝不当作失效
  if (/^\\\\/.test(p)) return { level: 'unsure', reason: '网络位置，现在连不上不代表不存在' };

  const abs = path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);

  if (!abs) {
    const bare = !p.includes('/') && !p.includes('\\');
    if (bare) {
      const hit = resolveLib.exists(p, { fs: fsi, env });
      // PATH 里找不到的裸命令：可能是应用别名、也可能是拼错了 —— 只能存疑
      return hit ? { level: 'ok', reason: 'PATH 里能找到' }
        : { level: 'unsure', reason: 'PATH 里找不到这个命令' };
    }
    return { level: 'unsure', reason: '相对路径，不确定相对哪个目录' };
  }

  // 盘符有没有接入：U 盘 / 移动硬盘拔了、网络盘没映射，都会让 statSync 回 ENOENT
  const root = driveRootOf(p);
  if (root) {
    const dr = statOf(root, fsi);
    if (!dr.exists) {
      return { level: 'unsure', reason: '所在磁盘（' + root.slice(0, 2) + '）现在没接入' };
    }
  }

  const st = statOf(p, fsi);
  if (st.exists) return { level: 'ok', reason: '路径存在' };
  if (st.missing) return { level: 'certain', reason: '路径不存在' };
  return { level: 'unsure', reason: '看不到这个路径（' + st.code + '），不能断定失效' };
}

/**
 * 扫一遍整份配置。
 * @returns {{certain:Array, unsure:Array}} 每行 { id, name, path, type, gid, gname, reason }
 */
function scan(cfg, opts) {
  const certain = [];
  const unsure = [];
  const groups = (cfg && Array.isArray(cfg.groups)) ? cfg.groups : [];
  groups.forEach(g => {
    (g.items || []).forEach(it => {
      const r = classify(it, opts);
      if (r.level === 'ok') return;
      const row = {
        id: it.id,
        name: it.name || '未命名',
        path: String(it.path || ''),
        type: it.type || 'app',
        gid: g.id,
        gname: g.name || '未命名分组',
        reason: r.reason,
      };
      (r.level === 'certain' ? certain : unsure).push(row);
    });
  });
  return { certain, unsure };
}

/**
 * 按 id 删项。**会就地修改传入的 cfg**（与 store.save 的用法一致）。
 *
 * ★ 每个 id 都要在这里**重新判一次**：
 *   渲染层可能拿的是几十秒前的扫描结果（这期间用户可能把 U 盘插回来了），
 *   也可能被脚本伪造。只有仍然判为 certain 的才删。
 * @returns {{removed:Array<{gid,gname,item}>, skipped:Array}}
 */
function prune(cfg, ids, opts) {
  const want = new Set(Array.isArray(ids) ? ids.filter(x => typeof x === 'string') : []);
  const removed = [];
  const skipped = [];
  if (!want.size || !cfg || !Array.isArray(cfg.groups)) return { removed, skipped };

  cfg.groups.forEach(g => {
    const keep = [];
    (g.items || []).forEach(it => {
      if (!want.has(it.id)) { keep.push(it); return; }
      const r = classify(it, opts);
      if (r.level === 'certain') {
        removed.push({ gid: g.id, gname: g.name || '未命名分组', item: it });
      } else {
        keep.push(it);
        skipped.push({ id: it.id, name: it.name || '未命名', reason: r.reason });
      }
    });
    g.items = keep;
  });
  return { removed, skipped };
}

/**
 * 清理前落一份备份。**写不出来就别删**（调用方据此中止）。
 * 文件名 invalid-YYYYMMDD-HHmmss.json，内容带版本与完整 item，能原样塞回去。
 */
function writeBackup(removed, dir, now) {
  const d = new Date(now == null ? Date.now() : now);
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
    + `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `invalid-${stamp}.json`);
  const body = {
    version: 1,
    savedAt: d.toISOString(),
    note: '「清理无效项」删除前的备份，可原样还原到对应分组',
    removed: removed.map(r => ({ gid: r.gid, gname: r.gname, item: r.item })),
  };
  fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
  return file;
}

module.exports = {
  classify, scan, prune, writeBackup,
  expand, unquote, statOf, driveRootOf,
  UNEXPANDED_RE, URL_RE,
};

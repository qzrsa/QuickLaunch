/**
 * dist 产物清理的核心逻辑（纯函数；CLI 薄壳在 scripts/prune-dist.mjs）。
 *
 * 需求（用户原话）：「每次编译完之后删掉之前的版本 只保留最新版」。
 * dist\ 里每发一版就多一套 Setup/Portable/Green（每个 100~160 MiB），
 * 攒几版就是两三个 GB 的旧产物，没有任何用途（历史版本 GitHub Release 上都有）。
 *
 * 规则从严 —— 这个脚本的权限只到「认识得出来的产物名」：
 *   ✗ 删：QuickLaunch-Setup/Portable/Green-<版本>.exe/.zip（含 .blockmap）、
 *         QuickLaunch-Delta-<from>-to-<to>.bin（属于 to 那个版本）、
 *         update.json（版本号在**内容**里，读出来比对）。
 *   ✓ 留：版本号等于当前版本的产物；win-unpacked/ 等一切目录；
 *         latest.yml / builder-debug.yml / build.log 等**不认识**的文件。
 * 认不出来就绝不碰 —— 宁可少删，也不能把构建元数据当垃圾清了。
 */
import fs from 'node:fs';   // 内置模块，纯函数路径带上它没有副作用

/** 从产物文件名提取「这个文件属于哪个版本」；不是认识的产物名返回 null。 */
export function artifactVersion(name) {
  let m;
  // Setup/Portable/Green 同一个模式；Setup 还会带 electron-builder 的 .blockmap
  if ((m = name.match(/^QuickLaunch-(?:Setup|Portable|Green)-(\d+\.\d+\.\d+)\.(?:exe|zip)(?:\.blockmap)?$/))) return m[1];
  // 差量包属于 to 那个**目标版本**（from 是它的基准，基准旧不旧不影响这份补丁的用途）
  if ((m = name.match(/^QuickLaunch-Delta-\d+\.\d+\.\d+-to-(\d+\.\d+\.\d+)\.bin$/))) return m[1];
  return null;
}

/** update.json 的版本在内容里；读不出来（缺字段/坏 JSON）就当不认识，返回 null。 */
export function manifestVersion(file, fsMod) {
  try {
    const j = JSON.parse(fsMod.readFileSync(file, 'utf8'));
    return typeof j.version === 'string' ? j.version : null;
  } catch { return null; }
}

const fmtSize = n => n >= 1024 * 1024 ? (Math.round(n / 1024 / 1024 * 100) / 100 + ' MiB')
  : n >= 1024 ? (Math.round(n / 1024 * 10) / 10 + ' KiB') : n + ' B';

/**
 * 扫 distDir **顶层**，删除版本 ≠ current 的已认识产物。
 * 只删文件，绝不碰目录（win-unpacked / data 这些一律绕开）。
 * @param {object} o
 * @param {string} o.distDir   产物目录
 * @param {string} o.version   当前版本（package.json 的 version）
 * @param {object} [o.fsMod]   注入 fs（离线测试用）；缺省用真 fs
 * @param {(line:string)=>void} [o.log]  每删一个文件回调一行
 * @returns {{removed:{name:string,size:number}[], kept:string[], failed:{name:string,reason:string}[], freed:number}}
 */
export function pruneDist({ distDir, version, fsMod, log = () => {} }) {
  const removed = [];
  const kept = [];
  const failed = [];
  let freed = 0;
  let names;
  try { names = (fsMod || fs).readdirSync(distDir); } catch { return { removed, kept, failed, freed }; }
  for (const name of names) {
    // 拼接而不是 path.join：lib 保持零依赖；Windows 的 fs 接受正斜杠
    const full = distDir.replace(/[\\/]+$/, '') + '/' + name;
    let st;
    try { st = (fsMod || fs).statSync(full); } catch { continue; }
    if (!st.isFile()) { kept.push(name + '/'); continue; }   // 目录一律不动
    let v = artifactVersion(name);
    if (v === null && name === 'update.json') v = manifestVersion(full, fsMod || fs);
    if (v === null) { kept.push(name); continue; }           // 不认识的绝不碰
    if (v === version) { kept.push(name); continue; }        // 当前版本
    try {
      (fsMod || fs).rmSync(full, { force: true });
    } catch (e) {
      // ★ 单个删失败不中断（中断会变成"删一半，删了多少不知道"）：
      //   记下来继续删别的，最后由 CLI 汇总列出 + 非零退出 —— 不静默跳过。
      failed.push({ name, reason: e && e.message || String(e) });
      continue;
    }
    removed.push({ name, size: st.size });
    freed += st.size;
    log(`  删 ${name}（${fmtSize(st.size)}）`);
  }
  return { removed, kept, failed, freed };
}

export { fmtSize };

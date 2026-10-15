'use strict';
/**
 * 数据目录决策：Electron 的 userData 到底放哪。
 *
 * 规则（用户要求：数据跟着程序走）：
 *   安装版 → 安装目录、绿色版 → 运行目录、便携版 → 便携版 exe 所在目录，
 *   统一落在 `<程序目录>/data/`，不让 Chromium 那十几个缓存目录把程序根目录搅乱。
 *   只有程序目录不可写（例如装进 C:\Program Files 又没提权）才回落到系统目录。
 *
 * 这里刻意做成「注入 fs 的纯逻辑」，这样回落分支能在 CI 上跑（smoke 里塞一个 mkdirSync 会抛的假 fs）。
 * 想真机复现：`icacls <目录> /deny "<机器名>\<用户>:(OI)(CI)(W)"` 就能造出真的不可写目录，
 * 见 `.tmpdata/ro-fallback-probe.js`。★ 注意 deny 一定要带 `(OI)(CI)`，
 * 否则先建出来的 `data\` 子目录不继承这条拒绝、仍是可写的，实验会得出假结论。
 */

const path = require('path');
const nodeFs = require('fs');

const DATA_DIR_NAME = 'data';

/**
 * 目录能建且能写才算可写。
 * 探测文件删不掉**不算**致命 —— 我们要的是「能写」，删不掉多半只是回收站策略问题。
 */
function ensureWritable(dir, fs = nodeFs, pid = process.pid) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.ql-write-probe-${pid}`);
    fs.writeFileSync(probe, 'ok');
    try { fs.unlinkSync(probe); } catch { /* 删不掉但能写，放行 */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * 算出数据目录落点。
 * @param {object} o
 * @param {boolean} o.isPackaged  开发态直接走 o.devDataDir
 * @param {string}  o.devDataDir  开发态目录
 * @param {string}  o.legacyDir   改动前的位置（%APPDATA%\<App>）
 * @param {string}  o.programDir  程序所在目录（便携版要传 PORTABLE_EXECUTABLE_DIR）
 * @param {object}  [o.fs]
 * @returns {{dir:string, inProgramDir:boolean, note:string}}
 */
function resolveDataDir(o) {
  const fs = o.fs || nodeFs;

  if (!o.isPackaged) {
    return { dir: o.devDataDir, inProgramDir: false, note: '开发模式：写在项目内，不碰真实配置' };
  }

  const legacy = o.legacyDir;
  const target = path.join(o.programDir, DATA_DIR_NAME);

  // 探的是 `<程序目录>/data` 本身，不是程序目录 —— 只要那个子目录能建能写就够用。
  // （所以「程序目录不可写但 data 已存在且有权限」会被正常接受，这正是想要的：
  //   管理员手动给 data 目录放权之后，数据还是跟着程序走。）
  if (!ensureWritable(target, fs)) {
    return { dir: legacy, inProgramDir: false, note: '程序目录不可写，已回落到系统目录' };
  }

  return { dir: target, inProgramDir: true, note: '数据随程序走' };
}

/**
 * 首次把数据搬到程序目录时，把旧位置的 config.json 带过来 ——
 * 否则老用户一打开会看到空空的面板（数据其实没丢，只是没被读到）。
 * 用**复制**不用移动：万一新位置之后被删/被清，旧配置还在。
 * @returns {boolean} 是否真的迁移了
 */
function migrateLegacyConfig(targetDir, legacyDir, fs = nodeFs) {
  const from = path.join(legacyDir, 'config.json');
  const to = path.join(targetDir, 'config.json');
  try {
    if (path.resolve(from) === path.resolve(to)) return false;
    if (fs.existsSync(to)) return false;          // 新位置已有配置，不覆盖
    if (!fs.existsSync(from)) return false;
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(from, to);
    return true;
  } catch {
    return false;
  }
}

module.exports = { DATA_DIR_NAME, ensureWritable, resolveDataDir, migrateLegacyConfig };

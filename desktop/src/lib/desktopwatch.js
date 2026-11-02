'use strict';
/**
 * 桌面新增图标自动同步 —— 纯逻辑（可注入 fs，便于 smoke 离线单测）。
 *
 * 设计要点：
 * - 只做「检测新增」，不碰删除：删除交给「启动项维护 → 清理无效项」（手动）。
 * - 低频轮询（主进程 2.5s 一次）读桌面目录文件名集合、跟上次 diff，开销可忽略。
 * - 严格过滤（desktopWatchAll=false，默认）：只认桌面「图标/快捷方式」常见的几种扩展名，
 *   并跳过隐藏/临时文件 —— desktop.ini / Thumbs.db / 各种 .tmp 因扩展名不在白名单而天然排除。
 * - desktopWatchAll=true：不过滤，桌面任何新增文件都同步（用户明确要求「也能打开」）。
 */

const path = require('path');

/** 严格过滤时认的扩展名（桌面「图标/快捷方式」常见，与 importer 的 APP_EXT 呼应）。 */
const WATCH_EXT = ['.lnk', '.url', '.exe', '.appref-ms'];

/**
 * 判断一个新出现在桌面的文件名是否该同步。
 * @param {string} name 文件名（不含目录）
 * @param {{all?: boolean}} [opt] all=true 时不过滤（同步所有文件）
 */
function shouldSync(name, opt = {}) {
  if (opt.all) return true;
  const s = String(name || '');
  if (!s) return false;
  // 隐藏 / 临时文件（. 或 ~ 开头）一律跳过，哪怕扩展名命中白名单
  if (s.startsWith('.') || s.startsWith('~')) return false;
  const ext = path.extname(s).toLowerCase();
  return WATCH_EXT.includes(ext);
}

/**
 * 读桌面目录，返回当前「文件名集合」（只盯文件，不盯子文件夹）。
 * @param {string} dir 桌面目录绝对路径
 * @param {object} fs  fs 模块（可注入）
 * @returns {Set<string>}
 */
function snapshot(dir, fs) {
  const set = new Set();
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return set; }   // 目录读不到（被删/权限）就空，别让轮询炸掉
  for (const e of entries) {
    if (e.isDirectory()) continue;   // 桌面文件夹不自动同步（可能一整个目录，容易误收）
    set.add(e.name);
  }
  return set;
}

/**
 * 计算新增：新快照里有、旧快照里没有的文件名。
 * @param {Set<string>} prev
 * @param {Set<string>} cur
 * @returns {string[]}
 */
function diffNew(prev, cur) {
  const added = [];
  for (const name of cur) if (!prev.has(name)) added.push(name);
  return added;
}

module.exports = { shouldSync, snapshot, diffNew, WATCH_EXT };

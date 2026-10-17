'use strict';
/**
 * 裸命令名解析 + 控制台程序判定（**唯一实现**）。
 *
 * 为什么单独一个模块：
 * `powershell.exe` / `python.exe` / `wt.exe` 这些东西**只存在于 PATH 里**，
 * 不在 System32。以前 store（判断卡片能不能用）与 actions（真去启动）各写了
 * 一份"只在 System32 里找"的逻辑，于是同一个东西长出了两副面孔：
 *   · 卡片写「路径不存在」（机器上明明有）—— itemOk 不查 PATH
 *   · 点启动毫无动静 —— resolveTarget 也不查 PATH，
 *     shell.openPath 拿到裸名字必然失败，退回 detached 派生又静默死掉
 * 两边共用这一份，才不会一处修好一处还坏。
 *
 * 全部纯函数，fs / env 都可注入 —— 单测不用真的建目录，也不用动本机 PATH。
 */

const fs = require('fs');
const path = require('path');

/** PATHEXT 缺失时的兜底；顺序与 Windows 默认值一致（.COM 在前） */
const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'];

/** 裸命令名解析结果缓存。键里带 PATH，PATH 变了自动失效 */
const memo = new Map();
/** exe 子系统缓存：每次启动都去读 PE 头没必要 */
const consoleMemo = new Map();
const MEMO_MAX = 500;

/** 裸命令名：既不是绝对路径，也不含任何分隔符 */
function isBareName(p) {
  const v = String(p || '').trim();
  if (!v) return false;
  if (path.isAbsolute(v)) return false;
  return !v.includes('/') && !v.includes('\\');
}

function unquote(v) {
  const s = String(v == null ? '' : v).trim();
  return /^".*"$/.test(s) ? s.slice(1, -1) : s;
}

/**
 * 找命令时要看的目录，按优先级。
 * 前四个是系统自带的固定位置 —— PowerShell 5.1 与 WBEM 常常**不在** PATH 里
 * （PATH 被精简过的机器上尤其明显），但它们就是系统自带的东西，必须能找到。
 */
function searchDirs(env = process.env) {
  const dirs = [];
  const add = d => {
    const v = unquote(d);
    if (v && !dirs.includes(v)) dirs.push(v);
  };
  const root = env.SystemRoot || env.windir || env.WINDIR || 'C:\\Windows';
  add(path.join(root, 'System32'));
  add(root);
  add(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0'));
  add(path.join(root, 'System32', 'Wbem'));
  if (env.LOCALAPPDATA) add(path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'));
  // PATH 里常有空项与带引号的项，add() 一起处理
  for (const d of String(env.PATH || '').split(';')) add(d);
  return dirs;
}

function extensions(env = process.env) {
  const list = String(env.PATHEXT || '').split(';').map(s => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_PATHEXT;
}

/** 一个裸名字所有可能的绝对路径，按 Windows 的搜索顺序 */
function candidates(name, env = process.env) {
  const raw = String(name || '').trim();
  const hasExt = path.extname(raw) !== '';
  const exts = hasExt ? [] : extensions(env);
  const out = [];
  for (const d of searchDirs(env)) {
    out.push(path.join(d, raw));
    for (const e of exts) out.push(path.join(d, raw + e));
  }
  return out;
}

/** 裸命令名 → 绝对路径；找不到就把原样返回（调用方自己决定怎么提示） */
function resolveCommand(name, opts = {}) {
  const fsi = opts.fs || fs;
  const env = opts.env || process.env;
  const raw = String(name || '').trim();
  if (!raw || !isBareName(raw)) return raw;

  const key = raw.toLowerCase() + '\u0000' + (env.PATH || '');
  if (memo.has(key)) return memo.get(key);

  let hit = raw;
  for (const c of candidates(raw, env)) {
    try {
      if (fsi.existsSync(c)) { hit = c; break; }
    } catch { /* 无权限 / 已失效的 PATH 目录，跳过 */ }
  }
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(key, hit);
  return hit;
}

/** 路径 / 命令是否真的存在（裸名字会去 PATH 里找） */
function exists(p, opts = {}) {
  const raw = String(p || '').trim();
  if (!raw) return false;
  if (isBareName(raw)) return resolveCommand(raw, opts) !== raw;
  try { return (opts.fs || fs).existsSync(raw); } catch { return false; }
}

/**
 * 判断一个 .exe 是不是**控制台程序**（PE OptionalHeader.Subsystem === 3）。
 *
 * 为什么要读这几个字节：控制台程序必须拿到一个控制台才能跑起来。
 * 用 DETACHED_PROCESS 派生（spawn 的 detached:true）会把控制台一起拿掉，
 * powershell / python 会直接 return —— 静默、零日志、零窗口，
 * 用户看到的就是"点了启动什么都没有"。读 PE 头能自动认出这类程序，
 * 不用指望用户自己去勾「显示命令行窗口」。
 */
function isConsoleExe(p, opts = {}) {
  const fsi = opts.fs || fs;
  const key = String(p || '');
  if (!key) return false;
  if (consoleMemo.has(key)) return consoleMemo.get(key);

  let yes = false;
  try {
    const fd = fsi.openSync(key, 'r');
    try {
      const dos = Buffer.alloc(64);
      if (fsi.readSync(fd, dos, 0, 64, 0) >= 64 && dos.readUInt16LE(0) === 0x5a4d) {   // 'MZ'
        const peOff = dos.readUInt32LE(0x3c);
        const head = Buffer.alloc(94);            // PE 签名 4 + COFF 20 + OptionalHeader 前 70
        if (fsi.readSync(fd, head, 0, 94, peOff) >= 94 && head.readUInt32LE(0) === 0x00004550) {
          // OptionalHeader 从 PE 签名后 24 字节开始，Subsystem 在它 +68（PE32 / PE32+ 同位置）
          yes = head.readUInt16LE(24 + 68) === 3;
        }
      }
    } finally { try { fsi.closeSync(fd); } catch { /* noop */ } }
  } catch { yes = false; }

  if (consoleMemo.size >= MEMO_MAX) consoleMemo.clear();
  consoleMemo.set(key, yes);
  return yes;
}

/** 只给测试用：清缓存 */
function resetCache() { memo.clear(); consoleMemo.clear(); }

module.exports = {
  isBareName, searchDirs, extensions, candidates,
  resolveCommand, exists, isConsoleExe, resetCache,
  DEFAULT_PATHEXT,
};

'use strict';
/**
 * 启动动作层：把配置项变成真实的进程 / 窗口 / 网址打开动作。
 */

const { shell, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const resolveLib = require('./resolve');

/* ---------------------------------------------------- 小工具 */

/** PowerShell 单引号转义 */
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function systemCmd() {
  if (process.env.ComSpec) return process.env.ComSpec;
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'cmd.exe');
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** 工作目录不存在就别传 —— 传了 Node 会异步报错，而那个错误没人接 */
function safeCwd(cwd) {
  if (!cwd) return undefined;
  return fileExists(cwd) ? cwd : undefined;
}

/** 派生失败是**异步事件**，没监听器会直接把主进程抛崩；这里统一吞掉并返回 false */
function spawnQuiet(file, args, opts) {
  try {
    const child = spawn(file, args, opts);
    child.on('error', e => console.warn('[launch] 派生失败:', file, e && e.message));
    child.unref();
    return child.pid;
  } catch (e) {
    console.warn('[launch] 派生异常:', file, e && e.message);
    return 0;
  }
}

/**
 * 把裸命令名解析成绝对路径（notepad.exe → C:\Windows\System32\notepad.exe）。
 * 以前只在 System32 / SystemRoot 里找，于是 powershell.exe、python.exe、wt.exe
 * 这类**只存在于 PATH 里**的命令永远解析不出来 → openPath 必然失败 →
 * 退回 detached 派生又静默死掉 = 「点了启动什么都没有」。
 * 现在统一走 lib/resolve.js（与 store 的存在性判定共用一份实现）。
 */
function resolveTarget(p) {
  const s = store.expandEnv(p);
  if (!s) return s;
  return resolveLib.resolveCommand(s);
}

function whichPython() {
  const found = resolveLib.resolveCommand('python.exe');
  if (found && found !== 'python.exe') return found;
  const cands = [];
  const local = process.env.LOCALAPPDATA || '';
  if (local) cands.push(path.join(local, 'Programs', 'Python'));
  for (const c of [
    'D:\\Program Files\\Python312\\python.exe',
    'C:\\Python312\\python.exe',
    'C:\\Python311\\python.exe',
  ]) cands.push(c);
  for (const c of cands) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* noop */ }
  }
  return 'python';
}

/**
 * 交给 cmd 跑一整行（「命令」类型与「脚本」类型用）。
 *
 * ★ 不再用 detached:true。Windows 上它会给子进程带 DETACHED_PROCESS，
 *   控制台程序（powershell / cmd / python）拿不到控制台就一行都不执行、
 *   直接 exit 0 —— 静默、零日志、零窗口。详见 runStart 上方那张实测对照表。
 * ★ 也不再让 cmd 自己占一个控制台窗口（windowsHide），否则用户会先看到
 *   一个黑框闪一下。可见性交给命令里的 `start ""` 去给。
 */
function runShell(command, { cwd = null, visible = false } = {}) {
  const line = visible ? `start "" ${command}` : command;
  return spawnQuiet(line, [], {
    shell: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: safeCwd(cwd),
  });
}

/**
 * 启动一个可执行文件 —— 等价于「双击」，但保证控制台程序能拿到窗口。
 *
 * 为什么必须经 cmd 的 start，而不是直接 spawn（本机实测对照表）：
 *   spawn(exe, {detached:true})            → 目标一行都没执行（DETACHED_PROCESS，无控制台）
 *   spawn(exe, {detached:false}) 父进程退出 → 目标被连带清掉
 *   cmd /c start "" "exe" …                → 活得很好，而且拿到了自己的新控制台
 *   cmd /c ""exe" …"                       → 也能活，但 cmd 得一直陪到最后
 * 启动器"点完就该回来"，所以走 start 形态；cmd 自己不给窗口，避免黑框闪一下。
 */
function runStart(target, args, { cwd = null } = {}) {
  const command = `"${target}"${args ? ' ' + args : ''}`;
  return spawnQuiet(systemCmd(), [`/c start "" ${command}`], {
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
    cwd: safeCwd(cwd),
  });
}

/* ---------------------------------------------------- 主入口 */

async function launch(item) {
  const type = item.type || 'app';
  const raw = (item.path || '').trim();
  const target = resolveTarget(raw);
  const args = (item.args || '').trim();
  const cwd = item.cwd ? store.expandEnv(item.cwd) : null;

  if (!target) return { ok: false, msg: '路径为空' };

  try {
    /* ---- 网址 ---- */
    if (type === 'url') {
      const url = /^https?:\/\//i.test(target) ? target : 'http://' + target;
      await shell.openExternal(url);
      return { ok: true, msg: `已打开 ${url}` };
    }

    /* ---- 目录 / 文件 ---- */
    if (type === 'folder' || type === 'file') {
      const err = await shell.openPath(target);
      if (err) return { ok: false, msg: err };
      return { ok: true, msg: `已打开 ${path.basename(target)}` };
    }

    /* ---- 需要管理员权限 ---- */
    if (item.elevate) {
      // 这个 powershell 要等 UAC 结果，所以**不能** detached：
      // 没有控制台它同样一行都不执行，表现就是"点了管理员启动，什么都没弹"。
      const ps = resolveLib.resolveCommand('powershell.exe');
      const line = args
        ? `Start-Process -FilePath ${psQuote(target)} -ArgumentList ${psQuote(args)} -Verb RunAs`
        : `Start-Process -FilePath ${psQuote(target)} -Verb RunAs`;
      spawnQuiet(ps, ['-NoProfile', '-Command', line], { stdio: 'ignore', windowsHide: true });
      return { ok: true, msg: '已请求管理员权限启动' };
    }

    /* ---- 命令行 ---- */
    if (type === 'cmd') {
      runShell(args ? `${target} ${args}` : target, { cwd, visible: !!item.console });
      return { ok: true, msg: `已执行 ${item.name || target}` };
    }

    /* ---- 脚本：按扩展名路由解释器 ---- */
    if (type === 'script') {
      const ext = path.extname(target).toLowerCase();
      let line;
      if (ext === '.bat' || ext === '.cmd') {
        line = `"${target}"${args ? ' ' + args : ''}`;
      } else if (ext === '.ps1') {
        line = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${target}"${args ? ' ' + args : ''}`;
      } else if (ext === '.py' || ext === '.pyw') {
        line = `"${whichPython()}" "${target}"${args ? ' ' + args : ''}`;
      } else if (ext === '.js' || ext === '.mjs') {
        line = `node "${target}"${args ? ' ' + args : ''}`;
      } else {
        line = `"${target}"${args ? ' ' + args : ''}`;
      }
      runShell(line, { cwd, visible: item.console !== false });
      return { ok: true, msg: `已运行脚本 ${path.basename(target)}` };
    }

    /* ---- 应用 ---- */
    const label = item.name || path.basename(target);
    const isExe = /\.(exe|com)$/i.test(target);

    // 先确认文件真的在。这一步以前没有，而 spawn 的 ENOENT 是异步事件、
    // 又没人监听 —— 于是"找不到程序"也返回成功：界面弹「已启动」，
    // 屏幕上什么都没有。这就是"点了启动没反应"的另一半原因。
    if (isExe && !fileExists(target)) {
      return { ok: false, msg: `找不到这个程序：${target}` };
    }

    // 非 .exe（.lnk / .msc / .cpl / .appref-ms / 已关联的文件）只能交给 shell
    if (!isExe) {
      const err = await shell.openPath(target);
      if (err) return { ok: false, msg: err };
      return { ok: true, msg: `已启动 ${label}` };
    }

    // 控制台程序（powershell / cmd / python / git-bash）必须给它一个窗口，
    // 否则它连交互都没有意义 —— 也别指望用户自己去勾「显示命令行窗口」。
    const consoleApp = !!item.console || resolveLib.isConsoleExe(target);

    if (!args && !consoleApp) {
      // 普通窗口程序：走 ShellExecute，等同于双击（带 UAC manifest 的也能正常弹）
      const err = await shell.openPath(target);
      if (!err) return { ok: true, msg: `已启动 ${label}` };
    }
    runStart(target, args, { cwd });
    return { ok: true, msg: `已启动 ${label}` };

  } catch (e) {
    return { ok: false, msg: `${e.code || e.name}: ${e.message}` };
  }
}

/* ---------------------------------------------------- 其他系统动作 */

async function openContaining(p) {
  const t = store.expandEnv(p);
  if (!t) return { ok: false, msg: '路径为空' };
  try {
    shell.showItemInFolder(t);
    return { ok: true, msg: '已在资源管理器中定位' };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

async function pick(kind, win) {
  const isDir = kind === 'dir';
  const isScript = kind === 'script';
  const opts = {
    title: isDir ? '选择文件夹' : '选择要启动的文件',
    properties: isDir ? ['openDirectory'] : ['openFile'],
  };
  if (!isDir) {
    const exts = isScript
      ? [['脚本与批处理', ['py', 'pyw', 'bat', 'cmd', 'ps1', 'js', 'mjs', 'vbs']]]
      : [['程序与快捷方式', ['exe', 'lnk', 'url', 'bat', 'cmd', 'msc', 'cpl', 'appref-ms']],
         ['所有文件', ['*']]];
    opts.filters = exts;
  }
  const r = await dialog.showOpenDialog(win, opts);
  return r.canceled || !r.filePaths.length ? '' : r.filePaths[0];
}

module.exports = { launch, openContaining, pick, resolveTarget };

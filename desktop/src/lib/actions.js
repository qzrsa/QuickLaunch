'use strict';
/**
 * 启动动作层：把配置项变成真实的进程 / 窗口 / 网址打开动作。
 */

const { shell, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const store = require('./store');

const IS_WIN = process.platform === 'win32';

/* ---------------------------------------------------- 小工具 */

/** 把参数字符串切成数组，支持双引号包裹 */
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || '')) !== null) {
    out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  }
  return out;
}

/** PowerShell 单引号转义 */
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

/** 把裸命令名解析成绝对路径（notepad.exe → C:\Windows\System32\notepad.exe） */
function resolveTarget(p) {
  const s = store.expandEnv(p);
  if (!s) return s;
  if (path.isAbsolute(s)) return s;
  if (s.includes(path.sep) || s.includes('/')) return s;
  const roots = [
    process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : null,
    process.env.SystemRoot || null,
  ].filter(Boolean);
  for (const r of roots) {
    const c = path.join(r, s);
    try { if (fs.existsSync(c)) return c; } catch { /* noop */ }
  }
  const win = process.env.windir || process.env.WINDIR;
  if (win) {
    const c = path.join(win, 'System32', s);
    try { if (fs.existsSync(c)) return c; } catch { /* noop */ }
  }
  return s;
}

function whichPython() {
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

/** 分离式启动：父进程退出后子进程继续活着 */
function runDetached(command, { cwd = null, visible = false } = {}) {
  const line = visible ? `start "" ${command}` : command;
  const child = spawn(line, {
    shell: true,
    detached: true,
    stdio: 'ignore',
    windowsHide: !visible,
    cwd: cwd || undefined,
  });
  child.unref();
  return child.pid;
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
      const ps = args
        ? `Start-Process -FilePath ${psQuote(target)} -ArgumentList ${psQuote(args)} -Verb RunAs`
        : `Start-Process -FilePath ${psQuote(target)} -Verb RunAs`;
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
      return { ok: true, msg: '已请求管理员权限启动' };
    }

    /* ---- 命令行 ---- */
    if (type === 'cmd') {
      runDetached(args ? `${target} ${args}` : target, { cwd, visible: !!item.console });
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
      runDetached(line, { cwd, visible: item.console !== false });
      return { ok: true, msg: `已运行脚本 ${path.basename(target)}` };
    }

    /* ---- 应用 ---- */
    if (!args) {
      const err = await shell.openPath(target);
      if (err) {
        // openPath 对某些无关联的 exe 会失败，退回直接派生
        if (target.toLowerCase().endsWith('.exe')) {
          spawn(target, [], { detached: true, stdio: 'ignore', windowsHide: false, cwd: cwd || undefined }).unref();
          return { ok: true, msg: `已启动 ${item.name || path.basename(target)}` };
        }
        return { ok: false, msg: err };
      }
      return { ok: true, msg: `已启动 ${item.name || path.basename(target)}` };
    }

    spawn(target, splitArgs(args), {
      detached: true, stdio: 'ignore', windowsHide: !item.console, cwd: cwd || undefined,
    }).unref();
    return { ok: true, msg: `已启动 ${item.name || path.basename(target)}` };

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

module.exports = { launch, openContaining, pick, resolveTarget, splitArgs };

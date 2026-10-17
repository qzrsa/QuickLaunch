'use strict';
/**
 * 拖入导入：把拖进窗口的文件 / 文件夹 / 网址转成启动项。
 *
 * 设计要点：
 * - 分类逻辑（classifyBasic）是纯同步的，不依赖 electron，方便单测。
 * - .lnk / .url 需要读取目标，.lnk 走一次批量 PowerShell（WScript.Shell COM），
 *   整批只启动一次进程，路径通过 base64 内联传入，避免中文与引号转义问题。
 * - 解析出 .lnk 目标后，存的是**目标本体**（exe 路径 + args + cwd）而不是 lnk 本身，
 *   这样"打开所在位置"能定位到真正的程序，启动也更可靠。
 * - .url 存的是**协议原样**（`steam://rungameid/1`，不补 http://），外加一个 `_iconFile`
 *   把 `IconFile=` 指的图标路径带给主进程 —— 本模块没有 electron，取不了图标。
 *   `_iconFile` 只在本进程内传递，`store.newItem` 只收固定字段，不会被写进 config.json。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const urlsc = require('./urlshortcut');

const SCRIPT_EXT = ['.bat', '.cmd', '.ps1', '.py', '.js', '.mjs', '.vbs', '.ahk', '.sh'];
const APP_EXT = ['.exe', '.com', '.msc', '.cpl', '.appref-ms'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tif', '.tiff'];
const VIDEO_EXT = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm'];
const AUDIO_EXT = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.ape'];
const ARC_EXT = ['.zip', '.7z', '.rar', '.tar', '.gz'];

const MAX_ITEMS = 50;

/** 快捷方式常见的后缀噪声，Windows 生成时爱加 */
const NAME_NOISE = [/[-—]\s*快捷方式$/i, /\s*-\s*shortcut$/i, /\.lnk$/i, /\.url$/i];

function iconFor(ext, isDir) {
  if (isDir) return '📁';
  if (APP_EXT.includes(ext)) return '🚀';
  if (SCRIPT_EXT.includes(ext)) return '📜';
  if (IMAGE_EXT.includes(ext)) return '🖼️';
  if (VIDEO_EXT.includes(ext)) return '🎬';
  if (AUDIO_EXT.includes(ext)) return '🎵';
  if (ARC_EXT.includes(ext)) return '📦';
  if (['.msc', '.cpl'].includes(ext)) return '🛠️';
  return '📄';
}

function cleanName(p) {
  let base = path.basename(String(p || ''));
  const ext = path.extname(base);
  if (ext) base = base.slice(0, -ext.length);
  for (const re of NAME_NOISE) base = base.replace(re, '');
  base = base.replace(/\s+/g, ' ').trim();
  return base || path.basename(String(p || '')) || '未命名';
}

/** 取主机名（去掉 www）。★ 协议链接（steam://）没有主机名，别拿这个当名字，见 urlsc.descForUrl */
const hostOf = urlsc.hostOf;

/**
 * 同步分类一个本地路径。返回 null 表示无法处理。
 * 注意：.lnk / .url 在这里只给出"占位"结果，真正目标由 resolveShellLinks 补齐。
 */
function classifyBasic(p) {
  const full = String(p || '').trim();
  if (!full) return null;

  let st = null;
  try { st = fs.statSync(full); } catch { st = null; }

  const ext = path.extname(full).toLowerCase();
  const name = cleanName(full);

  if (st && st.isDirectory()) {
    return { name, icon: '📁', type: 'folder', path: full, desc: '' };
  }

  if (ext === '.lnk' || ext === '.url') {
    // 未解析前的兜底：交给 shell 关联打开，至少能用
    return { name, icon: ext === '.url' ? '🌐' : '🔗', type: 'app', path: full, desc: '', _shell: true };
  }

  if (APP_EXT.includes(ext)) return { name, icon: iconFor(ext), type: 'app', path: full, desc: '' };
  if (SCRIPT_EXT.includes(ext)) return { name, icon: '📜', type: 'script', path: full, desc: '' };

  if (!st) {
    // 不存在的路径也允许导入（用户可能稍后才接入该盘），但走 file 类型
    return { name, icon: iconFor(ext), type: 'file', path: full, desc: '' };
  }
  return { name, icon: iconFor(ext), type: 'file', path: full, desc: '' };
}

/* ------------------------------------------------ .url 解析 */

/**
 * 解析 `.url` 里的 `URL=`。返回 null 表示读不到/不是 Internet 快捷方式。
 * ★ v1.4.4 起真正的实现搬到 `lib/urlshortcut.js`（还要拿 IconFile），这里只留一个门面，
 *   别在两处各写一份正则 —— 两份必然漂移。
 */
function parseUrlFile(p) {
  const sc = urlsc.readUrlShortcut(p, { fs });
  return sc ? sc.url : null;
}

/* ------------------------------------------------ .lnk 解析 */

/**
 * 注意两个已经踩过的坑：
 * 1) 输入不要用 JSON 数组。PS 5.1 里 `@($json | ConvertFrom-Json)` 会把整个数组
 *    包成**单个元素**，foreach 只跑一次，CreateShortcut 收到一串拼接后的垃圾路径，
 *    所有 .lnk 的目标都会是空。改用 `|` 连接后再 -split —— `|` 不是合法文件名字符。
 * 2) 用 String.Split([char]124) 而不是 -split。`-split` 把参数当**正则**，
 *    `|` 是正则的"或"（匹配空串），会把整串按单个字符切开。
 */
const PS_LNK = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$blob = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('__B64__'))
$list = @($blob.Split([char]124) | Where-Object { $_ -ne '' })
$sh = New-Object -ComObject WScript.Shell
$out = @()
foreach ($p in $list) {
  $s = $sh.CreateShortcut([string]$p)
  $out += [pscustomobject]@{
    src    = [string]$p
    target = [string]$s.TargetPath
    args   = [string]$s.Arguments
    cwd    = [string]$s.WorkingDirectory
    desc   = [string]$s.Description
  }
}
$out | ConvertTo-Json -Compress -Depth 4
`;

/** 批量解析 .lnk，返回 Map<原路径, {target,args,cwd,desc}> */
function resolveShortcuts(list) {
  return new Promise(resolve => {
    const map = new Map();
    if (!list.length) return resolve(map);
    if (process.platform !== 'win32') return resolve(map);

    const b64 = Buffer.from(list.join('|'), 'utf8').toString('base64');
    const script = PS_LNK.replace('__B64__', b64);
    const enc = Buffer.from(script, 'utf16le').toString('base64');

    let child;
    try {
      child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
        { windowsHide: true });
    } catch { return resolve(map); }

    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } }, 15000);

    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(map); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        let parsed = JSON.parse(out.trim() || '[]');
        if (!Array.isArray(parsed)) parsed = [parsed];
        for (const r of parsed) {
          if (!r || !r.src) continue;
          map.set(String(r.src).trim(), {
            target: String(r.target || '').trim(),
            args: String(r.args || '').trim(),
            cwd: String(r.cwd || '').trim(),
            desc: String(r.desc || '').trim(),
          });
        }
      } catch { /* 解析失败就退回未解析版本 */ }
      resolve(map);
    });
  });
}

/* ------------------------------------------------ 汇总 */

const keyOf = it => `${it.type}|${String(it.path || '').toLowerCase()}`;

/**
 * @param {object} opt
 * @param {string[]} opt.paths    本地路径（文件 / 目录）
 * @param {string[]} opt.urls     网址
 * @param {object[]} opt.existing 现有启动项，用于去重
 * @returns {Promise<{items:object[], skipped:string[], failed:string[]}>}
 */
async function buildItems({ paths = [], urls = [], existing = [] } = {}) {
  const items = [];
  const skipped = [];
  const failed = [];
  const seen = new Set(existing.map(keyOf));

  const push = (it, label) => {
    if (!it) return failed.push(label);
    const k = keyOf(it);
    if (seen.has(k)) return skipped.push(it.name || label);
    seen.add(k);
    items.push(it);
  };

  /* 网址 */
  for (const raw of urls) {
    const u = urlsc.normalizeUrl(raw);
    if (!u) continue;
    // ★ 协议链接（`steam://`）不能用 hostname 当名字 —— `new URL('steam://rungameid/1')`
    //   的 hostname 是 `rungameid`，看着像域名其实是路径段。见 urlshortcut.descForUrl。
    const desc = urlsc.descForUrl(u);
    if (!desc) { failed.push(raw); continue; }
    push({ name: desc, icon: '🌐', type: 'url', path: u, desc }, raw);
  }

  /* 本地路径 */
  const lnks = [];
  for (const p of paths) {
    const full = String(p || '').trim();
    if (!full) continue;
    const ext = path.extname(full).toLowerCase();

    if (ext === '.url') {
      // ★★ 这里以前是「把 URL= 读出来，不认 http 就补 http://，图标写死 🌐」——
      //    于是 `steam://rungameid/1` 变成 `http://steam://rungameid/1`（点不开），
      //    而同一行下面写着的 `IconFile=…ico` 完全没被读过（11 个游戏全是同一个大地球）。
      const sc = urlsc.readUrlShortcut(full, { fs });
      const url = sc ? urlsc.normalizeUrl(sc.url) : '';
      if (url) {
        push({
          name: cleanName(full), icon: '🌐', type: 'url', path: url,
          desc: urlsc.descForUrl(url),
          // 交给主进程取图标：这里没有 electron，只能把文件路径带出去
          _iconFile: sc.iconFile || '',
        }, full);
      } else {
        push(classifyBasic(full), full);   // 解析不出 URL 就按文件处理
      }
      continue;
    }
    if (ext === '.lnk') { lnks.push(full); continue; }
    push(classifyBasic(full), full);
  }

  /* .lnk：一次批量解析 */
  if (lnks.length) {
    const resolved = await resolveShortcuts(lnks);
    for (const src of lnks) {
      const r = resolved.get(src);
      const name = cleanName(src);
      if (!r || !r.target) {
        // 解析不到目标：保留 lnk 本身，交给 shell 关联
        push({ name, icon: '🔗', type: 'app', path: src, desc: '' }, src);
        continue;
      }

      let targetIsDir = false;
      try { targetIsDir = fs.statSync(r.target).isDirectory(); } catch { /* noop */ }

      if (targetIsDir) {
        push({ name, icon: '📁', type: 'folder', path: r.target, desc: r.desc || '' }, src);
      } else {
        const ext = path.extname(r.target).toLowerCase();
        const type = SCRIPT_EXT.includes(ext) ? 'script' : 'app';
        push({
          name, icon: iconFor(ext, false), type, path: r.target,
          args: r.args || '', cwd: r.cwd || '', desc: r.desc || '',
        }, src);
      }
    }
  }

  return { items: items.slice(0, MAX_ITEMS), skipped, failed };
}

module.exports = {
  buildItems, classifyBasic, cleanName, iconFor, hostOf, parseUrlFile, resolveShortcuts,
  keyOf, MAX_ITEMS,
  SCRIPT_EXT, APP_EXT,
};

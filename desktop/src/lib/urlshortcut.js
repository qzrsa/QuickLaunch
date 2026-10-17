'use strict';
/**
 * `.url`（Internet 快捷方式）解析：拿到**真实 URL** 和它引用的**图标文件**。
 *
 * 起因（v1.4.4）：桌面上 11 个游戏平台的 `.url`（Steam / fevergames / loadingbay）拖进来后
 * 全是同一个大地球 🌐，用户的原话是「其实肯定不止这两个」。真因有两条：
 *  1) `URL=steam://rungameid/400040` 被当成"裸网址"又套了一层 `http://`，变成
 *     `http://steam://rungameid/400040` —— 既点不开（浏览器打开一个不存在的地址），
 *     也永远拿不到图标（`hostOf()` 取到 `steam`，图标写死 '🌐'）；
 *  2) `.url` 里明明写着 `IconFile=…\8de261a4….ico`，导入时压根没读。
 *
 * ★★ 图标只有一条路可靠（本机实测 3/3）：
 *    `IconFile` 指的 `.ico` 用 `nativeImage.createFromPath()` 读 → 256×256，三个文件三个不同哈希。
 *    而 `app.getFileIcon()` 对 `.ico` 和对 `.url` 本体**都只回一张 32×32 的通用图标**
 *    （多个不同文件哈希一模一样）—— 跟 `.lnk` 不追目标是同一类坑，别再走那条路。
 * ★ `IconIndex` 只在 `IconFile` 是 `.dll` / `.exe`（多图标容器）时才有意义，
 *    nativeImage 读不了容器 → 这种情况保持 emoji 回退，别硬凑一张假图。
 * ★ 编码：`.url` 是纯 ASCII 的 INI 文本（CRLF 或 LF 都有，本机两种都存在），
 *    按 utf8 读就够；不要用 PowerShell 的 `-Encoding Default` 去看，`\r` 会显示成 `X`。
 *
 * 纯函数为主，`fs` / `env` 可注入 —— 单测不需要真文件系统。
 */

const path = require('path');

const HTTP_RE = /^https?:\/\//i;
// `scheme://`；scheme 允许单字符（x://），但必须带 `//` —— 否则 `C:` `localhost:3000`
// 这类会被误判成协议。
const SCHEME_RE = /^[a-z][a-z0-9+.\-]*:\/\//i;

const MAX_SCAN_DEPTH = 4;
const MAX_SCAN_FILES = 8000;

/** 去掉首尾空白与成对引号（`.url` 里 URL 常写成 "https://…"） */
function trim(v) {
  return String(v == null ? '' : v).trim().replace(/^"|"$/g, '').trim();
}

/**
 * 解析一段 `.url` 文本 → `{url, iconFile, iconIndex}`。
 * 没有 `URL=` 行返回 null（不是 Internet 快捷方式）。
 * @param {string} raw 文件全文
 * @returns {{url:string, iconFile:string, iconIndex:number}|null}
 */
function parseInternetShortcut(raw) {
  const txt = String(raw || '').replace(/^\uFEFF/, '');
  if (!txt) return null;
  const m = txt.match(/^[ \t]*URL[ \t]*=[ \t]*(.+?)[ \t]*$/im);
  if (!m) return null;
  const url = trim(m[1]);
  if (!url) return null;

  const f = txt.match(/^[ \t]*IconFile[ \t]*=[ \t]*(.+?)[ \t]*$/im);
  const ix = txt.match(/^[ \t]*IconIndex[ \t]*=[ \t]*(-?\d+)[ \t]*$/im);
  return {
    url,
    iconFile: f ? trim(f[1]) : '',
    iconIndex: ix ? Number(ix[1]) : 0,
  };
}

/** 读一个 `.url` 文件；读不到/不是快捷方式返回 null */
function readUrlShortcut(file, deps = {}) {
  const fs = deps.fs || require('fs');
  try { return parseInternetShortcut(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 把用户给的"网址"规整成一个能直接交给 `shell.openExternal` 的 URL。
 *  - `https://x` / `http://x` → 原样
 *  - `steam://…` / `fevergames://…` → **原样**（★ 这就是以前被套成 `http://steam://…` 的地方）
 *  - `example.com` / `localhost:3000` → 补 `http://`
 */
function normalizeUrl(u) {
  const s = trim(u);
  if (!s) return '';
  if (HTTP_RE.test(s)) return s;
  if (SCHEME_RE.test(s)) return s;
  return 'http://' + s;
}

/**
 * 修 `http://steam://rungameid/1` 这种**旧版本套出来的双层协议**。
 * 只在「第一个协议后面紧跟另一个完整 `scheme://`」时才动，正常 URL 一律返回 ''。
 */
function stripBogusScheme(u) {
  const s = trim(u);
  const m = s.match(/^https?:\/\/([a-z][a-z0-9+.\-]*:\/\/\S*)$/i);
  return m ? m[1] : '';
}

/** 取协议名（小写，不含冒号）；没有协议返回 '' */
function schemeOf(u) {
  const m = trim(u).match(/^([a-z][a-z0-9+.\-]*):/i);
  return m ? m[1].toLowerCase() : '';
}

/** 是不是普通网页（http/https）—— 只有这种才用 hostname 当名字/说明 */
function isWebUrl(u) {
  return HTTP_RE.test(trim(u));
}

function hostOf(u) {
  try { return new URL(trim(u)).hostname.replace(/^www\./i, ''); } catch { return ''; }
}

/**
 * 卡片的「说明」一行：
 *  - 网页 → 主机名（`github.com`）
 *  - `steam://` / `fevergames://` 这类 → 协议名（`steam`）
 * ★ 不能对协议链接用 hostname：`new URL('steam://rungameid/400040').hostname` 是
 *   `rungameid`，看着像域名，其实是路径段。
 */
function descForUrl(u) {
  if (isWebUrl(u)) return hostOf(u);
  return schemeOf(u);
}

/** 卡片标题：网页用主机名，协议链接用协议名，都没有就用原串 */
function nameForUrl(u) {
  return descForUrl(u) || trim(u);
}

/** 比较两个 URL 是否"同一张"（忽略大小写与结尾斜杠） */
function urlKey(u) {
  return trim(u).replace(/\/+$/, '').toLowerCase();
}

/**
 * 把 [.url 快捷方式] 列表压成 Map<urlKey, iconFile>（先到先得）。
 * @param {{url:string, iconFile:string}[]} list
 */
function iconFileIndex(list) {
  const m = new Map();
  for (const s of list || []) {
    if (!s || !s.url || !s.iconFile) continue;
    const k = urlKey(s.url);
    if (k && !m.has(k)) m.set(k, s.iconFile);
  }
  return m;
}

/**
 * 递归扫若干个目录里的 `.url`，返回 `{file, url, iconFile, iconIndex}[]`。
 * 只读小文本文件；本机 4 个目录共 32 个 `.url`、189ms（含首次冷读），
 * 所以"启动时扫一次"完全可接受，但**别在启动路径上无条件扫**——由调用方决定时机。
 */
function scanUrlShortcuts(dirs, deps = {}) {
  const fs = deps.fs || require('fs');
  const maxDepth = deps.maxDepth == null ? MAX_SCAN_DEPTH : deps.maxDepth;
  const out = [];
  const seen = new Set();
  let count = 0;

  const walk = (dir, depth) => {
    if (!dir || depth > maxDepth || out.length >= MAX_SCAN_FILES) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      let isDir = false;
      try { isDir = e.isDirectory(); } catch { isDir = false; }
      const full = path.join(dir, e.name);
      if (isDir) { walk(full, depth + 1); continue; }
      if (!/\.url$/i.test(e.name)) continue;
      const key = full.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      count++;
      if (count > MAX_SCAN_FILES) return;
      const sc = readUrlShortcut(full, { fs });
      if (sc) out.push(Object.assign({ file: full }, sc));
    }
  };

  for (const d of dirs || []) walk(d, 0);
  return out;
}

/** 默认扫描目录：桌面（含公共桌面）+ 开始菜单（含公共开始菜单） */
function defaultScanDirs(env = process.env) {
  const home = env.USERPROFILE || env.HOME || '';
  const appdata = env.APPDATA || '';
  const programdata = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData';
  const pub = env.PUBLIC || 'C:\\Users\\Public';
  return [
    home ? path.join(home, 'Desktop') : '',
    path.join(pub, 'Desktop'),
    appdata ? path.join(appdata, 'Microsoft', 'Windows', 'Start Menu') : '',
    path.join(programdata, 'Microsoft', 'Windows', 'Start Menu'),
  ].filter(Boolean);
}

module.exports = {
  parseInternetShortcut, readUrlShortcut,
  normalizeUrl, stripBogusScheme, schemeOf, isWebUrl, hostOf, descForUrl, nameForUrl,
  urlKey, iconFileIndex, scanUrlShortcuts, defaultScanDirs,
  MAX_SCAN_DEPTH, MAX_SCAN_FILES,
};

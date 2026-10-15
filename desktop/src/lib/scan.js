'use strict';
/**
 * 软件扫描：开始菜单快捷方式 + 注册表安装信息
 * 结果缓存 120 秒。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SKIP_WORDS = ['卸载', 'uninstall', 'readme', '帮助', 'help', '文档', 'docs',
  'license', '许可', 'changelog', '更新日志', '官方网站', 'website', '网址',
  'repair', '修复', 'setup', '安装程序'];

const cache = { ts: 0, data: [] };

/* ------------------------------------------------ 开始菜单 */

function walk(dir, root, depth, out) {
  if (depth > 3) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, root, depth + 1, out);
    } else {
      const low = e.name.toLowerCase();
      if (!low.endsWith('.lnk') && !low.endsWith('.url')) continue;
      const name = path.basename(e.name, path.extname(e.name));
      const lname = name.toLowerCase();
      if (SKIP_WORDS.some(w => lname.includes(w))) continue;
      out.push({ name, path: full, type: 'app', source: '开始菜单' });
    }
  }
}

function scanStartMenu() {
  const out = [];
  const roots = [];
  if (process.env.ProgramData) {
    roots.push(path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }
  if (process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }
  for (const r of roots) {
    try { if (fs.existsSync(r)) walk(r, r, 1, out); } catch { /* noop */ }
  }
  return out;
}

/* ------------------------------------------------ 注册表 */

const PS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
Get-ItemProperty $paths -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -and $_.DisplayIcon -and -not $_.SystemComponent } |
  ForEach-Object {
    [pscustomobject]@{
      name = [string]$_.DisplayName
      icon = [string]($_.DisplayIcon -replace ',\\s*-?\\d+\\s*$', '')
    }
  } | ConvertTo-Json -Compress -Depth 3
`;

function scanRegistry() {
  return new Promise(resolve => {
    const b64 = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      { windowsHide: true });

    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } }, 20000);

    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('close', () => {
      clearTimeout(timer);
      const items = [];
      try {
        let parsed = JSON.parse(out.trim() || '[]');
        if (!Array.isArray(parsed)) parsed = [parsed];
        for (const r of parsed) {
          const icon = String(r.icon || '').replace(/^"|"$/g, '').trim();
          if (!icon || !icon.toLowerCase().endsWith('.exe')) continue;
          let exists = false;
          try { exists = fs.existsSync(icon); } catch { /* noop */ }
          if (!exists) continue;
          items.push({ name: String(r.name || '').trim(), path: icon, type: 'app', source: '注册表' });
        }
      } catch (e) {
        if (err) console.error('[scan] PowerShell 错误:', err.slice(0, 500));
      }
      resolve(items);
    });
  });
}

/* ------------------------------------------------ 汇总 */

async function scan(force = false) {
  if (!force && cache.data.length && Date.now() - cache.ts < 120000) return cache.data;

  const [menu, reg] = await Promise.all([
    Promise.resolve(scanStartMenu()),
    scanRegistry(),
  ]);

  const seen = new Set();
  const uniq = [];
  for (const it of menu.concat(reg)) {
    if (!it.name) continue;
    const key = it.name.toLowerCase();
    const base = path.basename(it.path, path.extname(it.path)).toLowerCase();
    if (seen.has(key) || seen.has(base)) continue;
    seen.add(key);
    if (base) seen.add(base);
    uniq.push(it);
  }
  uniq.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  cache.ts = Date.now();
  cache.data = uniq.slice(0, 400);
  return cache.data;
}

module.exports = { scan };

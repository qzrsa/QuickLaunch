#!/usr/bin/env node
/**
 * 解开**绿色版 zip**（`QuickLaunch-Green-<版本>.zip`）。
 *
 *   node scripts/unpack-green.mjs --zip ../dist/QuickLaunch-Green-1.1.1.zip --out <目录>
 *
 * 为什么需要它：差量补丁要拿**上一个 Release 的绿色版**当基准，而
 * `make-update-manifest.mjs --old` 要的是一个**目录**（不是 zip）——
 * CI 里就得先把这个 zip 解开。读 zip 的实现只有 `src/lib/unzip.js` 一份
 * （写的那一半在 `pack-green.mjs`，两边共用同一个 CRC32）。
 *
 * ★ 解包时把 `datadir.isProtectedPath` 交给 unzip：绿色版 zip 里**不该**有 `data/`
 *   （pack-green 已经排除），万一混进去（例如谁手动压了一个"本机跑过"的目录），
 *   这里必须**当场拒绝**而不是解出一份带用户私人配置的基准 —— 拿它当差量基准，
 *   等于把用户的配置当成"程序文件"去比对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const unzip = require('../src/lib/unzip.js');
const { isProtectedPath } = require('../src/lib/datadir.js');

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};

const ZIP = arg('zip');
const OUT = arg('out');

if (!ZIP || !OUT) {
  console.error('用法: node scripts/unpack-green.mjs --zip <绿色版zip> --out <解包目录>');
  process.exit(2);
}
if (!fs.existsSync(ZIP)) { console.error(`[解包] 找不到 zip: ${ZIP}`); process.exit(1); }

const buf = fs.readFileSync(ZIP);
let entries;
try {
  entries = unzip.listZip(buf);
} catch (e) {
  console.error(`[解包] 这不是一个能读的 zip: ${e.message}`);
  process.exit(1);
}
if (!entries.length) { console.error('[解包] zip 里一个条目都没有'); process.exit(1); }

fs.mkdirSync(OUT, { recursive: true });

let written;
try {
  written = unzip.extractToDir(buf, OUT, { isProtected: isProtectedPath });
} catch (e) {
  console.error(`[解包] 拒绝解开这个 zip: ${e.message}`);
  process.exit(1);
}

// ★ 再独立数一遍：解出来的东西里有没有落在受保护目录的（上面的守卫是"逐条拦"，
//   这里是"解完之后回头查"—— 两处都过才算干净，不靠单点判断）。
const leaked = written.filter(f => isProtectedPath(f.path));
if (leaked.length) {
  console.error(`[解包] 解出了受保护路径，拒绝：${leaked.slice(0, 3).map(f => f.path).join(', ')}`);
  process.exit(1);
}

const total = written.reduce((s, f) => s + f.size, 0);
// `resources/app.asar` 是绿色版的核心载荷：它丢了，解出来的就不是一个能跑的程序，
// 而差量基准少一个文件只会表现成"补丁打不上"，排查起来会绕远路。
if (!written.some(f => f.path === 'resources/app.asar')) {
  console.error('[解包] 解出来没有 resources/app.asar —— 这不像一个绿色版包');
  process.exit(1);
}

console.log(`[解包] ${path.resolve(OUT)}`);
console.log(`          条目 ${written.length} 个 / 解出 ${(total / 1048576).toFixed(1)} MiB`);

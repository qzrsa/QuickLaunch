#!/usr/bin/env node
/**
 * 生成绿色版的更新清单 `update.json`（+ 可选差量补丁包 `.bin`）。
 *
 *   node scripts/make-update-manifest.mjs \
 *        --new ../dist/win-unpacked \
 *        --zip ../dist/QuickLaunch-Green-<版本>.zip \
 *        --out ../dist \
 *        [--old <上一个版本的目录>] [--from <上一个版本号>]
 *
 * 为什么要这份清单：绿色版是"目录即程序"，没有安装器，也就没人帮它算差量。
 * 清单里给出**目标版本的每个文件的 sha256**（全量下载后可以逐文件校验），
 * 以及**针对某个旧版本的差量计划**（COPY 本地已有块 + DATA 下载缺失块）。
 *
 * ★★ 这里必须复用 scripts/lib/dist-walk.mjs 的运行时目录排除与硬校验：
 *    `win-unpacked` 里可能躺着用户跑过之后留下的 `data/config.json`，
 *    一旦进了 `files` 清单，客户端会把它当成"程序文件"去校验/覆盖，后果不可控。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import * as distWalk from './lib/dist-walk.mjs';

const require = createRequire(import.meta.url);
const vcdiff = require('../src/lib/vcdiff.js');

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};

const NEW_DIR = arg('new');
const OLD_DIR = arg('old');
const OUT_DIR = arg('out', path.join(NEW_DIR || '.', '..'));
const ZIP = arg('zip');
let FROM_VER = arg('from');

if (!NEW_DIR || !ZIP) {
  console.error('用法: node scripts/make-update-manifest.mjs --new <新版本目录> --zip <绿色版zip> [--out <输出目录>] [--old <旧版本目录>] [--from <旧版本号>]');
  process.exit(2);
}
if (!fs.existsSync(NEW_DIR)) { console.error(`[清单] 新版本目录不存在: ${NEW_DIR}`); process.exit(1); }
if (!fs.existsSync(ZIP)) {
  // 全量回退路径必须可校验。没有 zip 就没有可信的全量兜底 —— 宁可报错，不要出一份
  // 「没法验签的清单」：客户端拿到它会陷入"补丁打不上、全量也不敢下"的死角。
  console.error(`[清单] 找不到绿色版 zip: ${ZIP}（先跑 pack-green，全量回退需要它的 sha256）`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const VERSION = pkg.version;
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const mib = (n) => (n / 1048576).toFixed(2) + ' MiB';

/* ------------------------------------------------------- 从 asar 里读旧版本号 */
/**
 * 旧版本目录里没有独立的版本文件，但 `resources/app.asar` 里就有打包时的 package.json。
 * asar 的头部布局**不是**直觉上的"8 字节头 + JSON"，实际是三个 uint32 前缀：
 *   [0]  = 4                      （"尺寸"那层 pickle 本身）
 *   [4]  = headerBuf.length       （= 4 + JSON 长度）
 *   [8]  = 4 + JSON 长度
 *   [12] = JSON 长度              ← 长度在这里
 *   [16..] = JSON 明文（未压缩）
 * 文件数据区基址 = 8 + [4]；每个条目自己的 offset 相对这个基址。
 * ★ 而且头部 JSON 是**目录索引**（{"files":{...}}），不是 package.json ——
 *   要拿版本号还得再跳一层，按条目里的 offset/size 去读真正的 package.json。
 * 读出来的 bytes 会拿条目自带的 integrity.hash 验一遍：**顺便自证偏移算对了**，
 * 算错偏移一定对不上哈希，不会静默返回一个错的版本号。
 */
function readAsarVersion(dir) {
  try {
    const fd = fs.openSync(path.join(dir, 'resources', 'app.asar'), 'r');
    try {
      const head = Buffer.alloc(16);
      if (fs.readSync(fd, head, 0, 16, 0) < 16) return null;
      const jsonLen = head.readUInt32LE(12);
      const dataBase = 8 + head.readUInt32LE(4);
      if (!jsonLen || jsonLen > 64 * 1024 * 1024) return null;

      const meta = JSON.parse(readAt(fd, 16, jsonLen).toString('utf8'));
      const entry = meta && meta.files && meta.files['package.json'];
      if (!entry || !entry.size) return null;

      const raw = readAt(fd, dataBase + Number(entry.offset), Number(entry.size));
      const want = entry.integrity && entry.integrity.hash;
      if (want && crypto.createHash('sha256').update(raw).digest('hex') !== want) {
        console.warn('[清单] ⚠ asar 里的 package.json 校验不过（偏移算错了？），改用 --from 指定版本号');
        return null;
      }
      return JSON.parse(raw.toString('utf8')).version || null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function readAt(fd, offset, len) {
  const buf = Buffer.alloc(len);
  let read = 0;
  while (read < len) {
    const n = fs.readSync(fd, buf, read, len - read, offset + read);
    if (!n) break;
    read += n;
  }
  if (read !== len) throw new Error(`asar 读取不完整: 需要 ${len} 实际 ${read}`);
  return buf;
}

/* ------------------------------------------------------------------ 收集文件 */
const warn = (kind, rel) => {
  if (kind === 'dir') console.log(`[清单] ⚠ 已排除运行时目录: ${rel}/（不进清单，避免把本机数据当程序文件）`);
};
const loadDir = (dir) => distWalk.walkDist(dir, '', warn)
  .map(f => ({ path: f.rel, data: fs.readFileSync(f.abs) }));

const newFiles = loadDir(NEW_DIR);
if (!newFiles.length) { console.error('[清单] 新版本目录里没有文件'); process.exit(1); }

/* ★ 硬校验：清单里一个运行时文件都不许有。
   独立再数一遍磁盘上真实存在的运行时文件，断言它们没被写进 files。
   （不能"从 files 反推"，那种断言永远为空。） */
const runtimeCount = distWalk.assertNoRuntimeLeak(NEW_DIR, newFiles.map(f => f.path), 'update.json');
if (runtimeCount) console.log(`[清单]    本机程序目录里有 ${runtimeCount} 个运行时文件，均已排除`);

const zipSize = fs.statSync(ZIP).size;
const zipSha = sha256File(ZIP);

const manifest = {
  schema: 1,
  app: pkg.productName || 'QuickLaunch',
  channel: 'green',
  version: VERSION,
  unpackedSize: newFiles.reduce((s, f) => s + f.data.length, 0),
  // 全量回退：直接下这个 zip，解包后按下面的 files 逐个校验
  full: { asset: path.basename(ZIP), size: zipSize, sha256: zipSha },
  // 目标版本的权威文件清单（全量下载靠它验签）
  files: newFiles.map(f => ({
    path: f.path,
    size: f.data.length,
    sha256: vcdiff.sha256hex(f.data),
  })),
  patches: [],
};

/* ------------------------------------------------------------------ 差量补丁 */
if (OLD_DIR) {
  if (!fs.existsSync(OLD_DIR)) { console.error(`[清单] 旧版本目录不存在: ${OLD_DIR}`); process.exit(1); }
  const oldFiles = loadDir(OLD_DIR);
  const fromVer = FROM_VER || readAsarVersion(OLD_DIR);
  if (!fromVer) {
    console.error('[清单] 读不出旧版本号（asar 头里没有 version），请显式传 --from <版本号>');
    process.exit(1);
  }

  const { manifest: plan, pack } = vcdiff.makeDirPatch(oldFiles, newFiles, {
    dropFile: (p) => String(p).split('/').some(s => distWalk.SKIP_TOP.has(s)),
  });
  const packName = `QuickLaunch-Delta-${fromVer}-to-${VERSION}.bin`;
  const outPath = path.join(OUT_DIR, packName);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, pack);

  const changed = plan.files.filter(f => f.action === 'patch');
  const same = plan.files.filter(f => f.action === 'same');
  const worthIt = vcdiff.shouldUseDelta(pack.length, zipSize, 0.6);

  manifest.patches.push({
    from: fromVer,
    asset: packName,
    size: pack.length,
    sha256: vcdiff.sha256hex(pack),
    // 占比超过阈值：客户端应当直接走全量。仍然把补丁留在清单里（可能对别的用户仍有价值），
    // 由客户端按 shouldUseDelta 自己判 —— 但这里必须**明确标注**，免得看日志的人以为它没用。
    recommended: worthIt ? 'delta' : 'full',
    plan,
  });

  console.log(`[清单] 差量 ${fromVer} → ${VERSION}`);
  console.log(`         未变文件 ${same.length} 个（客户端本地即可，零下载）`);
  console.log(`         需下载   ${mib(pack.length)}  (改动文件 ${changed.length} 个)`);
  console.log(`         全量 zip ${mib(zipSize)}`);
  console.log(`         占比 ${(pack.length / zipSize * 100).toFixed(3)}%  → 建议 ${worthIt ? '走增量' : '走全量（超过 60% 阈值）'}`);
  console.log(`         ${outPath}`);
} else {
  console.log('[清单] 没给 --old，只产出目标文件清单 + 全量信息（没有差量补丁）');
}

const outJson = path.join(OUT_DIR, 'update.json');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(outJson, JSON.stringify(manifest, null, 2) + '\n');

console.log(`[清单] ${outJson}`);
console.log(`         版本 ${VERSION} / 文件 ${manifest.files.length} 个 / 未压缩 ${mib(manifest.unpackedSize)}`);
console.log(`         全量: ${manifest.full.asset} ${mib(zipSize)} sha256=${zipSha.slice(0, 16)}…`);
console.log(`         补丁 ${manifest.patches.length} 条`);

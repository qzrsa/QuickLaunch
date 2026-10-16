#!/usr/bin/env node
'use strict';
/**
 * 差量引擎实测台（拿**真实的两份构建产物**跑，不看设计文档）。
 *
 *   node scripts/delta-bench.mjs --old <旧版本目录> --new <新版本目录> [--full <全量zip或exe，用来算占比>]
 *
 * 三件事必须一次说清：
 *   1. 差量包到底多大（对比全量），占比是多少；
 *   2. 打出来的文件**逐字节**等于新版本（不是"哈希对得上"就完事）；
 *   3. 坏输入必须**抛错**，绝不能打出一个半残的程序：
 *      - 补丁包被改一个字节 → 抛错
 *      - 本地基准文件被改过   → 抛错
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// vcdiff.js 是 CommonJS（要同时被主进程 require），这里用 createRequire 拿它，
// 免得把库本身也改成 ESM —— 主进程里 require 更省事。
const require = createRequire(import.meta.url);
const vcdiff = require('../src/lib/vcdiff.js');

const SKIP_DIRS = new Set(['data', '.probe-shot', '.tmpdata', 'node_modules']);
const dropFile = (p) => String(p).split('/').some(s => SKIP_DIRS.has(s));

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...walk(path.join(dir, e.name), rel));
    } else if (e.isFile()) {
      out.push({ path: rel, abs: path.join(dir, e.name) });
    }
  }
  return out;
}

const loadDir = (dir) => walk(dir).map(f => ({ path: f.path, data: fs.readFileSync(f.abs) }));

const mib = (n) => (n / 1048576).toFixed(2) + ' MiB';
const kib = (n) => (n / 1024).toFixed(1) + ' KiB';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

const oldDir = arg('old');
const newDir = arg('new');
const fullPath = arg('full');
if (!oldDir || !newDir) {
  console.error('用法：node scripts/delta-bench.mjs --old <旧版本目录> --new <新版本目录> [--full <全量文件>]');
  process.exit(2);
}

let pass = 0, fail = 0;
const check = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? ' → ' + extra : '')); }
};

console.log('差量实测台');
console.log('  旧版本目录:', oldDir);
console.log('  新版本目录:', newDir);
console.log('');

const t0 = Date.now();
const oldFiles = loadDir(oldDir);
const newFiles = loadDir(newDir);
const tLoad = Date.now() - t0;

console.log('--- 载入 ---');
console.log(`  旧 ${oldFiles.length} 个文件 / ${mib(oldFiles.reduce((s, f) => s + f.data.length, 0))}`);
console.log(`  新 ${newFiles.length} 个文件 / ${mib(newFiles.reduce((s, f) => s + f.data.length, 0))}`);
console.log(`  读盘耗时 ${tLoad} ms`);

const t1 = Date.now();
const { manifest, pack, stats } = vcdiff.makeDirPatch(oldFiles, newFiles, { dropFile });
const tPatch = Date.now() - t1;

const changed = manifest.files.filter(f => f.action === 'patch');
const same = manifest.files.filter(f => f.action === 'same');

console.log('');
console.log('--- 差量结果 ---');
console.log(`  未变文件 ${same.length} 个（客户端原样保留，不下载）`);
console.log(`  需处理文件 ${changed.length} 个：`);
for (const f of changed) {
  const dataLen = f.ops.filter(o => o[0] === 1).reduce((s, o) => s + o[3], 0);
  const copyLen = f.ops.filter(o => o[0] === 0).reduce((s, o) => s + o[3], 0);
  console.log(`      ${f.path}`);
  console.log(`         原文件 ${mib(f.size)}  →  COPY ${mib(copyLen)}（本地取） + DATA ${kib(dataLen)}（要下） | ${f.ops.length} 条指令`);
}
console.log(`  需删除 ${manifest.removed.length} 个: ${manifest.removed.slice(0, 5).join(', ') || '无'}`);
console.log(`  差量包大小 = ${mib(pack.length)}   (COPY ${mib(stats.copyBytes)} / DATA ${mib(stats.dataBytes)})`);
console.log(`  算补丁耗时 ${tPatch} ms`);

console.log('');
console.log('--- 断言：产物正确性 ---');
check(manifest.files.length === newFiles.length, '清单覆盖了全部新文件');
check(manifest.olds.length === oldFiles.length, '基准清单覆盖了全部旧文件');
check(same.length + changed.length === newFiles.length, '未变 + 需处理 = 全量文件数');

const localByPath = new Map(oldFiles.map(f => [f.path, f.data]));
const t2 = Date.now();
let produced = [];
let threw = null;
try { produced = vcdiff.applyDirPatch(localByPath, manifest, pack); } catch (e) { threw = e; }
const tApply = Date.now() - t2;
check(!threw, '正常补丁能应用', threw && threw.message);
// ★ 把"非空"并进同一条断言：产出为空时，下面那条"逐字节相等"会**空转变绿**，等于没测。
check(produced.length === changed.length && produced.length > 0,
  `产出文件数 = 需处理文件数且非空（${produced.length}/${changed.length}）`);

// ★ 逐字节比对，不是只信 applyDirPatch 内部的哈希校验
const newByPath = new Map(newFiles.map(f => [f.path, f.data]));
let byteDiff = 0, missing = 0;
for (const p of produced) {
  const want = newByPath.get(p.path);
  if (!want) { missing++; continue; }
  if (!want.equals(p.data)) byteDiff++;
}
check(missing === 0, '产出的文件路径都在新版本里', missing ? `缺 ${missing} 个` : '');
check(produced.length > 0 && byteDiff === 0, '产出的文件**逐字节**等于新版本',
  produced.length === 0 ? '产出为空，这条比对会空转，按失败处理' : (byteDiff ? `${byteDiff} 个不一致` : ''));
// 未变的文件必须真的和本地一致（否则客户端"原样保留"就保留了错的）
let sameBad = 0;
for (const f of same) {
  const local = localByPath.get(f.path) || newByPath.get(f.path);
  const want = newByPath.get(f.path);
  if (!local || !want || !local.equals(want)) sameBad++;
}
check(sameBad === 0, '标为"未变"的文件确实与本地逐字节一致', sameBad ? `${sameBad} 个对不上` : '');
console.log(`  应用补丁耗时 ${tApply} ms`);

console.log('');
console.log('--- 断言：坏输入必须抛错（否则会打出半残的程序）---');
const bad = Buffer.from(pack);
if (bad.length > 1024) bad[1024] ^= 0xff;
let e1 = null;
try { vcdiff.applyDirPatch(localByPath, manifest, bad); } catch (e) { e1 = e; }
check(!!e1, '补丁包被改一个字节 → 抛错', e1 && e1.message);

const tampered = new Map(localByPath);
const firstOld = manifest.olds[0];
const mut = Buffer.from(tampered.get(firstOld.path));
mut[0] ^= 0xff;
tampered.set(firstOld.path, mut);
let e2 = null;
try { vcdiff.applyDirPatch(tampered, manifest, pack); } catch (e) { e2 = e; }
check(!!e2, '本地基准文件被改过 → 抛错（会退回全量）', e2 && e2.message);

const shortMap = new Map(localByPath);
shortMap.delete(firstOld.path);
let e3 = null;
try { vcdiff.applyDirPatch(shortMap, manifest, pack); } catch (e) { e3 = e; }
check(!!e3, '本地缺基准文件 → 抛错', e3 && e3.message);

console.log('');
console.log('--- 值与不值 ---');
let fullSize = null;
if (fullPath && fs.existsSync(fullPath)) fullSize = fs.statSync(fullPath).size;
if (fullSize) {
  const ratio = pack.length / fullSize;
  console.log(`  全量 = ${mib(fullSize)}   差量包 = ${mib(pack.length)}   占比 ${(ratio * 100).toFixed(3)}%`);
  console.log(`  判定（阈值 60%）→ ${vcdiff.shouldUseDelta(pack.length, fullSize, 0.6) ? '走增量' : '走全量'}`);
  check(ratio < 0.6, '这一对版本走增量（差额低于阈值）', `占比 ${(ratio * 100).toFixed(1)}%`);
} else {
  console.log('  （没给 --full，跳过占比计算）');
}

console.log('');
console.log(`合计：通过 ${pass}${fail ? ` / \x1b[31m失败 ${fail}\x1b[0m` : ''}`);
process.exit(fail ? 1 : 0);

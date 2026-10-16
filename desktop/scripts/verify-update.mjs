#!/usr/bin/env node
/**
 * 自更新链路的**离线端到端**验证：把客户端真正要走的那条路完整跑一遍，
 * 但完全不联网、不启动 app、不动真实程序目录。
 *
 *   node scripts/verify-update.mjs \
 *        --manifest ../dist/update.json \
 *        --old   <旧版本目录>            # 假装是"本机现在的程序目录"
 *        [--bin  ../dist/QuickLaunch-Delta-x-to-y.bin]
 *        [--target <新版本目录>]         # 有的话就再跟真实目标目录逐字节对一遍
 *
 * 最关键的一条断言是第 ⑥ 步：
 *   **差量补丁产出的文件 + 本地未变的文件 = 完整的目标版本**，
 *   并且逐字节等于真实构建产物。只看"补丁能打上"是不够的 ——
 *   真正会出事的是"打上了但少了一个文件/多了一个旧文件"，那样用户拿到的是半残程序。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import * as distWalk from './lib/dist-walk.mjs';

const require = createRequire(import.meta.url);
const core = require('../src/lib/updater-core.js');

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const MANIFEST = arg('manifest');
const OLD = arg('old');
const BIN = arg('bin');
const TARGET = arg('target');
if (!MANIFEST || !OLD) {
  console.error('用法: node scripts/verify-update.mjs --manifest <update.json> --old <旧版本目录> [--bin <补丁>] [--target <新版本目录>]');
  process.exit(2);
}

let pass = 0, fail = 0;
const check = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? ' → ' + extra : '')); }
};
const mib = (n) => (n / 1048576).toFixed(2) + ' MiB';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const raw = (p) => fs.readFileSync(p);

/** 目录 -> [{path,size,sha256,data?}]（复用唯一那份"排除运行时目录"的实现） */
function scan(dir, withData = false) {
  return distWalk.walkDist(dir).map(f => {
    const data = withData ? fs.readFileSync(f.abs) : null;
    const buf = data || null;
    return {
      path: f.rel,
      size: fs.statSync(f.abs).size,
      sha256: buf ? sha256(buf) : sha256(fs.readFileSync(f.abs)),
      data: buf,
    };
  });
}
function treeOf(dir) {
  const m = new Map();
  for (const f of distWalk.walkDist(dir)) m.set(f.rel, fs.readFileSync(f.abs));
  return m;
}

const manifest = JSON.parse(raw(MANIFEST).toString('utf8'));
console.log('自更新链路离线验证');
console.log('  清单:', MANIFEST);
console.log('  本机:', OLD);
console.log('');

/* ① 清单形状 */
console.log('--- ① 清单 ---');
check(!!core.validManifest(manifest), '清单通过 validManifest 形状校验');
console.log('    ', core.summarize(manifest));
const patch = (manifest.patches || [])[0];
if (!patch) { console.error('清单里没有差量补丁，无法继续（这个验证器专门验差量路径）'); process.exit(1); }
const FROM = patch.from;
const binPath = BIN || path.join(path.dirname(MANIFEST), patch.asset);
check(fs.existsSync(binPath), `补丁文件存在: ${path.basename(binPath)}`);
check(fs.statSync(binPath).size === patch.size, `补丁大小与清单一致（${mib(patch.size)}）`);

/* ② 扫描"本机" */
console.log('');
console.log('--- ② 扫描本机程序目录 ---');
const localFiles = scan(OLD, true);
console.log(`    ${localFiles.length} 个文件 / ${mib(localFiles.reduce((s, f) => s + f.size, 0))}`);
const protectedCount = distWalk.runtimeFilesOnDisk(OLD).length;
if (protectedCount) console.log(`    本机另有 ${protectedCount} 个运行时文件（data/ 等），已排除在更新范围之外`);

/* ③ 选方案 */
console.log('');
console.log('--- ③ 方案选择 ---');
const plan = core.selectPlan(manifest, FROM, localFiles);
check(plan.mode === 'delta', `本机版本 ${FROM} → 判定走增量`, `mode=${plan.mode} 原因=${plan.reason}`);
check(plan.mode === 'delta' && plan.patch.from === FROM, '选中的补丁就是本机版本对应的那条');

/* ④ 负向：本地被改过就必须退回全量 */
console.log('');
console.log('--- ④ 负向：坏输入必须退回全量（而不是硬打补丁）---');
{
  const t = localFiles.map(f => ({ ...f }));
  const victim = t.find(f => f.sha256 === patch.plan.olds[0].sha256);
  victim.sha256 = sha256(Buffer.from('tampered'));
  const p2 = core.selectPlan(manifest, FROM, t);
  check(p2.mode === 'full', '某个本地文件哈希对不上 → 退回全量', `mode=${p2.mode}`);
}
{
  const p3 = core.selectPlan(manifest, '9.9.9', localFiles);
  check(p3.mode === 'full', '本机版本没有对应差量 → 退回全量', `mode=${p3.mode}`);
}
{
  const p4 = core.selectPlan(manifest, FROM, localFiles.filter(f => f.path !== patch.plan.olds[0].path));
  check(p4.mode === 'full', '本机少了一个基准文件 → 退回全量', `mode=${p4.mode}`);
}
{
  const big = JSON.parse(JSON.stringify(manifest));
  big.patches[0].size = big.full.size * 0.9;         // 差量比全量还大
  check(core.selectPlan(big, FROM, localFiles).mode === 'full', '差量占全量 90% → 退回全量（超过 60% 阈值）');
}

/* ⑤ 应用补丁 */
console.log('');
console.log('--- ⑤ 应用差量补丁 ---');
const pack = raw(binPath);
check(sha256(pack) === patch.sha256, '补丁包 sha256 与清单一致');
const localByPath = new Map(localFiles.map(f => [f.path, f.data]));
let produced = null, err = null;
try { produced = core.applyDelta(manifest, patch, pack, localByPath); } catch (e) { err = e; }
check(!err, '补丁应用成功', err && err.message);
check(!!produced && produced.length > 0, `产出了 ${produced ? produced.length : 0} 个文件（非空，否则后面的比对是空转）`);
check(sha256(pack) !== '0'.repeat(64) && (() => {
  const bad = Buffer.from(pack); bad[0] ^= 0xff;
  try { core.applyDelta(manifest, patch, bad, localByPath); return false; } catch { return true; }
})(), '补丁被改一个字节 → 抛错（绝不产出半残结果）');

/* ⑥ 关键：补丁产出 + 本地未变文件 = 完整目标版本 */
console.log('');
console.log('--- ⑥ 差量 + 本地未变文件 = 完整目标版本 ---');
const merged = new Map(localByPath);
for (const f of produced || []) merged.set(f.path, f.data);
// 删掉新版本已经移除的文件（受保护路径不会被列进来，见 removalList）
const rem = core.removalList(patch);
for (const p of rem.paths) merged.delete(p);
console.log(`    合并后 ${merged.size} 个文件；清单声明目标 ${manifest.files.length} 个`);
if (rem.skipped.length) console.log(`    ⚠ 有 ${rem.skipped.length} 个受保护路径被拒绝删除: ${rem.skipped.join(', ')}`);

const mergedFiles = [...merged].map(([p, d]) => ({ path: p, size: d.length, sha256: sha256(d) }));
const vr = core.verifyDir(manifest, mergedFiles);
check(vr.ok, '合并出的目录**逐文件**通过目标清单校验',
  vr.ok ? `校验 ${vr.checked} 个文件` : `缺 ${vr.missing.length} / 不一致 ${vr.differ.length}`);
check(vr.extra.length === 0, '合并结果没有多余文件', vr.extra.length ? vr.extra.slice(0, 3).join(', ') : '');

/* ⑦ 有真实目标目录的话，逐字节对一遍 */
console.log('');
console.log('--- ⑦ 与真实构建产物逐字节比对 ---');
if (!TARGET) {
  console.log('    （没给 --target，跳过）');
} else {
  const target = treeOf(TARGET);
  check(merged.size === target.size, `文件数一致（${merged.size} vs ${target.size}）`);
  let diff = 0, miss = 0;
  for (const [p, want] of target) {
    const got = merged.get(p);
    if (!got) { miss++; continue; }
    if (!got.equals(want)) diff++;
  }
  check(miss === 0, '目标版本里的每个文件都在合并结果里', miss ? `缺 ${miss}` : '');
  check(diff === 0, '内容逐字节一致', diff ? `${diff} 个不一致` : '');
  const tf = [...target].map(([p, d]) => ({ path: p, size: d.length, sha256: sha256(d) }));
  check(core.verifyDir(manifest, tf).ok, '真实目标目录也通过清单校验（清单与构建产物是自洽的）');
}

/* ⑧ 受保护路径：更新器绝不许碰 data/ */
console.log('');
console.log('--- ⑧ 受保护路径（运行时数据）---');
{
  const bad = JSON.parse(JSON.stringify(patch));
  bad.plan.files.push({ path: 'data/config.json', size: 10, sha256: 'x', action: 'patch', ops: [[1, 0, 0, 10]] });
  let e = null;
  try { core.applyDelta(manifest, bad, pack, localByPath); } catch (x) { e = x; }
  check(!!e, '差量清单里出现 data/ 下的文件 → 直接抛错拒做');
}
{
  const bad = JSON.parse(JSON.stringify(patch));
  bad.plan.removed = ['data/config.json', 'resources/old.txt'];
  const r = core.removalList(bad);
  check(r.paths.length === 1 && r.paths[0] === 'resources/old.txt', '待删列表里只保留非受保护路径');
  check(r.skipped.length === 1 && r.skipped[0] === 'data/config.json', 'data/ 被放进 skipped 只报告、绝不删');
}
check(core.removalList({ plan: { removed: [] } }).paths.length === 0, '没有要删的文件时返回空列表');

console.log('');
console.log(`合计：通过 ${pass}${fail ? ` / \x1b[31m失败 ${fail}\x1b[0m` : ''}`);
process.exit(fail ? 1 : 0);

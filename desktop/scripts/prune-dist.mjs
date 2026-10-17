#!/usr/bin/env node
/**
 * 构建后清理：dist\ 里只留**当前版本**的产物，旧版本全删（用户原话：
 * 「每次编译完之后删掉之前的版本 只保留最新版」）。
 *
 * 核心规则在 scripts/lib/prune-dist.mjs（smoke 直接测它）：只删认识得出来的
 * QuickLaunch 产物名 + 版本号不匹配的 update.json；目录和不认识的文件绝不碰。
 *
 * 用法：
 *   node scripts/prune-dist.mjs                       # 清 <仓库根>/dist（npm run dist 末尾自动跑）
 *   node scripts/prune-dist.mjs --dist <目录>         # 清指定目录（测试 / 手动用）
 *   node scripts/prune-dist.mjs --dist <目录> --version 1.2.1
 *                                                     # 指定"当前版本"（测试用，默认取 package.json）
 *
 * ★ 为什么要有 --version：不显式给的话，CLI 读的是**真实** package.json 的版本。
 *   测试夹具里的产物名是写死的版本号，一旦升版本，夹具里的"当前版"就成了 CLI 眼里的"旧版"，
 *   于是被一起删掉 → 两条断言莫名其妙变红（只靠升版本号就能复现，与本次改动无关）。
 *   给测试一个显式的 --version，就把测试与"仓库当前版本"彻底解耦。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneDist, fmtSize } from './lib/prune-dist.mjs';

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// dist 在仓库根（desktop 的上一级）；从脚本位置推导，不依赖调用时的 cwd
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const distDir = path.resolve(arg('--dist') || DIST);
// 当前版本：默认取 package.json；测试用 --version 显式指定，与仓库版本解耦
const version = arg('--version') || PKG.version;

if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
  console.log(`[清理] 目录不存在（${distDir}），没东西可清`);
  process.exit(0);
}

console.log(`[清理] dist 只留 v${version} 的产物（${distDir}）：`);
const { removed, kept, failed, freed } = pruneDist({
  distDir, version, fsMod: fs, log: console.log,
});

if (!removed.length) {
  console.log('[清理] 没有旧版本产物，无需删除');
} else {
  const total = removed.reduce((n, r) => n + r.size, 0);
  console.log(`[清理] 已删 ${removed.length} 个旧产物，释放 ${fmtSize(freed)}`
    + `（按文件合计 ${fmtSize(total)}）；保留 ${kept.length} 项（当前版本产物 + 不认识的文件/目录）`);
}
// ★ 有删失败的必须吼出来 + 非零退出：绝不能"删了一半还报成功"（静默跳过是项目大忌）。
if (failed.length) {
  console.error(`[清理] ★ ${failed.length} 个文件删除失败（已删的 ${removed.length} 个不受影响）：`);
  failed.forEach(f => console.error(`  - ${f.name}: ${f.reason}`));
  process.exit(1);
}
process.exit(0);

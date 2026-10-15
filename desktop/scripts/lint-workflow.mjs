#!/usr/bin/env node
/**
 * 工作流自检（防回归）。故意**扫原始文本**而不是解析 YAML —— 两个原因：
 *   1. `on:` 在 YAML 1.1 里会被解析成布尔 `true`，想检查触发配置只能看原文；
 *   2. js-yaml 只是 electron-builder 的传递依赖，没在 package.json 里声明，
 *      在 CI 上靠它等于埋雷。
 *
 * 覆盖的都是本项目实际踩过 / 技能里记录过的坑：
 *   - `..` 出现在 action 的 path 里 → @actions/glob 的 fixupPattern 直接断言失败
 *   - 资产名含空格 → GitHub 会把 Release 资产名的空格换成点，从 action 侧治不了
 *   - CI 下 electron-builder 隐式发布 → 必须带 `--publish never`
 *   - 干净机器上 electron 的 postinstall 被门控跳过 → 必须补齐 electronDist
 *   - `branches` 和 `tags` 写在两个 `push:` 键下 → 后者静默覆盖前者
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF = path.resolve(HERE, '..', '..', '.github', 'workflows', 'build.yml');

const src = fs.readFileSync(WF, 'utf8');
const lines = src.split(/\r?\n/);

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name); }
};

console.log('工作流自检 ·', WF.replace(/\\/g, '/'));
console.log('--- 触发配置 ---');

// ---- `on:` 下只能有一个 `push:`，且 branches / tags 必须在同一个下面 ----
const onIdx = lines.findIndex(l => /^on:\s*$/.test(l));
ok(onIdx >= 0, '存在 on: 顶层键');
const topKeys = lines.filter(l => /^[a-zA-Z_][\w-]*:/.test(l)).map(l => l.replace(/:.*/, ''));
ok(topKeys.filter(k => k === 'push').length === 0, 'on: 下 push 不是顶层键（缩进正确）');

// 从 on: 往后扫，收集 push: 的出现次数（缩进 2 空格）
const onBlock = [];
for (let i = onIdx + 1; i < lines.length; i++) {
  const l = lines[i];
  if (/^\S/.test(l) && l.trim()) break;      // 回到顶层键，on 块结束
  onBlock.push(l);
}
const pushCount = onBlock.filter(l => /^\s{2}push:\s*$/.test(l)).length;
ok(pushCount === 1, `on: 下只有一个 push: 键（实际 ${pushCount}）`);
ok(onBlock.some(l => /^\s{4}branches:\s*\[.*main.*\]/.test(l)), 'push 下有 branches: [main]');
ok(onBlock.some(l => /^\s{4}tags:\s*\[.*v\*.*\]/.test(l)), 'push 下有 tags: [v*]');
ok(onBlock.some(l => /^\s{2}workflow_dispatch:/.test(l)), 'on: 下有 workflow_dispatch');
if (fail === 0) console.log('    （branches 与 tags 同属一个 push，不会被覆盖）');

console.log('--- 关键项 ---');
ok(/^permissions:\s*$/m.test(src), '声明了 permissions');
ok(/^\s+contents:\s*write\b/m.test(src), 'permissions.contents: write（发 Release 需要）');
ok(src.includes('--publish never'), 'electron-builder 带 --publish never（挡掉 CI 隐式发布）');
ok(src.includes('test -f node_modules/electron/dist/electron.exe'),
  '有 electronDist 兜底断言（test -f ... || ::error::）');
ok(src.includes('cygpath -w -a'), 'RELEASE_DIR 用 cygpath -w -a 求');
ok(src.includes('RELEASE_DIR 仍含 ..'), '有「含 .. 就 ::error::」守卫');

console.log('--- action 版本 ---');
const wantVer = [
  ['actions/checkout@v5', true],
  ['actions/setup-node@v5', true],
  ['actions/upload-artifact@v4', true],
  ['softprops/action-gh-release@v3', true],
  ['softprops/action-gh-release@v2', false],
  ['actions/upload-artifact@v3', false],
  ['actions/checkout@v3', false],
  ['actions/checkout@v4', false],
  ['actions/setup-node@v4', false],
];
for (const [s, want] of wantVer) {
  const has = src.includes(s);
  ok(has === want, `${want ? '使用' : '不使用'} ${s}`);
}

console.log('--- path / files 不含 .. ---');
// 收集所有 `path:` / `files:` 块（含续行）里的内容
const badPaths = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s*(path|files):\s*(.*)$/);
  if (!m) continue;
  const inline = m[2].trim();
  const vals = inline && inline !== '|' && inline !== '>' ? [inline] : [];
  if (!vals.length) {
    for (let j = i + 1; j < lines.length; j++) {
      const v = lines[j];
      if (!/^\s{6,}\S/.test(v)) break;
      vals.push(v.trim());
    }
  }
  for (const v of vals) {
    if (v.includes('..')) badPaths.push(`${m[1]}: ${v}`);
  }
}
ok(badPaths.length === 0, `action 的 path/files 均不含 .. ${badPaths.length ? '→ ' + badPaths.join(' | ') : ''}`);

console.log('--- 资产名不含空格 ---');
const assetNames = [...src.matchAll(/QuickLaunch-(Setup|Portable|Green)-[^"'\s]*?\.(exe|zip)/g)].map(m => m[0]);
ok(assetNames.length >= 3, `抓到 ${assetNames.length} 处资产名`);
ok(assetNames.every(n => !n.includes(' ')), '资产名均不含空格（Release 资产名不会被 GitHub 改点）');

console.log('--- Release 步骤 ---');
ok(/if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(src), 'Release 仅在 tag 上触发');
const relIdx = src.indexOf('softprops/action-gh-release');
const relBlock = src.slice(relIdx);
ok(relBlock.includes('GITHUB_TOKEN'), 'Release 步骤带 GITHUB_TOKEN');

console.log('');
console.log(`结果：通过 ${pass}${fail ? ` / \x1b[31m失败 ${fail}\x1b[0m` : ''}`);
process.exit(fail ? 1 : 0);

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
 *   - CI 误把单文件便携版重新加回构建 → 构建了却不发布的静默不一致
 *   - 浅克隆下 tag 对象不在本地 → 发布说明静默变成空白（每一环都会安静退化）
 *   - run 块里的 shell 语法错误 → 只在 push 之后才由 CI 报错，白烧一个来回
 */
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
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
// 退出后助手（PowerShell 换文件）必须在 CI 里真跑一遍：它唯一会出事的方式就是
// "悄悄没生效 / 悄悄删了 data/"，只做语法检查是发现不了的。
ok(/npm run check[\s\S]{0,200}npm run test[\s\S]{0,300}npm run verify:apply/.test(src),
  'CI 静态自检里跑 verify:apply（真跑退出后助手，不是只 node --check）');

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
ok(assetNames.length === 2, `抓到 ${assetNames.length} 处资产名（CI 只出安装版 + 绿色版）`);
ok(assetNames.every(n => !n.includes(' ')), '资产名均不含空格（Release 资产名不会被 GitHub 改点）');

console.log('--- CI 不含便携版（用户要求：单文件版只在本地构建）---');
// ★ 这里刻意数**出现次数**而不是 `!includes(...)`：反向守卫本身就得写出
//   `QuickLaunch-Portable-*` 这个 glob，`!includes` 会被自己的守卫判红。
const portMentions = [...src.matchAll(/QuickLaunch-Portable-/g)].length;
ok(portMentions === 1, `QuickLaunch-Portable- 全篇只出现 1 次（就是那条反向守卫；实际 ${portMentions}）`);
ok(!/env\.PORTABLE/.test(src), '工作流里不再引用 env.PORTABLE');
ok(!/^\s*PORTABLE=/m.test(src), '不再声明 PORTABLE 变量');
// 打包命令必须恰好是 `--win nsis dir`（也不许漏掉 dir —— 绿色版 zip 靠它）
const winLines = lines.filter(l => /electron-builder\s+--win\b/.test(l));
ok(winLines.length === 1 && /--win\s+nsis\s+dir\s+--x64/.test(winLines[0] || ''),
  `打包命令是 --win nsis dir --x64（实际 ${winLines.length} 条：${(winLines[0] || '').trim() || '无'}）`);
ok(src.includes('QuickLaunch-Portable-*'), '有「CI 不该产出便携版」的反向守卫（发现即 ::error:: 退出）');

// 上传 / 发布各只应有 SETUP + GREEN 两行
const countEnv = (block, name) => (block.match(new RegExp(`env\\.${name}`, 'g')) || []).length;
const relIdx = src.indexOf('softprops/action-gh-release');
const uploadBlock = src.slice(src.indexOf('upload-artifact@v4'), relIdx);
const relBlock = src.slice(relIdx);
for (const [label, blk] of [['upload-artifact', uploadBlock], ['Release', relBlock]]) {
  ok(countEnv(blk, 'SETUP') === 1 && countEnv(blk, 'GREEN') === 1,
    `${label} 的资产列表恰好是 SETUP + GREEN 两行（SETUP=${countEnv(blk, 'SETUP')} GREEN=${countEnv(blk, 'GREEN')}）`);
}

console.log('--- Release 步骤 ---');
ok(/if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(src), 'Release 仅在 tag 上触发');
ok(relBlock.includes('GITHUB_TOKEN'), 'Release 步骤带 GITHUB_TOKEN');

// ---- 发布说明来自 annotated tag 的 message ----
// 之前 Release 页面上只有一行自动生成的 compare 链接（action 没给 body）。现在的链条是：
//   tag message →（浅克隆补取）→ git tag -l --format='%(contents)' → $GITHUB_ENV → body:
// 每一环都能安静地退化，所以每一环都得断言住。
console.log('--- 发布说明来自 tag message ---');
const notesIdx = src.indexOf('取 tag 里的发布说明');
ok(notesIdx > 0 && notesIdx < relIdx, '取说明的步骤排在 Release 步骤之前');
ok(/git fetch --depth=1 --no-tags origin/.test(src),
  '浅克隆下显式补取 tag 对象（fetch-depth:1 默认不带 tag，取不到就静默没有说明）');
ok(/git tag -l --format='%\(contents\)'/.test(src) && /git tag -l --format='%\(contents:subject\)'/.test(src),
  '用 %(contents) 取完整 message、%(contents:subject) 取标题');
ok(/RELEASE_NOTES<<\$DELIM/.test(src) && /DELIM="QL_NOTES_\$\{TAG\}_\$\$_\$\(date \+%s\)"/.test(src),
  '写进 GITHUB_ENV 用**随机** heredoc 分隔符（说明里出现同名列时会被提前截断）');
ok(/cat-file -t "refs\/tags\//.test(src) && /::warning::.*取不到 message/.test(src),
  '取不到说明时只 ::warning:: 不失败，并在告警里带上本地 tag 类型（好定位是补取失败还是轻量 tag）');
ok(relBlock.includes('body: ${{ env.RELEASE_NOTES }}'), 'Release 步骤把 RELEASE_NOTES 当 body');
ok(relBlock.includes('name: ${{ env.RELEASE_TITLE }}'), 'Release 步骤把 RELEASE_TITLE 当标题');
// generate_release_notes 与 body 是**拼接**关系（v3 源码里 body + "\n\n" + notes），
// 关掉它就等于用自己写的说明换掉 GitHub 的提交列表 —— 那是降级，不是优化。
ok(relBlock.includes('generate_release_notes: true'),
  '保留 generate_release_notes（说明是前置拼接，不是替换掉自动变更列表）');
// 说明步骤与 Release 步骤必须同样只在 tag 上跑：否则推 main 时会去 fetch tag、还会写 env
const tagGateCount = [...src.matchAll(/if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/g)].length;
ok(tagGateCount === 3, `取说明、生成清单、发布这三步都只在 tag 上跑（实际 ${tagGateCount} 处）`);

// ---- 更新元数据：update.json + 差量包 ----
// 客户端默认从 `<更新源>/update.json` 取清单，而默认更新源是 releases/latest/download ——
// 所以清单必须作为**同名 Release 资产**发出去。它不是资产，客户端就永远只看到 404。
console.log('--- 更新元数据（update.json / 差量包）---');
const mfIdx = src.indexOf('生成更新清单');
ok(mfIdx > 0, '有「生成更新清单」这一步');
ok(mfIdx > 0 && mfIdx < relIdx, '生成清单排在 Release 之前（资产得先生成出来）');
ok(mfIdx > 0 && /if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(src.slice(mfIdx - 300, mfIdx + 300)),
  '清单步骤只在 tag 上跑（推 main 不产出、也不发资产）');
ok(relBlock.includes('update.json'), 'Release 资产里有 update.json（客户端默认就取这个文件名）');
ok(relBlock.includes('QuickLaunch-Delta-*.bin'),
  'Release 资产里有差量包（名字带版本号，只能 glob；匹配不到时 action 跳过，正好对上降级路径）');
ok(/scripts\/unpack-green\.mjs/.test(src) && /scripts\/make-update-manifest\.mjs/.test(src),
  '解包与生成清单都走现成脚本，没有在 YAML 里另写一份解压/哈希');
ok(/--old\s+"\$TMP\/old"\s+--from\s+"\$FROM"/.test(src),
  '上一個版本的目录与版本号一起传给清单脚本（差量基准）');
// 降级路径必须存在且只告警：一次网络抖动不该把整个 Release 卡死
ok(/::warning::[^\n]*不含差量/.test(src),
  '拿不到差量基准只 ::warning:: 不失败（降级成"只有全量"的清单）');
// 清单自己也要过一道：混进 data/ 就等于把用户私人配置当程序文件发出去
ok(/混进了运行时文件/.test(src), '清单生成后自查有没有混进运行时目录（data/ 等）');
ok(/清单引用的差量包不在 dist 里/.test(src), '自查清单引用的差量包真的在 dist 里（否则客户端下载必然 404）');

// ---- 每个 run 块都必须是合法 bash ----
// 走 stdin（`bash -n` 不带文件名就读 stdin），不落临时文件、不依赖 YAML 解析。
// 这一步纯粹为了"别把 shell 语法错误留到 push 之后才由 CI 报"。
console.log('--- run 块是合法 bash（语法）---');
const hasBash = cp.spawnSync('bash', ['-c', 'true']).status === 0;
if (!hasBash) {
  // 显式跳过、且**不计入通过**：没 bash 就没法验，但绝不能假装验过了。
  console.log('  \x1b[33m⚠\x1b[0m 跳过：本机没有可用的 bash，未校验 run 块语法（不计入通过）');
} else {
  const blocks = [];
  const nonScript = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)run:[ \t]*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const inline = m[2].trim();
    if (inline && !/^[|>]/.test(inline)) { blocks.push({ line: i + 1, src: inline }); continue; }
    const body = [];
    let base = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) { body.push(''); continue; }
      const ind = l.match(/^\s*/)[0].length;
      if (ind <= indent) break;
      if (base === null) base = ind;
      body.push(l.slice(Math.min(base, ind)));
    }
    // `defaults: { run: { working-directory: … } }` 也是 `run:`，但值是 YAML 映射而不是脚本
    // （首行形如 `key: 值`）→ 跳过，别把它当成一段"语法永远合法"的假 block 充数。
    const firstSrc = (body.find(l => l.trim()) || '').trim();
    if (!inline && /^[A-Za-z_][\w-]*:(\s|$)/.test(firstSrc)) {
      nonScript.push(i + 1);
      continue;
    }
    blocks.push({ line: i + 1, src: body.join('\n') });
  }
  if (nonScript.length) {
    console.log(`    （第 ${nonScript.join('、')} 行的 run: 是 YAML 映射（如 defaults.run），非脚本，已跳过）`);
  }
  for (const b of blocks) {
    const r = cp.spawnSync('bash', ['-n'], { input: b.src, encoding: 'utf8' });
    const firstErr = String(r.stderr || '').trim().split('\n')[0];
    ok(r.status === 0, `run 块（第 ${b.line} 行）bash -n 通过${r.status === 0 ? '' : ' → ' + firstErr}`);
  }
}

console.log('');
console.log(`结果：通过 ${pass}${fail ? ` / \x1b[31m失败 ${fail}\x1b[0m` : ''}`);
process.exit(fail ? 1 : 0);

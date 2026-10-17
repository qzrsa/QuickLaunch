#!/usr/bin/env node
/**
 * 「退出后助手」的**真实执行**验证（不是读源码猜，而是真的起 PowerShell 去换文件）。
 *
 * 被验对象：`src/lib/updater-apply.js` 拼出来的那段脚本 + `updater.js` 写下的 apply.json 格式。
 * 为什么一定要真跑：这段脚本的整个存在意义就是"在主进程退出后才动手"，任何静态断言都
 * 证不了它真的等了、真的原子换了、真的没碰 data/。而这些恰好是唯一会造成
 * **用户数据丢失 / 装出半残程序**的地方。
 *
 * 每个用例都在临时目录里造假程序目录跑，**绝不碰真实安装目录**。
 *
 *   node scripts/verify-apply.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const applyLib = require('../src/lib/updater-apply.js');
const { PROTECTED_TOP } = require('../src/lib/datadir.js');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ROOT = path.join(os.tmpdir(), 'ql-apply-verify-' + process.pid);

let pass = 0, fail = 0;
const check = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? ' → ' + extra : '')); }
};

/* ---------------------------------------------------------- PowerShell 可用性 */
// ★ 用绝对路径：本文件的用例会把它注入到 cmd 命令行里，不指望 PATH。
const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
if (!fs.existsSync(PS_EXE) || cp.spawnSync(PS_EXE, ['-NoProfile', '-Command', 'exit 0']).status !== 0) {
  console.log('\x1b[33m⚠\x1b[0m 本机没有可用的 powershell.exe，未验证（**不计入通过**）');
  process.exit(2);
}

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

/* ---------------------------------------------------------- 造场景 */
function mkfile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return { size: Buffer.byteLength(content), sha256: sha(Buffer.from(content)) };
}
function read(p) { return fs.readFileSync(p, 'utf8'); }
function exists(p) { return fs.existsSync(p); }

/** 一个假的「程序目录」：含诱饵 data/config.json、一个该被删掉的旧文件、一个上次残留的 .ql-new */
function makeProgram(name) {
  const prog = path.join(ROOT, name);
  mkfile(path.join(prog, 'QuickLaunch.exe'), 'OLD-EXE-'.repeat(500));
  mkfile(path.join(prog, 'resources', 'app.asar'), 'OLD-ASAR-'.repeat(500));
  mkfile(path.join(prog, 'resources', 'icon.ico'), 'OLD-ICON');
  mkfile(path.join(prog, 'data', 'config.json'), '{"secret":"用户的私人配置"}');   // 诱饵
  mkfile(path.join(prog, '.probe-shot', 'shot.png'), 'PROBE');                      // 诱饵
  mkfile(path.join(prog, 'obsolete.txt'), 'OLD-FILE');
  // ★ 诱饵要埋成**会被用到的那个临时名**：如果更新前 `<exe>.ql-new` 已经存在，
  //   Copy-Item -Force 必须照样能盖掉它 —— 埋个无关的 .ql-new 是验不出东西的。
  mkfile(path.join(prog, 'QuickLaunch.exe.ql-new'), 'GARBAGE');
  return prog;
}

/** 摆好 stage 目录 + apply.json；files 是 {rel: content} */
function prepare(prog, version, files, deletes, opts = {}) {
  const stage = path.join(prog, '.update', version);
  const writes = [];
  for (const [rel, content] of Object.entries(files)) {
    const m = mkfile(path.join(stage, 'files', ...rel.split('/')), content);
    writes.push({ path: rel, size: m.size, sha256: m.sha256 });
  }
  const plan = {
    schema: 1, app: 'QuickLaunch', from: '1.0.0', to: version,
    programDir: prog, stageDir: stage, exe: opts.exe || '', restart: !!opts.restart,
    mode: opts.mode || 'delta',
    protectedTop: opts.protectedTop || PROTECTED_TOP.slice(),
    writes, deletes: deletes.slice(),
  };
  mkfile(path.join(stage, 'apply.json'), JSON.stringify(plan, null, 2) + '\n');
  mkfile(path.join(prog, '.update', 'state.json'), JSON.stringify({ state: 'staged', to: version }) + '\n');
  return { stage, plan };
}

/** 跑助手；pid 用真实存在的数字（见各用例） */
function runHelper(plan, pid, waitSeconds = 60) {
  // 和主进程完全一样的交接方式：脚本落成 apply.ps1（带 BOM），由 cmd 起 PowerShell -File。
  // ★ 走这套而不是 spawnSync powershell 直接跑，是为了让这里验的就是生产链路。
  const scriptPath = path.join(plan.stageDir, applyLib.HELPER_FILE);
  const logPath = path.join(plan.stageDir, 'apply.log');
  const script = applyLib.buildApplyScript(plan, { pid, waitSeconds, logPath });
  fs.writeFileSync(scriptPath, applyLib.scriptFileText(script), 'utf8');
  const line = applyLib.launcherCommandLine(PS_EXE, scriptPath);
  const t0 = Date.now();
  const r = cp.spawnSync('cmd.exe', [line], { encoding: 'utf8', windowsVerbatimArguments: true });
  return { code: r.status, elapsed: Date.now() - t0, stderr: String(r.stderr || '') };
}

const readState = (prog) => {
  const p = path.join(prog, '.update', 'state.json');
  if (!exists(p)) return null;
  // ★ 顺手验 BOM：PowerShell 5.1 的 -Encoding utf8 会加 BOM，而 Node 的 JSON.parse 会炸
  const raw = fs.readFileSync(p, 'utf8');
  try { return JSON.parse(raw); } catch { return { __parseError: raw.slice(0, 12) }; }
};
const qlNewLeftovers = (prog) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ql-new')) out.push(p);
    }
  };
  walk(prog);
  return out;
};

/** 一个"已经死掉"的 pid：起一个进程等它退出，那个 pid 就是确定不存在的 */
function deadPid() {
  const r = cp.spawnSync(process.execPath, ['-e', '0']);
  return r.pid || 999999;
}

/* ============================================================ ① 正向 */
console.log('\n--- ① 正向：真的把文件换掉，且不碰 data/ ---');
const P1 = makeProgram('ok');
{
  const { plan } = prepare(P1, '9.9.9',
    { 'QuickLaunch.exe': 'NEW-EXE-'.repeat(500), 'resources/app.asar': 'NEW-ASAR-'.repeat(500), 'locales/zh-CN.pak': 'NEW-PAK' },
    ['obsolete.txt']);
  const r = runHelper(plan, deadPid());
  check(r.code === 0, '助手退出码 0', `code=${r.code}`);
  // PowerShell 会把 stderr 序列化成 CLIXML。这里明确断言"没有错误记录"，
  // 而不是想当然地把 stderr 当噪音忽略掉 —— 否则真出错时也会被当成噪音。
  check(!/<S S="Error"/.test(r.stderr) && !/FullyQualifiedErrorId/.test(r.stderr),
    'stderr 里没有 PowerShell 错误记录',
    r.stderr.trim() ? r.stderr.trim().replace(/\s+/g, ' ').slice(0, 160) : '');
  check(read(path.join(P1, 'QuickLaunch.exe')) === 'NEW-EXE-'.repeat(500), 'exe 内容已换成新版');
  check(read(path.join(P1, 'resources', 'app.asar')) === 'NEW-ASAR-'.repeat(500), 'app.asar 内容已换成新版');
  check(read(path.join(P1, 'locales', 'zh-CN.pak')) === 'NEW-PAK', '新增的子目录与文件被建出来了');
  check(!exists(path.join(P1, 'obsolete.txt')), '该删的旧文件被删掉');
  check(read(path.join(P1, 'data', 'config.json')) === '{"secret":"用户的私人配置"}', '★ data/config.json 一字未动');
  check(read(path.join(P1, '.probe-shot', 'shot.png')) === 'PROBE', '★ .probe-shot 一字未动');
  check(!exists(path.join(P1, '.update', '9.9.9')), '暂存目录已被清理');
  check(exists(path.join(P1, '.update', 'apply-9.9.9.log')), '日志被留在 .update/ 下（暂存删了也不丢线索）');
  const st = readState(P1);
  check(st && st.state === 'applied', 'state.json = applied', JSON.stringify(st));
  check(st && !st.__parseError, 'state.json 能被 JSON.parse（没有 BOM）', st && st.__parseError ? st.__parseError : '');
  check(qlNewLeftovers(P1).length === 0, '没有 .ql-new 残留（连更新前就存在的那份也被消费掉了）',
    qlNewLeftovers(P1).map(p => path.basename(p)).join(','));
}

/* ============================================================ ② 受保护路径 */
console.log('\n--- ② 负向：计划里出现受保护路径，必须拒绝 ---');
const P2 = makeProgram('guard');
{
  // ★ 关键：暂存内容与哈希**都是对的**，唯一的拒绝理由只能是受保护路径守卫。
  //   否则这条断言会因为"哈希不符"而变绿 —— 那就验错东西了。
  const { plan } = prepare(P2, '9.9.9', { 'data/config.json': 'EVIL', 'QuickLaunch.exe': 'NEW-EXE' }, []);
  const r = runHelper(plan, deadPid());
  check(r.code === 4, '助手以 4 退出（受保护路径被拒）', `code=${r.code}`);
  check(read(path.join(P2, 'data', 'config.json')) === '{"secret":"用户的私人配置"}', '★ 诱饵配置未被覆盖');
  check(read(path.join(P2, 'QuickLaunch.exe')) === 'OLD-EXE-'.repeat(500), '同批次里的合法文件也一并未动（要么全做要么全不做）');
  check(qlNewLeftovers(P2).length === 0, '失败后没有 .ql-new 残留');
  const st = readState(P2);
  check(st && st.state === 'failed', 'state.json = failed', JSON.stringify(st));
  check(!!(st && st.note && st.note.includes('受保护')), '失败原因写明了"受保护"', st && st.note);
}
{
  const { plan } = prepare(P2, '9.9.8', { 'data/../data/x.txt': 'EVIL' }, []);
  const r = runHelper(plan, deadPid());
  check(r.code === 4, 'data/../data 这种写法也被拒（.. 先被拦）', `code=${r.code}`);
}
{
  const { plan } = prepare(P2, '9.9.7', { 'x.txt': 'OK' }, ['data/config.json']);
  const r = runHelper(plan, deadPid());
  check(r.code === 4, '★ 删除清单里出现 data/ → 拒绝', `code=${r.code}`);
  check(read(path.join(P2, 'data', 'config.json')) === '{"secret":"用户的私人配置"}', '★ 诱饵文件还在');
}
{
  const { plan } = prepare(P2, '9.9.6', { '../escape.txt': 'EVIL' }, []);
  const r = runHelper(plan, deadPid());
  check(r.code === 4, '.. 穿越被拒', `code=${r.code}`);
}
{
  const abs = path.join(ROOT, 'escape-abs.txt');
  const { plan } = prepare(P2, '9.9.5', {}, []);
  // 绝对路径在 Assert-Safe 里**先于**"暂存文件是否存在"被拦掉，所以这里刻意不摆暂存文件 ——
  // 如果守卫漏了绝对路径，助手会改成因为"暂存文件不存在"而失败，那就验错东西了。
  plan.writes.push({ path: abs, size: 3, sha256: sha(Buffer.from('abc')) });
  fs.writeFileSync(path.join(plan.stageDir, 'apply.json'), JSON.stringify(plan, null, 2));
  const r = runHelper(plan, deadPid());
  check(r.code === 4, '绝对路径被拒', `code=${r.code}`);
  check(!exists(abs), '那个绝对路径处没有被写出文件');
  const st = readState(P2);
  check(!!(st && st.note && st.note.includes('绝对路径')), '失败原因是"绝对路径"（而不是"暂存文件不存在"）', st && st.note);
}

/* ============================================================ ③ 名单是注入的 */
console.log('\n--- ③ 受保护名单来自 datadir 的注入，不是助手里的硬编码 ---');
{
  const prog = makeProgram('injected');
  const { plan } = prepare(prog, '9.9.9', { 'mydata/x.txt': 'EVIL' }, [], { protectedTop: ['mydata'] });
  const r = runHelper(plan, deadPid());
  check(r.code === 4, '把 mydata 注入名单后，mydata/ 立刻被拒（证明名单不是写死的）', `code=${r.code}`);
}

/* ============================================================ ④ 暂存文件被动过 */
console.log('\n--- ④ 负向：暂存文件与计划里的哈希不符 ---');
{
  const prog = makeProgram('tamper');
  const { plan } = prepare(prog, '9.9.9', { 'QuickLaunch.exe': 'NEW-EXE' }, []);
  fs.writeFileSync(path.join(plan.stageDir, 'files', 'QuickLaunch.exe'), 'TAMPERED');
  const r = runHelper(plan, deadPid());
  check(r.code === 4, '暂存文件被改 → 拒绝', `code=${r.code}`);
  check(read(path.join(prog, 'QuickLaunch.exe')) === 'OLD-EXE-'.repeat(500), '本机 exe 未被替换');
}

/* ============================================================ ⑤ 真的等主进程退出 */
console.log('\n--- ⑤ 真的会等主进程退出（不是"立刻动手"）---');
{
  const prog = makeProgram('wait');
  const { plan } = prepare(prog, '9.9.9', { 'QuickLaunch.exe': 'NEW-EXE-AFTER-WAIT' }, []);
  // 起一个真进程活 2.5 秒，拿它的 pid 当"主进程"
  const child = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 2500)'], { stdio: 'ignore' });
  const r = runHelper(plan, child.pid, 30);
  check(r.code === 0, '助手成功', `code=${r.code}`);
  check(r.elapsed >= 2000, `助手确实等了主进程（耗时 ${r.elapsed}ms ≥ 2000ms）`);
  check(read(path.join(prog, 'QuickLaunch.exe')) === 'NEW-EXE-AFTER-WAIT', '等完之后才替换');

  // 反向：主进程一直不退 → 助手必须**一个文件都不动**，并以 3 退出
  const prog2 = makeProgram('neverquits');
  const { plan: plan2 } = prepare(prog2, '9.9.9', { 'QuickLaunch.exe': 'SHOULD-NOT-APPLY' }, []);
  const alive = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
  const r2 = runHelper(plan2, alive.pid, 1);
  check(r2.code === 3, '主进程迟迟不退 → 助手以 3 退出', `code=${r2.code}`);
  check(read(path.join(prog2, 'QuickLaunch.exe')) === 'OLD-EXE-'.repeat(500), '★ 一个文件都没动');
  check(exists(path.join(prog2, '.update', '9.9.9')), '暂存区保留（下次还能用）');
  alive.kill();
}

/* ============================================================ ⑥ 中文路径 */
console.log('\n--- ⑥ 中文/空格路径（本项目真实路径就有中文）---');
{
  const prog = makeProgram('中文 目录/程序');
  const { plan } = prepare(prog, '9.9.9', { 'resources/app.asar': 'NEW-ASAR-中文', '子目录/说明.txt': '中文内容' }, []);
  const r = runHelper(plan, deadPid());
  check(r.code === 0, '中文+空格路径下助手正常退出（脚本带 BOM，不走代码页猜测）', `code=${r.code}`);
  check(read(path.join(prog, 'resources', 'app.asar')) === 'NEW-ASAR-中文', '中文路径下的文件替换成功');
  check(read(path.join(prog, '子目录', '说明.txt')) === '中文内容', '中文子目录也能建出来');
  check(read(path.join(prog, 'data', 'config.json')) === '{"secret":"用户的私人配置"}', '诱饵仍未被碰');
}

/* ============================================================ ⑦ 拉不起来新版 */
console.log('\n--- ⑦ 换完文件后拉不起新版，也不能把"已更新"写成"失败" ---');
{
  const prog = makeProgram('restartfail');
  // 指向一个不是可执行文件的东西：Start-Process 会抛错
  const bogus = path.join(prog, 'not-a-program.txt');
  fs.writeFileSync(bogus, 'not a program');
  const { plan } = prepare(prog, '9.9.9', { 'QuickLaunch.exe': 'NEW-EXE-AFTER-RESTART' }, [],
    { restart: true, exe: bogus });
  const r = runHelper(plan, deadPid());
  check(r.code === 0, '助手仍然以 0 退出（文件已经换好了，重启失败不算更新失败）', `code=${r.code}`);
  check(read(path.join(prog, 'QuickLaunch.exe')) === 'NEW-EXE-AFTER-RESTART', '文件已经换好了');
  const st = readState(prog);
  check(st && st.state === 'applied',
    '★ state.json 仍是 applied（否则下次启动会谎报"上次更新没有成功"）', JSON.stringify(st));
}

/* ============================================================ ⑧ 脚本本身 */
console.log('\n--- ⑧ 脚本拼装（静态）---');
{
  const script = applyLib.buildApplyScript({ programDir: 'C:\\p', stageDir: 'C:\\p\\.update\\1', to: '1', from: '0', writes: [], deletes: [], protectedTop: ['data'] }, { pid: 1 });
  check(!/Set-Content[^\n]*-Encoding\s+utf8/i.test(script), '不用 Set-Content -Encoding utf8（会写 BOM 把 JSON.parse 弄炸）');
  check(script.includes('UTF8Encoding $false'), '显式用不带 BOM 的 UTF8Encoding');
  check(/Move-Item -LiteralPath \$p\.Tmp/.test(script), '用 Move-Item 原子替换（不是 Copy-Item 直接盖）');
  check(/\$_.Exe\b/.test(script) || /Exe = \(\$w\.path -match/.test(script), '把 exe 标记出来单独排序');
  check(script.includes('Assert-Safe'), '有 Assert-Safe 纵深守卫');
  check(script.includes("if ($rel.Contains('..'))"), '守卫里包含 .. 检查');
  // ★ 交接链路的静态防线（对应 1.4.0/1.4.1 两次真事故）
  const line = applyLib.launcherCommandLine(PS_EXE, 'D:\\Program Files\\a b\\apply.ps1');
  check(line.startsWith('/c ""') && line.endsWith('""'),
    '★ cmd 命令行用 /c ""…"" 包起来（cmd 不认 \\" 转义）', line.slice(0, 40) + '…');
  check(line.includes(`-File "${'D:\\Program Files\\a b\\apply.ps1'}"`),
    '★ 脚本走 -File，且带空格的路径被引号兜住（cmd 命令行 8191 字符上限塞不进 -EncodedCommand）');
  check(applyLib.scriptFileText('x').charCodeAt(0) === 0xFEFF,
    '★ 脚本落盘时带 BOM（PowerShell 5.1 认 BOM 才按 UTF-8 解析，中文路径才不会废）');
  check(applyLib.HELPER_FILE === 'apply.ps1', '助手脚本文件名固定为 apply.ps1（随暂存区一起删）');
  check(applyLib.psQuote("a'b") === "'a''b'", '单引号按 PS 规则转义成两个');
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log('');
console.log(`合计：通过 ${pass}${fail ? ` / \x1b[31m失败 ${fail}\x1b[0m` : ''}`);
process.exit(fail ? 1 : 0);

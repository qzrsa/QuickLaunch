'use strict';
/**
 * 无界面冒烟测试：用桩替换 electron，验证 store / actions / scan 三个模块。
 * 运行： node test/smoke.js      （在 desktop 目录下）
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 注意：不要用 .tmpdata —— 那是开发态 userData 与 --shot/--import-probe 截图的家，
// 测试末尾会整目录删除，跑一次测试就会把开发配置和截图一起清掉。
const TMP = path.join(__dirname, '..', '.tmpdata-smoke');
const TMP_HOME = path.join(TMP, 'home');

/* ---------- electron 桩 ---------- */
const stub = {
  app: {
    isPackaged: false,
    getVersion: () => '1.0.0',
    getPath: name => ({
      home: TMP_HOME,
      userData: path.join(TMP, 'userData'),
      exe: process.execPath,
      temp: os.tmpdir(),
    }[name] || TMP),
    setLoginItemSettings: () => {},
    getLoginItemSettings: () => ({ openAtLogin: false }),
    quit: () => {},
    // 图标提取用的桩：返回一个"非空图片"，用来验证「存在路径 → 能转出 dataURL」这条链路。
    // ★ 真实 Windows 上 getFileIcon 对**不存在**的路径不报错、也不返回空，而是给个通用白板图标 ——
    //   所以 icon.js 自己用 fs.existsSync 挡了一道，这条桩不模拟那个坑，由断言单独覆盖。
    // ★ 记下最后一次调用路径：用来断言「.lnk 是先解析出目标再取图标」。
    getFileIcon: async p => {
      stub.__lastIconPath = p;
      return {
        isEmpty: () => false,
        getSize: () => ({ width: 32, height: 32 }),
        resize: () => ({ toDataURL: () => 'data:image/png;base64,ICON' }),
        toDataURL: () => 'data:image/png;base64,ICON',
      };
    },
  },
  shell: {
    openPath: async p => { stub.__lastOpenPath = p; return ''; },
    openExternal: async () => {},
    showItemInFolder: p => { stub.__lastFolder = p; },
    // .lnk 解析的桩：真机上是 shell.readShortcutLink(lnk) → {target, icon, ...}。
    // ★ 真实行为（本机实测 4/4）：对 .lnk 直接 getFileIcon 只会拿到同一张通用图；
    //   解析出 target 再取，才拿到各自不同的真图标。
    readShortcutLink: p => {
      const v = (stub.__lnk || {})[p];
      if (!v) throw new Error('不是有效的快捷方式');
      return v;
    },
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: class { static fromWebContents() { return null; } },
  Tray: class {}, Menu: { buildFromTemplate: () => ({}) }, ipcMain: { handle: () => {} },
  globalShortcut: { register: () => true, unregisterAll: () => {}, isRegistered: () => true },
  nativeImage: {
    // `.url` 里的 IconFile → 图片走的**就是这条**（nativeImage 直读，.ico 也可以）。
    // ★ 桩里按"文件是否存在"决定空不空，才能验出「不存在就返回空、不挂假图」。
    // ★★ 真机实测（v1.4.4）：`.ico` 走 getFileIcon 只会得到同一张 32×32 通用图
    //    （多个不同 .ico 哈希一模一样），只有 nativeImage 直读才拿到 256×256 的真图。
    createFromPath: p => {
      let exists = false;
      try { exists = require('fs').existsSync(p); } catch { exists = false; }
      if (!exists) return { isEmpty: () => true };
      return {
        isEmpty: () => false,
        getSize: () => ({ width: 256, height: 256 }),
        resize: () => ({ toDataURL: () => 'data:image/png;base64,ICO' }),
        toDataURL: () => 'data:image/png;base64,ICO',
      };
    },
    createFromDataURL: () => ({ isEmpty: () => true }),
  },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return stub;
  return origLoad.call(this, request, ...rest);
};

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label} ${extra}`); }
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

/* ---------- 主流程 ---------- */
(async () => {
  // ★ 开头先把上一轮的残留整个清掉：结尾会清一次，但上一轮若在收尾前崩溃/被掐，
  //   TMP 里会留下半截夹具（如 old-only.txt、.update/2.0.0、locales/zh-CN.pak），
  //   下一次运行那些"恰好 N 个文件 / 恰好这几个文件"的断言就会报红 —— 而且报红的样子
  //   跟"刚改的代码坏了"一模一样，会把人带进沟里白查半天。所以**测试自己必须先摆平状态，
  //   不能依赖上一轮**（datadir 的 mig 段也是这么干的）。
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP_HOME, { recursive: true });
  fs.rmSync(path.join(TMP, 'userData'), { recursive: true, force: true });

  const store = require('../src/lib/store');
  const actions = require('../src/lib/actions');
  const scanner = require('../src/lib/scan');

  section('store 配置存储');
  const cfgPath = store.init();
  ok(fs.existsSync(cfgPath), 'config.json 已创建', cfgPath);
  const cfg = store.load();
  ok(Array.isArray(cfg.groups) && cfg.groups.length > 0, `默认分组数 = ${cfg.groups.length}`);
  ok(cfg.settings.hotkey === 'Ctrl+Alt+Space', `默认热键 = ${cfg.settings.hotkey}`);
  ok(cfg.settings.hoverActions === false, '悬停操作条默认关闭（改用右键）');
  const all = cfg.groups.flatMap(g => g.items);
  ok(all.length > 0, `默认启动项数 = ${all.length}`);
  ok(all.every(i => typeof i.favorite === 'boolean'), '每项都有 favorite 字段');

  store.annotate(cfg);
  ok(all.every(i => typeof i._exists === 'boolean'), 'annotate 注入 _exists');

  /* ---- 恢复默认分组：只补不删、幂等（v1.4.9，「全选误删」的后悔药） ---- */
  section('恢复默认分组（只补不删）');
  {
    // 模拟「全选 → 删除」：默认分组和默认项全没了，只剩一个用户自建分组
    const broken = store.defaultConfig();
    broken.groups = [{ id: 'mine', name: '我的分组', icon: '⭐', color: '#3b6cf6', items: [
      store.newItem('自制项', '🚀', 'app', 'notepad.exe'),
    ] }];
    const r1 = store.restoreDefaults(broken);
    ok(r1.groupsAdded === 4, `缺失的 4 个默认分组被整组补回（实际 ${r1.groupsAdded}）`);
    ok(r1.itemsAdded > 0, `补回默认启动项 ${r1.itemsAdded} 个`);
    ok(broken.groups[0].id === 'mine' && broken.groups[0].items.length === 1,
      '★ 用户自建分组与自加项原样保留（恢复是加法，不是重置）');
    ok(broken.groups.some(g => g.id === 'files') && broken.groups.some(g => g.id === 'tools')
      && broken.groups.some(g => g.id === 'dev') && broken.groups.some(g => g.id === 'web'),
      '四个默认分组都回来了');

    // 幂等：再点一次不该重复添加
    const before = broken.groups.reduce((n, g) => n + g.items.length, 0);
    const r2 = store.restoreDefaults(broken);
    ok(r2.groupsAdded === 0 && r2.itemsAdded === 0, '★ 再点一次不重复添加（幂等）');
    ok(broken.groups.reduce((n, g) => n + g.items.length, 0) === before, '总项数没变');

    // 分组还在、只删了里面几项 → 只补缺的那几项，且按 type|path 去重（改过名也算同一项）
    const partial = store.defaultConfig();
    const files = partial.groups.find(g => g.id === 'files');
    const keepItem = files.items[0];
    files.items = [{ ...keepItem, name: '我自己改的名字' }];   // 路径没变，只是改了名
    const r3 = store.restoreDefaults(partial);
    ok(r3.groupsAdded === 0, '分组还在就不整组重建');
    ok(!files.items.some(i => i.path === keepItem.path && i.name === keepItem.name),
      '★ 改过名的默认项不会被再插一条（按 type|path 去重）');
    ok(files.items.length === store.defaultConfig().groups.find(g => g.id === 'files').items.length,
      `缺的默认项补齐（${files.items.length} 项）`);
  }

  section('itemOk 存在性判定');
  ok(store.itemOk({ type: 'url', path: 'https://github.com' }) === true, '网址恒为存在');
  ok(store.itemOk({ type: 'app', path: 'notepad.exe' }) === true, '裸命令名 notepad.exe 命中 System32');
  ok(store.itemOk({ type: 'app', path: 'powershell.exe' }) === true,
    'powershell.exe 不在 System32 但 PATH 里有 → 不许再报「路径不存在」');
  ok(store.itemOk({ type: 'app', path: 'C:\\__nope__\\x.exe' }) === false, '不存在的绝对路径判为缺失');
  ok(store.itemOk({ type: 'app', path: 'services.msc' }) === true, '.msc 交给 shell 关联');
  ok(store.itemOk({ type: 'app', path: 'definitely_not_here_xyz.exe' }) === false,
    'PATH 里也没有的裸名字判为缺失（以前这条会假阳性）');
  ok(store.itemOk({ type: 'cmd', path: 'explorer.exe "shell:MyComputerFolder"' }) === true,
    '「命令」是一整行 shell 语句，不校验路径（与 keep() 的保留条件一致）');
  ok(store.expandEnv('%SystemRoot%\\System32') === (process.env.SystemRoot + '\\System32'), '环境变量展开');

  /* ---- 裸命令名解析：store 与 actions 共用的一份实现 ---- */
  section('lib/resolve：裸命令名与控制台判定');
  const resolveLib = require('../src/lib/resolve');
  ok(resolveLib.isBareName('notepad.exe') === true, '裸名字识别');
  ok(resolveLib.isBareName('C:\\Windows\\notepad.exe') === false, '绝对路径不算裸名字');
  ok(resolveLib.isBareName('sub/x.exe') === false, '带分隔符不算裸名字');
  const psResolved = resolveLib.resolveCommand('powershell.exe');
  ok(path.isAbsolute(psResolved) && fs.existsSync(psResolved),
    'powershell.exe 解析成真实绝对路径', psResolved);
  ok(resolveLib.resolveCommand('C:\\__nope__\\x.exe') === 'C:\\__nope__\\x.exe', '绝对路径原样返回');
  ok(resolveLib.resolveCommand('no_such_cmd_zz.exe') === 'no_such_cmd_zz.exe', '找不到就原样返回');
  ok(resolveLib.exists('no_such_cmd_zz.exe') === false, 'exists() 对找不到的裸名字给 false');

  // 注入假 fs / 假 env：不碰本机，验搜索顺序与 PATHEXT 展开
  const fakeFs = { existsSync: p => String(p).toLowerCase() === 'c:\\shim\\thing.exe' };
  const fakeEnv = { SystemRoot: 'C:\\Windows', PATH: 'C:\\shim', PATHEXT: '.EXE' };
  ok(resolveLib.resolveCommand('thing', { fs: fakeFs, env: fakeEnv }).toLowerCase() === 'c:\\shim\\thing.exe',
    '按 PATHEXT 展开（thing → thing.exe）');
  ok(resolveLib.candidates('thing', fakeEnv)[0].toLowerCase() === 'c:\\windows\\system32\\thing',
    '搜索顺序从 System32 开始');
  ok(resolveLib.candidates('ps1', fakeEnv).some(p => /windows ?powershell/i.test(p)),
    'PowerShell 5.1 的目录在候选里（PATH 被精简也找得到）');

  ok(resolveLib.isConsoleExe(psResolved) === true, 'powershell.exe 识别为控制台程序');
  ok(resolveLib.isConsoleExe(path.join(process.env.SystemRoot, 'System32', 'notepad.exe')) === false,
    'notepad.exe 识别为窗口程序');
  ok(resolveLib.isConsoleExe(path.join(TMP, 'no-such.exe')) === false,
    '读不到 PE 头时不当成控制台程序（宁可普通启动）');

  section('actions 启动动作');
  const out = path.join(TMP, 'launch-ok.txt');
  try { fs.unlinkSync(out); } catch {}
  let r = await actions.launch({ type: 'cmd', path: `echo ql-ok > "${out}"` });
  ok(r.ok, 'cmd 类型执行返回 ok', r.msg);
  await new Promise(res => setTimeout(res, 700));
  const content = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : '';
  ok(content === 'ql-ok', '命令真的落盘（引号与重定向正确）', JSON.stringify(content));

  r = await actions.launch({ type: 'app', path: 'C:\\__nope__\\nope.exe' });
  ok(r.ok === false && /找不到/.test(r.msg),
    '不存在的程序必须明确报错 —— 以前 spawn 的 ENOENT 没人接，会假装成功', r.msg);

  r = await actions.launch({ type: 'folder', path: TMP });
  ok(r.ok, '目录类型可打开', r.msg);

  r = await actions.launch({ type: 'url', path: 'github.com' });
  ok(r.ok, '网址自动补 http:// 并交给 shell', r.msg);

  // ★ v1.4.4：协议链接（Steam / 游戏平台）以前被套成 `http://steam://…`，
  //   浏览器打开一个不存在的地址 → 用户看到的是"点了没反应"。
  r = await actions.launch({ type: 'url', path: 'steam://rungameid/400040' });
  ok(r.ok && r.msg.includes('steam://rungameid/400040') && !/http:\/\/steam/.test(r.msg),
    '★ 协议链接原样交给 shell（不再套 http://）', r.msg);

  ok(path.basename(actions.resolveTarget('notepad.exe')).toLowerCase() === 'notepad.exe',
    'resolveTarget 解析裸命令名');
  ok(actions.resolveTarget('powershell.exe') !== 'powershell.exe',
    'resolveTarget 也能解析只在 PATH 里的命令');

  /* ---- 打开所在位置：必须真的定位到东西（v1.4.8） ----
     以前直接把 path 丢给 showItemInFolder：
       · 裸命令名（taskmgr.exe / notepad.exe / services.msc）→ 相对路径 → Windows 静默无反应
       · .lnk（扫描导入存的是开始菜单里的快捷方式）→ 定位到开始菜单，不是程序真正所在
       · 路径不存在 → 静默无反应
     这三条就是用户说的「不是真的打开所在位置」。 */
  section('打开所在位置：裸命令名 / .lnk / 不存在');
  stub.__lastFolder = null; stub.__lastOpenPath = null;
  r = await actions.openContaining('cmd.exe');
  ok(r.ok && !!stub.__lastFolder && path.isAbsolute(stub.__lastFolder)
    && path.basename(stub.__lastFolder).toLowerCase() === 'cmd.exe',
    '★ 裸命令名先解析成绝对路径再定位（直接丢给 showItemInFolder 会静默无反应）',
    stub.__lastFolder);

  stub.__lastFolder = null;
  r = await actions.openContaining(TMP);
  ok(r.ok && stub.__lastFolder === path.normalize(TMP), '存在的目录 → 资源管理器里定位', stub.__lastFolder);

  // .lnk → 跟到真实目标（扫描导入存的是开始菜单里的 .lnk 本身）
  const lnkTest = path.join(TMP, 'ql-open-containing.lnk');
  const lnkReal = path.join(TMP, 'ql-real-target.exe');
  fs.writeFileSync(lnkTest, '');
  fs.writeFileSync(lnkReal, 'x');
  stub.__lnk = { [lnkTest]: { target: lnkReal, icon: '' } };
  stub.__lastFolder = null;
  r = await actions.openContaining(lnkTest);
  ok(r.ok && stub.__lastFolder === lnkReal,
    '★ .lnk 定位到 target（不是快捷方式自己所在的开始菜单文件夹）', stub.__lastFolder);
  stub.__lnk = {};

  // 路径不存在 → 打开最近一个存在的上级目录并说明，别装没事
  stub.__lastFolder = null; stub.__lastOpenPath = null;
  r = await actions.openContaining(path.join(TMP, '__nope__', 'deep', 'x.exe'));
  ok(r.ok && stub.__lastOpenPath === path.normalize(TMP) && /不存在/.test(r.msg),
    '★ 路径不存在 → 打开最近的上级目录并说明（不再静默无反应）', r.msg);
  ok(stub.__lastFolder === null, '不存在时不该假装「已定位」');

  r = await actions.openContaining('');
  ok(r.ok === false && /路径为空/.test(r.msg), '空路径 → 明确报错');
  ok(actions.nearestExistingDir('C:\\__ql_nope__\\a\\b\\c.exe') === 'C:\\',
    'nearestExistingDir 一路向上找到盘符根');

  /* ---- 静态铁律：启动形态是被实测逼出来的，别改回去 ---- */
  section('启动形态铁律（实测对照见探针手册）');
  const actSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'actions.js'), 'utf8');
  // 先剥注释再断言：注释里会写到被禁的写法（否则这条永远红）
  const actCode = actSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/detached:\s*true/.test(actCode),
    'actions.js 里不许再有 detached:true（控制台程序没有控制台，一行都不执行就退出）');
  ok(/\/c start "" /.test(actCode),
    '可执行文件统一经 cmd 的 start 启动（实测唯一「父进程退出后还活着」的形态）');
  ok(/windowsVerbatimArguments:\s*true/.test(actCode),
    'cmd 命令行必须原样传参（交给 CRT 再转义一遍会 exit 1，一个进程都起不来）');
  ok(/isConsoleExe\(/.test(actCode),
    '控制台程序自动给窗口，不指望用户自己去勾「显示命令行窗口」');
  ok(/urlsc\.normalizeUrl\(target\)/.test(actCode),
    '网址 / 协议链接统一走 urlshortcut.normalizeUrl（唯一实现，别在两处各写一份）');
  ok(!/'http:\/\/'\s*\+\s*target/.test(actCode),
    '★ 不许再手写「不是 http 就补 http://」（`steam://` 会被套成双层协议，点了打不开）');
  ok(/resolveLib\.resolveCommand\(t\)/.test(actCode),
    '★ openContaining 也走 resolve.js 解析裸命令名（否则「能启动但定位不到」）');
  ok(/readShortcut\(t\)/.test(actCode) && /info\.target/.test(actCode),
    '★ .lnk 定位跟到真实 target');
  ok(/nearestExistingDir\(t, fs\)/.test(actCode),
    '★ 路径不存在时退到最近的上级目录，不静默无反应');

  section('scan 软件扫描');
  const t0 = Date.now();
  const items = await scanner.scan(true);
  const dt = Date.now() - t0;
  ok(items.length > 0, `扫到 ${items.length} 个候选（${dt}ms）`);
  ok(items.every(i => i.name && i.path && i.source), '每项含 name/path/source');
  ok(items.every(i => i.type === 'app'), '类型统一为 app');
  const dup = items.length - new Set(items.map(i => i.name.toLowerCase())).size;
  ok(dup === 0, `按名称去重，重复 ${dup} 条`);
  console.log('    示例:', items.slice(0, 5).map(i => `${i.name}[${i.source}]`).join(', '));

  const t1 = Date.now();
  await scanner.scan(false);
  ok(Date.now() - t1 < 50, '二次扫描命中缓存');

  /* ---- 扫描导入：进度 + 不许取消 + 不许重复点 ----
     导入两百多项时每项都要异步提图标（十几秒）。以前既没进度也不锁：用户会以为卡死，
     再点一次「导入到分组」就重复导入一整批，点「取消」/按 Esc 就把进度丢了。 */
  section('扫描导入：进度条与防重复');
  const scanHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const scanJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const scanCss = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'style.css'), 'utf8');
  ok(/id="scanProgress"/.test(scanHtml) && /id="scanBar"/.test(scanHtml) && /id="scanProgressPct"/.test(scanHtml),
    '扫描弹窗里有进度条：轨道 + 填充 + 百分比');
  ok(/id="scanProgress"[^>]*\shidden/.test(scanHtml), '进度条默认隐藏（不占位）');
  ok(/function setScanProgress/.test(scanJs) && /style\.width = pct \+ '%'/.test(scanJs),
    '进度宽度按 done/total 真算（不是假动画）');
  ok(/function setScanBusy/.test(scanJs), '有 setScanBusy() 统一开关"导入中"状态');
  ok(/'#btnScanImport', '#btnScanAll', '#btnScanNone', '#scanQ'/.test(scanJs),
    '导入中禁用 导入 / 全选 / 全不选 / 筛选');
  ok(/querySelectorAll\('\[data-close\]'\)[\s\S]{0,60}disabled = !!on/.test(scanJs),
    '★ 导入中「取消」与右上角 ✕ 一起禁用（不能取消）');
  ok(/async function importScan\(\)[\s\S]{0,160}if \(state\.importing\) return;/.test(scanJs),
    '★ 重复点「导入到分组」直接忽略（不会重复导入）');
  const lockUses = (scanJs.match(/overlayLocked\(/g) || []).length;
  ok(/function overlayLocked/.test(scanJs) && lockUses >= 4,
    `★ 所有关闭入口（✕ / 遮罩 / Esc）都过 overlayLocked 这道闸（${lockUses} 处）`);
  ok(/async function openScan\(\)[\s\S]{0,120}state\.importing/.test(scanJs),
    '导入中重开扫描弹窗会被挡住（否则进度与冻结的勾选被冲掉）');
  ok(/if \(state\.importing\) return;\s*\/\/ 导入中不再改勾选/.test(scanJs),
    '导入中列表不再响应勾选');
  ok(/have\.has\(key\)/.test(scanJs) && /have\.add\(key\)/.test(scanJs),
    '同一批里重复路径也去重（边筛边把 key 塞进 have）');
  ok(/Math\.min\(6, total\)/.test(scanJs), '图标提取 6 路并发（两百多项串行要十几秒）');
  ok(/g\.items\.push\(\.\.\.slots\)/.test(scanJs), '先按顺序占槽位再并发 → 导入顺序仍与候选列表一致');
  ok(/#scanOverlay\.is-busy \.scan-list/.test(scanCss), '导入中列表变灰且点不动');
  ok(/\.btn:disabled/.test(scanCss), '禁用态有视觉反馈（否则按钮看着还能点）');
  // ★ 预览模式的 TDZ 坑：createMockBridge() 在初始化时就用 PALETTE，
  //   所以 API/PREVIEW 不能声明在 PALETTE 之前，否则普通浏览器里整页白屏
  //   （桌面版因为走 window.ql 碰不到这条路，一直没被发现）。
  const iPal = scanJs.indexOf('const PALETTE =');
  const iApi = scanJs.indexOf('const API = window.ql');
  ok(iPal > 0 && iApi > iPal,
    'API / PREVIEW 初始化排在 PALETTE 之后（放最前面会让预览模式踩 TDZ 白屏）');

  section('menus 右键菜单模板');
  const menus = require('../src/lib/menus');
  const labels = tpl => tpl.filter(i => i.type !== 'separator').map(i => i.label);

  // —— 卡片：普通应用 ——
  let ct = menus.cardMenuTemplate({ type: 'app', path: 'C:\\Windows\\notepad.exe', favorite: false });
  let acts = ct.filter(i => typeof i.click === 'function').map(i => i.click());
  ok(acts.includes('launch'), '卡片菜单含 启动');
  ok(acts.includes('elevate'), 'app 类型含 以管理员身份运行');
  ok(acts.includes('folder'), '本地路径含 打开所在位置');
  ok(acts.includes('copy') && acts.includes('edit') && acts.includes('del'), '含 复制/编辑/删除');
  ok(acts.includes('multiselect'), '卡片菜单含 多选编辑');
  ok(labels(ct).includes('加入收藏'), '未收藏时显示「加入收藏」');

  ct = menus.cardMenuTemplate({ type: 'app', path: 'C:\\Windows\\notepad.exe', favorite: true });
  ok(labels(ct).includes('取消收藏'), '已收藏时显示「取消收藏」');

  // —— 卡片：网址 ——
  ct = menus.cardMenuTemplate({ type: 'url', path: 'https://github.com' });
  acts = ct.filter(i => typeof i.click === 'function').map(i => i.click());
  ok(!acts.includes('folder'), '网址类型不出现 打开所在位置');
  ok(!acts.includes('elevate'), '网址类型不出现 提权');

  // —— 卡片：cmd ——
  ct = menus.cardMenuTemplate({ type: 'cmd', path: 'echo hi' });
  acts = ct.filter(i => typeof i.click === 'function').map(i => i.click());
  ok(acts.includes('elevate'), 'cmd 类型含 提权');
  ok(!acts.includes('folder'), 'cmd 类型不出现 打开所在位置');

  // —— 卡片：路径缺失 ——
  ct = menus.cardMenuTemplate({ type: 'app', path: 'C:\\__nope__\\x.exe', _exists: false });
  ok(labels(ct).some(l => l.includes('路径可能不存在')), '缺失路径给出提示文案');

  // —— 分组 ——
  const gt = menus.groupMenuTemplate({ name: '常用', icon: '🚀', count: 3, color: '#7c5cff' });
  const gacts = gt.filter(i => typeof i.click === 'function').map(i => i.click());
  ok(labels(gt)[0].includes('常用'), '分组菜单首项显示分组名');
  ok(gacts.includes('new') && gacts.includes('rename') && gacts.includes('del'), '含 新建/重命名/删除');
  ok(gacts.includes('newgroup'), '分组菜单含 新建分组(newgroup)');
  const colorItem = gt.find(i => i.label === '更换颜色');
  ok(Array.isArray(colorItem.submenu) && colorItem.submenu.length === 8, `颜色子菜单 8 项`);
  ok(colorItem.submenu.every(c => typeof c.click === 'function' && c.click().startsWith('color:#')),
    '颜色子菜单项可点击且回传 color:#rrggbb');
  ok(colorItem.submenu.some(c => c.checked && c.click() === 'color:#7c5cff'), '当前颜色被勾选');
  ok(labels(gt).some(l => l.includes('含 3 项')), '删除项提示包含条目数');

  // —— 空白 ——
  const bt = menus.blankMenuTemplate();
  const bacts = bt.filter(i => typeof i.click === 'function').map(i => i.click());
  ok(bacts.join(',') === 'new,newgroup,multiselect,scan,prune,settings', '空白菜单动作 = new,newgroup,multiselect,scan,prune,settings', bacts.join(','));

  ok(menus.DEFAULT_COLORS.length === 8 && menus.DEFAULT_COLORS.every(c => c.name && /^#[0-9a-f]{6}$/i.test(c.value)),
    'DEFAULT_COLORS 均为合法 #rrggbb');

  section('importer 拖入导入');
  const importer = require('../src/lib/importer');

  // 造几个真实文件，验证按扩展名分类
  const work = path.join(TMP, 'drop');
  fs.mkdirSync(path.join(work, '我的文件夹'), { recursive: true });
  const mk = (rel, body = 'x') => {
    const p = path.join(work, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  const exeP = mk('tool.exe');
  const batP = mk('run.bat');
  const pyP = mk('bot.py');
  const mdP = mk('readme.md');
  const pngP = mk('shot.png');
  const zipP = mk('pack.zip');
  const urlP = mk('GitHub.url', '[InternetShortcut]\r\nURL=https://github.com/qzrsa\r\n');
  const badUrlP = mk('broken.url', 'nothing here');
  const dirP = path.join(work, '我的文件夹');

  ok(importer.classifyBasic(dirP).type === 'folder', '目录 → folder');
  ok(importer.classifyBasic(dirP).icon === '📁', '目录图标 📁');
  ok(importer.classifyBasic(exeP).type === 'app', '.exe → app');
  ok(importer.classifyBasic(batP).type === 'script', '.bat → script');
  ok(importer.classifyBasic(pyP).type === 'script', '.py → script');
  ok(importer.classifyBasic(mdP).type === 'file', '.md → file');
  ok(importer.classifyBasic(pngP).icon === '🖼️', '.png 图标 🖼️');
  ok(importer.classifyBasic(zipP).icon === '📦', '.zip 图标 📦');
  ok(importer.classifyBasic('') === null, '空字符串返回 null');
  ok(importer.classifyBasic('C:\\__nope__\\x.exe').type === 'app', '不存在的 .exe 仍按 app 处理');

  ok(importer.cleanName('C:\\x\\微信 - 快捷方式.lnk') === '微信', '去掉「 - 快捷方式」后缀');
  ok(importer.cleanName('C:\\x\\Chrome.lnk') === 'Chrome', '去掉 .lnk 扩展名');
  ok(importer.cleanName('D:\\a\\我的工具.exe') === '我的工具', '中文名保留');
  ok(importer.hostOf('https://www.github.com/x') === 'github.com', 'hostOf 去掉 www');
  ok(importer.parseUrlFile(urlP) === 'https://github.com/qzrsa', '解析 .url 里的 URL=');
  ok(importer.parseUrlFile(badUrlP) === null, '无效 .url 返回 null');

  let r2 = await importer.buildItems({
    paths: [dirP, exeP, batP, 'C:\\__nope__\\x.exe'],
    urls: ['github.com', 'https://example.com/a'],
    existing: [],
  });
  ok(r2.items.length === 6, `分类出 ${r2.items.length} 项（含 2 个网址）`);
  ok(r2.items.filter(i => i.type === 'url').length === 2, '两个网址都是 url 类型');
  const gh = r2.items.find(i => i.type === 'url' && i.path === 'http://github.com');
  ok(!!gh, '裸域名自动补 http://', gh && gh.path);
  ok(r2.items.find(i => i.name === '我的文件夹').type === 'folder', '中文目录名正确');

  // .url 文件应被解析成网址而不是文件
  r2 = await importer.buildItems({ paths: [urlP], urls: [], existing: [] });
  ok(r2.items.length === 1 && r2.items[0].type === 'url', '.url 文件解析为网址类型');
  ok(r2.items[0].path === 'https://github.com/qzrsa', '.url 目标正确', r2.items[0].path);
  ok(r2.items[0].name === 'GitHub', '.url 名称取文件名');

  // ---- 协议型 .url（Steam / 游戏平台）：v1.4.4 的核心修复 ----
  // 以前：URL=steam://… → 套成 http://steam://…（点不开），图标写死 🌐，
  //       同一行下面的 IconFile=…ico 压根没读过。本机 11 个游戏全是同一个大地球。
  const steamUrlP = mk('ShareX.url',
    '[InternetShortcut]\r\nIconIndex=0\r\nURL=steam://rungameid/400040\r\nIconFile=C:\\icons\\a.ico\r\n');
  const rSteam = await importer.buildItems({ paths: [steamUrlP], urls: [], existing: [] });
  const si = rSteam.items[0];
  ok(!!si && si.type === 'url', '协议型 .url 仍是 url 类型');
  ok(si.path === 'steam://rungameid/400040', '★ 协议原样保留（不再套成 http://steam://…）', si.path);
  ok(si.desc === 'steam', '.url 说明取协议名（不是 hostname rungameid）', si.desc);
  ok(si._iconFile === 'C:\\icons\\a.ico', '.url 把 IconFile 带出去给主进程取图');
  // 没有 IconFile 的（普通网页快捷方式）也不许崩
  ok(r2.items[0]._iconFile === '', '没有 IconFile → 空串');

  // 去重：同样的输入第二次应全部跳过
  r2 = await importer.buildItems({ paths: [dirP, exeP], urls: ['github.com'], existing: [] });
  const again = await importer.buildItems({
    paths: [dirP, exeP], urls: ['github.com'], existing: r2.items,
  });
  ok(again.items.length === 0, '与 existing 重复时不再导入');
  ok(again.skipped.length === 3, `重复项计入 skipped（${again.skipped.length}）`);

  // 同一批里重复的路径只留一个
  const dupBatch = await importer.buildItems({ paths: [exeP, exeP, exeP], urls: [], existing: [] });
  ok(dupBatch.items.length === 1, '同一批内重复路径只保留一项');
  ok(dupBatch.skipped.length === 2, '批内重复计入 skipped');

  // 上限保护：超出 MAX_ITEMS 的部分要截断，而且**明确回报**被截掉多少（不静默丢）
  const many = await importer.buildItems({
    urls: Array.from({ length: importer.MAX_ITEMS + 10 }, (_, i) => `https://h${i}.example.com`), existing: [],
  });
  ok(many.items.length === importer.MAX_ITEMS, `单次上限 ${importer.MAX_ITEMS} 项`);
  ok(many.truncated === 10, `★ 超出上限的 10 项回报为 truncated（不再静默丢弃）`, String(many.truncated));
  ok(importer.MAX_ITEMS > 50, '单次拖入上限已从 50 放开（有并发 + 进度条才敢放开）');

  ok(importer.keyOf({ type: 'app', path: 'C:\\A.EXE' }) === 'app|c:\\a.exe', 'keyOf 大小写归一');

  // .lnk 解析（真机上是 PowerShell + WScript.Shell）
  const lnkSrc = mk('Notepad.lnk');
  const lnkMap = await importer.resolveShortcuts([lnkSrc]);
  if (process.platform === 'win32') {
    ok(lnkMap instanceof Map, 'resolveShortcuts 始终返回 Map');
    if (lnkMap.get(lnkSrc) && lnkMap.get(lnkSrc).target) {
      ok(true, `.lnk 解析到目标：${path.basename(lnkMap.get(lnkSrc).target)}`);
    } else {
      ok(true, '.lnk 为伪造文件，按预期解析不到目标（真实 lnk 才会命中）');
    }
  } else {
    ok(lnkMap.size === 0, '非 Windows 平台不做 .lnk 解析');
  }

  const lnkFallback = await importer.buildItems({ paths: [lnkSrc], urls: [], existing: [] });
  ok(lnkFallback.items.length === 1, '解析不出的 .lnk 仍保留为一项');
  ok(lnkFallback.items[0].type === 'app' && lnkFallback.items[0].path === lnkSrc,
    '.lnk 兜底存 lnk 本身，交给 shell 关联');

  // 真实快捷方式：开始菜单里捞几个，验证 COM 解出来的是目标本体而不是 lnk 自己
  // （这条是回归护栏 —— PS 5.1 下 @($x | ConvertFrom-Json) 会把数组包成单元素，
  //   曾经导致所有 .lnk 的 target 全是空字符串）
  const smRoots = [
    process.env.ProgramData && path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ].filter(Boolean);
  const realLnks = [];
  const collect = (dir, depth) => {
    if (depth > 4 || realLnks.length >= 6) return;
    let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (realLnks.length >= 6) return;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) collect(f, depth + 1);
      else if (e.name.toLowerCase().endsWith('.lnk')) realLnks.push(f);
    }
  };
  smRoots.forEach(r => collect(r, 1));

  if (realLnks.length >= 2) {
    const realMap = await importer.resolveShortcuts(realLnks);
    const hit = [...realMap.values()].filter(v => v.target);
    ok(hit.length >= 1, `真实快捷方式解析：${hit.length}/${realLnks.length} 拿到目标`);
    const sample = hit[0];
    if (sample) {
      console.log('    示例:', path.basename(realLnks.find(p => (realMap.get(p) || {}).target === sample.target) || ''),
        '=>', sample.target, sample.args ? `(args: ${sample.args})` : '');
      ok(/^[a-zA-Z]:\\/.test(sample.target), '解析出的目标是被引用的绝对路径');
    }
    const realBuilt = await importer.buildItems({ paths: realLnks, urls: [], existing: [] });
    ok(realBuilt.items.every(i => i.type === 'app' || i.type === 'script'),
      '真实快捷方式统一分类为 app / script');
    ok(realBuilt.items.some(i => i.path !== realLnks[0]),
      '至少有一项存的是目标本体而非 .lnk 自身');
  } else {
    ok(true, '本机没找到开始菜单快捷方式，跳过真实 .lnk 解析断言');
  }

  /* --------------------------------------------- 拖入导入：进度与上限（v1.4.9） */
  section('拖入导入：进度条 / 上限放开 / 恢复默认接线');
  {
    const mainSrc2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const preloadSrc2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
    const appSrc2 = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    const htmlSrc2 = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
    const cssSrc2 = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'style.css'), 'utf8');

    ok(/send\('ql:import-progress'/.test(mainSrc2), '★ 主进程逐项推 ql:import-progress（没进度就像卡死）');
    ok(/Math\.min\(6, total\)/.test(mainSrc2), '提图标 6 路并发（串行时上百项要等很久）');
    ok(/phase: 'resolve'/.test(mainSrc2) && /phase: 'icons'/.test(mainSrc2) && /phase: 'done'/.test(mainSrc2),
      '三个阶段都推：解析 / 提图标 / 完成');
    ok(/\.unshift\(\.\.\.slots\)/.test(mainSrc2), '并发提图后按原顺序插回（先占槽位再回填）');
    ok(/'ql:import-progress'/.test(preloadSrc2), 'preload 白名单登记了 ql:import-progress');

    ok(/id="dropProgress"/.test(htmlSrc2) && /id="dropBar"/.test(htmlSrc2), '拖入遮罩里有进度条元素');
    ok(/function setDropProgress/.test(appSrc2) && /function showDropProgress/.test(appSrc2),
      '渲染层有 setDropProgress / showDropProgress');
    ok(/API\.on\('ql:import-progress'/.test(appSrc2), '渲染层订阅导入进度');
    ok(/state\.importingDrop/.test(appSrc2), '导入中再拖一次直接忽略（避免同一批导两遍）');
    ok(/truncated/.test(appSrc2), '★ 超出上限会明确告诉用户（不再静默丢弃）');
    ok(/\.dv-bar/.test(cssSrc2) && /indeterminate/.test(cssSrc2), '进度条样式齐全（含解析阶段的滑块动画）');

    ok(/ql:config:restore-defaults/.test(mainSrc2) && /restoreDefaults/.test(preloadSrc2),
      '恢复默认：IPC 通道与 preload 桥都齐（漏一个就是静默失效）');
    ok(/id="btnRestoreDefaults"/.test(htmlSrc2) && /restoreDefaultGroups/.test(appSrc2),
      '设置面板有「恢复默认分组」按钮并已接线');
    ok(/restoreDefaults: async/.test(appSrc2), '预览模式 mock 也实现了 restoreDefaults');
  }

  /* --------------------------------------------- 拖入落点 + 导入后分配（v1.5.9）
     问题：以前不管从哪儿拖进来，一律落到「拖入的快捷方式」；一次拖几十个，
     就得逐张长按 0.5 秒搬走 —— 整理 20 项要 20 次手势。
     现在两级：站在某个分组里拖进来 = 进那个组；落在桶里则给一次「分配到分组…」。
     ------------------------------------------------------------------ */
  section('拖入落点与导入后分配');
  {
    const appSrcD = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    const cssSrcD = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'style.css'), 'utf8');

    // ★ 纯函数直接抠出来跑，不写"镜像实现"（镜像实现永远通过 = 没测）
    const dropFnSrc = (appSrcD.match(/function dropGroupFor\s*\([\s\S]*?\n\}/) || [''])[0];
    ok(!!dropFnSrc, 'dropGroupFor 能抠出来');
    const dropGroupFor = new Function('return (' + dropFnSrc + ')')();
    const groups = [{ id: 'g1', name: '一' }, { id: 'g2', name: '二' }];

    ok(dropGroupFor({ sidebarId: 'g2', active: 'g1', groups }) === 'g2',
      '松手在侧栏分组上 → 用侧栏那个（优先级最高）');
    ok(dropGroupFor({ sidebarId: null, active: 'g1', groups }) === 'g1',
      '★ 站在分组里拖到空白 → 进当前分组（本次改动的核心）');
    ok(dropGroupFor({ sidebarId: null, active: 'all', groups }) === null,
      '「全部」视图不猜分组 → 走兜底的「拖入的快捷方式」');
    ok(dropGroupFor({ sidebarId: 'recent', active: 'all', groups }) === null
      && dropGroupFor({ sidebarId: 'fav', active: 'g1', groups }) === 'g1',
      '虚拟视图既不算侧栏分组，也不改当前分组的判定');
    ok(dropGroupFor({ sidebarId: 'deleted', active: 'g2', groups }) === 'g2',
      '侧栏分组刚被删（id 失效）→ 退回当前分组，而不是掉进桶里');
    ok(dropGroupFor({}) === null, '没参数 / 空配置也不炸');

    // 落点提示必须把后果说清楚（以前只说"松开即可导入"，用户不知道会进桶）
    ok(/将放入「拖入的快捷方式」/.test(appSrcD), '遮罩文案写明兜底落点');

    // toast 动作按钮
    ok(/opts\.action/.test(appSrcD) && /className = 't-act'/.test(appSrcD),
      'toast 支持可选动作按钮（opts.action）');
    ok(/opts\.ttl \|\|/.test(appSrcD), '带按钮的提示能自定义停留时长');
    ok(/\.toast \.t-act\s*\{[^}]*pointer-events:\s*auto/.test(cssSrcD),
      '★ .toasts 是 pointer-events:none，按钮必须自己把事件收回来，否则点不动');

    // 分配入口：只在落桶时出现；进多选时把这批预先勾上
    ok(/r\.groupId === 'dropped'/.test(appSrcD), '只有落到「拖入的快捷方式」才给「分配…」');
    ok(/function assignImported/.test(appSrcD) && /setEditMode\(true, alive\)/.test(appSrcD),
      '「分配…」= 进多选 + 整批预勾选（复用现成的批量移动）');
    ok(/Array\.isArray\(preselect\)/.test(appSrcD),
      'setEditMode 接受 id 数组（原来只收单个）');
    ok(/if \(ids\.length && state\.q\)/.test(appSrcD),
      '预勾选时清空搜索词（否则"已选 12 项"配一个空网格）');
  }

  /* --------------------------------------------- 右键「发送到」→ 快捷启动（v1.6.0）
     用户：文件右键 → 发送到 → 多一项「快捷启动」，一键把文件/快捷方式加进来。
     实现：SendTo 目录放一条指向本 exe 的 .lnk；系统把文件路径当参数再起一个实例，
     second-instance 里挑出路径走导入链路（与拖入同一套）。
     ------------------------------------------------------------------ */
  section('右键「发送到」快捷启动');
  {
    const mainSrcS = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const appSrcS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

    // 默认关：往系统 SendTo 目录写东西必须是用户主动开
    ok(store.defaultConfig().settings.sendTo === false, '★ 默认关闭（要主动开才往 SendTo 写快捷方式）');

    // 主进程：创建 / 删除 + 参数解析只有一份实现
    ok(/function applySendTo/.test(mainSrcS) && /function createSendToLink/.test(mainSrcS),
      '创建 / 删除 SendTo 快捷方式只有一份实现');
    ok(/appData'\), 'Microsoft', 'Windows', 'SendTo'/.test(mainSrcS),
      '落点在用户级 %APPDATA%\\Microsoft\\Windows\\SendTo（不用管理员权限）');
    ok(/WScript\.Shell/.test(mainSrcS) && /IconLocation/.test(mainSrcS),
      '用 WScript.Shell 建 .lnk（带图标，指向当前 exe）');
    ok(/function sendToPathsFromArgs/.test(mainSrcS) && /!a\.startsWith\('--'\)/.test(mainSrcS),
      '从 argv 挑文件路径时过滤掉自己的 -- 开关');
    ok(/sendToPathsFromArgs\(argv\)/.test(mainSrcS) && /paths: paths\.length \? paths : \[\]/.test(mainSrcS),
      'second-instance 挑出文件路径透传给渲染层');

    // 渲染层：带 paths 就是一次导入请求
    ok(/function handleSendTo/.test(appSrcS)
      && /importAndShow\(\{ paths: \(paths \|\| \[\]\)\.filter\(Boolean\)/.test(appSrcS),
      '「发送到」走导入链路（与拖入同一套，落桶 + 一键分配）');
    ok(/function importAndShow/.test(appSrcS),
      '导入结果处理只有一份实现（拖入与发送到共用，防漂移）');
    ok(/info\.paths/.test(appSrcS), 'second-instance 订阅里识别带文件的请求');

    // 设置项：字段贯通 DOM → patch → 主进程
    ok((appSrcS.match(/sendTo:\s*\$\('#sSendTo'\)\.checked/g) || []).length >= 2,
      'sendTo 字段贯通 settingsFromDom 与 saveSettings（未保存提示不会漏）');
  }

  /* -------------------------------- 常用网站：前两项固定（v1.5.1） */
  section('常用网站：第一项 Google、第二项百度');
  {
    const w = store.buildGroups().find(g => g.id === 'web');
    ok(!!w && w.items.length >= 2, '「常用网站」分组存在');
    ok(store.hostOf(w.items[0].path) === 'google.com', `默认第一项是 Google（实际 ${w.items[0].name}）`);
    ok(store.hostOf(w.items[1].path) === 'baidu.com', `默认第二项是百度（实际 ${w.items[1].name}）`);
    ok(w.items.every(i => i.type === 'url'), '常用网站都是网址类型');
    ok(w.items.length >= 6, `原有站点一个没丢（共 ${w.items.length} 项）`);

    // hostOf 是「按域名认项」的地基：改名/换图标都不影响识别
    ok(store.hostOf('https://www.google.com/') === 'google.com', '去 www');
    ok(store.hostOf('http://WWW.Baidu.com/s?wd=1') === 'baidu.com', '小写 + 去路径');
    ok(store.hostOf('https://www.google.com.hk/') === 'google.com.hk', '域名原样（google.com.hk 也算 Google）');
    ok(store.hostOf('https://localhost:3000/x') === 'localhost', '去端口');
    ok(store.hostOf('') === '' && store.hostOf('notepad.exe') === '', '非网址 → 空串');

    // 老配置（<= v1.5.0）：GitHub 第一、阿里云第二，压根没有 Google / 百度
    const old = store.defaultConfig();
    const web = old.groups.find(g => g.id === 'web');
    web.items = [
      store.newItem('GitHub', '🐙', 'url', 'https://github.com/qzrsa'),
      store.newItem('阿里云控制台', '☁️', 'url', 'https://ecs.console.aliyun.com/'),
      store.newItem('我的收藏夹', '⭐', 'url', 'https://example.com/'),
    ];
    const r1w = store.ensureWebOrder(old);
    ok(r1w.changed === true && r1w.added === 2, '老配置补上 Google / 百度两项');
    ok(store.hostOf(web.items[0].path) === 'google.com' && store.hostOf(web.items[1].path) === 'baidu.com',
      '★ 补在最前两位，不是追加到末尾');
    ok(web.items.length === 5, '原有 3 项一个都不丢');
    ok(web.items[2].path === 'https://github.com/qzrsa'
      && web.items[3].path === 'https://ecs.console.aliyun.com/'
      && web.items[4].path === 'https://example.com/', '其余项保持原来的相对顺序');
    ok(old.settings.webOrderRev === store.WEB_ORDER_REV, '置 webOrderRev 标记');

    // 幂等：再跑一次什么都不做
    const r2w = store.ensureWebOrder(old);
    ok(r2w.changed === false && r2w.added === 0, '★ 只跑一次（幂等）');

    // 已有 Google / 百度 但排在后面 → 挪上来，**不重新造**（收藏与使用次数一起搬）
    const mid = store.defaultConfig();
    const web2 = mid.groups.find(g => g.id === 'web');
    web2.items = [
      store.newItem('GitHub', '🐙', 'url', 'https://github.com/qzrsa'),
      store.newItem('搜中文', '🐾', 'url', 'https://www.baidu.com/', { favorite: true, useCount: 99 }),
      store.newItem('Google 香港', '🔍', 'url', 'https://www.google.com.hk/'),
    ];
    const baiduId = web2.items[1].id;
    const r3w = store.ensureWebOrder(mid);
    ok(r3w.added === 0 && r3w.moved === 1, `已有项只挪不新增（挪动 ${r3w.moved} 项）`);
    ok(web2.items.length === 3, '总项数不变');
    ok(store.hostOf(web2.items[0].path) === 'google.com.hk', '★ google.com.hk 也认作 Google，排第一');
    ok(web2.items[1].id === baiduId, '★ 改过名的百度排第二（按域名认，不按名字）');
    ok(web2.items[1].favorite === true && web2.items[1].useCount === 99, '收藏与使用次数一起跟着搬');

    // rev 之后是用户的顺序，再也不干预。
    // ★★ 前提：defaultConfig() 里**绝不能**出现 webOrderRev —— load() 会拿默认值补字段，
    //    默认值一旦带上 rev，老配置一读进来就被标成"已修正"，迁移永远不跑（静默失效）。
    ok(!('webOrderRev' in store.defaultConfig().settings),
      '★ defaultConfig 不含 webOrderRev（否则 load 补齐后迁移永远不跑）');

    const later = store.defaultConfig();
    later.settings.webOrderRev = store.WEB_ORDER_REV;   // 模拟"已经修正过"
    const web3 = later.groups.find(g => g.id === 'web');
    web3.items.reverse();
    const firstAfter = web3.items[0].id;
    const r4w = store.ensureWebOrder(later);
    ok(r4w.changed === false, '★ rev 已置位后不再动用户的顺序');
    ok(web3.items[0].id === firstAfter, '顺序原样（真实分组里用户自己拖过的顺序必须尊重）');

    // 分组被删了 → 只记标记，不报错、不凭空建组（恢复默认会按新顺序整组补回）
    const noWeb = store.defaultConfig();
    noWeb.groups = noWeb.groups.filter(g => g.id !== 'web');
    const r5w = store.ensureWebOrder(noWeb);
    ok(r5w.changed === true && r5w.added === 0, '没有该分组时不报错、不凭空建组');
    ok(noWeb.groups.length === 3, '分组数没变');

    // 接线：必须跑在 whenReady 里，且排在 createWindow() 之前
    const mainSrcW = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const bootAt = mainSrcW.indexOf('app.whenReady()');
    const bootSrcW = bootAt >= 0 ? mainSrcW.slice(bootAt, bootAt + 2600) : '';
    ok(/store\.ensureWebOrder\(/.test(bootSrcW), '主进程启动时调用 ensureWebOrder');
    ok(bootSrcW.indexOf('store.ensureWebOrder(') < bootSrcW.indexOf('createWindow();'),
      '★ 修正排在 createWindow() 之前（否则首屏先铺旧顺序，再闪一下变成新的）');

    const appSrcW = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    ok(/name: 'Google'/.test(appSrcW) && /name: '百度'/.test(appSrcW), '预览模式的 demo 数据也同步了前两项');
  }

  section('urlshortcut .url 快捷方式（协议 + 图标）');
  const urlsc = require('../src/lib/urlshortcut');

  // 真实文件长这样（本机 11 个桌面游戏快捷方式都是这个形状，CRLF / LF 都有）
  const scText = '[InternetShortcut]\r\nIDList=\r\nIconIndex=0\r\n'
    + 'URL=steam://rungameid/400040\r\nIconFile=C:\\icons\\game.ico\r\n';
  const scOne = urlsc.parseInternetShortcut(scText);
  ok(!!scOne && scOne.url === 'steam://rungameid/400040', '解析出 URL=');
  ok(scOne.iconFile === 'C:\\icons\\game.ico', '解析出 IconFile=');
  ok(scOne.iconIndex === 0, '解析出 IconIndex=');
  ok(urlsc.parseInternetShortcut('not a shortcut') === null, '没有 URL= 行 → null');
  ok(urlsc.parseInternetShortcut('') === null, '空文本 → null');
  ok(urlsc.parseInternetShortcut('[InternetShortcut]\nURL="https://a.b/x"\n').url === 'https://a.b/x',
    'URL 值带引号 → 去掉引号');
  ok(urlsc.parseInternetShortcut('\uFEFF[InternetShortcut]\r\nURL=https://a.b\r\n').url === 'https://a.b',
    '带 BOM 也能解析');
  ok(urlsc.parseInternetShortcut('URL=ftp://x/y\n').iconFile === '', '没有 IconFile → 空串（不报错）');

  // ★ 双层协议：v1.4.3 及以前把 `steam://` 当成裸网址又套了一层 http://
  ok(urlsc.normalizeUrl('steam://rungameid/400040') === 'steam://rungameid/400040',
    '★ 协议链接原样保留（这套错一层就点不开）');
  ok(urlsc.normalizeUrl('fevergames://mygame/?gameId=63') === 'fevergames://mygame/?gameId=63',
    '自定义协议原样保留');
  ok(urlsc.normalizeUrl('https://a.b/c') === 'https://a.b/c', 'https 原样');
  ok(urlsc.normalizeUrl('github.com') === 'http://github.com', '裸域名补 http://');
  ok(urlsc.normalizeUrl('localhost:3000') === 'http://localhost:3000', 'host:port 不当成协议');
  ok(urlsc.normalizeUrl('') === '', '空串 → 空串');
  ok(urlsc.stripBogusScheme('http://steam://rungameid/1') === 'steam://rungameid/1', '修双层协议');
  ok(urlsc.stripBogusScheme('http://fevergames://x/?g=1') === 'fevergames://x/?g=1', '修双层协议（自定义）');
  ok(urlsc.stripBogusScheme('https://github.com/x') === '', '正常网址不动');
  ok(urlsc.stripBogusScheme('http://a.b:8080/x') === '', 'host:port 不动');
  ok(urlsc.schemeOf('STEAM://x') === 'steam', 'schemeOf 取小写协议名');
  // 协议链接没有"主机名"：new URL('steam://rungameid/1').hostname === 'rungameid'
  ok(urlsc.descForUrl('steam://rungameid/1') === 'steam',
    '★ 协议链接的说明 = 协议名（不是 hostname `rungameid`）');
  ok(urlsc.descForUrl('https://www.github.com/x') === 'github.com', '网页说明 = 主机名（去 www）');
  ok(urlsc.urlKey('HTTPS://A.B/x/') === 'https://a.b/x', 'urlKey 忽略大小写与结尾斜杠');

  // 假 fs：递归扫目录 + 建索引（不碰真磁盘）
  const vtree = {
    'C:\\dd': [{ name: 'a.url', isDirectory: () => false },
      { name: 'note.txt', isDirectory: () => false },
      { name: 'sub', isDirectory: () => true }],
    'C:\\dd\\sub': [{ name: 'b.url', isDirectory: () => false }],
  };
  const vtext = {
    'C:\\dd\\a.url': 'URL=steam://1\nIconFile=C:\\a.ico\n',
    'C:\\dd\\sub\\b.url': 'URL=https://b.c/\n',
  };
  const vfs = {
    readdirSync: d => { if (!vtree[d]) throw new Error('ENOENT'); return vtree[d]; },
    readFileSync: p => { if (!vtext[p]) throw new Error('ENOENT'); return vtext[p]; },
  };
  const found = urlsc.scanUrlShortcuts(['C:\\dd'], { fs: vfs });
  ok(found.length === 2, `递归扫到 2 个 .url（实得 ${found.length}）`);
  ok(found[0].url === 'steam://1' && found[0].file === 'C:\\dd\\a.url', '先扫根目录，带回源文件路径');
  ok(found[1].url === 'https://b.c/', '子目录也扫到了');
  ok(urlsc.scanUrlShortcuts(['C:\\nope'], { fs: vfs }).length === 0, '目录不存在 → 空数组（不抛）');
  const vix = urlsc.iconFileIndex(found);
  ok(vix.get('steam://1') === 'C:\\a.ico', '索引：URL → IconFile');
  ok(urlsc.iconFileIndex([{ url: 'https://b.c/' }, { url: 'x', iconFile: 'y.ico' }]).size === 1,
    '没有 IconFile 的快捷方式不进索引');
  ok(urlsc.defaultScanDirs({ USERPROFILE: 'C:\\U', APPDATA: 'C:\\U\\AppData\\Roaming' }).length === 4,
    '默认扫桌面 + 公共桌面 + 两个开始菜单');

  // 真实 .url 读盘（有就顺手验一把，没有也不红）
  const scReal = urlsc.readUrlShortcut(urlP);
  ok(!!scReal && scReal.url === 'https://github.com/qzrsa', 'readUrlShortcut 读真实文件');
  ok(urlsc.readUrlShortcut(badUrlP) === null, '不是快捷方式的文件 → null');

  /* ---------------------------------------------------------- 搜索拼音匹配（v1.4.6） */
  section('搜索：拼音（全拼 / 首字母）匹配中文名');
  // ★ pinyin-pro 是本地 vendored 的 UMD（renderer/pinyin-pro.js，v3.29.5），
  //   在 node 里也能 require（走 exports 分支），所以这里能直接验转换结果，
  //   顺带锁定"库没被换掉 / 全局名没改"。
  const pinyinPro = require('../renderer/pinyin-pro.js');
  ok(!!pinyinPro && typeof pinyinPro.pinyin === 'function', 'pinyin-pro 加载成功（UMD）');
  const pyFull = s => pinyinPro.pinyin(s, { toneType: 'none', type: 'string' }).replace(/\s+/g, '').toLowerCase();
  const pyFirst = s => pinyinPro.pinyin(s, { toneType: 'none', type: 'string', pattern: 'first' })
    .replace(/\s+/g, '').toLowerCase();
  ok(pyFull('记事本') === 'jishiben', '记事本 全拼 = jishiben', pyFull('记事本'));
  ok(pyFirst('记事本') === 'jsb', '记事本 首字母 = jsb', pyFirst('记事本'));
  ok(pyFull('微信') === 'weixin' && pyFirst('微信') === 'wx', '微信 = weixin / wx');
  ok(pyFull('重庆') === 'chongqing', '多音字按常见读音（重庆 = chongqing）', pyFull('重庆'));

  // 渲染层接线（静态对账）：index.html 先引入 pinyin-pro 再引入 app.js；matches 里真的用到它
  const searchHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const searchJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const ppPos = searchHtml.indexOf('pinyin-pro.js');
  const appPos = searchHtml.indexOf('app.js');
  ok(ppPos !== -1 && appPos !== -1 && ppPos < appPos,
    '★ index.html 里 pinyin-pro.js 在 app.js 之前引入（否则 window.pinyinPro 是 undefined）');
  ok(/function pinyinKeys/.test(searchJs), '渲染层有 pinyinKeys()（名字 → 全拼 + 首字母）');
  ok(/window\.pinyinPro\.pinyin\(name/.test(searchJs), '★ 用的是 window.pinyinPro（全局名，别手写错）');
  ok(/pinyinKeys\(name\)/.test(searchJs) && /function matches/.test(searchJs),
    '★ matches() 里挂了拼音匹配分支');
  ok(/!\/\[\\u4e00-\\u9fff\]\/\.test\(q\)/.test(searchJs),
    '★ 查中文时跳过拼音转换（只在纯字母/数字查询词时才转换，省得白算）');
  ok(/pinyinCache/.test(searchJs) && /Map/.test(searchJs), '拼音结果按 name 缓存（搜索时上千项不卡）');
  ok(/搜索名称、路径或描述，拼音也行/.test(searchHtml), '搜索框占位文案提示了支持拼音');

  /* ---------------------------------------------------------- 侧栏分组拖动排序（v1.4.7） */
  section('侧栏分组：拖动改变顺序');
  const navCss = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'style.css'), 'utf8');
  ok(/function reorderGroup/.test(searchJs), '渲染层有 reorderGroup()（splice 移动分组顺序）');
  ok(/const gs = state\.config\.groups/.test(searchJs) && /gs\.splice/.test(searchJs),
    '★ 排序就是改 state.config.groups 数组顺序（splice 移动，别无第二份数据源）');
  ok(/draggable="true"/.test(searchJs), 'renderNav 给分组行加了 draggable="true"');
  ok((searchJs.match(/draggable="true"/g) || []).length === 1,
    '★ draggable 只出现在真实分组那一行（「全部/最近/收藏」和「新建分组」不可拖）');
  ok(/addEventListener\('dragstart'/.test(searchJs) && /addEventListener\('dragover'/.test(searchJs)
    && /addEventListener\('drop'/.test(searchJs) && /addEventListener\('dragend'/.test(searchJs),
    '★ 四个拖拽事件都挂上了（dragstart / dragover / drop / dragend）');
  ok(/const navGroupAt = e =>/.test(searchJs) && /state\.config\.groups\.find\(g => g\.id === btn\.dataset\.nav\)/.test(searchJs),
    '★ navGroupAt 只在真实分组里找（虚拟视图 / 新建分组当不了拖拽落点）');
  ok(/setData\('text\/plain'/.test(searchJs), '★ dragstart 里 setData 了（Firefox 缺这个不触发拖拽）');
  ok(/requestAnimationFrame/.test(searchJs) && /\.dragging/.test(searchJs),
    '拖影半透明等下一帧再上（避免拖影带上透明度）');
  ok(/reorderGroup\(fromId, g\.id/.test(searchJs), 'drop 时调用 reorderGroup(fromId, g.id, 上半/下半)');
  ok(/\.drop-before/.test(navCss) && /\.drop-after/.test(navCss), '★ CSS 有 drop-before / drop-after 两条插入线');
  ok(/\.nav-item\[draggable="true"\]\s*\{\s*cursor:\s*grab/.test(navCss), '可拖分组鼠标悬停是抓手 cursor:grab');
  ok(/\.nav-item\.dragging\s*\{\s*opacity:\s*\.45/.test(navCss), '拖拽中源行半透明（opacity .45）');

  /* ---------------------------------------------------------- 图标提取 */
  /* ---- 从 PE 资源里抠图标（v1.4.5 的核心：不再信 app.getFileIcon）---- */
  section('exeicon 从 PE 里抠图标');
  const exeicon = require('../src/lib/exeicon');
  ok(typeof exeicon.parseIcon === 'function' && typeof exeicon.readIconResource === 'function',
    'exeicon 暴露 parseIcon / readIconResource');
  const selfBuf = fs.readFileSync(process.execPath);
  const selfIco = exeicon.parseIcon(exeicon.bufferReader(selfBuf));
  ok(Buffer.isBuffer(selfIco) && selfIco.length > 100, '真 exe（本进程自己）解出 ICO 字节');
  ok(selfIco && selfIco.readUInt16LE(0) === 0 && selfIco.readUInt16LE(2) === 1,
    '★ 拼出来的头是合法 ICONDIR（reserved=0 / type=1）');
  ok(selfIco && selfIco.readUInt16LE(4) >= 1, '至少含 1 张图', selfIco && String(selfIco.readUInt16LE(4)));
  ok(exeicon.parseIcon(exeicon.bufferReader(Buffer.from('MZ'))) === null,
    '只有 MZ 头的残片 → null（不抛）');
  ok(exeicon.parseIcon(exeicon.bufferReader(Buffer.from('not a pe at all'))) === null, '不是 PE → null');
  ok(exeicon.parseIcon(exeicon.bufferReader(Buffer.alloc(0))) === null, '空 buffer → null');
  // 指定一个不存在的组 → null（不许"猜"一张别的图顶上）
  ok(exeicon.parseIcon(exeicon.bufferReader(selfBuf), { group: 99 }) === null,
    '★ 指定的图标组不存在 → null（不拿别组的图凑数）');
  // .url 的 IconIndex 0 就该拿到东西（大多数程序只有一组，组 0 就是主图标）
  ok(Buffer.isBuffer(exeicon.parseIcon(exeicon.bufferReader(selfBuf), { group: 0 })),
    'group=0 取第一组图标');
  ok(exeicon.readIconResource(process.execPath) === null || Buffer.isBuffer(exeicon.readIconResource(process.execPath)),
    'readIconResource 对真文件返回 Buffer / null 之一');
  ok(Buffer.isBuffer(exeicon.readIconResource(process.execPath)), 'readIconResource 读真 exe 有结果');
  ok(exeicon.readIconResource('C:\\__nope__\\x.exe') === null, '不存在的文件 → null（不抛）');
  ok(exeicon.readIconResource('') === null, '空路径 → null');
  const cacheA = exeicon.readIconResource(process.execPath);
  exeicon.clearCache();
  const cacheB = exeicon.readIconResource(process.execPath);
  ok(cacheA && cacheB && cacheA.equals(cacheB), '清了缓存重读，结果一致（幂等）');
  ok(exeicon.MAX_ICO_BYTES > 0 && exeicon.MAX_ICO_BYTES <= 4 * 1024 * 1024,
    'MAX_ICO_BYTES 有上限（防巨型资源）', String(exeicon.MAX_ICO_BYTES));

  /* ---- Win10/11 的「图标搬家」：%SystemRoot%\SystemResources\<名字>.mun ----
     本机实测：notepad.exe / mspaint.exe / mstsc.exe / magnify.exe / dfrgui.exe / shell32.dll
     这些文件的资源表里**一张图标都没有**（只剩 RT_VERSION / RT_MANIFEST），图标全在
     同名的 .mun MUI 文件里。不接这条路，记事本/画图/远程桌面就是永远修不好的通用图。
     ★ 这条断言必须**自适应**：Windows Server 的 runner 常常没有 SystemResources\*.mun
       （那边图标还在文件本体里）。写死"必须有 .mun"会让 CI 红在本机绿 —— 第一版就是这么翻的。 */
  ok(typeof exeicon.munFor === 'function', 'exeicon 暴露 munFor');
  const npPath = path.join(process.env.SystemRoot, 'System32', 'notepad.exe');
  const npMun = fs.existsSync(npPath) ? exeicon.munFor(npPath, fs) : '';
  if (npMun) {
    ok(/SystemResources/i.test(npMun) && /notepad\.exe\.mun$/i.test(npMun),
      '★ notepad.exe → 找到 SystemResources\\notepad.exe.mun', npMun);
    const npIco = exeicon.readIconResource(npPath);
    ok(Buffer.isBuffer(npIco) && npIco.length > 1000,
      '★ 记事本（资源表里没有图标）→ 从 .mun 里抠到了图标', npIco && String(npIco.length));
  } else {
    ok(true, '这台机没有 SystemResources\\notepad.exe.mun（Server 版常见），跳过 .mun 断言');
  }
  ok(exeicon.munFor('C:\\__nope__\\x.exe', fs) === '', '找不到 .mun → 空串（不抛）');
  ok(exeicon.munFor(path.join(process.env.SystemRoot, 'SystemResources', 'a.dll.mun'), fs) === '',
    '.mun 自己不再去套 .mun（不然无限递归）');
  ok(exeicon.munFor('', fs) === '', '空路径 → 空串');
  const munSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'exeicon.js'), 'utf8');
  ok(/SystemResources/.test(munSrc), '★ 源码里写死了 SystemResources（唯一的 .mun 位置）');
  ok(/deps\.mun !== false/.test(munSrc), '回退可关闭（单测/诊断要能只看文件本身）');
  // ★ 静态对账：icon.js 取 exe 图标必须经 exeicon，不许退回 getFileIcon
  const iconLibSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'icon.js'), 'utf8');
  ok(/require\('\.\/exeicon'\)/.test(iconLibSrc), 'icon.js 引入 exeicon（唯一实现）');
  ok(/\.\(exe\|dll\|cpl\|scr\|ocx\)\$/.test(iconLibSrc), 'icon.js 对可执行扩展名走 PE 解析');
  ok(/createFromBuffer/.test(iconLibSrc) === false || /不支持/.test(iconLibSrc),
    '★ 没有拿 createFromBuffer 去喂 ICO（它不认，会得到空图）');
  ok(/unlinkSync/.test(iconLibSrc), '临时 ico 读完就删（不往系统临时目录堆垃圾）');
  const mainSrcPe = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  ok(/require\('\.\/lib\/icon'\)/.test(mainSrcPe) || /lib\/icon/.test(mainSrcPe),
    'main.js 的图标 IPC 仍走 lib/icon（不要在 main 里另开一份实现）');

  section('icon.js 图标提取与判定');
  const iconMod = require('../src/lib/icon');
  ok(typeof iconMod.isImageIcon === 'function', 'icon.js 暴露 isImageIcon');
  ok(iconMod.isImageIcon('data:image/png;base64,xxx') === true, 'data: 开头判为图片图标');
  ok(iconMod.isImageIcon('data:image/png;base64,'.replace('data:', 'data:')) === true, 'data:image 前缀识别（PNG）');
  ok(iconMod.isImageIcon('🚀') === false, 'emoji 不是图片图标');
  ok(iconMod.isImageIcon('') === false, '空串不是图片图标');
  ok(iconMod.isImageIcon(null) === false, 'null 不是图片图标');
  ok(iconMod.isImageIcon('data:text/plain;base64,xxx') === false, '非 image 的 data: 不算图片图标');
  ok(typeof iconMod.imageToDataUrl === 'function', 'icon.js 暴露 imageToDataUrl');
  ok(iconMod.imageToDataUrl(null) === '', 'null 图片转 dataURL → 空（不抛）');
  ok(iconMod.imageToDataUrl({ isEmpty: () => true }) === '', '空图片转 dataURL → 空');
  ok(typeof iconMod.MAX_NATIVE === 'number' && iconMod.MAX_NATIVE > 0, 'MAX_NATIVE 有合理值');
  ok(typeof iconMod.fileDefaultIconToDataUrl === 'function', 'icon.js 暴露 fileDefaultIconToDataUrl');
  ok(typeof iconMod.imageFileToDataUrl === 'function', 'icon.js 暴露 imageFileToDataUrl');
  /* v1.4.5：`.exe` 不再问系统，自己解 PE 资源。
     ★ app.getFileIcon 在本机对 notepad.exe / QuickLaunch.exe / clash-verge.exe 只回同一张
       32×32 通用图（哈希相同），对 python.exe / WeaselServer.exe 又给 48×48 真图 —— 不能依赖。 */
  stub.__lastIconPath = null;
  const icReal = await iconMod.fileDefaultIconToDataUrl(process.execPath, 128);
  ok(icReal === 'data:image/png;base64,ICO', '真 exe → 解 PE 拿到图标', icReal);
  ok(stub.__lastIconPath === null, '★ 取 exe 图标时**没有**走 getFileIcon（它就爱回通用图）');
  // 没有图标资源的 exe（假文件）→ 空，保持 emoji，别拿通用图糊
  const icFake = await iconMod.fileDefaultIconToDataUrl(exeP, 128);
  ok(icFake === '', '没有图标资源的 exe → 空（不拿通用图糊上去）', icFake);
  // ★ 不存在的路径必须返回空（否则会给"稍后才接入的盘"挂上通用白板图标，而不是保持 emoji）
  const icMissing = await iconMod.fileDefaultIconToDataUrl('C:\\__nope__\\x.exe', 128);
  ok(icMissing === '', '不存在的路径 → 空（不会拿到通用假图标）', icMissing);
  // %ENV% 展开：%SystemRoot%\explorer.exe 应被当成真实存在（同样自适应资源是否存在）
  const icEnv = await iconMod.fileDefaultIconToDataUrl('%SystemRoot%\\explorer.exe', 128);
  if (Buffer.isBuffer(exeicon.readIconResource(path.join(process.env.SystemRoot, 'explorer.exe')))) {
    ok(icEnv === 'data:image/png;base64,ICO', '%ENV% 展开后按存在处理', icEnv);
  } else {
    ok(true, '这台机的 explorer.exe 没有可抠的图标资源，跳过 %ENV% 断言');
  }

  /* ---- .url 的 IconFile：只能 nativeImage 直读 ----
     1.4.3 之前的真实事故：11 个桌面游戏快捷方式（Steam / FeverGames）全是同一个 🌐。
     本机实测：对 `.ico` 调 app.getFileIcon **回同一张 32×32 通用图**（多文件同哈希），
     nativeImage.createFromPath 才是 256×256 且 11 个文件 11 张不同图。 */
  ok(typeof iconMod.urlIconFileToDataUrl === 'function', 'icon.js 暴露 urlIconFileToDataUrl');
  const icoFileP = mk('game-icon.ico');
  ok(iconMod.urlIconFileToDataUrl(icoFileP, 128) === 'data:image/png;base64,ICO',
    'IconFile 存在 → 读到图片（走 nativeImage，不是 getFileIcon）');
  stub.__lastIconPath = null;
  ok(iconMod.urlIconFileToDataUrl('C:\\__nope__\\gone.ico') === '', 'IconFile 不存在 → 空（保持 emoji）');
  ok(iconMod.urlIconFileToDataUrl(mk('container.dll')) === '',
    '.dll 多图标容器读不了 → 空（要 IconIndex 才有意义，别硬凑假图）');
  ok(stub.__lastIconPath === null,
    '★ 取 .ico 时**不许**调 getFileIcon（它对 .ico 只回通用图）');

  /* ---- .lnk 必须解析出目标再取图标 ----
     1.3.1 的真实事故：开始菜单里 173 个 .lnk 拿到的图标**哈希完全一样**（一张 32×32 通用图），
     界面上就是"一片空白"，而桌面上都正常。真机实测 4/4 解析出 target 后各不相同。 */
  ok(typeof iconMod.shortcutTarget === 'function', 'icon.js 暴露 shortcutTarget');
  const lnkP = mk('desk-shortcut.lnk');
  const tgtP = mk('target-app.exe');
  stub.__lnk = { [lnkP]: { target: tgtP, icon: '', args: '' } };
  ok(iconMod.shortcutTarget(lnkP) === tgtP, '.lnk → 解析出真实目标');
  /* v1.4.5：目标既然是 .exe，就去解它的 PE —— 桩里 tgtP 是随便写的假文件（没有资源），
     于是返回空。真正要守的是「.lnk 的图标只能来自它解析出的目标」，所以再拿一个真 exe 验一遍。 */
  stub.__lnk = { [lnkP]: { target: process.execPath, icon: '', args: '' } };
  stub.__lastIconPath = null;
  const icLnk = await iconMod.fileDefaultIconToDataUrl(lnkP, 128);
  ok(icLnk === 'data:image/png;base64,ICO', '.lnk 也能提出图标');
  ok(stub.__lastIconPath === null,
    '★ .lnk 走的也是「解析目标 + 解 PE」，没退回 getFileIcon（它对 .lnk 只回通用图）');
  // 目标是别的类型的可执行文件（假文件，无 PE 资源）→ 空，不能拿通用图糊
  stub.__lnk = { [lnkP]: { target: tgtP, icon: '', args: '' } };
  ok(await iconMod.fileDefaultIconToDataUrl(lnkP, 128) === '',
    '.lnk 的目标没有图标资源 → 空（保持 emoji）');
  // 目标不存在 → 不采信，退回 .lnk 自身
  stub.__lnk = { [lnkP]: { target: 'C:\\__nope__\\gone.exe', icon: '' } };
  ok(iconMod.shortcutTarget(lnkP) === '', '目标不存在 → 不被采信');
  // 自定义 .ico 优先
  const icoP = mk('my-custom.ico');
  stub.__lnk = { [lnkP]: { target: tgtP, icon: icoP } };
  ok(iconMod.shortcutTarget(lnkP) === icoP, '.lnk 指定了 .ico → 优先用这张');
  /* v1.4.5：`.lnk` 的 icon 指向 `.dll` / `.exe` 时要按 `iconIndex` 去那个 PE 里取"那一张"。
     本机实例：iSCSI Initiator.lnk 的 icon = iscsicpl.dll + iconIndex=-1，而它的 target
     `iscsicpl.exe` 自己一张图标都没有 —— 以前直接忽略 .dll，这类程序只能退回通用图。 */
  stub.__lnk = { [lnkP]: { target: tgtP, icon: 'C:\\Windows\\system32\\shell32.dll', iconIndex: 3 } };
  const dllSrc = iconMod.shortcutSource(lnkP);
  ok(dllSrc && /shell32\.dll$/i.test(dllSrc.path) && dllSrc.group === 3,
    '★ icon 指向 .dll + iconIndex=3 → 记住「取第 3 组」', JSON.stringify(dllSrc));
  ok(iconMod.shortcutTarget(lnkP) === 'C:\\Windows\\system32\\shell32.dll',
    '旧接口 shortcutTarget 仍只回路径（别的地方还在用）');
  stub.__lnk = { [lnkP]: { target: tgtP, icon: 'C:\\Windows\\system32\\shell32.dll', iconIndex: -1 } };
  const dllNeg = iconMod.shortcutSource(lnkP);
  ok(dllNeg && dllNeg.id === 1 && dllNeg.group === undefined,
    '★ 负数 iconIndex = 资源 ID 就是 -N（-1 → id 1），不是"第 -1 组"', JSON.stringify(dllNeg));
  stub.__lnk = { [lnkP]: { target: tgtP, icon: 'C:\\Windows\\system32\\shell32.dll', iconIndex: 0 } };
  // ★ 自适应：这台机的 shell32.dll 能不能取到图标（有没有 .mun）不该由断言写死 ——
  //   CI 的 Windows Server 与本机不一样，写死就变成"本机绿、CI 红"。
  const shProbe = exeicon.readIconResource('C:\\Windows\\system32\\shell32.dll');
  if (Buffer.isBuffer(shProbe)) {
    ok(await iconMod.fileDefaultIconToDataUrl(lnkP, 128) === 'data:image/png;base64,ICO',
      '★ 从 dll 的第 0 组真拿到了图标（走 PE，不碰 getFileIcon）');
  } else {
    ok(true, '这台机的 shell32.dll 取不到图标，跳过 dll 组断言');
  }
  stub.__lnk = { [lnkP]: { target: tgtP, icon: 'C:\\Windows\\system32\\shell32.dll', iconIndex: 9999 } };
  ok(await iconMod.fileDefaultIconToDataUrl(lnkP, 128) === '',
    '★ 指定的那组不存在 → 空（绝不拿别组的图凑数，那比留空更难查）');
  ok(iconMod.shortcutSource('C:\\__nope__\\broken.lnk') === null, '读不了 .lnk → null 且不抛');
  // 读不了 .lnk → 空且不抛
  ok(iconMod.shortcutTarget('C:\\__nope__\\broken.lnk') === '', '读不了 .lnk → 返回空且不抛');
  stub.__lnk = {};

  // 渲染层判定函数与主进程同一约定（静态对账：app.js 里必须是正则 data:image 开头）
  const iconAppSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const iconHtmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const iconStoreSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'store.js'), 'utf8');
  /* ---- 老数据自愈（<=1.3.1 存进去的是通用占位图，光修提取逻辑救不了存量数据）---- */
  ok(/iconRev: 1/.test(iconStoreSrc), 'store 默认值带 iconRev（一次性自愈的开关）');
  ok(/function reextractIcons/.test(iconAppSrc), '渲染层有 reextractIcons()（补老数据的图标）');
  ok(/function placeholderIconItems/.test(iconAppSrc), '渲染层有 placeholderIconItems()（挑出占位图条目）');
  ok(/\(use\.get\(ic\) \|\| 0\) >= 3/.test(iconAppSrc),
    '★ 只挑「同一张图被 >=3 个条目共用」的项 —— 用户自己挑的图片不会被冲掉');
  ok(/isImageIcon\(ic\) && \(use\.get\(ic\) \|\| 0\) >= 3 && GENERIC_ICON_PATH\.test/.test(iconAppSrc),
    '★ 自愈只处理 .lnk / .exe / .url 条目（通用占位图就是它们贡献的）');
  ok(/GENERIC_ICON_PATH = \/\\\.\(lnk\|exe\|url\)\$\/i/.test(iconAppSrc),
    '★ 通用图标污染的路径类型是 .lnk/.exe/.url（.exe 那批是 v1.4.5 才认的）');
  ok(/settings\.iconRev = ICON_REV/.test(iconAppSrc), '自愈跑完会写回 iconRev，避免每次启动重扫');
  // v1.4.5：`.exe` 自己解 PE 了 → rev 升到 4，存量数据里那批"窗口+蓝块"才会被重提
  ok(/const ICON_REV = 4/.test(iconAppSrc), 'ICON_REV 升到 4（.exe 通用图标修复也要补存量数据）');
  ok(/'🚀'/.test(iconAppSrc) && /cleared\+\+/.test(iconAppSrc),
    '★ 真取不到图标时退回 emoji（不许留一张通用白板当"坏了的图"）');
  ok(/function healUrlItems/.test(iconAppSrc) && /function healAllIcons/.test(iconAppSrc),
    '渲染层有 healUrlItems / healAllIcons（.url 先修协议补图标，再补 .lnk 占位图）');
  ok(/healAllIcons\(\{ quiet: true \}\)/.test(iconAppSrc),
    '启动时的一次性自愈走 healAllIcons（两条链路都不落下）');
  ok(/btnReextractIcons/.test(iconHtmlSrc) && /btnReextractIcons/.test(iconAppSrc),
    '设置里有「重新提取图标」手动入口');
  ok(/readShortcutLink/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'icon.js'), 'utf8')),
    '主进程用 shell.readShortcutLink 解析 .lnk（不是硬编码/手写 LNK 解析）');
  ok(/^data:image\//i.test('data:image/png;base64,x'), '数据URL格式约定可被 isImageIcon 识别');
  ok(/function iconHtml/.test(iconAppSrc), '渲染层有 iconHtml()（卡片/弹窗图片图标渲染）');
  ok(/function applyIcon/.test(iconAppSrc), '渲染层有 applyIcon()（选中图片/emoji 后统一刷新预览）');
  ok(/tile-img/.test(iconAppSrc), '卡片用图片图标的缩略图类');
  ok(/mh-img/.test(iconAppSrc), '弹窗头部图标支持图片缩略图');
  ok(/btnIconDefault/.test(iconHtmlSrc) && /btnIconPick/.test(iconHtmlSrc) && /btnIconClear/.test(iconHtmlSrc),
    '编辑弹窗有「还原默认图标 / 选择图片 / 清除自定义」三个按钮');
  ok(/API\.iconDefault\(/.test(iconAppSrc) && /API\.iconPick\(/.test(iconAppSrc),
    '渲染层接线了 iconDefault / iconPick 两个 IPC');
  // 主进程注册了对应 handle（静态对账）：main.js 里必须有这两条 IPC
  const iconMainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  ok(/ql:icon:default/.test(iconMainSrc) && /ql:icon:pick/.test(iconMainSrc),
    '主进程注册 ql:icon:default / ql:icon:pick 两个 handle');
  ok(/ipcMain\.handle\('ql:heal:urls'/.test(iconMainSrc) && /ipcMain\.handle\('ql:icon:url'/.test(iconMainSrc),
    '主进程注册 ql:heal:urls / ql:icon:url（.url 自愈的唯一实现，渲染层只叫一声）');
  ok(/urlsc\.stripBogusScheme/.test(iconMainSrc) && /urlsc\.scanUrlShortcuts/.test(iconMainSrc),
    '主进程复用 urlshortcut（修协议与扫盘都只有一份实现）');

  /* ---------------------------------------------------------- 数据目录 */
  section('datadir 数据目录决策');
  const datadir = require('../src/lib/datadir');

  ok(datadir.DATA_DIR_NAME === 'data', '数据子目录名叫 data');

  // ① 开发态：写在项目内，不碰真实配置
  const devRes = datadir.resolveDataDir({
    isPackaged: false, devDataDir: path.join(TMP, 'devUserData'),
    legacyDir: path.join(TMP, 'appdata'), programDir: path.join(TMP, 'prog'),
  });
  ok(devRes.dir === path.join(TMP, 'devUserData'), '开发态用项目内目录');
  ok(devRes.inProgramDir === false, '开发态标记为“不随程序走”');

  // ② 打包态 + 程序目录可写：数据落在 <程序目录>/data
  const progDir = path.join(TMP, 'prog');
  fs.mkdirSync(progDir, { recursive: true });
  const packRes = datadir.resolveDataDir({
    isPackaged: true, devDataDir: path.join(TMP, 'devUserData'),
    legacyDir: path.join(TMP, 'appdata'), programDir: progDir,
  });
  ok(packRes.dir === path.join(progDir, 'data'), '打包态数据落在 <程序目录>/data');
  ok(packRes.inProgramDir === true, '打包态标记为“数据随程序走”');
  ok(fs.existsSync(path.join(progDir, 'data')), '决策后目录真的被建出来了');

  // ③ 打包态 + 程序目录不可写：回落到系统目录，并且**说出来**
  //    —— 这条真实环境很难复现（Windows 上没法随手把目录变成只读），
  //       所以注入一个 mkdirSync 必抛的假 fs
  const failFs = {
    mkdirSync: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; },
    existsSync: () => false, writeFileSync: () => {}, unlinkSync: () => {}, copyFileSync: () => {},
  };
  const fallbackRes = datadir.resolveDataDir({
    isPackaged: true, devDataDir: path.join(TMP, 'devUserData'),
    legacyDir: path.join(TMP, 'appdata'), programDir: progDir, fs: failFs,
  });
  ok(fallbackRes.dir === path.join(TMP, 'appdata'), '程序目录不可写时回落到系统目录');
  ok(fallbackRes.inProgramDir === false, '回落时如实标记为“不随程序走”');
  ok(/不可写|回落/.test(fallbackRes.note), `回落原因会写进 note（实际：${fallbackRes.note}）`);

  // ④ 目标目录就是源目录时，迁移必须自己认出「这是同一个文件」而不是硬拷
  const selfDir = path.join(TMP, 'self');
  fs.mkdirSync(selfDir, { recursive: true });
  fs.writeFileSync(path.join(selfDir, 'config.json'), '{"groups":[]}');
  ok(datadir.migrateLegacyConfig(selfDir, selfDir) === false, '源与目标同一目录时不迁移');
  ok(fs.readFileSync(path.join(selfDir, 'config.json'), 'utf8') === '{"groups":[]}',
    '同一目录时文件内容没被动过');

  // ⑤ ensureWritable：真临时目录可写；路径落在一个**文件**底下则不可写（确定性失败）
  const wDir = path.join(TMP, 'writable-check');
  ok(datadir.ensureWritable(wDir) === true, '正常临时目录判定为可写');
  ok(!fs.existsSync(path.join(wDir, '.ql-write-probe-' + process.pid)),
    '探测文件用完被清掉了，不留下垃圾');
  const blocker = path.join(TMP, 'blocker.txt');
  fs.writeFileSync(blocker, 'x');
  ok(datadir.ensureWritable(path.join(blocker, 'sub')) === false,
    '路径穿过一个文件时判定为不可写（ENOTDIR）');

  // ⑥ migrateLegacyConfig：搬旧配置，但不能覆盖已有的新配置
  // ★ 先把 mig 目录清干净：下面第 1 条断言要求"新位置还没有配置"。
  //   如果上一次跑崩在收尾之前（崩溃路径早期没清 TMP），这里会读到残留的
  //   mig/data/config.json，断言就变成**偶发失败** —— 实测踩过：1/3 的概率报红，
  //   而且红的那次看不出和上一次崩溃有关。**测试自己必须先把状态摆平，不能依赖上一轮。**
  fs.rmSync(path.join(TMP, 'mig'), { recursive: true, force: true });
  const migTarget = path.join(TMP, 'mig', 'data');
  const migLegacy = path.join(TMP, 'mig', 'appdata');
  fs.mkdirSync(migLegacy, { recursive: true });
  fs.writeFileSync(path.join(migLegacy, 'config.json'), '{"groups":[]}');
  ok(datadir.migrateLegacyConfig(migTarget, migLegacy) === true, '新位置没有配置时会把旧的搬过来');
  ok(fs.existsSync(path.join(migTarget, 'config.json')), '迁移后新位置确实有 config.json');
  ok(fs.existsSync(path.join(migLegacy, 'config.json')), '旧位置用的是复制不是移动，原文件还在');
  fs.writeFileSync(path.join(migTarget, 'config.json'), '{"groups":[1]}');
  ok(datadir.migrateLegacyConfig(migTarget, migLegacy) === false, '新位置已有配置时不覆盖');
  ok(fs.readFileSync(path.join(migTarget, 'config.json'), 'utf8') === '{"groups":[1]}',
    '不覆盖意味着内容原样保留');
  ok(datadir.migrateLegacyConfig(migTarget, path.join(TMP, 'nope')) === false,
    '旧位置没有配置时什么也不做');

  /* ---- 侧栏布局不变量：分组多了要能滚、底部栏与「新建分组」常驻 ----
     这些是 UI 几何的关键约束，回归成本低，直接扫 style.css 文本。 */
  section('侧栏布局不变量');
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'style.css'), 'utf8');
  const rule = sel => {
    const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    return m ? m[1] : '';
  };
  ok(/grid-template-rows:\s*100%/.test(rule('.app')),
    '.app 行高写死 100%（否则隐式 auto 行被内容撑破窗口）');
  ok(/overflow:\s*hidden/.test(rule('.app')), '.app 自身不溢出');
  ok(/min-height:\s*0/.test(rule('.rail')) && /overflow:\s*hidden/.test(rule('.rail')),
    '.rail min-height:0 + overflow:hidden');
  ok(/min-height:\s*0/.test(rule('.nav')), '.nav min-height:0（否则 flex 子项撑开不滚）');
  ok(/flex:\s*none/.test(css.match(/\.nav\s*>\s*\*\s*\{([^}]*)\}/)[1]),
    '.nav > * flex:none（否则行被压扁而不是滚动）');
  ok(/flex:\s*none/.test(rule('.rail-foot')), '.rail-foot flex:none（底部栏常驻）');
  ok(/position:\s*sticky/.test(rule('.nav-new')) && /bottom:\s*0/.test(rule('.nav-new')),
    '「新建分组」吸附列表底部');
  ok(/background:\s*var\(--panel\)/.test(rule('.nav-new')),
    '吸附按钮底色不透明（避免滚动内容透出来）');
  ok(/left:\s*0\b/.test(rule('.nav-item.active::before')) &&
    !/left:\s*-14px/.test(rule('.nav-item.active::before')),
    '选中竖条画在可视区内（left:0，而非会被裁剪的 -14px）');

  /* ---- 「启动时打开哪个分组」的设置与解析 ----
     解析函数直接**从 app.js 源码里抠出来跑**，不另写一份镜像实现
     （镜像实现永远会通过，等于没测）。 */
  section('startGroup 启动分组设置');
  const fresh = store.defaultConfig();
  ok(fresh.settings.startGroup === 'last', `默认 startGroup = ${fresh.settings.startGroup}（记住上次）`);
  ok(fresh.settings.lastGroup === 'all', `默认 lastGroup = ${fresh.settings.lastGroup}`);
  ok(cfg.settings.startGroup !== undefined, '已存在的配置文件也被补上 startGroup（load 时的默认合并）');

  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const grab = name => {
    const m = appSrc.match(new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`));
    return m ? m[0] : '';
  };
  const srcViewId = grab('isViewId');
  const srcFromCode = grab('viewFromCode');
  const srcStart = grab('startViewFromSettings');
  ok(!!srcViewId && !!srcFromCode && !!srcStart,
    '能从 app.js 抠出 isViewId / viewFromCode / startViewFromSettings');
  if (srcViewId && srcFromCode && srcStart) {
    const stub = { config: { groups: [{ id: 'g1', name: '甲' }, { id: 'g2', name: '乙' }] } };
    const fn = new Function('state',
      `${srcViewId}\n${srcFromCode}\n${srcStart}\nreturn startViewFromSettings;`);
    const resolve = fn(stub);
    const table = [
      // ★ lastGroup 也是带 g: 前缀写的，必须和 startGroup 一样被解码。
      //   只解一处的话，「记住上次打开的分组」（默认值）永远回落到「全部」。
      [{ startGroup: 'last', lastGroup: 'g:g2' }, 'g2', '记住上次 → 上次那个真实分组（g: 前缀要解）'],
      [{ startGroup: 'last', lastGroup: 'fav' }, 'fav', '记住上次 → 上次停在虚拟视图'],
      [{ startGroup: 'last' }, 'all', '记住上次但没记录过'],
      [{ startGroup: 'fav' }, 'fav', '固定收藏'],
      [{ startGroup: 'recent' }, 'recent', '固定最近使用'],
      [{ startGroup: 'g:g1' }, 'g1', '固定到指定分组（g: 前缀要解）'],
      [{ startGroup: 'g:已被删掉的分组' }, 'all', '指定的分组已不存在 → 兜底 all'],
      [{ startGroup: 'last', lastGroup: 'g:已被删掉的分组' }, 'all', '上次的分组被删了 → 兜底 all'],
      [{ startGroup: 'g:' }, 'all', '只有一个前缀没有 id → 兜底 all'],
      [{ startGroup: '' }, 'all', '空串 → 兜底 all'],
      [{}, 'all', '空 settings → 兜底 all'],
    ];
    let miss = 0;
    table.forEach(([s, want]) => { if (resolve(s) !== want) miss++; });
    ok(miss === 0, `${table.length} 条解析表全部命中（含已删分组的兜底）`, `未命中 ${miss}`);

    // 写入侧（viewToCode）与读取侧（viewFromCode）必须严格互逆 ——
    // 两侧各写一份编码规则的话，迟早会像上面那样只解一半。
    const srcToCode = grab('viewToCode');
    ok(!!srcToCode, '能从 app.js 抠出 viewToCode');
    if (srcToCode) {
      const codec = new Function('state',
        `${srcFromCode}\n${srcToCode}\nreturn { viewToCode, viewFromCode };`)(stub);
      const views = ['all', 'recent', 'fav', 'g1', 'g2', '某个真实分组 id'];
      const bad = views.filter(v => codec.viewFromCode(codec.viewToCode(v)) !== v);
      ok(bad.length === 0, `${views.length} 个视图编码↔解码往返一致`, bad.join(',') || 'ok');
      ok(codec.viewToCode('g1') === 'g:g1' && codec.viewFromCode('g:g1') === 'g1',
        '真实分组的编码格式为 g:<id>');
      ok(codec.viewToCode('all') === 'all' &&
        codec.viewToCode('recent') === 'recent' && codec.viewToCode('fav') === 'fav',
        '三个虚拟视图原样存取（不加前缀）');
    }
  }
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  ok(/id="sStartGroup"/.test(htmlSrc), '设置面板有「启动时打开」下拉');
  ok(/启动时打开/.test(htmlSrc), '下拉带中文标签');
  ok(/renderStartGroupOptions/.test(appSrc) && /\$\('#sStartGroup'\)\.value/.test(appSrc),
    '下拉由 renderStartGroupOptions 填充、由 saveSettings 读回');
  ok(/value="\$\{esc\(viewToCode\(g\.id\)\)\}"/.test(appSrc),
    '下拉 option.value 复用 viewToCode（不再手写 g: 前缀，杜绝编解码两边漂移）');
  ok(/API\.setSettings\(\{ lastGroup: enc \}\)/.test(appSrc),
    '切换视图时把当前分组记为 lastGroup（供「记住上次」用）');

  /* ---- 多选编辑模式 ---- */
  section('多选编辑模式');
  ok(/id="btnSelect"/.test(htmlSrc), '顶栏有「多选」按钮');
  ok(/id="editBar"/.test(htmlSrc), '底部有浮动操作栏 #editBar');
  ['ebCount', 'ebAll', 'ebNone', 'ebFavOn', 'ebFavOff', 'ebMove', 'ebDel', 'ebDone']
    .forEach(id => ok(new RegExp(`id="${id}"`).test(htmlSrc), `操作栏含 #${id}`));
  ok(/id="editBar"[^>]*\shidden/.test(htmlSrc), '操作栏默认隐藏（不进编辑模式不占屏幕）');

  const fns = ['setEditMode', 'updateEditBar', 'togglePick', 'pickedPairs', 'visibleItemIds',
    'renderMoveOptions', 'batchFavorite', 'batchMove', 'batchDelete'];
  const missingFn = fns.filter(n => !new RegExp(`function ${n}\\s*\\(`).test(appSrc));
  ok(missingFn.length === 0, `编辑模式 9 个函数齐备`, missingFn.join(',') || 'ok');
  ok(/case 'multiselect':\s*return setEditMode\(true, id\)/.test(appSrc),
    '卡片右键「多选编辑」进模式并顺手选中该项');
  ok(/if \(state\.editMode\) \{[\s\S]{0,260}togglePick\(pickable\.dataset\.id\)/.test(appSrc),
    '编辑模式下点卡片 = 勾选（排在「新建卡片」与右上角按钮之前）');
  ok(/function setEditMode[\s\S]{0,400}state\.picked = new Set\(\)/.test(appSrc),
    '退出/进入编辑模式都清空勾选（防上一轮的隐形残留）');
  ok(/state\.picked\.clear\(\)/.test(appSrc), '切换视图时会清空勾选');

  /* ---- v1.5.0：多选模式下也能拖动排序（按住 0.3 秒）；v1.5.6：普通模式 1.5s → 0.5s ---- */
  const cssEdit = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'style.css'), 'utf8');
  ok(/const HOLD_MS = 500/.test(appSrc), '★ 普通模式长按 0.5 秒进入拖动（v1.5.6 从 1.5 秒调短）');
  ok(/const HOLD_MS_EDIT = 300/.test(appSrc), '多选模式长按 0.3 秒即可拖动');
  ok(/function holdMsFor\(card\)/.test(appSrc), '拖动等待时长统一由 holdMsFor 决定');
  ok(/if \(!state\.editMode\) return HOLD_MS;/.test(appSrc) && /return state\.q \? 0 : HOLD_MS_EDIT;/.test(appSrc),
    '★ 普通模式 0.5s（"全部"视图也要能拖去垃圾桶）；多选模式只要不在搜索中就 0.3s');
  ok(/animation: holdFill var\(--hold, 500ms\)/.test(cssEdit),
    '★ 长按进度条的 CSS 兜底时长与 HOLD_MS 一致（否则进度条走完还没起拖）');
  ok(!/function onGridPointerDown[\s\S]{0,220}state\.editMode\) return/.test(appSrc),
    '★ onGridPointerDown 不再一见多选模式就 return（否则永远拖不动）');
  ok(/card-drag-no-trash/.test(appSrc) && /card-drag-no-trash/.test(cssEdit),
    '多选模式拖动不出垃圾桶（只排序，避免"想挪位置"变成"删了一项"）');
  ok(/if \(!d\.moved && !overTrash && !dry && !state\.probeMode\) \{[\s\S]{0,60}togglePick\(d\.id\)/.test(appSrc),
    '★ 按住够久但一步没挪 → 多选当成点选（不然按重一点就既没排序也没勾上）');
  ok(/if \(state\.editMode\) togglePick\(d\.id\);[\s\S]{0,40}runItem\(d\.id\);/.test(appSrc),
    '★ 普通模式「按够但没挪就松手」= 启动一次（0.5s 门槛下慢速点击不能变成"点了没反应"）');
  ok(/card-drag-no-trash \.content \{ margin-bottom: 0/.test(cssEdit),
    '多选拖动时不预留底部 88px 死区');
  ok(/card-drag-no-trash #editBar \{[^}]*pointer-events: none/.test(cssEdit),
    '★ 拖动时操作栏不拦截指针（否则它压住的最后一行当不了落点）');

  /* ★ 快捷键守卫的两面：Esc 不能被输入框焦点挡住，Delete/Ctrl+A 必须被挡住。
     反面案例：程序启动自动聚焦搜索框 → 右键进编辑模式不移焦点 → 按 Esc 被 typing
     拦下后落到"清搜索词 / 隐藏窗口"分支，用户想退出编辑，窗口却没了。 */
  ok(/if \(state\.editMode && !anyOpen\)/.test(appSrc),
    '编辑模式快捷键只让弹窗开路，不让输入框焦点开路');
  ok(/state\.editMode && !anyOpen\)[\s\S]{0,240}if \(e\.key === 'Escape'\)/.test(appSrc),
    'Esc 退出编辑模式不受「焦点在输入框」影响');
  ok(/state\.editMode && !anyOpen\)[\s\S]{0,900}if \(!typing\) \{/.test(appSrc),
    'Delete / Ctrl+A 仍受 !typing 保护（打字不会被当成批量删除）');
  const iEditEsc = appSrc.indexOf('if (state.editMode && !anyOpen)');
  // ★ 用正则而不是 indexOf 找那个多行字面量：一旦文件被某个工具改写成 CRLF，
  //   带 `\n` 的 indexOf 会返回 -1，这条断言就会假报红（真踩过，排查了半天）。
  const mGlobalEsc = appSrc.match(/if \(e\.key === 'Escape'\) \{\r?\n\s*if \(state\.dlgCancel\)/);
  const iGlobalEsc = mGlobalEsc ? mGlobalEsc.index : -1;
  ok(iEditEsc > 0 && iGlobalEsc > 0 && iEditEsc < iGlobalEsc,
    '编辑模式的 Esc 处理排在全局 Esc 处理之前', `edit=${iEditEsc} global=${iGlobalEsc}`);
  ok(/setEditMode\(false\);[\s\S]{0,200}activeElement\.blur\(\)/.test(appSrc),
    '退出编辑模式时把焦点从输入框上摘掉（免得下一次 Esc 直接隐藏窗口）');
  ok(/const canAdd = !state\.editMode/.test(appSrc) && /card\.add\[data-add\]/.test(htmlSrc + appSrc),
    '编辑模式下隐藏「新建启动项」卡片');

  /* 编辑模式的关键样式（几何/可见性约束，扫文本回归成本最低） */
  ok(/position:\s*fixed/.test(rule('.editbar')), '.editbar 悬浮（fixed）');
  ok(/z-index:\s*140/.test(rule('.editbar')), '.editbar 层级高于垃圾桶（两者不同时出现）');
  ok(/bottom:\s*22px/.test(rule('.editbar')), '.editbar 贴底 22px');
  ok(/editRise/.test(rule('.editbar')) || /@keyframes editRise/.test(css),
    '.editbar 有入场动画 editRise');
  ok(/data-empty="1"/.test(css) && /pointer-events:\s*none/.test(css),
    '未勾选任何项时批量动作置灰（不会静默失败）');
  ok(/position:\s*absolute/.test(rule('.pick')), '.pick 勾选标记绝对定位在卡片左上');
  ok(/border-color:\s*var\(--accent\)/.test(rule('.card.picked')),
    '.card.picked 有明确的选中描边');
  ok(/body\.edit-mode\s+\.card\s+\.card-top\s*\{[^}]*padding-left/.test(css),
    '编辑模式下卡片标题让位给勾选标记');
  ok(/body\.edit-mode\s+\.content\s*\{[^}]*padding-bottom/.test(css),
    '编辑模式下内容区留出底部空间（最后一行不会被操作栏挡住）');

  /* 编辑栏的图标必须是内联 SVG：字体符号（☆ ★ 🗑）的宽度/基位取决于系统字体回退，
     小字号下会变成"看不懂的方块"或粗细不匀的按钮。 */
  const iBar = htmlSrc.indexOf('id="editBar"');
  const iBarEnd = htmlSrc.indexOf('<!--', iBar);
  const barHtml = htmlSrc.slice(iBar, iBarEnd > iBar ? iBarEnd : iBar + 3000);
  ok(iBar > 0, '能定位到编辑栏 HTML 片段', `iBar=${iBar}`);
  ok(!/[☆★🗑❐☐─]/.test(barHtml), '编辑栏不含字体符号图标');
  ok((barHtml.match(/<svg/g) || []).length >= 3, '编辑栏的收藏/取消/删除都用内联 SVG');
  ok(/\.btn\s+\.ic\.solid\s*\{[^}]*fill:\s*currentColor/.test(css),
    '.ic.solid 显式放开 fill（CSS 会盖掉 SVG 自带的 fill 呈现属性）');

  /* ------------------------------------------------------------------
   * 「关于」窗口 / 运行环境归属 —— 设置面板只放"能改的东西"
   *   历史：设置面板底部原有一整块只读的「运行环境」文本（9 行，含
   *   Electron/Chromium/Node 版本与两个绝对路径），既不可点也不可改，
   *   还把弹窗撑得老长（自检脚本得先 scrollIntoView 才能截全）。
   *   现在搬进独立的「关于」窗口，入口是侧栏底部状态行和设置页脚的「关于」。
   * ------------------------------------------------------------------ */
  section('关于窗口 / 运行环境归属');
  ok(/id="aboutOverlay"/.test(htmlSrc), '有独立的「关于」弹窗 #aboutOverlay');
  ['abGrid', 'abVer', 'abWarn', 'btnAboutCopy', 'btnOpenCfg'].forEach(id =>
    ok(new RegExp(`id="${id}"`).test(htmlSrc), `「关于」里含 #${id}`));
  ok(/id="aboutOverlay"[^>]*\shidden/.test(htmlSrc), '「关于」默认隐藏');

  // 设置面板里不该再有那块只读文本 —— 这是本轮改动的核心，写死成回归守卫
  ok(!/id="envBox"/.test(htmlSrc), '设置面板已无 #envBox（只读运行环境块已搬走）');
  ok(!/env-box/.test(css), 'style.css 里 .env-box 死样式已删除');
  // 同理：设置面板底部曾内嵌一整块「使用说明」（右键/多选/启动分组/托盘/热键/开机自启/数据 共 7 行）。
  // 那是"看一眼"的阅读材料，已搬到 README —— 别让它再爬回来（设置面板只放能改的东西）。
  ok(!/在卡片上右键可启动/.test(htmlSrc) && !/便携版移动位置后请重新勾选/.test(htmlSrc),
    '设置面板不再内嵌使用说明块（改由 README 承载）');
  ok(/id="setDataWarn"[^>]*\shidden/.test(htmlSrc) && /id="setDataWarn"/.test(htmlSrc),
    '设置面板有警示条 #setDataWarn 且默认隐藏（不占位）');
  ok(css.match(/\.warn-box\s*\{[^}]*var\(--danger-soft\)/) !== null,
    '.warn-box 用 danger-soft 底色（一眼看出是"要留意"）');

  // 「打开配置目录」搬去了「关于」；设置页脚换成「关于」
  const iSet = htmlSrc.indexOf('id="setOverlay"');
  const iAbout = htmlSrc.indexOf('id="aboutOverlay"');
  const iCfgBtn = htmlSrc.indexOf('id="btnOpenCfg"');
  ok(iSet > 0 && iAbout > iSet && iCfgBtn > iAbout,
    '「打开配置目录」在「关于」窗口里，不再占设置页脚', `set=${iSet} about=${iAbout} cfg=${iCfgBtn}`);
  ok(/id="btnAbout"/.test(htmlSrc), '设置页脚有「关于」入口');
  ok(/<button[^>]*class="conn"\s+id="conn"/.test(htmlSrc),
    '侧栏状态行是 <button>（可点、可键盘触发，不是死文本）');
  ok(/\.conn\s*\{[^}]*width:\s*100%/.test(css) && /\.conn\s*\{[^}]*text-align:\s*left/.test(css),
    '.conn 补了按钮需要的 width/text-align（按钮默认居中）');
  ok(/\.conn\.warn\s+i\s*\{[^}]*var\(--danger\)/.test(css),
    '.conn.warn 的红点用 danger 色（数据没落在程序目录时一眼可见）');

  /* ------------------------------------------------------------------
     设置面板分区（对齐 QZRS Scrcpy 的 collapsible sections）
     原来是十几个字段一路平铺：开关挤成一行换行、维护按钮混在表单里、更新源滚到底才看见。
     现在四个分区，常用默认展开、维护/更新默认收起。
     这里只钉"结构不能退回去"：分区成对出现、控件 id 一个不少、收起的 body 真的不占位。
     ------------------------------------------------------------------ */
  section('设置面板分区');
  ok(/id="setSecs"/.test(htmlSrc), '设置面板有分区容器 #setSecs');
  const secIds = (htmlSrc.match(/data-sec="[a-z]+"/g) || []).map(s => s.slice(10, -1));
  ok(JSON.stringify(secIds) === JSON.stringify(['launch', 'window', 'maint', 'update']),
    '四个分区按「多久动一次」排序', secIds.join(','));
  const nHead = (htmlSrc.match(/class="sec-head"/g) || []).length;
  const nBody = (htmlSrc.match(/class="sec-body"/g) || []).length;
  ok(nHead === 4 && nBody === 4, '每个分区都是 head + body 成对', `head=${nHead} body=${nBody}`);
  ok((htmlSrc.match(/class="sec open"/g) || []).length === 2,
    '常用的两个分区默认展开，维护/更新默认收起（用户手点过的状态另有 localStorage 记忆）');
  ok(/\.sec:not\(\.open\) \.sec-body\s*\{\s*display:\s*none/.test(css),
    '★ 收起的分区必须真的 display:none（只切箭头不藏 body = 面板照样长，实测踩过）');
  ok(/\.sec\.open \.sec-arrow\s*\{[^}]*rotate\(90deg\)/.test(css),
    '展开时箭头从「>」转成「v」（状态靠 class 切，不换图标）');
  ok(/\.sec\.open \.sec-badge\s*\{\s*display:\s*none/.test(css),
    '展开后标题徽标隐藏（信息已在正文里，不重复）');

  // 控件 id 一个都不能少：渲染层全按 id 取值，漏一个就是无声的 undefined
  const needIds = ['sHotkey', 'sHotkeyOn', 'sAutostart', 'sSendTo', 'sStartGroup', 'sCloseAction', 'sTrayQuick',
    'sHoverActs', 'sAnimations', 'sAutoUpdate', 'sUpdateBase', 'setDirty',
    'btnReextractIcons', 'btnRestoreDefaults', 'btnPruneInvalid'];
  const lost = needIds.filter(id => !new RegExp(`id="${id}"`).test(htmlSrc));
  ok(lost.length === 0, '分区化之后所有控件 id 都还在（界面按 id 取值，不按 DOM 位置）', lost.join(',') || 'ok');
  ok((htmlSrc.match(/<label class="trow">/g) || []).length === 6,
    '6 个开关都是整行 <label>（热键/自启/发送到/悬停/动画/自动更新，点文字也能切，读屏能拿到名字）');

  // 折叠逻辑只有一份实现：写 localStorage、切 class、同步 aria
  ok(/const SET_SEC_KEY = ['"]ql\.settings\.secs['"]/.test(appSrc)
    && /function initSettingsSections\(\)/.test(appSrc)
    && /localStorage\.setItem\(SET_SEC_KEY/.test(appSrc),
    '折叠状态写 localStorage（下次打开保持），只有一份实现');
  ok(/aria-expanded/.test(appSrc), '折叠时同步 aria-expanded（键盘/读屏用户也要知道开没开）');
  ok(/function markSettingsDirty\(\)/.test(appSrc) && /function settingsFromDom\(\)/.test(appSrc),
    '页脚「有未保存的修改」由 DOM 快照比对得出，不靠事件记账');

  /* ★ 从源码里抠出这几个纯函数真跑，不另写"镜像实现"（镜像实现永远通过 = 没测）。
     它们只依赖 FORM_TXT / PREVIEW，抠出来就能跑。 */
  const fnSrc = n => {
    const m = appSrc.match(new RegExp(`function ${n}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`));
    return m ? m[0] : '';
  };
  const formMapSrc = (appSrc.match(/const FORM_TXT = \{[\s\S]*?\n\};/) || [''])[0];
  const parts = ['FORM_TXT', 'formText', 'statusText', 'dataWarnText', 'aboutGroups', 'envLines', 'updateRows'];
  const got = {
    FORM_TXT: formMapSrc,
    formText: fnSrc('formText'),
    statusText: fnSrc('statusText'),
    dataWarnText: fnSrc('dataWarnText'),
    aboutGroups: fnSrc('aboutGroups'),
    envLines: fnSrc('envLines'),
    updateRows: fnSrc('updateRows'),
  };
  const missingSrc = parts.filter(n => !got[n]);
  ok(missingSrc.length === 0, '7 段源码都抠出来了', missingSrc.join(',') || 'ok');
  ok((appSrc.match(/FORM_TXT/g) || []).length === 2,
    'FORM_TXT 只有一份（定义 + formText 里取用）；状态行和「关于」共用它',
    `出现 ${(appSrc.match(/FORM_TXT/g) || []).length} 次`);

  if (missingSrc.length === 0) {
    // ★ envLines 现在还会去读 state.update（"关于"里推过来的最新快照），
    //   所以把 state 也一起注进去 —— 不注的话抽出来一跑就是 ReferenceError。
    const mk = (preview, st = {}) => new Function('PREVIEW', 'state',
      [formMapSrc, got.formText, got.statusText, got.dataWarnText, got.aboutGroups,
        got.updateRows, got.envLines].join('\n')
      + '\nreturn { formText, statusText, dataWarnText, aboutGroups, envLines, updateRows };')(preview, st);
    const A = mk(false);

    // 运行形态四种标签
    ok(A.formText({ form: 'installed' }) === '安装版', 'installed → 安装版');
    ok(A.formText({ form: 'green' }) === '绿色版', 'green → 绿色版');
    ok(/便携版/.test(A.formText({ form: 'portable' })), 'portable → 便携版');
    ok(A.formText({ form: 'dev' }) === '开发模式', 'dev → 开发模式');
    ok(A.formText({ packaged: true }) === '已打包' && A.formText({}) === '开发模式',
      '未知 form 时按 packaged 兜底');

    // 状态行：只写版本号（运行形态归「关于」），且绝不出现「已连接」
    ok(A.statusText({ version: '1.0.2', form: 'installed' }) === 'v1.0.2',
      '状态行只有版本号，不再带运行形态');
    ok(!/安装版|绿色版|便携版|开发模式/.test(A.statusText({ version: '1.0.2', form: 'installed' })),
      '首页不重复显示运行形态（它已经在「关于」里）');
    ok(!/已连接/.test(A.statusText({ version: '1.0.2', form: 'installed' })),
      '状态行不再出现「已连接」（那词会被读成在线状态）');
    ok(A.statusText({ version: '1.0.2', form: 'green' }) === 'v1.0.2', '绿色版状态行同样只有版本号');
    ok(A.statusText(null) === '初始化…' && A.statusText({ form: 'installed' }) === '初始化…',
      'info 还没到手（或没有版本字段）时说「初始化…」，不先猜一个版本号');
    ok(mk(true).statusText({ version: '1.0.2', form: 'installed' }) === '预览模式（非桌面版）',
      '预览模式（浏览器打开）显示预览文案');

    // 数据回落提示：四处共用这一份判断
    ok(A.dataWarnText({ packaged: true, dataInProgramDir: false, dataNote: '已回落到 X' }) === '已回落到 X',
      '数据没落在程序目录时给出说明');
    ok(A.dataWarnText({ packaged: true, dataInProgramDir: false }) === '数据未写在程序目录',
      '没有 dataNote 时用默认说明（不会打出 undefined）');
    ok(A.dataWarnText({ packaged: true, dataInProgramDir: true }) === '',
      '数据落在程序目录 → 无警示（正常情况不打扰用户）');
    ok(A.dataWarnText({ packaged: false, dataInProgramDir: false, dataNote: 'x' }) === '',
      '开发/预览形态不报数据回落（那本来就不落程序目录）');
    ok(A.dataWarnText(null) === '', '没有 info 时不报警示');
    ok((appSrc.match(/dataWarnText\(/g) || []).length >= 4,
      '警示条 / 状态行红点 / 关于提示 / 复制文本四处共用 dataWarnText',
      `用了 ${(appSrc.match(/dataWarnText\(/g) || []).length} 次`);

    // 「关于」的分组与复制文本
    const info = {
      version: '1.0.2', electron: '44.7.2', chrome: '152.0.0.0', node: '22.0.0',
      packaged: true, form: 'installed', exePath: 'C:\\App\\QuickLaunch.exe',
      configFile: 'C:\\App\\data\\config.json', dataDir: 'C:\\App\\data',
      dataInProgramDir: true, dataNote: '', autostart: false,
    };
    const gs = A.aboutGroups(info);
    ok(gs.length === 3, '「关于」分三组（程序 / 环境 / 数据）');
    const rows = gs.reduce((n, g) => n + g.rows.length, 0);
    ok(rows === 9, '三组共 9 条（版本/形态/exe/三个版本号/数据目录/配置/自启）');
    ok(gs.every(g => g.title && g.rows.every(r => r.k && typeof r.v === 'string')),
      '每条都有键和有值的字符串（主进程少给字段会在这里露馅）');
    const text = A.envLines(info).join('\n');
    ok(!/undefined|null|NaN/.test(text), '复制的诊断信息里没有 undefined/null/NaN');
    ok(/v1\.0\.2/.test(text) && /安装版/.test(text), '诊断信息含版本与运行形态');
    const warnInfo = { ...info, dataInProgramDir: false, dataNote: '程序目录不可写' };
    ok(/注意\s+程序目录不可写/.test(A.envLines(warnInfo).join('\n')),
      '数据回落时诊断信息里带一行「注意」（用户贴出来就能定位问题）');
    ok(!/注意/.test(text), '数据正常时诊断信息里不带「注意」');

    /* 更新段：用户报"更新下不动"时，这段字里有状态、目标版本、实际用的更新源、日志目录。
       ★ 一个 undefined 就能把整段诊断信息废掉 —— 这几条就是盯这个的。 */
    const updInfo = {
      ...info,
      update: {
        supported: true, unsupportedReason: '', form: 'green', myVersion: '1.0.2', autoUpdate: true,
        base: 'https://example.invalid/ql', baseError: '', status: 'available',
        statusText: '发现新版本', latest: '1.1.0', reason: '可以走增量',
        plan: { mode: 'delta', size: 1024, sizeText: '1.0 KiB' }, progress: null,
        checkedAt: 0, checkedAtText: '2026-10-16 10:00', busy: false,
        canCheck: true, canDownload: true, canApply: false, notice: null, dir: 'C:\\App\\.update',
      },
    };
    const updText = A.envLines(updInfo).join('\n');
    ok(/【更新】/.test(updText), '★ 诊断信息里带一段【更新】（用户贴出来就能定位更新问题）');
    ok(!/undefined|null|NaN/.test(updText), '更新段里也没有 undefined/null/NaN');
    ok(/发现新版本/.test(updText) && /1\.1\.0/.test(updText), '更新段写清了状态与目标版本');
    ok(/https:\/\/example\.invalid\/ql/.test(updText),
      '★ 更新段带上了**实际用的**更新源（更新下不动时这是第一个要看的东西）');
    ok(!/【更新】/.test(text), '拿不到更新快照时不硬造一段（宁可没有，也不要一段假的）');
    const updOff = {
      ...info,
      update: {
        supported: false, unsupportedReason: '便携版是单文件 exe，换不了自己',
        status: 'unsupported', statusText: '当前形态不支持自动更新', autoUpdate: true,
        base: '', baseError: '', latest: '', reason: '', checkedAt: 0, checkedAtText: '',
        progress: null, plan: null, dir: '—',
      },
    };
    const offText = A.envLines(updOff).join('\n');
    ok(!/undefined|null|NaN/.test(offText) && /便携版是单文件/.test(offText),
      '不支持的形态在诊断信息里也给出人话原因');
    ok(A.updateRows(null).every(r => r.k && typeof r.v === 'string'),
      'updateRows(null)（快照还没到）也不吐 undefined');
    ok(A.updateRows({ supported: true, status: 'idle', statusText: '尚未检查', autoUpdate: true })
      .every(r => typeof r.v === 'string'),
    '字段很稀疏的快照也不会吐 undefined（主进程少给字段就会在这露馅）');
  }


  /* ------------------------------------------------------------------
   * 单实例交接提示：第二个实例必须"会说话"
   *   单实例锁按 **userData 目录**上锁，而打包形态的 userData 就是程序目录下的 `data\`，
   *   所以同一个文件夹里的不同版本共用一把锁。用户双击新版 exe 时新进程拿不到锁直接
   *   退出，浮起来的是**旧版窗口** —— 看起来就像"新功能没做"（真踩过：用户报
   *   「关于加了吗？」）。原实现只有一句 showWindow()，必须补上说明。
   * ------------------------------------------------------------------ */
  section('单实例交接提示');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  ok(/'ql:second-instance'/.test(preloadSrc), 'preload 白名单放行 ql:second-instance');
  ok(/'ql:second-probe'/.test(preloadSrc), 'preload 白名单放行 ql:second-probe');
  ok(/app\.on\('second-instance',[\s\S]{0,120}showWindow\(\)/.test(mainSrc),
    '第二个实例仍把窗口带到前台');
  ok(/app\.on\('second-instance',[\s\S]{0,600}send\('ql:second-instance'/.test(mainSrc),
    '并且把「你看到的是已在运行的那个版本」告知渲染层');
  ok(/DRAG_PROBE \|\| GROUP_PROBE[\s\S]{0,160}SECOND_PROBE/.test(mainSrc),
    '--second-probe 放开了 ql:probe-shot 的闸门（漏了会报 No handler registered，探针白跑）');
  ok(/API\.on\('ql:second-instance'/.test(appSrc), '渲染层订阅了单实例交接事件');
  ok(/已有一个实例在运行/.test(appSrc) && /托盘图标上右键退出/.test(appSrc),
    '提示既说清"看到的是哪个版本"，也说清"去哪退出再打开新版"');
  ok(/API\.on\('ql:second-instance'[\s\S]{0,300}formText\(info\)/.test(appSrc),
    '交接提示带上运行形态（它比状态行多一个 formText，就是要让人分清占着锁的是哪个版本）');
  ok(/API\.on\('ql:second-instance'[\s\S]{0,300}v\$\{info\.version/.test(appSrc),
    '交接提示里的版本号取 info.version（不是写死的字符串）');
  ok(/^function lastToast/m.test(appSrc),
    'lastToast 提到顶层（探针共用一份，不再每个探针各拷一遍）');

  /* ------------------------------------------------------------------
   * 静默失效防线：主进程往外发的每个频道都得在 preload 白名单里
   * ------------------------------------------------------------------ */
  /* ------------------------- 启动卡片不再"闪一下"（v1.5.2） */
  section('启动后不整块重绘（点卡片不再闪一下）');
  {
    const appSrcF = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    const at = appSrcF.indexOf('async function runItem(');
    ok(at >= 0, '找得到 runItem');
    const body = at >= 0 ? appSrcF.slice(at, appSrcF.indexOf('\n}', at) + 2) : '';
    // 注释里会提到 refresh()（说明"为什么不要"），先按整行去掉注释再判断
    const bodyCode = body.replace(/^\s*\/\/.*$/gm, '');
    ok(!/refresh\(/.test(bodyCode), '★ runItem 里不再 refresh（主进程 runAndBump 已经广播 config-changed）');

    ok(/API\.on\('ql:config-changed', \(\) => refresh\(\{ soft: true \}\)\)/.test(appSrcF),
      '★ config-changed 走 soft 通道（只有计数变了就一次重绘都不做）');
    ok(/function softSync\(next\)/.test(appSrcF), '有 softSync（就地改「用过 N 次」）');
    ok(/if \(opts && opts\.soft && softSync\(next\)\) return;/.test(appSrcF), 'refresh 支持 soft 分支');
    ok(/render\(\{ noAnim: !!\(opts && \(opts\.noAnim \|\| opts\.soft\)\) \}\)/.test(appSrcF),
      '★ soft 落到重绘分支时也不播入场动画');
    ok(/if \(state\.sort === 'uses' \|\| state\.sort === 'recent'\) return false;/.test(appSrcF),
      '★ 按使用次数 / 最近排序时不就地同步（顺序依赖计数，必须重排）');
    ok(/if \(state\.q\) return false;/.test(appSrcF), '搜索中不就地同步（匹配结果可能变）');
    ok(/k === 'useCount' \|\| k === 'lastUsed' \|\| k === '_exists'/.test(appSrcF),
      '比对时只抹平 useCount / lastUsed / _exists 三个字段');
    ok(/span\.className = 'uses'/.test(appSrcF) && /\.card-foot/.test(appSrcF),
      '★ 0 → 1 次（原来没有这个节点）也是就地补一个 span，不整块重绘');
    ok(/if \(flatten\(cur\) !== flatten\(next\)\) return false;/.test(appSrcF),
      '★ 别处有任何差异就老实重绘（宁可多绘，不能漏掉用户的改动）');
  }

  /* --------------------- 拖到左侧分组：批量移动 + 普通模式单张（v1.5.3 → v1.5.4） */
  section('拖到左侧分组：批量移动 + 普通模式单张');
  {
    const appSrcG = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    const cssSrcG = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'style.css'), 'utf8');

    ok(/function groupAtPoint\(x, y\)/.test(appSrcG), '有 groupAtPoint（指针落在哪个分组上）');
    ok(/document\.elementFromPoint\(x, y\)/.test(appSrcG),
      '★ 用 elementFromPoint 现取，不缓存矩形（侧栏能滚动，缓存必失准）');
    ok(/state\.config\.groups\.find\(g => g\.id === btn\.dataset\.nav\)/.test(appSrcG),
      '★ 只认真实分组（全部/最近/收藏是虚拟视图，不算目的地）');
    ok(/function dragIds\(d\)/.test(appSrcG), '有 dragIds（这次拖动带走哪些项）');
    ok(/if \(d && d\.id && state\.picked\.has\(d\.id\)\) return \[\.\.\.state\.picked\];/.test(appSrcG),
      '★ 被拖的卡已勾选 = 整批走；没勾选就只移它自己（拖谁移谁）');
    ok(/function dragMoveCount\(d\)[\s\S]{0,90}dragIds\(d\)\.length \|\| 1/.test(appSrcG),
      'dragMoveCount 复用 dragIds（不另算一遍）');
    ok(/function paintGroupDrop\(gid, count\)/.test(appSrcG), '有 paintGroupDrop（落点高亮）');

    ok(/async function moveItemsTo\(gid, ids, opts\)/.test(appSrcG), '有 moveItemsTo（移动的唯一实现）');
    ok(/await moveItemsTo\(gid, pairs\.map\(p => p\.i\.id\)\)/.test(appSrcG),
      '★ 浮动栏的「移动分组」复用它，不是各写一份');
    ok(/const moving = found\.filter\(p => p\.g\.id !== gid\)/.test(appSrcG),
      '★ 已经在目标分组里的排除掉（否则先摘后加会把它自己摘没）');

    /* ---- v1.5.4：普通模式（非编辑）也能拖到左侧分组 ---- */
    ok(/const g = d\.overTrash \? null : groupAtPoint\(x, y\);/.test(appSrcG),
      '★ v1.5.4：分组落点判定不再只看多选模式（普通模式单张也能拖过去）');
    ok(!/if \(state\.editMode\) \{\s*const g = groupAtPoint/.test(appSrcG),
      '★ 旧的「仅多选模式才判定分组」分支已经去掉（留着就是普通模式永远拖不过去）');
    ok(/d\.overTrash \? null : groupAtPoint/.test(appSrcG),
      '★ 垃圾桶优先：指针在底部删除带里时不判定分组（否则"想删却移走"）');
    ok(/function dragWouldMove\(d, gid\)/.test(appSrcG), '有 dragWouldMove（这次拖过去有没有意义）');
    ok(/return dragIds\(d\)\.some\(id => !have\.has\(id\)\);/.test(appSrcG),
      '★ 全都已经在目标分组里 → 不算移动，不高亮也不接管');
    ok(/const overGid = \(g && dragWouldMove\(d, g\.id\)\) \? g\.id : null;/.test(appSrcG),
      '落点要过 dragWouldMove 才认');
    ok(/if \(overGid\) return;/.test(appSrcG),
      '★ 悬在分组上时停止"实时让位" —— 此刻表达的是"移走"，不是"排到这里"');
    ok(/if \(d\.overGid\) \{[\s\S]{0,240}const moving = dragIds\(d\);/.test(appSrcG),
      '★ endDrag 里松手就移进去，多选/普通同一套（普通模式勾选集是空的，自然只移一张）');
    ok(/const n = await moveItemsTo\(d\.overGid, moving, \{ quiet: true \}\);/.test(appSrcG),
      '松手时真正落库');
    ok(/\? `移入 \$\{count\} 项` : '移到这里'/.test(appSrcG),
      '单张写「移到这里」，成批才报「移入 N 项」');
    ok(/已移到「\$\{dest\.name\}」/.test(appSrcG), '单张成功的提示是「已移到「X」」（不是"移动 1 项"）');
    ok(/if \(!state\.editMode\) \{\s*toast\('info', '这里不支持拖动排序'/.test(appSrcG),
      '★ 多选在「全部/最近/收藏」里拖到空白处不弹"不支持排序"（那里本来只为拖去分组）');
    ok(/想换分组就直接拖到左侧的分组上/.test(appSrcG),
      '普通模式在虚拟视图拖空白时，提示里带上"拖到左侧分组"这条路');
    ok(/paintGroupDrop\(null\);/.test(appSrcG), '重置时清掉落点高亮');
    ok(/const stillVisible = state\.active === 'all'/.test(appSrcG),
      '★ 移走且已不在当前视图时清空勾选（否则下次批量操作作用到看不见的项）');

    ok(/\.nav-item\.drop-target \{/.test(cssSrcG), '落点高亮样式存在');
    ok(/content: attr\(data-drop-label\)/.test(cssSrcG), '高亮上直接写「移到这里 / 移入 N 项」');
    ok(/\.card\.dragging[\s\S]{0,200}pointer-events: none/.test(cssSrcG),
      '★ 被拖卡片 pointer-events:none —— elementFromPoint 才能打到侧栏');
    ok(/\.card\.dragging\.over-group \{/.test(cssSrcG),
      '★ 悬在分组上时被拖卡片让位（否则它正好盖住要高亮的那一行）');
  }

  /* --------------------- 清理无效项（v1.5.5） */
  section('清理无效项：只判「确定失效」，存疑一律不动');
  {
    const prune = require('../src/lib/prune');
    const resolveLib = require('../src/lib/resolve');
    resolveLib.resetCache();

    const ENV = { SystemRoot: 'C:\\Windows', PATHEXT: '.EXE', PATH: '' };
    const HOME = 'C:\\Users\\tester';
    /* 假 fs：键统一小写；'ok' = 存在；其它字符串 = statSync 抛该 code。
       ★ existsSync 也实现，因为裸命令要经 resolve 的 PATH 搜索。 */
    const mkFs = map => ({
      statSync(p) {
        const v = map[String(p).toLowerCase()];
        if (v === 'ok' || v === true) return { size: 0 };
        const e = new Error(v || 'ENOENT'); e.code = v || 'ENOENT'; throw e;
      },
      existsSync(p) {
        const v = map[String(p).toLowerCase()];
        return v === 'ok' || v === true;
      },
    });
    const cls = (item, map, env) => prune.classify(item, { fs: mkFs(map || {}), env: env || ENV, home: HOME });
    const it = o => Object.assign({ id: 'i', name: 'n', type: 'app', path: '' }, o);

    // ---- 不参与清理的三类 ----
    ok(cls(it({ type: 'url', path: 'https://a.b' })).level === 'ok', '网址项不参与清理');
    ok(cls(it({ type: 'cmd', path: 'explorer.exe "shell:MyComputerFolder"' })).level === 'ok',
      '★ type=cmd 是整行命令，没有"路径"可查 → 永不清理');
    ok(cls(it({ type: 'app', path: 'https://example.com/x' })).level === 'ok', 'path 是网址也不参与');

    // ---- 确定失效：绝对路径 + 盘在 + 明确 ENOENT ----
    const fsGone = mkFs({ 'd:\\': 'ok' });
    ok(prune.classify(it({ path: 'D:\\gone\\a.exe' }), { fs: fsGone, env: ENV, home: HOME }).level === 'certain',
      '★ 盘在、文件 ENOENT → 确定失效');

    // ---- 存疑的各种情形（一个都不许判成 certain） ----
    const fsNoDrive = mkFs({});   // 连 D:\ 都没有
    const rDrive = prune.classify(it({ path: 'D:\\gone\\a.exe' }), { fs: fsNoDrive, env: ENV, home: HOME });
    ok(rDrive.level === 'unsure' && /磁盘/.test(rDrive.reason),
      '★★ U 盘/移动硬盘没插（盘符不存在）→ 存疑，绝不清理', rDrive.reason);

    const fsDeny = mkFs({ 'd:\\': 'ok', 'd:\\gone\\a.exe': 'EACCES' });
    const rDeny = prune.classify(it({ path: 'D:\\gone\\a.exe' }), { fs: fsDeny, env: ENV, home: HOME });
    ok(rDeny.level === 'unsure' && /EACCES/.test(rDeny.reason),
      '★★ 没权限看不到（EACCES）→ 存疑，绝不清理（existsSync 也会回 false，不能拿它当失效）', rDeny.reason);

    ok(cls(it({ path: '\\\\nas\\share\\a.exe' })).level === 'unsure', '★★ 网络位置 → 存疑');
    ok(cls(it({ path: '' })).level === 'unsure', '没填路径 → 存疑');
    ok(cls(it({ path: 'bin\\a.exe' })).level === 'unsure', '相对路径 → 存疑');
    ok(cls(it({ path: '%NOPE_VAR%\\a.exe' })).level === 'unsure', '★ 环境变量没展开 → 存疑');

    // ★ 展开必须在"还有没有 %VAR%"的判断**之前**，否则 %SystemRoot%\… 会被全判成存疑
    const fsSys = mkFs({ 'c:\\': 'ok', 'c:\\windows\\ok.exe': 'ok' });
    ok(prune.classify(it({ path: '%SystemRoot%\\ok.exe' }), { fs: fsSys, env: ENV, home: HOME }).level === 'ok',
      '★ 能展开的环境变量先展开再判断（%SystemRoot%\\ok.exe → 路径存在）');

    // 带引号的路径：不去引号就必判失效 —— 这正是"误删"的经典来源
    const fsQ = mkFs({ 'd:\\': 'ok', 'd:\\a b\\c.exe': 'ok' });
    ok(prune.classify(it({ path: '"D:\\a b\\c.exe"' }), { fs: fsQ, env: ENV, home: HOME }).level === 'ok',
      '★ 带引号的路径先去引号（否则引号里的路径必然"不存在"→ 误删）');

    // 裸命令：PATH 里能找到就不是无效项；找不到也只算存疑
    const fsBare = mkFs({ 'c:\\windows\\system32\\zzfind1.exe': 'ok' });
    ok(prune.classify(it({ path: 'zzfind1.exe' }), { fs: fsBare, env: ENV, home: HOME }).level === 'ok',
      '裸命令能在 PATH/System32 里找到 → 正常');
    const rBare = prune.classify(it({ path: 'zznosuchcmd9.exe' }), { fs: mkFs({}), env: ENV, home: HOME });
    ok(rBare.level === 'unsure', '★ PATH 里找不到的裸命令 → 存疑（可能是 Store 别名 / 打错了）', rBare.reason);

    // ---- scan：分流 + 行内容 ----
    const cfgP = store.defaultConfig();
    cfgP.groups = [
      { id: 'g1', name: '一号组', items: [
        it({ id: 'ok1', name: '正常', path: 'C:\\Windows\\ok.exe' }),
        it({ id: 'bad1', name: '没了', path: 'D:\\gone\\a.exe' }),
        it({ id: 'u1', name: 'U 盘上的', path: 'Z:\\x\\a.exe' }),
        it({ id: 'u2', name: '裸命令', path: 'nope_zz_cmd.exe' }),
      ] },
      { id: 'g2', name: '二号组', items: [it({ id: 'bad2', name: '也没了', path: 'D:\\gone\\b.exe' })] },
    ];
    const scanMap = { 'c:\\': 'ok', 'c:\\windows\\ok.exe': 'ok', 'd:\\': 'ok' };
    const scanned = prune.scan(cfgP, { fs: mkFs(scanMap), env: ENV, home: HOME });
    ok(scanned.certain.length === 2 && scanned.unsure.length === 2,
      `scan 分流正确：确定 ${scanned.certain.length} / 存疑 ${scanned.unsure.length}`);
    ok(scanned.certain.every(r => r.gid && r.gname && r.reason && r.path),
      '★ 每行都带 gid/gname/reason/path（弹窗要按分组显示，删的时候也按 gid 回写）');
    ok(!scanned.certain.some(r => r.id === 'ok1'), '正常项不出现在清单里');
    ok(scanned.unsure.some(r => r.id === 'u1') && scanned.unsure.some(r => r.id === 'u2'),
      '存疑项进的是 unsure 组（默认不勾选）');

    // ---- prune：只删 certain；传进来的 unsure id 要跳过 ----
    const cfgQ = JSON.parse(JSON.stringify(cfgP));
    const pr = prune.prune(cfgQ, ['bad1', 'u1', 'u2', 'ok1', 'not-exist'], { fs: mkFs(scanMap), env: ENV, home: HOME });
    ok(pr.removed.length === 1 && pr.removed[0].item.id === 'bad1',
      '★ 只删确定失效那一项（存疑的 u1/u2、正常的 ok1 都不动）');
    ok(pr.skipped.length === 3 && pr.skipped.every(s => /路径存在|PATH|磁盘/.test(s.reason)),
      '★ 被跳过的项带原因回传（界面要如实告诉用户"这几项没动"）');
    ok(cfgQ.groups[0].items.map(i => i.id).join(',') === 'ok1,u1,u2',
      '★ 没被选中的项保持原顺序（不是重建数组）');
    ok(cfgQ.groups[1].items.length === 1 && cfgQ.groups[1].items[0].id === 'bad2',
      '另一组没被选中的 bad2 仍在原位');

    const prSame = prune.prune(cfgQ, ['not-exist'], { fs: mkFs(scanMap), env: ENV, home: HOME });
    ok(prSame.removed.length === 0, '传一个不存在的 id → 什么都不删（不抛错）');

    // ---- 备份：写不出来就别删（main.js 据此中止） ----
    const bakDir = path.join(TMP, 'prune-bak');
    fs.rmSync(bakDir, { recursive: true, force: true });
    const bak = prune.writeBackup(pr.removed, bakDir, Date.UTC(2026, 9, 19, 4, 5, 6));
    ok(fs.existsSync(bak) && /invalid-\d{8}-\d{6}\.json$/.test(bak), '备份文件按 invalid-日期-时间.json 落盘', path.basename(bak));
    const rawBak = fs.readFileSync(bak, 'utf8');
    ok(rawBak.charCodeAt(0) === 0x7b, '★ 备份是纯 JSON（不带 BOM，PowerShell 5.1 那种 BOM 会让 JSON.parse 抛）');
    const parsedBak = JSON.parse(rawBak);
    ok(parsedBak.removed.length === 1 && parsedBak.removed[0].gid === 'g1'
      && parsedBak.removed[0].item.id === 'bad1',
      '★ 备份里带着分组与完整 item（撤销就是照它塞回去）');
    ok(typeof parsedBak.savedAt === 'string' && !!parsedBak.note, '备份带时间与说明');

    // ---- 主进程接线：备份成功之后才 save；备份失败整批放弃 ----
    const mainSrcP = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const iWrite = mainSrcP.indexOf('prune.writeBackup');
    const iSave = mainSrcP.indexOf('store.save(cfg)', iWrite);
    ok(iWrite > 0 && iSave > iWrite, '★★ 先写备份、再 store.save（顺序反了就是"删完才发现没备份"）');
    ok(/备份没写成，已放弃这次清理/.test(mainSrcP), '★★ 备份失败 → 整批放弃，不写盘也不报"已清理"');
    ok(/const r = prune\.prune\(cfg, ids\)/.test(mainSrcP),
      '★ 服务端按同一份 classify 再判一遍（渲染层传来的 id 不可信）');

    const preSrcP = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
    ok(/scanInvalid: \(\) => ipcRenderer\.invoke\('ql:invalid:scan'\)/.test(preSrcP), 'preload 暴露 scanInvalid');
    ok(/pruneInvalid: ids => ipcRenderer\.invoke\('ql:invalid:prune', ids\)/.test(preSrcP), 'preload 暴露 pruneInvalid');
    ok(/restoreItems: pairs => ipcRenderer\.invoke\('ql:items:restore', pairs\)/.test(preSrcP), 'preload 暴露 restoreItems');
    ['ql:invalid:scan', 'ql:invalid:prune', 'ql:items:restore'].forEach(ch => {
      ok(new RegExp(`ipcMain\\.handle\\('${ch}'`).test(mainSrcP), `主进程注册了 ${ch}`);
    });

    const menusSrcP = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'menus.js'), 'utf8');
    ok(/label: '清理无效项…', click: \(\) => 'prune'/.test(menusSrcP), '空白处右键有「清理无效项…」入口');

    const appSrcP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    ok(/const PRUNE_HINT_WARN = '存疑，默认不动'/.test(appSrcP), '存疑组有明确文案');
    ok(/state\.prune\.picked = new Set\(\(r\.certain \|\| \[\]\)\.map\(x => x\.id\)\)/.test(appSrcP),
      '★★ 打开弹窗时**只预勾**「确定失效」，存疑项必须用户自己动手');
    ok(/filter\(r => r\.level === 'certain'\)\.forEach\(r => state\.prune\.picked\.add\(r\.id\)\)/.test(appSrcP),
      '★★ 「全选」也只选确定失效 —— 一键全选不能把存疑项一起带走');
    ok(/await API\.pruneInvalid\(ids\)/.test(appSrcP), '点「清理」走主进程 IPC（不在渲染层删数据）');
    ok(/await API\.restoreItems\(last\.map/.test(appSrcP), '清理结果里能一键撤销');

    const indexSrcP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
    ok(/id="btnPruneInvalid"/.test(indexSrcP), '设置面板有入口按钮');
    ok(/id="btnPruneUndo"/.test(indexSrcP) && /id="btnPruneAll"/.test(indexSrcP), '弹窗里有撤销与全选');
  }

  section('事件白名单对账');
  {
    // preload 的 EVENTS 白名单漏登记一个频道，API.on 会**静默**返回空函数 ——
    // 探针看起来跑了，其实渲染层一个字都没收到（--perf-probe 真栽过这个，
    // 白白等了 5 分钟看门狗才退出，日志里只有一行"用了 300757ms"）。
    const evLine = (preloadSrc.match(/const EVENTS = \[[\s\S]*?\];/) || [''])[0];
    const declared = new Set((evLine.match(/'ql:[^']+'/g) || []).map(s => s.slice(1, -1)));
    const sent = [...new Set((mainSrc.match(/send\(\s*'ql:[^']+'/g) || [])
      .map(s => s.match(/'ql:[^']+'/)[0].slice(1, -1)))];
    // ★ 先把"两边都解析出来了"钉死：解析失败会得到空集合，下面的差集断言就**永远为绿**，
    //   等于没写（本项目吃过好几次"空集合上的断言"的亏）。
    ok(declared.size >= 15, 'preload 的 EVENTS 白名单解析成功', `解析到 ${declared.size} 条`);
    ok(sent.length >= 15, "main.js 的 send('ql:…') 解析成功", `解析到 ${sent.length} 条`);
    ok(!/EVENTS\.push/.test(preloadSrc),
      '白名单是字面量数组（如果改成 push，上面这条静态对账就失效了，得换写法）');
    const missing = sent.filter(c => !declared.has(c));
    ok(missing.length === 0,
      '★ main.js 每个 send(\'ql:…\') 频道都在 preload 白名单里（漏了就是「探针白跑」）',
      `缺: ${missing.join(', ')}`);
    ok(declared.has('ql:perf-probe') && /PERF_PROBE/.test(mainSrc),
      '--perf-probe 的频道与常量都已就位');

    /* ---- invoke / handle 对账（v1.4.4 补的）----
       preload 漏挂一个方法 → 渲染层那次调用直接抛 TypeError，被 catch 吞掉：
       ".url 自愈永远没生效"，而且日志里一个字都没有（v1.4.4 就踩了这个：写了
       ql:heal:urls 的 handler 却忘了在 preload 暴露 healUrls）。
       主进程漏挂 handler → invoke 只回 "No handler registered"，同样是静默的。 */
    const invoked = [...new Set((preloadSrc.match(/invoke\(\s*'ql:[^']+'/g) || [])
      .map(s => s.match(/'ql:[^']+'/)[0].slice(1, -1)))];
    const handled = new Set((mainSrc.match(/ipcMain\.handle\(\s*'ql:[^']+'/g) || [])
      .map(s => s.match(/'ql:[^']+'/)[0].slice(1, -1)));
    ok(invoked.length >= 15, "preload 的 invoke('ql:…') 解析成功", `解析到 ${invoked.length} 条`);
    ok(handled.size >= 15, "main.js 的 ipcMain.handle('ql:…') 解析成功", `解析到 ${handled.size} 条`);
    const noHandler = invoked.filter(c => !handled.has(c));
    ok(noHandler.length === 0,
      '★ preload 每个 invoke 的频道主进程都有 handle（漏了渲染层只看到 "No handler registered"）',
      `缺: ${noHandler.join(', ')}`);
    ok(invoked.includes('ql:heal:urls') && handled.has('ql:heal:urls'),
      '.url 自愈的 ql:heal:urls 两边都在（少一边 = 永远静默失败）');
  }

  /* ------------------------------------------------------------------
   * 差量引擎 vcdiff —— 纯函数、不碰 fs，所以能直接在这里跑
   * ------------------------------------------------------------------ */
  section('差量引擎 vcdiff');
  const vc = require('../src/lib/vcdiff');
  /* 确定性伪随机（xorshift32）：每次跑出来的字节完全一样，CI 上不会飘。
     ★ 这里**不能**用 LCG（`s = s*1103515245 + 12345`）：它的字节分布是退化的
       （实测卡方 151774，理想值约 255），Gear 哈希在这种数据上一次都不切块，
       于是"平均块长"这条断言会假失败 —— 而真实数据、xorshift 数据都正常。
       一旦测试数据退化，断言既会假红也可能假绿，等于没测。 */
  const xs32 = (n, seed) => {
    const b = Buffer.allocUnsafe(n);
    let x = (seed >>> 0) || 1;
    for (let i = 0; i < n; i++) {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      b[i] = x & 0xff;
    }
    return b;
  };
  // 生成器的质量本身也要验：卡方偏得离谱就说明后面的断言不可信
  {
    const probe = xs32(65536, 3);
    const cnt = new Array(256).fill(0);
    for (const v of probe) cnt[v]++;
    const exp = probe.length / 256;
    const chi = cnt.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
    ok(chi < 400, `测试数据生成器分布正常（卡方 ${Math.round(chi)}，255 自由度下理想≈255）`);
  }

  const big = xs32(256 * 1024, 5);
  const cs = vc.chunkify(big);
  ok(cs.every(c => c.len >= vc.MIN_CHUNK && c.len <= vc.MAX_CHUNK), '每个块长度都在 [MIN_CHUNK, MAX_CHUNK] 内');
  ok(cs.reduce((s, c) => s + c.len, 0) === big.length, '所有块长度之和 = 文件长度（不丢字节）');
  ok(cs.every((c, i) => i === 0 || cs[i - 1].start + cs[i - 1].len === c.start), '块首尾相接，无缝隙无重叠');
  const avgChunk = big.length / cs.length;
  ok(avgChunk > 1500 && avgChunk < 26000,
    `平均块长 ${Math.round(avgChunk)} 字节落在合理区间（设计期望 ~10 KiB）`);

  /* ★★ 内容定义分块的**核心性质**：中间插入一段，后面所有边界只做平移、不重新洗牌。
     固定长度分块（以及"切得太稀、退化成固定长度"）会在这里立刻失败。 */
  const ins = Buffer.alloc(3000, 0x5a);
  const at = 100000;
  const shifted = Buffer.concat([big.subarray(0, at), ins, big.subarray(at)]);
  const starts2 = new Set(vc.chunkify(shifted).map(c => c.start));
  const eligible = cs.map(c => c.start).filter(s => s > at + 2 * vc.MAX_CHUNK);
  const keep = eligible.filter(s => starts2.has(s + ins.length)).length;
  ok(eligible.length > 5, '有足够多的边界可用来验证平移性质', `eligible=${eligible.length}`);
  ok(keep / eligible.length >= 0.8,
    `中间插入 ${ins.length} 字节后，${(keep / eligible.length * 100).toFixed(0)}% 的后续边界仍复用在平移后的位置（≥80%）`);
  // ★ 实测过：Gear 的低位只由最后一个字节决定，用低位掩码去切，真实数据上几乎切不动
  //   （app.asar 变成平均 23 KiB 一块，复用率 0/11，差量对该文件直接失效）。
  ok((vc.MASK & 0xff) === 0, '切割掩码不使用低 8 位（Gear 低位没混匀，会在真实数据上退化成大块）');

  /* ---- 目录级差量 ---- */
  const A = { path: 'a.bin', data: xs32(300 * 1024, 7) };        // 原样不变
  const B = { path: 'b.bin', data: xs32(1024 * 1024, 21) };      // 中间改 19 字节
  const C = { path: 'gone.bin', data: xs32(50 * 1024, 9) };      // 被删掉
  const D = { path: 'new.bin', data: xs32(20 * 1024, 11) };      // 新增
  const bNew = Buffer.from(B.data);
  bNew.write('CHANGED-QUICKLAUNCH!', 500000, 'utf8');

  const dp = vc.makeDirPatch([A, B, C], [A, { path: 'b.bin', data: bNew }, D]);
  const byPath = new Map(dp.manifest.files.map(f => [f.path, f]));
  ok(byPath.get('a.bin').action === 'same', '内容没变的文件标为 same（客户端保留本地那份，零下载）');
  ok(byPath.get('b.bin').action === 'patch', '内容变了的文件标为 patch');
  ok(byPath.get('new.bin').action === 'patch', '新增的文件标为 patch');
  ok(dp.manifest.removed.length === 1 && dp.manifest.removed[0] === 'gone.bin', '被删掉的文件进 removed 列表');

  /* ★ 回归：指令必须是统一的 4 元组 [type, a, b, len]。
     一开始 COPY 写 4 元、DATA 写 3 元，长度落在不同下标上 → 还原算出 NaN 直接炸。 */
  const allOps = dp.manifest.files.filter(f => f.action === 'patch').flatMap(f => f.ops);
  ok(allOps.length > 0 && allOps.every(o => Array.isArray(o) && o.length === 4),
    '所有指令都是 4 元组（长度恒在 index 3）');
  /* ★ 回归：相邻同类指令必须合并。不合并的话，1 MB 文件会产出上百条 COPY 指令，
     manifest 光是指令表就能膨胀到几百 KB，增量也就白做了。 */
  ok(byPath.get('b.bin').ops.length <= 5,
    `改 19 字节的 1 MB 文件只有 ${byPath.get('b.bin').ops.length} 条指令（≤5，说明合并生效）`);
  ok(dp.pack.length < (B.data.length + D.data.length) / 4,
    `差量包 ${dp.pack.length} 字节，远小于全量的 ${B.data.length + D.data.length} 字节`);

  const local = new Map([[A.path, A.data], [B.path, B.data], [C.path, C.data]]);
  let produced = null, applyErr = null;
  try { produced = vc.applyDirPatch(local, dp.manifest, dp.pack); } catch (e) { applyErr = e; }
  ok(!applyErr, '正常补丁能应用', applyErr && applyErr.message);
  const om = new Map((produced || []).map(f => [f.path, f.data]));
  ok(om.size === 2, `产出 2 个文件（实际 ${om.size}）`);
  ok(om.has('b.bin') && om.get('b.bin').equals(bNew), 'b.bin 还原后**逐字节**等于新版本');
  ok(om.has('new.bin') && om.get('new.bin').equals(D.data), 'new.bin 还原后**逐字节**等于新版本');
  ok(!om.has('a.bin'), '标为 same 的文件不重复产出（客户端本来就有一模一样的那份）');

  /* ---- 坏输入必须抛错：宁可退回全量下载，也不能打出半残的程序 ---- */
  const badPack = Buffer.from(dp.pack);
  badPack[0] ^= 0xff;
  let pe = null; try { vc.applyDirPatch(local, dp.manifest, badPack); } catch (e) { pe = e; }
  ok(!!pe, '补丁包被改一个字节 → 抛错（哈希校验兜住）');

  const tampered = new Map(local);
  tampered.set('b.bin', Buffer.alloc(B.data.length, 0x00));
  let te = null; try { vc.applyDirPatch(tampered, dp.manifest, dp.pack); } catch (e) { te = e; }
  ok(!!te, '本地基准文件被改过 → 抛错（上层据此自动退回全量下载）');

  const missing = new Map(local);
  missing.delete('gone.bin');
  let me = null; try { vc.applyDirPatch(missing, dp.manifest, dp.pack); } catch (e) { me = e; }
  ok(!!me, '本地缺基准文件 → 抛错');

  /* ---- 增量 / 全量的判定：判据是**占比**，不是"文件大不大" ---- */
  ok(vc.shouldUseDelta(0.25 * 1048576, 153 * 1048576, 0.6) === true, '差量占 0.16% → 走增量');
  ok(vc.shouldUseDelta(100 * 1048576, 153 * 1048576, 0.6) === false, '差量占 65% → 超过阈值，走全量');
  ok(vc.shouldUseDelta(1024, 0, 0.6) === false, '全量大小未知/为 0 → 不冒险，走全量');

  /* ------------------------------------------------------------------
   * 自更新纯逻辑 updater-core —— 决定「走增量还是走全量」以及各种拒绝条件
   * ------------------------------------------------------------------ */
  section('自更新 决策与校验 updater-core');
  const core = require('../src/lib/updater-core');

  // 拿真实引擎造一份小清单，别手写假数据（手写的假数据只能证明假数据自洽）
  const o1 = Buffer.from('hello quicklaunch '.repeat(4000));          // 约 68 KB
  const n1 = Buffer.from(o1);
  n1.write('CHANGED', 30000, 'utf8');
  const pk = vc.makeDirPatch([{ path: 'f.bin', data: o1 }], [{ path: 'f.bin', data: n1 }]);
  const mkManifest = (over = {}) => Object.assign({
    schema: 1,
    app: 'QuickLaunch',
    channel: 'green',
    version: '2.0.0',
    unpackedSize: n1.length,
    full: { asset: 'QuickLaunch-Green-2.0.0.zip', size: pk.pack.length * 20, sha256: 'f'.repeat(64) },
    files: [{ path: 'f.bin', size: n1.length, sha256: vc.sha256hex(n1) }],
    patches: [{
      from: '1.0.0',
      asset: 'QuickLaunch-Delta-1.0.0-to-2.0.0.bin',
      size: pk.pack.length,
      sha256: vc.sha256hex(pk.pack),
      plan: pk.manifest,
    }],
  }, over);

  const localOk = [{ path: 'f.bin', size: o1.length, sha256: vc.sha256hex(o1) }];
  const man = mkManifest();

  ok(core.validManifest(man) === man, '合法清单通过校验');
  ok(core.validManifest(null) === null, 'null 清单 → 判为不可用（上层退全量，而不是崩）');
  ok(core.validManifest({ ...man, schema: 9 }) === null, 'schema 不认识 → 判为不可用（不猜格式）');
  ok(core.validManifest({ ...man, full: { asset: 'x.zip' } }) === null, '全量包缺 sha256 → 判为不可用（没法验签就不敢下）');
  ok(core.validManifest({ ...man, files: 'oops' }) === null, 'files 不是数组 → 判为不可用');

  const okPlan = core.selectPlan(man, '1.0.0', localOk);
  ok(okPlan.mode === 'delta', '本机版本有对应差量 + 基准全对 → 走增量', `mode=${okPlan.mode}`);
  ok(core.selectPlan(man, '0.9.0', localOk).mode === 'full', '本机版本没有对应差量 → 走全量');
  ok(core.selectPlan(man, '', localOk).mode === 'full', '本机版本未知 → 走全量');
  ok(core.selectPlan(man, '1.0.0', []).mode === 'full', '没有任何本地文件可比对 → 走全量');
  ok(core.selectPlan(man, '1.0.0', [{ path: 'f.bin', size: o1.length, sha256: 'a'.repeat(64) }]).mode === 'full',
    '本地文件哈希对不上旧清单 → 走全量（被改过或版本不符）');
  ok(core.selectPlan(man, '1.0.0', [{ path: 'f.bin', size: o1.length + 1, sha256: vc.sha256hex(o1) }]).mode === 'full',
    '本地文件大小对不上 → 走全量');
  const tooBig = mkManifest();
  tooBig.patches[0].size = Math.ceil(tooBig.full.size * 0.7);
  const tb = core.selectPlan(tooBig, '1.0.0', localOk);
  ok(tb.mode === 'full' && /阈值/.test(tb.reason), '差量占 70% → 走全量，且 reason 说明是阈值问题', tb.reason);
  ok(core.DELTA_LIMIT === 0.6, '默认阈值是 60%');

  // 增量产出必须落在清单内；applyDelta 会拒收清单之外/受保护路径
  const applied = core.applyDelta(man, man.patches[0], pk.pack,
    new Map([['f.bin', o1]]));
  ok(applied.length === 1 && applied[0].data.equals(n1), 'applyDelta 产出逐字节等于目标文件');

  const badPlan = JSON.parse(JSON.stringify(man));
  badPlan.patches[0].plan.files = [{ path: 'data/config.json', size: 4, sha256: 'x', action: 'patch', ops: [[1, 0, 0, 4]] }];
  let pe2 = null;
  try { core.applyDelta(badPlan, badPlan.patches[0], pk.pack, new Map()); } catch (e) { pe2 = e; }
  ok(!!pe2, '差量清单里出现 data/ 下的文件 → 直接抛错拒做（更新器绝不碰用户数据）');

  const outside = JSON.parse(JSON.stringify(man));
  outside.patches[0].plan.files = [{ path: 'not/in/manifest.bin', size: 1, sha256: 'x', action: 'patch', ops: [[1, 0, 0, 1]] }];
  let pe3 = null;
  try { core.applyDelta(outside, outside.patches[0], pk.pack, new Map()); } catch (e) { pe3 = e; }
  ok(!!pe3, '补丁产出清单之外的文件 → 抛错');

  const rl = core.removalList({ plan: { removed: ['data/config.json', 'old.txt'] } });
  ok(rl.paths.length === 1 && rl.paths[0] === 'old.txt', '待删列表只留非受保护路径');
  ok(rl.skipped.length === 1 && rl.skipped[0] === 'data/config.json', '受保护路径进 skipped：只报告、绝不删');

  const vv = core.verifyDir(man, [{ path: 'f.bin', size: n1.length, sha256: vc.sha256hex(n1) }]);
  ok(vv.ok && vv.checked === 1, '完整正确的目录 → verifyDir 通过');
  ok(!core.verifyDir(man, []).ok, '空目录 → verifyDir 不通过（会报 missing）');
  ok(core.verifyDir(man, []).missing.length === 1, '空目录报出缺失的文件');
  const ve = core.verifyDir(man, [
    { path: 'f.bin', size: n1.length, sha256: vc.sha256hex(n1) },
    { path: 'user-added.txt', size: 3, sha256: 'z'.repeat(64) },
  ]);
  ok(ve.ok && ve.extra.length === 1, '多出来的文件不算失败，但要报出来（更新器不主动删看不懂的文件）');
  ok(core.verifyDir(man, [{ path: 'f.bin', size: n1.length, sha256: 'b'.repeat(64) }]).differ.length === 1,
    '内容不符会被 verifyDir 单独列进 differ');
  ok(/v2\.0\.0/.test(core.summarize(man)), 'summarize 里带版本号', core.summarize(man));

  /* ------------------------------------------------------------------
   * 自更新 执行层（updater.js）—— 传输层注入，全程离线
   * ------------------------------------------------------------------ */
  section('自更新 执行层 updater');
  const updater = require('../src/lib/updater');

  // ---- 版本比较 ----
  ok(updater.isNewer('1.2.0', '1.1.1') === true, '1.2.0 比 1.1.1 新');
  ok(updater.isNewer('1.1.1', '1.1.1') === false, '同版本不算新');
  ok(updater.isNewer('1.1.0', '1.1.1') === false, '旧版本不算新');
  ok(updater.isNewer('2.0.0', '1.9.9') === true, '主版本号优先');
  ok(updater.isNewer('1.10.0', '1.9.0') === true, '1.10.0 > 1.9.0（按数字比，不是按字符串比）');
  // ★ 解析不出来时必须"不算新"：假报有更新会把用户引向一个不存在的资产
  ok(updater.isNewer('abc', '1.0.0') === false, '版本号解析不出来 → 保守地判"不是新版"');
  ok(updater.isNewer('1.0.0', '') === false, '本机版本为空 → 判"不是新版"');
  ok(updater.parseVer('v1.2.3') === null && updater.parseVer('1.2.3') !== null, 'parseVer 只认裸三段数字');

  // ---- 更新源 ----
  ok(updater.normalizeBase('') === updater.DEFAULT_BASE, '空更新源 → 默认 GitHub latest');
  ok(updater.DEFAULT_BASE.includes('/releases/latest/download'),
    '默认走 releases/latest/download（会 302 到最新 Release 的资产）');
  ok(updater.normalizeBase(' https://mirror.example/ql/ ') === 'https://mirror.example/ql',
    '更新源去掉首尾空白与尾部斜杠');
  let nbaseErr = null;
  try { updater.normalizeBase('ftp://x'); } catch (e) { nbaseErr = e.message; }
  ok(!!nbaseErr && /http\(s\)/.test(nbaseErr), '非 http(s) 的更新源直接报错', nbaseErr || '');
  ok(updater.feedUrl('https://m') === 'https://m/update.json', 'feedUrl 拼的是 update.json');

  // ---- 形态支持 ----
  ok(updater.canSelfUpdate('installed').ok && updater.canSelfUpdate('green').ok,
    '安装版与绿色版都支持自更新');
  ok(updater.canSelfUpdate('portable').ok === false, '便携版不做自更新（单文件 exe 换不了自己）');
  ok(/单文件/.test(updater.canSelfUpdate('portable').reason), '便携版给出人话原因',
    updater.canSelfUpdate('portable').reason);
  ok(updater.canSelfUpdate('dev').ok === false, '开发模式不做自更新');

  // ---- 扫本机程序目录：受保护目录必须整棵跳过 ----
  const PROG = path.join(TMP, 'prog');
  const put = (rel, content) => {
    const p = path.join(PROG, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  put('QuickLaunch.exe', 'EXE');
  put('resources/app.asar', 'ASAR');
  put('locales/zh-CN.pak', 'PAK');
  put('data/config.json', '{"secret":1}');          // 诱饵：绝不能进清单
  put('data/nested/deep.bin', 'DEEP');
  put('.probe-shot/shot.png', 'SHOT');              // 诱饵
  put('.update/1.0.0/files/x', 'STAGE');            // 诱饵：暂存区
  const scanned = updater.scanProgramDir(PROG);
  const rels = scanned.map(f => f.path);
  ok(rels.length === 3, `扫到 3 个程序文件（实际 ${rels.length}：${rels.join(',')}）`);
  ok(rels.includes('QuickLaunch.exe') && rels.includes('resources/app.asar'), '程序文件在清单里');
  ok(rels.every(p => !p.startsWith('data/')), '★ data/ 下的文件一个都没进清单');
  ok(rels.every(p => !p.startsWith('.probe-shot/') && !p.startsWith('.update/')),
    '★ .probe-shot / .update 也没进清单');
  ok(scanned.every(f => f.sha256 === vc.sha256hex(fs.readFileSync(path.join(PROG, ...f.path.split('/'))))),
    '每个文件的 sha256 与磁盘上的真实内容一致（不是占位值）');
  ok(scanned.every(f => typeof f.size === 'number' && /^[0-9a-f]{64}$/.test(f.sha256)), '每项都有 size 与 sha256');

  // ---- check()：注入传输，把各种上游情况都走一遍 ----
  const feed = (payload, opts = {}) => async (url, o) => {
    if (opts.throwStatus) { const e = new Error('HTTP ' + opts.throwStatus); e.status = opts.throwStatus; throw e; }
    if (opts.throwMsg) throw new Error(opts.throwMsg);
    if (payload === null) return Buffer.from('not json at all');
    void url; void o;
    return Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  };

  const mkUpd = (over = {}) => Object.assign({
    schema: 1, app: 'QuickLaunch', channel: 'green', version: '2.0.0',
    full: { asset: 'QuickLaunch-Green-2.0.0.zip', size: 1000, sha256: 'a'.repeat(64) },
    files: [{ path: 'QuickLaunch.exe', size: 3, sha256: vc.sha256hex(Buffer.from('EXE')) }],
    patches: [],
  }, over);

  const c404 = await updater.check({ myVersion: '1.1.1', programDir: PROG, getBuffer: feed(null, { throwStatus: 404 }) });
  ok(c404.ok === true && c404.available === false, '★ 更新源 404（还没有清单）不算错误');
  ok(/还没有发布更新清单/.test(c404.reason), '404 给出人话原因', c404.reason);

  const cNet = await updater.check({ myVersion: '1.1.1', programDir: PROG, getBuffer: feed(null, { throwMsg: 'socket hang up' }) });
  ok(cNet.ok === false && cNet.available === false, '网络失败 → ok:false 但不算"有更新"');
  ok(/取更新清单失败/.test(cNet.reason), '网络失败的原因可读', cNet.reason);

  const cBad = await updater.check({ myVersion: '1.1.1', programDir: PROG, getBuffer: feed(null) });
  ok(cBad.ok === false && /不是合法 JSON/.test(cBad.reason), '清单不是 JSON → 明确报错', cBad.reason);

  const cShape = await updater.check({ myVersion: '1.1.1', programDir: PROG, getBuffer: feed({ schema: 9 }) });
  ok(cShape.ok === false && /格式不认识/.test(cShape.reason), '清单形状不认识 → 明确报错', cShape.reason);

  const cChan = await updater.check({ myVersion: '1.1.1', programDir: PROG, getBuffer: feed(mkUpd({ channel: 'nsis' })) });
  ok(cChan.ok === true && cChan.available === false && /渠道/.test(cChan.reason),
    '渠道不符（不是 green/installed/any）→ 不算有更新', cChan.reason);

  const cSame = await updater.check({ myVersion: '2.0.0', programDir: PROG, getBuffer: feed(mkUpd()) });
  ok(cSame.ok === true && cSame.available === false && /已是最新/.test(cSame.reason), '同版本 → 已是最新');

  // ★ 没有对应本机版本的差量时，绝不该去扫本机目录（扫一次要读 500 MB）
  const cFull = await updater.check({ myVersion: '1.1.1', programDir: PROG, getBuffer: feed(mkUpd()) });
  ok(cFull.available === true && cFull.plan.mode === 'full', '没有差量清单 → 走全量');
  ok(cFull.scanned === 0, '★ 走全量时没有扫本机目录（启动路径不能被 500 MB 读盘拖慢）');
  ok(/没有 1\.1\.1 → 2\.0\.0/.test(cFull.plan.reason), '退回全量的原因是人话', cFull.plan.reason);

  // 有对应差量时才扫；本机文件与补丁基准不符 → 仍然退回全量
  //   ★ 这里必须给一条**真的对不上**的 olds：给空 olds 的话 selectPlan 会合理地判"能走增量"，
  //     那条断言就会因为错误的原因变绿（第一次就是这么写错的）。
  const cCand = await updater.check({
    myVersion: '1.1.1', programDir: PROG,
    getBuffer: feed(mkUpd({
      patches: [{
        from: '1.1.1', asset: 'p.bin', size: 100, sha256: 'b'.repeat(64),
        plan: { version: 1, olds: [{ path: 'QuickLaunch.exe', size: 999999, sha256: 'c'.repeat(64) }], files: [], removed: [] },
      }],
    })),
  });
  ok(cCand.available === true, '有对应差量时认为有更新');
  ok(cCand.scanned > 0, `有对应差量时会扫本机目录（扫到 ${cCand.scanned} 个文件）`);
  ok(cCand.plan.mode === 'full', '★ 基准与补丁清单不符 → 仍然自动退回全量', cCand.plan.reason);
  ok(/不符|被改动/.test(cCand.plan.reason), '退回全量的原因指出了是基准不符', cCand.plan.reason);

  // ---- downloadAsset：三种失败都要能兜住，且不留垃圾 ----
  // ★ 注入的传输层必须**遵守真实传输层的约定**：给了 destPath 就要往那里写盘。
  //   只返回 Buffer、不落盘的假实现会让这条链路"看起来通过、其实根本没验到写盘"。
  const DL = path.join(TMP, 'dl.bin');
  const dlSha = vc.sha256hex(Buffer.from('PAYLOAD'));
  const serveFile = (body) => async (url, o) => {
    void url;
    if (o && o.destPath) {
      fs.writeFileSync(o.destPath, body);
      return { path: o.destPath, size: body.length, total: body.length };
    }
    return Buffer.from(body);
  };
  const dlOk = await updater.downloadAsset({
    base: 'https://m', asset: 'p.bin', size: 7, sha256: dlSha, dest: DL,
    getBuffer: serveFile('PAYLOAD'),
  });
  ok(dlOk.ok && fs.readFileSync(DL, 'utf8') === 'PAYLOAD', '下载正常路径通过（真的落了盘）');

  const dlShaBad = await updater.downloadAsset({
    base: 'https://m', asset: 'p.bin', size: 7, sha256: 'f'.repeat(64), dest: DL,
    getBuffer: serveFile('PAYLOAD'),
  });
  ok(dlShaBad.ok === false && /sha256/.test(dlShaBad.reason), 'sha256 不符 → 失败并说明原因', dlShaBad.reason);
  ok(!fs.existsSync(DL), '★ 校验失败的文件被立刻删掉（绝不留一个看似下好的坏包）');

  const dlSizeBad = await updater.downloadAsset({
    base: 'https://m', asset: 'p.bin', size: 999, sha256: dlSha, dest: DL,
    getBuffer: serveFile('PAYLOAD'),
  });
  ok(dlSizeBad.ok === false && /大小不符/.test(dlSizeBad.reason), '大小不符 → 失败', dlSizeBad.reason);

  const dlErr = await updater.downloadAsset({
    base: 'https://m', asset: 'p.bin', size: 7, sha256: dlSha, dest: DL,
    getBuffer: async () => { throw new Error('ECONNRESET'); },
  });
  ok(dlErr.ok === false && /ECONNRESET/.test(dlErr.reason), '传输异常 → 失败并带上原始原因', dlErr.reason);
  ok(!fs.existsSync(DL), '传输异常后也没有残留文件');

  // ---- ★ 真传输层 httpGetBuffer：给了 destPath 必须真的落盘 ----
  //   上面所有假传输层都"守规矩地"落了盘，却从没验过**真实现**也守规矩 —— "下载后读不到文件：
  //   ENOENT" 那个线上 bug 就藏在这儿：httpGetBuffer 曾把 destPath 写死成 null，于是真实下载
  //   只把字节收进内存 Buffer、从不写盘，下游 statSync 直接 ENOENT。
  //   这里起一个 127.0.0.1 本地服务（**不触外网**，离线可重复）直接跑真实现。
  {
    const http = require('http');
    const payload = Buffer.from('DELTA-PAYLOAD-'.repeat(64)); // 896 字节
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const url = `http://127.0.0.1:${port}/QuickLaunch-Delta-1.1.1-to-2.0.0.bin`;
    const outFile = path.join(TMP, 'real-dl.bin');
    try { fs.unlinkSync(outFile); } catch { /* noop */ }
    try {
      // ① 给了 destPath：必须落盘，且返回 {path,size,total}
      const rWrite = await updater.httpGetBuffer(url, { destPath: outFile });
      ok(fs.existsSync(outFile), '★ 真传输层：给了 destPath 就会真的写盘（线上 ENOENT 的根因）');
      const onDisk = fs.existsSync(outFile) ? fs.readFileSync(outFile) : Buffer.alloc(0);
      ok(onDisk.equals(payload), '★ 真传输层落盘的字节与响应体逐字节一致');
      ok(!!(rWrite && rWrite.path === outFile && rWrite.size === payload.length),
        '真传输层给了 destPath 时返回 {path,size}', JSON.stringify(rWrite));

      // ② 不给 destPath：返回 Buffer（getJson 走这条，别把这条也改坏）
      const rBuf = await updater.httpGetBuffer(url);
      ok(Buffer.isBuffer(rBuf) && rBuf.equals(payload), '真传输层不给 destPath 时返回 Buffer');
    } finally {
      srv.close();
    }
  }

  // ---- stage()：用真引擎造真差量，端到端摊进暂存区 ----
  const oldExe = Buffer.from('OLD-EXE-'.repeat(300));
  const newExe = Buffer.from(oldExe); newExe.write('NEW', 100, 'utf8');
  const newPak = Buffer.from('BRAND-NEW-PAK');
  const made = vc.makeDirPatch(
    [{ path: 'QuickLaunch.exe', data: oldExe }, { path: 'old-only.txt', data: Buffer.from('bye') }],
    [{ path: 'QuickLaunch.exe', data: newExe }, { path: 'locales/new.pak', data: newPak }]);
  const patchEntry = {
    from: '1.1.1', asset: 'QuickLaunch-Delta-1.1.1-to-2.0.0.bin',
    size: made.pack.length, sha256: vc.sha256hex(made.pack), plan: made.manifest,
  };
  const stManifest = mkUpd({
    // ★ 清单的 files 是"目标版本的权威文件列表"，applyDelta 会拒绝产出清单之外的文件。
    //   所以这里必须把两个目标文件都声明上 —— 少写一个，stage 会（正确地）拒绝。
    files: [
      { path: 'QuickLaunch.exe', size: newExe.length, sha256: vc.sha256hex(newExe) },
      { path: 'locales/new.pak', size: newPak.length, sha256: vc.sha256hex(newPak) },
    ],
    patches: [patchEntry],
  });
  // ★ 本机真实文件必须与补丁基准**逐字节**一致 —— applyDirPatch 会校验旧清单里的每一个文件
  //   （包括本次不参与 COPY 的 old-only.txt）。基准不对只会得到"补丁打不上"，
  //   那就验不到我们想验的路径了。
  put('QuickLaunch.exe', oldExe);
  put('old-only.txt', 'bye');
  const stg = updater.stage({
    manifest: stManifest, mode: 'delta', patch: patchEntry, pack: made.pack,
    programDir: PROG, myVersion: '1.1.1', exePath: path.join(PROG, 'QuickLaunch.exe'),
  });
  ok(stg.ok === true, 'stage 成功', stg.reason || '');
  // stg.stage 在失败时不存在；用防御式读取让后续断言**变红**，而不是把整个套件崩掉
  // （崩溃会把后面几十条断言一起吞掉，看起来像"改动只坏了一条"）。
  const stgRoot = stg.stage || path.join(TMP, 'stage-missing');
  const readIf = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
  const readJsonIf = (p) => { const b = readIf(p); return b ? JSON.parse(b.toString('utf8')) : null; };
  const stgExe = readIf(path.join(stgRoot, 'files', 'QuickLaunch.exe'));
  ok(!!stgExe && stgExe.equals(newExe), '★ 暂存的 exe 是真引擎还原出来的新版（逐字节等于目标）');
  const stgPak = readIf(path.join(stgRoot, 'files', 'locales', 'new.pak'));
  ok(!!stgPak && stgPak.equals(newPak), '新增文件也摊进暂存区了');
  ok(!fs.existsSync(path.join(stgRoot, 'files', 'old-only.txt')), '旧版本独有的文件不会被摊进暂存区');
  const ajRaw = readIf(path.join(stgRoot, 'apply.json'));
  const aj = ajRaw ? (JSON.parse(ajRaw.toString('utf8')) || {}) : {};
  ok(aj.schema === 1 && aj.to === '2.0.0' && aj.from === '1.1.1', 'apply.json 带 schema/版本');
  ok((aj.writes || []).length === 2 && (aj.writes || []).every(w => /^[0-9a-f]{64}$/.test(w.sha256)),
    'apply.json 的 writes 带 sha256（助手会照着再校一遍）');
  ok((aj.deletes || []).join(',') === 'old-only.txt', 'apply.json 的 deletes 是"新版没有了的旧文件"');
  ok(Array.isArray(aj.protectedTop) && JSON.stringify(aj.protectedTop) === JSON.stringify(datadir.PROTECTED_TOP),
    '★ apply.json 的受保护名单与 datadir.PROTECTED_TOP 完全一致（没有第二份定义）',
    JSON.stringify(aj.protectedTop));
  ok((aj.protectedTop || []).includes('.update'), '★ 名单里含 .update（暂存区自己也算运行时目录）');
  const stStateRaw = readIf(path.join(PROG, '.update', 'state.json'));
  const stState = stStateRaw ? JSON.parse(stStateRaw.toString('utf8')) : {};
  ok(stState.state === 'staged' && stState.to === '2.0.0', 'state.json 记为 staged');
  // ★ 暂存区自己也在受保护名单里 —— 否则它会被算成"程序文件"打进下一个清单
  ok(datadir.isProtectedPath('.update/2.0.0/files/QuickLaunch.exe'), '★ 暂存区路径被判为受保护');

  // 本机基准被动过 → stage 必须失败而不是硬打
  put('QuickLaunch.exe', 'TAMPERED-BEFORE-STAGE');
  const stgBad = updater.stage({
    manifest: stManifest, mode: 'delta', patch: patchEntry, pack: made.pack,
    programDir: PROG, myVersion: '1.1.1',
  });
  ok(stgBad.ok === false && /无法应用/.test(stgBad.reason), '★ 本机基准被改过 → stage 拒绝，绝不硬打半残', stgBad.reason);
  put('QuickLaunch.exe', oldExe);

  // 补丁包被改一个字节 → stage 也必须拒绝
  const tamperedPack = Buffer.from(made.pack); tamperedPack[0] ^= 0xff;
  const stgPack = updater.stage({
    manifest: stManifest, mode: 'delta', patch: patchEntry, pack: tamperedPack,
    programDir: PROG, myVersion: '1.1.1',
  });
  ok(stgPack.ok === false, '★ 补丁包被篡改 → stage 拒绝');

  // 清单少声明了一个目标文件 → 也必须拒绝（补丁不得产出"清单之外"的东西）
  const stgUnder = updater.stage({
    manifest: mkUpd({ files: [stManifest.files[0]], patches: [patchEntry] }),
    mode: 'delta', patch: patchEntry, pack: made.pack, programDir: PROG, myVersion: '1.1.1',
  });
  ok(stgUnder.ok === false && /清单之外/.test(stgUnder.reason),
    '★ 补丁产出了清单里没声明的文件 → 拒绝', stgUnder.reason);

  /* ------------------------------------------------------------------
   * ZIP 读取器 + 全量回退 stageFull —— 用**真写器**产 zip，避免自己造自己的假数据
   * ------------------------------------------------------------------ */
  section('ZIP 读取器 unzip + 全量回退 stageFull');
  const uz = require('../src/lib/unzip.js');
  const cp = require('child_process');

  // 造"目标版本"目录：big.bin 用**压不动**的字节（→ 走 store 分支），
  // app.asar 用高重复文本（→ 走 deflate 分支）。两个分支都要跑到。
  // ★ 这里踩过坑：原先写 `(i * 2654435761) & 0xff`，看着像伪随机，其实是**256 字节的循环**
  //   —— deflate 把 70000 压成 597，于是整包没有一条走 store，断言红；更要命的是包因此只有
  //   1 KB 出头，后面"截断的 zip"那条用 subarray(0, 2000) 压根没截到，等于什么都没测。
  //   写器选 store 的判据是 `deflated.length < raw.length`，所以测试数据必须真的不可压缩。
  const NEWDIR = path.join(TMP, 'newver');
  const putNew = (rel, content) => {
    const p = path.join(NEWDIR, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const bigRnd = Buffer.alloc(70000);
  {
    let seed = 0x2545f491;
    for (let i = 0; i < bigRnd.length; i++) {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5; seed >>>= 0;
      bigRnd[i] = seed & 0xff;
    }
  }
  const asarTxt = Buffer.from('ASAR-CONTENT-'.repeat(900));
  putNew('big.bin', bigRnd);
  putNew('resources/app.asar', asarTxt);
  putNew('locales/zh-CN.pak', Buffer.from('中文内容'.repeat(400)));
  putNew('data/secret.json', '{"must":"not be packed"}');   // 诱饵：写器必须排除

  const ZIP = path.join(TMP, 'green.zip');
  const pg = cp.spawnSync(process.execPath,
    [path.join(__dirname, '..', 'scripts', 'pack-green.mjs'), '--src', NEWDIR, '--out', ZIP, '--need', 'resources/app.asar'],
    { encoding: 'utf8', cwd: path.join(__dirname, '..') });
  ok(pg.status === 0, '用真写器（pack-green.mjs）成功打出 zip', String(pg.stderr || '').split('\n')[0]);
  const zipBuf = fs.readFileSync(ZIP);
  const zlist = uz.listZip(zipBuf);
  ok(zlist.length === 3, `zip 里 3 个条目（实际 ${zlist.length}）`);
  ok(!zlist.some(e => e.name.startsWith('data/')), '★ 运行时目录 data/ 没被打进 zip（写器的排除守卫生效）');
  // ★ 先证明 fixture 本身合格，再看 store/deflate 分支 —— 否则"没走到 store"会被误读成写器的 bug
  ok(require('zlib').deflateRawSync(bigRnd, { level: 9 }).length >= bigRnd.length,
    'fixture 的 big.bin 真的压不动（写器才会选 store）');
  ok(zlist.some(e => e.method === 0) && zlist.some(e => e.method === 8),
    '两种压缩方式都覆盖到了（store + deflate），两个分支都真跑过',
    zlist.map(e => `${e.name}=${e.method}`).join(' '));
  ok(zipBuf.length > 2000, `整包比"截断测试"的截断长度还长（实际 ${zipBuf.length} 字节）`);
  const zall = uz.extractAll(zipBuf);
  const srcOf = (rel) => fs.readFileSync(path.join(NEWDIR, ...rel.split('/')));
  ok(zall.every(f => f.data.equals(srcOf(f.name))), '★ 逐字节读回来与源文件一致',
    zall.filter(f => !f.data.equals(srcOf(f.name))).map(f => f.name).join(','));
  const EXTRACTED = path.join(TMP, 'unzipped');
  const wrote = uz.extractToDir(zipBuf, EXTRACTED);
  ok(wrote.length === 3 && wrote.every(f => fs.readFileSync(path.join(EXTRACTED, ...f.path.split('/'))).equals(srcOf(f.path))),
    '解包到目录也逐字节一致');
  ok(uz.crc32(Buffer.from('123456789')) === 0xCBF43926, 'CRC32 标准向量对得上（0xCBF43926）');

  // 坏一个数据字节 → 必须抛（不能悄悄写进程序目录）
  {
    const bad = Buffer.from(zipBuf);
    const e0 = zlist[0];
    bad[e0.localOffset + 30 + Buffer.byteLength(e0.name) + 2] ^= 0xff;
    let err = null;
    try { uz.extractEntry(bad, e0); } catch (e) { err = e.message; }
    ok(!!err && /CRC|解压/.test(err), '★ 数据被改一个字节 → 抛错（不是"尽力而为"地解出半残文件）', err || '');
  }
  // 不认识的压缩方式 → 明确抛
  {
    const bad = Buffer.from(zipBuf);
    const eocd = uz.findEocd(bad);
    const cdOff = bad.readUInt32LE(eocd + 16);
    bad.writeUInt16LE(99, cdOff + 10);
    let err = null;
    try { uz.listZip(bad); } catch (e) { err = e.message; }
    ok(!!err && /压缩方式/.test(err), '不认识的压缩方式 → 明确报错', err || '');
  }
  // zip slip / 受保护路径（纯函数直测）
  {
    const bad = (n) => { try { uz.assertSafeName(n, datadir.isProtectedPath); return 'ok'; } catch (e) { return e.message; } };
    ok(/绝对路径/.test(bad('/etc/passwd')), '绝对路径条目名被拒');
    ok(/绝对路径/.test(bad('C:/win.exe')), '盘符开头的条目名被拒');
    ok(/含 \.\./.test(bad('../evil.txt')) || /\.\./.test(bad('../evil.txt')), '.. 穿越条目名被拒');
    ok(/反斜杠/.test(bad('a\\b.txt')), '反斜杠条目名被拒');
    ok(/受保护/.test(bad('data/config.json')), '★ 落在受保护目录的条目名被拒');
    ok(bad('resources/app.asar') === 'ok', '正常条目名放行');
  }

  // ---- stageFull：全量回退的端到端 ----
  const PROG2 = path.join(TMP, 'prog2');
  const putP = (rel, content) => {
    const p = path.join(PROG2, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const mkFullManifest = (zipB, files) => ({
    schema: 1, app: 'QuickLaunch', channel: 'green', version: '2.0.0',
    full: { asset: 'QuickLaunch-Green-2.0.0.zip', size: zipB.length, sha256: vc.sha256hex(zipB) },
    files: files.map(f => ({ path: f.name, size: f.data.length, sha256: vc.sha256hex(f.data) })),
    patches: [],
  });
  const FULL_MAN = mkFullManifest(zipBuf, zall);

  // 本机：big.bin 与目标**完全相同**、app.asar 是旧的、locales/new.pak 缺
  putP('big.bin', bigRnd);
  putP('resources/app.asar', Buffer.from('OLD-ASAR'));
  const sf = await updater.stageFull({
    manifest: FULL_MAN, base: 'https://m', programDir: PROG2, myVersion: '1.1.1',
    getBuffer: serveFile(zipBuf),
  });
  ok(sf.ok === true, 'stageFull 成功', sf.reason || '');
  const sfRoot = sf.stage || path.join(TMP, 'sf-missing');
  const sfAj = readJsonIf(path.join(sfRoot, 'apply.json'));
  ok(!!sfAj && sfAj.mode === 'full', 'apply.json 记的是 full 模式');
  const sfPaths = ((sfAj && sfAj.writes) || []).map(w => w.path).sort();
  ok(sfPaths.join(',') === 'locales/zh-CN.pak,resources/app.asar',
    '★ 只摊了真正变了的文件（big.bin 本机已一致，没有被重复写）', sfPaths.join(','));
  ok(!!sfAj && Array.isArray(sfAj.deletes) && sfAj.deletes.length === 0,
    '★ 全量路径的 deletes 恒为空（不知道本机多出来的是什么，就绝不删）');
  ok(!!sfAj && JSON.stringify(sfAj.protectedTop) === JSON.stringify(datadir.PROTECTED_TOP),
    '★ 全量路径写出的受保护名单同样来自 datadir（两条路都过同一道闸）');
  ok(!fs.existsSync(path.join(sfRoot, 'QuickLaunch-Green-2.0.0.zip')), 'zip 用完就删（不把 160 MB 留在用户盘上）');
  ok(fs.readFileSync(path.join(PROG2, 'big.bin')).equals(bigRnd), '本机没被动的文件仍然原样');

  // 本机已经全对 → 什么都不做，并且不留暂存区
  putP('resources/app.asar', asarTxt);
  putP('locales/zh-CN.pak', Buffer.from('中文内容'.repeat(400)));
  const sfSame = await updater.stageFull({
    manifest: FULL_MAN, base: 'https://m', programDir: PROG2, myVersion: '1.1.1',
    getBuffer: serveFile(zipBuf),
  });
  ok(sfSame.ok === true && sfSame.nothingToDo === true, '★ 本机已与目标一致 → 明确返回"无需替换"', sfSame.reason);
  ok(!fs.existsSync(path.join(PROG2, '.update', '2.0.0')), '★ 无事可做时暂存区被清掉（不留几百 MB）');

  // 包与清单不符 → 必须拒绝，并清场
  {
    const wrong = JSON.parse(JSON.stringify(FULL_MAN));
    wrong.files.find(f => f.path === 'resources/app.asar').sha256 = 'd'.repeat(64);
    const r = await updater.stageFull({
      manifest: wrong, base: 'https://m', programDir: PROG2, myVersion: '1.1.1', getBuffer: serveFile(zipBuf),
    });
    ok(r.ok === false && /不符/.test(r.reason), '★ 包内容与清单不符 → 拒绝替换', r.reason);
    ok(!fs.existsSync(path.join(PROG2, '.update', '2.0.0')), '失败后暂存区被清场');
  }
  // 坏 zip → 明确报"解不开"，并清场
  {
    // ★ 按比例截：原先写死 subarray(0, 2000)，而当时的包只有 1 KB 出头 —— 等于**没有截**，
    //   这条断言在"产品代码完全正常"和"解包完全不校验"两种情况下都是绿的。
    const cut = zipBuf.subarray(0, Math.floor(zipBuf.length / 2));
    ok(cut.length < zipBuf.length, `截断体确实比整包短（${cut.length} < ${zipBuf.length}）`);

    // ① 清单仍按整包描述 → 第 1 步的大小校验就该拦住，连解都不去解
    const r1 = await updater.stageFull({
      manifest: FULL_MAN, base: 'https://m', programDir: PROG2, myVersion: '1.1.1',
      getBuffer: serveFile(cut),
    });
    ok(r1.ok === false && /大小不符/.test(r1.reason),
      '★ 下到一半的包在第 1 步就被拦住（不浪费时间去解它）', r1.reason);

    // ② 清单也按截断体描述（模拟"包本身就是坏的/清单被改过"）→ 必须倒在解包这一步
    const cutMan = JSON.parse(JSON.stringify(FULL_MAN));
    cutMan.full.size = cut.length;
    cutMan.full.sha256 = vc.sha256hex(cut);
    const r2 = await updater.stageFull({
      manifest: cutMan, base: 'https://m', programDir: PROG2, myVersion: '1.1.1',
      getBuffer: serveFile(cut),
    });
    ok(r2.ok === false && /解不开/.test(r2.reason),
      '★ 坏包 → 明说解不开（绝不尽力解出半残文件）', r2.reason);
    ok(!fs.existsSync(path.join(PROG2, '.update', '2.0.0')), '坏包失败后暂存区同样被清场');
  }
  // hash 不符的 zip → downloadAsset 就该拦住
  {
    const wrong = JSON.parse(JSON.stringify(FULL_MAN));
    wrong.full.sha256 = 'e'.repeat(64);
    const r = await updater.stageFull({
      manifest: wrong, base: 'https://m', programDir: PROG2, myVersion: '1.1.1', getBuffer: serveFile(zipBuf),
    });
    ok(r.ok === false && /sha256/.test(r.reason), '★ zip 校验失败在第 1 步就被拦住（不会解一个坏包）', r.reason);
  }

  /* ------------------------------------------------------------------
   * 构建后清理 prune-dist：dist\ 只留当前版本，旧版本全删
   * ------------------------------------------------------------------
   * 用户需求：「每次编译完之后删掉之前的版本 只保留最新版」。
   * 规则从严：只删**认识得出来**的产物名（Setup/Portable/Green/Delta/blockmap +
   * 版本号在内容里的 update.json）；目录（win-unpacked/data）和不认识的文件
   * （latest.yml / builder-debug.yml / build.log）绝不碰 —— 宁可少删不能误删。
   */
  section('构建后清理 prune-dist');
  {
    const { artifactVersion, pruneDist } = await import('../scripts/lib/prune-dist.mjs');

    // ---- 版本提取规则（纯函数，逐条钉死）----
    ok(artifactVersion('QuickLaunch-Setup-1.2.1.exe') === '1.2.1', 'Setup 提出版本');
    ok(artifactVersion('QuickLaunch-Portable-1.2.1.exe') === '1.2.1', 'Portable 提出版本');
    ok(artifactVersion('QuickLaunch-Green-1.2.1.zip') === '1.2.1', 'Green 提出版本');
    ok(artifactVersion('QuickLaunch-Setup-1.2.1.exe.blockmap') === '1.2.1',
      'Setup 的 .blockmap 跟着 Setup 的版本走');
    ok(artifactVersion('QuickLaunch-Delta-1.2.0-to-1.2.1.bin') === '1.2.1',
      '★ 差量包属于 to（目标版本），from 是它的基准不算数');
    ok(artifactVersion('latest.yml') === null
      && artifactVersion('builder-debug.yml') === null
      && artifactVersion('build.log') === null
      && artifactVersion('QuickLaunch-Weird-1.0.0.txt') === null
      && artifactVersion('update.json') === null,
      '不认识的文件名一律返回 null（update.json 的版本在内容里，单独判）');

    // ---- 真删真留（真实临时目录 + 真 fs）----
    const PDIR = path.join(TMP, 'prune-dist');
    fs.rmSync(PDIR, { recursive: true, force: true });
    const putP = (name, content) => {
      const p = path.join(PDIR, ...name.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return p;
    };
    const CUR = '1.2.1', OLD = '1.2.0';

    // 期望被删的：4 个旧产物 + 旧版 update.json（无版本号后缀，版本在内容里）
    const doomed = [
      [`QuickLaunch-Setup-${OLD}.exe`, 'x'.repeat(300)],
      [`QuickLaunch-Portable-${OLD}.exe`, 'x'.repeat(300)],
      [`QuickLaunch-Green-${OLD}.zip`, 'x'.repeat(300)],
      [`QuickLaunch-Delta-1.1.1-to-${OLD}.bin`, 'x'.repeat(300)],
      ['update.json', JSON.stringify({ version: OLD })],
    ];
    const expectFreed = doomed.reduce((n, [, c]) => n + Buffer.byteLength(c), 0);
    doomed.forEach(([n, c]) => putP(n, c));

    // 期望保留的：当前版本产物 + 不认识的文件 + 目录（目录里放诱饵防误删）
    putP(`QuickLaunch-Setup-${CUR}.exe`, 'new');
    putP(`QuickLaunch-Setup-${CUR}.exe.blockmap`, 'new');
    putP(`QuickLaunch-Portable-${CUR}.exe`, 'new');
    putP(`QuickLaunch-Green-${CUR}.zip`, 'new');
    putP(`QuickLaunch-Delta-${OLD}-to-${CUR}.bin`, 'new');   // to=当前版 → 留
    putP('latest.yml', 'yml');
    putP('builder-debug.yml', 'yml');
    putP('build.log', 'log');
    putP('update.json.old', '干扰项：名字不认识');
    putP('win-unpacked/QuickLaunch.exe', 'app');             // 目录
    putP('data/config.json', '{"private":1}');               // 目录（可能是本机私人配置）

    const r = pruneDist({ distDir: PDIR, version: CUR, log: () => {} });
    ok(r.removed.length === 5,
      `删了 5 个（4 个旧产物 + 旧版 update.json；实际 ${r.removed.length}：${r.removed.map(x => x.name).join(', ')}）`);
    ok(r.removed.every(x => x.name === 'update.json' || x.name.includes(OLD)),
      '删掉的全是旧版本产物（差量包按 to 判，1.1.1-to-1.2.0 属于 1.2.0）');
    ok(r.freed === expectFreed, `释放字节数 = 被删文件合计（实际 ${r.freed} / 期望 ${expectFreed}）`);
    ok([`QuickLaunch-Setup-${CUR}.exe`, `QuickLaunch-Setup-${CUR}.exe.blockmap`,
      `QuickLaunch-Portable-${CUR}.exe`, `QuickLaunch-Green-${CUR}.zip`,
      `QuickLaunch-Delta-${OLD}-to-${CUR}.bin`].every(n => r.kept.includes(n)),
      '当前版本产物 + 属于当前版的差量包全保留');
    ok(r.kept.includes('latest.yml') && r.kept.includes('builder-debug.yml')
      && r.kept.includes('build.log') && r.kept.includes('update.json.old'),
      '★ 构建元数据等不认识的名字一个都没动');
    ok(r.kept.includes('win-unpacked/') && r.kept.includes('data/'),
      '★ 目录一律绕开（win-unpacked 是产物本体，data 可能是本机私人配置）');
    ok(fs.readFileSync(path.join(PDIR, 'data', 'config.json'), 'utf8') === '{"private":1}',
      '目录里的文件原样保留');

    // update.json 的版本判断：当前版留（可重复执行） / 旧版删 / 坏 JSON 不动
    fs.writeFileSync(path.join(PDIR, 'update.json'), JSON.stringify({ version: CUR }));
    ok(pruneDist({ distDir: PDIR, version: CUR }).removed.length === 0,
      'update.json 版本 = 当前版本 → 保留（再跑一遍什么都不删，可重复执行）');
    fs.writeFileSync(path.join(PDIR, 'update.json'), JSON.stringify({ version: OLD }));
    ok(pruneDist({ distDir: PDIR, version: CUR }).removed.map(x => x.name).join(',') === 'update.json',
      'update.json 版本 ≠ 当前版本 → 删');
    fs.writeFileSync(path.join(PDIR, 'update.json'), '{ 坏掉的 JSON');
    ok(pruneDist({ distDir: PDIR, version: CUR }).removed.length === 0,
      '★ update.json 读不出版本（坏 JSON）→ 当不认识，不动');

    // dist 目录不存在 → 不抛、当空处理
    const rNone = pruneDist({ distDir: path.join(TMP, 'no-such-dist'), version: CUR });
    ok(rNone.removed.length === 0 && rNone.kept.length === 0, 'dist 目录不存在 → 不抛、当空处理');

    // ★ 单个删除失败 → 记录进 failed、继续删其他的（绝不"删一半就中断"）
    const FDIR = path.join(TMP, 'prune-fail');
    fs.rmSync(FDIR, { recursive: true, force: true });
    fs.mkdirSync(FDIR, { recursive: true });
    const boomFs = {
      readdirSync: fs.readdirSync.bind(fs),
      statSync: fs.statSync.bind(fs),
      rmSync: (p) => {
        if (String(p).includes('Green-1.2.0.zip')) {
          const e = new Error('EBUSY: 被占用'); e.code = 'EBUSY'; throw e;
        }
        return fs.rmSync(p, { force: true });
      },
    };
    [`QuickLaunch-Green-${OLD}.zip`, `QuickLaunch-Portable-${OLD}.exe`, `QuickLaunch-Setup-${OLD}.exe`]
      .forEach(n => fs.writeFileSync(path.join(FDIR, n), 'x'.repeat(100)));
    const rFail = pruneDist({ distDir: FDIR, version: CUR, fsMod: boomFs });
    ok(rFail.failed.length === 1 && rFail.failed[0].name === `QuickLaunch-Green-${OLD}.zip`
      && /EBUSY/.test(rFail.failed[0].reason),
      '★ 删除失败如实记进 failed（带原因），而不是中断或静默');
    ok(rFail.removed.length === 2, '失败后其余文件继续删（不中断）');
    ok(fs.existsSync(path.join(FDIR, `QuickLaunch-Green-${OLD}.zip`)),
      '删失败的那个还在（没被假装删掉）');

    // ---- CLI 端到端（跟 pack-green 同一测法：spawn 真进程；--dist 指定临时目录）----
    const CLI = path.join(__dirname, '..', 'scripts', 'prune-dist.mjs');
    fs.rmSync(PDIR, { recursive: true, force: true });
    fs.mkdirSync(PDIR, { recursive: true });
    fs.writeFileSync(path.join(PDIR, `QuickLaunch-Green-${OLD}.zip`), 'x'.repeat(500));
    fs.writeFileSync(path.join(PDIR, `QuickLaunch-Green-${CUR}.zip`), 'new');
    // ★ 必须显式 --version CUR：否则 CLI 读真实 package.json 的版本，升版本后
    //   夹具里的"当前版(=CUR)"会被当成旧版删掉，这两条断言会莫名其妙变红。
    const pr = cp.spawnSync(process.execPath, [CLI, '--dist', PDIR, '--version', CUR], { encoding: 'utf8' });
    ok(pr.status === 0, 'CLI（--dist 指定目录）退出码 0', String(pr.stderr || '').split('\n')[0]);
    ok(!fs.existsSync(path.join(PDIR, `QuickLaunch-Green-${OLD}.zip`))
      && fs.existsSync(path.join(PDIR, `QuickLaunch-Green-${CUR}.zip`)),
      'CLI 真删了旧版、真留了当前版');
    ok(/已删 1 个旧产物/.test(pr.stdout || ''), 'CLI 输出带删除统计（让人看得见删了多少）',
      (pr.stdout || '').trim().split('\n').pop());
    // CLI 不传 --dist 时指向真实 ../dist —— 真实 dist 的清理由 npm run dist 末尾自动执行，
    // 这里不在 smoke 里对真 dist 干跑（那会把真实产物删掉）。
  }

  /* ------------------------------------------------------------------
     verify-apply 的收尾不许把整套自检判死（v1.5.8 发版真踩过）
     ⑦ 的「换完文件拉不起新版」用例会"启动" restartfail 里的假程序，Windows 还占着句柄，
     收尾 rmSync(ROOT) 抛 EBUSY → 53 项全绿、退出码 1 → CI 的 Release 直接没发出来。
     结论：清理必须"带重试 + 兜异常"，删除失败只告警，不能改结论。
     ------------------------------------------------------------------ */
  section('verify-apply 收尾');
  const vaSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'verify-apply.mjs'), 'utf8');
  ok(/function rmTolerant\(/.test(vaSrc), '临时目录删除走 rmTolerant（带重试）');
  ok(/maxRetries:\s*\d+/.test(vaSrc), 'rmTolerant 真的带 maxRetries（不是空壳）');
  ok(!/^fs\.rmSync\(ROOT/m.test(vaSrc),
    '★ 不再直接 rmSync(ROOT)：一次 EBUSY 就能把全绿的 53 项判成失败');

  /* ------------------------------------------------------------------
   * asar 补丁：打包后才会踩到的坑
   * ------------------------------------------------------------------
   * Electron 会把**任何以 `.asar` 结尾的路径**当 asar 存档（大小写不敏感）：
   * `<程序目录>\resources\app.asar` 这个**文件本身**读不出来、statSync 还谎报 size=0。
   * 而更新器必须把它当普通文件（算 sha256、摊进暂存区、从 zip 解出来），每个真机上都有它。
   *
   * ★ 为什么单测以前全绿也漏掉了：纯 Node 下**根本没有这个补丁**。所以这里自己造一个
   *   **忠实的替身**（行为逐条来自 Electron 44.7.2 实测，见 .workbuddy/memory/探针手册.md），
   *   再由注入的 fs 灌进真实现里跑 —— 不然这一节测的只是"我以为补丁会做什么"。
   * ★ 先断言替身**真的会拦**（前提），再看真实现能不能扛住：否则一条假替身能让整节假绿。
   */
  section('asar 补丁：程序目录里的 app.asar 必须当普通文件');
  const asarSafe = require('../src/lib/asar-safe.js');
  // ★ 自己 require 一份：update-probe 在后面那个段落里才 require，"借用"会踩暂存死区
  const asarFx = require('../src/lib/update-probe');

  // ---- A. withoutAsar 的契约 ----
  ok(!process.noAsar, '起点：补丁是开着的');
  ok(asarSafe.withoutAsar(() => process.noAsar) === true, '守卫体里 noAsar 是 true');
  ok(!process.noAsar, '跑完自动还原');
  try { asarSafe.withoutAsar(() => { throw new Error('boom'); }); } catch { /* 预期 */ }
  ok(!process.noAsar, '★ 里面抛错也必须还原（否则整个程序读不到自己的 app.asar）');
  ok(asarSafe.withoutAsar(() => asarSafe.withoutAsar(() => process.noAsar)) === true, '嵌套的内层同样生效');
  ok(!process.noAsar, '嵌套跑完还原');
  process.noAsar = true;
  asarSafe.withoutAsar(() => {});
  ok(process.noAsar === true, '★ 外面本来就是 true 时，内层不许把它改回 false');
  process.noAsar = false;

  // ---- B. 忠实的"asar 补丁"替身 + 前提断言 ----
  // 拦（读不到 / 谎报）：readFileSync openSync statSync lstatSync realpathSync writeFileSync(Buffer)
  //                       existsSync（不抛，谎报 false）
  // 不拦：readdirSync unlinkSync renameSync copyFileSync mkdirSync rmSync
  //       writeFileSync(字符串)（Node 的 C++ 快路径绕过了 JS 层的 openSync，于是侥幸写进去）
  const isAsarPath = (p) => /\.asar$/i.test(String(p == null ? '' : p));
  const patchedFs = (base) => new Proxy(base, {
    get(t, k) {
      const fn = t[k];
      if (typeof k !== 'string' || typeof fn !== 'function') return fn;
      return (...args) => {
        const first = args[0];
        if (process.noAsar === true || typeof first !== 'string' || !isAsarPath(first)) {
          return fn.apply(t, args);
        }
        if (k === 'existsSync') return false;                                  // 谎报
        if (k === 'statSync' || k === 'lstatSync') {                           // 谎报 size=0
          return { size: 0, isFile: () => true, isDirectory: () => false, mtimeMs: 0,
            isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false,
            isFIFO: () => false, isSocket: () => false, dev: 0, ino: 0, mode: 0, nlink: 1,
            uid: 0, gid: 0, rdev: 0, blksize: 0, blocks: 0, atimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
            atime: new Date(0), mtime: new Date(0), ctime: new Date(0), birthtime: new Date(0) };
        }
        if (k === 'writeFileSync' && typeof args[1] === 'string') return fn.apply(t, args); // 侥幸
        if (k === 'readFileSync' || k === 'openSync' || k === 'realpathSync' || k === 'writeFileSync') {
          throw new Error('Invalid package ' + first);                          // 抛
        }
        return fn.apply(t, args);
      };
    },
  });

  const PATCHED = patchedFs(fs);
  const ASAR_PROG = path.join(TMP, 'prog-asar');
  const asarAbs = path.join(ASAR_PROG, 'resources', 'app.asar');
  const asarBytes = Buffer.from('这是 app.asar 的字节，绝不能当存档'.repeat(40));
  fs.mkdirSync(path.join(ASAR_PROG, 'resources'), { recursive: true });
  fs.writeFileSync(asarAbs, asarBytes);
  fs.writeFileSync(path.join(ASAR_PROG, 'other.dll'), Buffer.from('plain'));
  const asarShaTruth = vc.sha256hex(asarBytes);

  // 前提：替身真的会拦（这几条绿了，下面才算测到东西）
  let intercepted = null;
  try { PATCHED.readFileSync(asarAbs); } catch (e) { intercepted = e.message; }
  ok(/Invalid package/.test(intercepted || ''), '★ 替身真的会拦 *.asar（否则这一节全是假绿）', intercepted || '没拦');
  ok(PATCHED.statSync(asarAbs).size === 0, '替身像真补丁一样把 app.asar 的 size 谎报成 0');
  ok(PATCHED.existsSync(asarAbs) === false, '替身像真补丁一样 existsSync 谎报 false');
  ok(PATCHED.readdirSync(path.join(ASAR_PROG, 'resources')).includes('app.asar'),
    '替身不拦 readdirSync（与实测一致：列目录能看到它）');
  ok(PATCHED.readFileSync(path.join(ASAR_PROG, 'other.dll')).toString() === 'plain',
    '替身只拦 .asar，普通文件照常读');
  ok(isAsarPath('X:\\p\\resources\\App.ASAR') && !isAsarPath('X:\\p\\resources\\app.asar.txt'),
    '判据是"后缀正好是 .asar"（大小写不敏感，多一个后缀就不算）');

  // ---- C. 读：扫描本机程序目录要拿到真 size / 真 sha256 ----
  let scanPatched = null, scanErr = null;
  try { scanPatched = updater.scanProgramDir(ASAR_PROG, { fs: PATCHED }); } catch (e) { scanErr = e.message; }
  ok(scanErr === null, '★ 带补丁的 fs 也能扫完程序目录（不炸）', scanErr || '');
  const rowAsar = (scanPatched || []).find(f => f.path === 'resources/app.asar');
  ok(!!rowAsar, '扫描结果里有 resources/app.asar（不能因为补丁就"看不见"它）');
  ok(!!rowAsar && rowAsar.size === asarBytes.length,
    `★ app.asar 的 size 是真的（${asarBytes.length}，不是补丁谎报的 0）`,
    rowAsar ? String(rowAsar.size) : '');
  ok(!!rowAsar && rowAsar.sha256 === asarShaTruth, '★ app.asar 的 sha256 与真实字节一致',
    rowAsar ? rowAsar.sha256.slice(0, 16) : '');
  ok(updater.sha256File(asarAbs, PATCHED) === asarShaTruth, 'sha256File 自己就带守卫（回退用）');

  // ---- D. 写：从 zip 里解出 app.asar ----
  const ASAR_OUT = path.join(TMP, 'unzip-asar');
  fs.rmSync(ASAR_OUT, { recursive: true, force: true });
  let wroteAsar = null, wErr = null;
  try { wroteAsar = uz.extractToDir(zipBuf, ASAR_OUT, { fs: PATCHED }); } catch (e) { wErr = e.message; }
  ok(wErr === null && !!wroteAsar, '★ 带补丁的 fs 也能把 zip 解到目录（不炸）', wErr || '');
  const outAsar = readIf(path.join(ASAR_OUT, 'resources', 'app.asar'));
  ok(!!outAsar && outAsar.equals(asarTxt), '★ 解出来的 resources/app.asar 与源文件逐字节一致');

  // ---- E. 全量：stageFull 端到端（注入补丁 fs） ----
  const EPROG = path.join(TMP, 'prog-asar-full');
  fs.mkdirSync(path.join(EPROG, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(EPROG, 'resources', 'app.asar'), Buffer.from('OLD-ASAR'));
  fs.writeFileSync(path.join(EPROG, 'QuickLaunch.exe'), Buffer.from('OLD-EXE'));
  // 诱饵：更新器绝不能碰的文件（断言"内容没变"，比断言"不存在"强 —— 后者恒真）
  const eDecoy = path.join(EPROG, 'data', 'config.json');
  fs.mkdirSync(path.dirname(eDecoy), { recursive: true });
  fs.writeFileSync(eDecoy, '{"private":"用户数据"}');
  const eManifest = mkUpd({
    files: [{ path: 'resources/app.asar', size: asarTxt.length, sha256: vc.sha256hex(asarTxt) }],
    full: { asset: path.basename(ZIP), size: zipBuf.length, sha256: vc.sha256hex(zipBuf) },
    patches: [],
  });
  const eFull = await updater.stageFull({
    manifest: eManifest, base: 'https://fx.example', programDir: EPROG, version: '2.0.0', fs: PATCHED,
    getBuffer: asarFx.transport({ served: [{ name: path.basename(ZIP), body: zipBuf }] }),
  });
  ok(eFull.ok === true, '★ 全量路径在补丁 fs 下也能摊进暂存区', eFull.reason || '');
  const eStaged = readIf(path.join(eFull.stage || path.join(TMP, 'nope'), 'files', 'resources', 'app.asar'));
  ok(!!eStaged && eStaged.equals(asarTxt), '★ 暂存区里的 app.asar 是 zip 里那一份');
  ok(fs.readFileSync(eDecoy, 'utf8') === '{"private":"用户数据"}', '全量路径没碰受保护目录（config.json 一个字节都没动）');

  // ---- F. 差量：stage 端到端（覆盖 lazyLocalStore 读本机 app.asar） ----
  const DPROG = path.join(TMP, 'prog-asar-delta');
  const dPut = (rel, content) => {
    const p = path.join(DPROG, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const oldAsar = Buffer.from('OLD-ASAR-BYTES-'.repeat(300));
  const newAsar = Buffer.from(oldAsar); newAsar.write('NEW', 40, 'utf8');
  const oldExeD = Buffer.from('OLD-EXE-'.repeat(50));
  const newExeD = Buffer.from(oldExeD); newExeD.write('NEW', 10, 'utf8');
  dPut('resources/app.asar', oldAsar);
  dPut('QuickLaunch.exe', oldExeD);
  const madeD = vc.makeDirPatch(
    [{ path: 'resources/app.asar', data: oldAsar }, { path: 'QuickLaunch.exe', data: oldExeD }],
    [{ path: 'resources/app.asar', data: newAsar }, { path: 'QuickLaunch.exe', data: newExeD }]);
  const dPatch = { from: '1.1.1', asset: 'QuickLaunch-Delta-1.1.1-to-2.0.0.bin',
    size: madeD.pack.length, sha256: vc.sha256hex(madeD.pack), plan: madeD.manifest };
  const dManifest = mkUpd({
    files: [
      { path: 'resources/app.asar', size: newAsar.length, sha256: vc.sha256hex(newAsar) },
      { path: 'QuickLaunch.exe', size: newExeD.length, sha256: vc.sha256hex(newExeD) },
    ],
    patches: [dPatch],
  });
  const dStage = updater.stage({
    manifest: dManifest, mode: 'delta', patch: dPatch, pack: madeD.pack, fs: PATCHED,
    programDir: DPROG, myVersion: '1.1.1',
  });
  ok(dStage.ok === true, '★ 差量路径在补丁 fs 下也能摊进暂存区', dStage.reason || '');
  const dStagedAsar = readIf(path.join(dStage.stage || path.join(TMP, 'nope'), 'files', 'resources', 'app.asar'));
  ok(!!dStagedAsar && dStagedAsar.equals(newAsar), '★ 差量还原出的 app.asar 逐字节等于新版');

  /* ------------------------------------------------------------------
   * 自更新 界面接线（一处在主进程、一处在 preload、一处在渲染层）
   * ------------------------------------------------------------------
   * 这几条盯的都是"接错线"型的 bug —— 通道名打错一个字母、白名单忘登记、
   * 界面自己另拼一份状态。这类错误不会崩，只会静默不工作。
   */
  section('自更新 界面接线');
  ok(/id="abUpd"/.test(htmlSrc) && /id="abUpdState"/.test(htmlSrc), '「关于」里有更新块 #abUpd');
  for (const id of ['abUpdCheck', 'abUpdDown', 'abUpdApply', 'abUpdLog', 'abUpdMsg', 'abUpdBarIn']) {
    ok(new RegExp(`id="${id}"`).test(htmlSrc), `「关于」更新块含 #${id}`);
  }
  ok(/id="abUpdDown"[^>]*\shidden/.test(htmlSrc) && /id="abUpdApply"[^>]*\shidden/.test(htmlSrc),
    '「下载」与「重启并更新」默认隐藏（没有可下载的东西时不该出现）');
  ok(/id="sAutoUpdate"/.test(htmlSrc) && /id="sUpdateBase"/.test(htmlSrc),
    '设置面板里有「启动时自动检查更新」与「更新源」两项（能改的东西只在设置里）');
  const iAboutSec = htmlSrc.indexOf('id="aboutOverlay"');
  ok(htmlSrc.slice(iAboutSec).includes('id="abUpdCheck"'),
    '更新块在「关于」弹窗里（版本号 + "按一下检查"是同一类事情）');
  ok(/autoUpdate: \$\('#sAutoUpdate'\)\.checked/.test(appSrc),
    '保存设置时把开关读进 autoUpdate（不是硬编码 true）');
  ok(/const updateBase = \$\('#sUpdateBase'\)\.value\.trim\(\)/.test(appSrc)
    && /\^https\?:\\\/\\\//.test(appSrc),
    '保存设置时校验更新源格式（不合格就拦下来，不把垃圾写进配置）');
  ok(/openSettings[\s\S]{0,1400}\$\('#sAutoUpdate'\)\.checked = s\.autoUpdate !== false/.test(appSrc),
    '打开设置面板时把配置回填到开关（默认开：只有显式 false 才算关）');

  /* ---- v1.5.7：界面动画开关 ---- */
  const appSrcAnim = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const htmlSrcAnim = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const cssAnim = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'style.css'), 'utf8');
  ok(store.defaultConfig().settings.animations === true, '★ 默认开启动画（animations 默认 true）');
  ok(/id="sAnimations"/.test(htmlSrcAnim), '设置面板里有「界面动画」开关');
  ok(/animations: \$\('#sAnimations'\)\.checked/.test(appSrcAnim),
    '保存设置时把开关读进 animations（不是硬编码）');
  ok(/\$\('#sAnimations'\)\.checked = s\.animations !== false/.test(appSrcAnim),
    '打开设置面板时回填动画开关（默认开：只有显式 false 才算关）');
  ok(/setAttribute\('data-anim', 'off'\)/.test(appSrcAnim),
    '★ 关动画 = 给 <html> 挂 data-anim="off"（不是逐处 if）');
  ok(/html\[data-anim="off"\] \*/.test(cssAnim),
    '★ CSS 用一条规则停掉所有装饰性动画（animation-duration:0）');
  ok(/html\[data-anim="off"\] \.card\.holding::before/.test(cssAnim) && /animation: none !important/.test(cssAnim),
    '★ 长按进度条等「功能提示」动画被单独豁免，不被误关');

  ok(/\.conn\.upd\s+i\s*\{[^}]*var\(--accent\)/.test(css), '.conn.upd 的蓝点用 accent 色（有新版本一眼可见）');
  ok(/\.upd-state\.hot\s*\{/.test(css) && /\.upd-box\s*\{/.test(css), '更新块的样式齐备（.upd-box / .upd-state.hot）');
  ok(/\.conn\s+span\s*\{[^}]*text-overflow:\s*ellipsis/.test(css),
    '.conn span 会被裁（窄窗口下这行文案不折行顶掉底部栏）');

  // 状态行只有一份实现：以前内联在 refresh() 里，现在加了更新角标，很容易又抄一份
  ok((appSrc.match(/conn\.querySelector\('span'\)/g) || []).length === 1,
    '★ 状态行只有一处实现（paintStatusLine），不是刷新和更新各画一遍',
    `出现 ${(appSrc.match(/conn\.querySelector\('span'\)/g) || []).length} 次`);
  ok(/function paintStatusLine\(\)/.test(appSrc), '有 paintStatusLine()');
  ok(/const alert = updAlert\(u\)[\s\S]{0,300}可更新/.test(appSrc),
    '状态行在有新版本时会补上「可更新」（更新不自动下载，没有常驻提示就等于没这功能）');
  ok(/renderUpdate\(\)/.test(appSrc) && /applyUpdateState\(/.test(appSrc),
    '快照到了就重绘更新块（不是重开一次窗口）');
  ok((appSrc.match(/API\.on\('ql:update-state'/g) || []).length === 1, '只订阅一次更新快照事件');
  ok(/API\.on\('ql:update-available'/.test(appSrc) === false,
    '不再单开一条"有新版本"事件（同一个状态走同一条通道，免得两处口径不一致）');

  ok(/'ql:update-state'/.test(preloadSrc) && /'ql:update-probe'/.test(preloadSrc),
    'preload 白名单放行 ql:update-state / ql:update-probe');
  ok(/'ql:update-state', 'ql:update-available'/.test(preloadSrc),
    'ql:update-available 仍在白名单里（早期版本可能用到，去掉会让它静默收不到）');
  for (const m of ['updateState', 'updateCheck', 'updateDownload', 'updateApply']) {
    ok(new RegExp(`${m}:\\s*\\(\\)`).test(preloadSrc), `preload 暴露 ${m}()`);
  }

  for (const ch of ['ql:update:state', 'ql:update:check', 'ql:update:download', 'ql:update:apply']) {
    ok(new RegExp(`ipcMain\\.handle\\('${ch.replace(/:/g, ':')}'`).test(mainSrc), `主进程注册 ${ch}`);
  }
  ok(/ql:info'[\s\S]{0,900}update: svc \? svc\.snapshot\(\)/.test(mainSrc),
    '★ ql:info 里带上更新快照（界面打开「关于」时不必再单独问一次）');
  ok(/startGroup|START_CHECK_DELAY_MS/.test(mainSrc) && /setTimeout\(async \(\) => \{[\s\S]{0,400}svc\.check\(\{ silent: true \}\)/.test(mainSrc),
    '★ 启动时的静默检查是延后跑的（不抢启动那一下）');
  ok(/cfg\.settings\.autoUpdate !== false && !ANY_PROBE && svc\.canSelfUpdate\(\)\.ok/.test(mainSrc),
    '★ 静默检查有三重门：设置里开着 + 不是探针 + 形态支持（探针必须离线可重复）');
  ok((mainSrc.match(/svc\.download\(\)/g) || []).length === 1,
    '★ 全项目只有 IPC 一处会调用下载 —— 下载永远等用户点，不会自己动',
    `出现 ${(mainSrc.match(/svc\.download\(\)/g) || []).length} 次`);
  ok((mainSrc.match(/svc\.applyAndRestart\(\)/g) || []).length === 1,
    '★ 也只有一处会交接助手（那一步会退出程序，绝不能被别处顺手调到）');
  // ★ 一条事件只许一个气泡。这一条是 --update-probe 的**截图**逼出来的：
  //   applyUpdateState 与「检查更新」按钮的处理器都在报"发现新版本"，于是同屏两个气泡。
  ok((appSrc.match(/toast\([^)]*发现新版本/g) || []).length === 1,
    '★ 「发现新版本」的气泡只有一处实现（两处会同时弹两个）',
    `实际 ${(appSrc.match(/toast\([^)]*发现新版本/g) || []).length} 处`);
  ok(/const ANY_PROBE = /.test(mainSrc) && /UPDATE_PROBE/.test(mainSrc),
    'ANY_PROBE 常量存在且把新探针算了进去');
  // ★ 各探针共用的 ql:probe-shot 是**条件注册**的：漏把新探针加进那个条件，
  //   渲染层就会报 "No handler registered"，探针看起来"跑完了"其实一张图都没出。
  const shotRegAt = mainSrc.indexOf("ipcMain.handle('ql:probe-shot'");
  const shotGate = shotRegAt > 0 ? mainSrc.slice(Math.max(0, shotRegAt - 900), shotRegAt) : '';
  ok(/UPDATE_PROBE/.test(shotGate), '★ ql:probe-shot 的注册条件里加上了 --update-probe（漏了探针就白跑）');
  ok(/UPDATE_PROBE = !app\.isPackaged/.test(mainSrc), '--update-probe 只在未打包时生效（打包态不会误开假更新源）');

  /* ------------------------------------------------------------------
   * 自更新 编排层（update-service.js）—— 依赖全注入，完整状态机离线跑
   * ------------------------------------------------------------------
   * 这一层是"检查 → 下载 → 暂存 → 交接助手"的串线人，也是最容易出接线错误的地方
   * （比如把 st.patch 传成 st.plan、或者把"不支持的形态"也放进网络请求路径）。
   * 所以这里不 mock 内部：给真的 updater.js、真的 zip、真的补丁包，只把传输层与
   * 程序目录换成临时目录。
   */
  section('自更新 编排层 update-service');
  const { createUpdateService } = require('../src/lib/update-service');
  const probeFx = require('../src/lib/update-probe');

  function mkSvc(o = {}) {
    const sent = [];
    const settings = Object.assign({ autoUpdate: true, updateBase: '' }, o.settings || {});
    const svc = createUpdateService({
      version: () => o.version || '1.1.1',
      form: () => o.form || 'green',
      programDir: () => o.programDir || PROG,
      exePath: () => o.exePath || 'C:\\P\\QuickLaunch.exe',
      getSettings: () => settings,
      setSettings: p => Object.assign(settings, p),
      send: (ch, u) => sent.push({ ch, u }),
      quit: () => { sent.push({ ch: 'QUIT', u: null }); if (o.order) o.order.push('quit'); },
      fs,
      getBuffer: o.getBuffer,
      spawn: o.spawn,
      now: o.now,
    });
    return { svc, sent, settings };
  }

  /* ---- A. 形态：便携版/开发模式根本不该去碰网络 ---- */
  let netHits = 0;
  const sPortable = mkSvc({ form: 'portable', getBuffer: async () => { netHits++; return Buffer.from('{}'); } });
  const bp = sPortable.svc.boot();
  ok(bp.ok === false, '便携版 boot 明确返回"不支持"');
  ok(sPortable.svc.snapshot().status === 'unsupported', '便携版状态 = unsupported');
  ok(/单文件/.test(sPortable.svc.snapshot().unsupportedReason), '不支持的原因是人话',
    sPortable.svc.snapshot().unsupportedReason);
  const spSnap = sPortable.svc.snapshot();
  ok(spSnap.canCheck === false && spSnap.canDownload === false && spSnap.canApply === false,
    '不支持时三个按钮全不可用（不给用户一个点了没用的按钮）');
  const cpPortable = await sPortable.svc.check();
  ok(cpPortable.unsupported === true, '便携版调 check 直接返回不支持');
  ok(netHits === 0, '★ 不支持的形态一次网络请求都没发（连尝试都没有）');

  /* ---- B. 启动收尾：上次更新的结果 ---- */
  const P3 = path.join(TMP, 'prog3');
  const UPD3 = path.join(P3, '.update');
  const putP3 = (rel, content) => {
    const p = path.join(P3, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const writeState = (o) => {
    fs.mkdirSync(UPD3, { recursive: true });
    fs.writeFileSync(path.join(UPD3, 'state.json'), JSON.stringify(o, null, 2), 'utf8');
  };
  const rmState = () => { try { fs.unlinkSync(path.join(UPD3, 'state.json')); } catch { /* noop */ } };
  putP3('QuickLaunch.exe', 'EXE');

  writeState({ state: 'applied', to: '1.1.1', from: '1.1.0', at: '2026-10-16T00:00:00', note: '' });
  const sAppl = mkSvc({ programDir: P3 });
  const bAppl = sAppl.svc.boot();
  ok(bAppl.applied === '1.1.1', '上次更新成功 → 认出来');
  const nAppl = sAppl.svc.snapshot().notice;
  ok(!!nAppl && nAppl.kind === 'applied', '启动后挂上一条"已更新"提示');
  ok(/已更新到 v1\.1\.1/.test(nAppl.title), '提示文案带上目标版本', nAppl.title);
  ok(sAppl.settings.lastUpdateNotice === 'applied|1.1.1|2026-10-16T00:00:00',
    '已报过的记号被写进设置（跨重启去重靠它）');

  const sAppl2 = mkSvc({ programDir: P3, settings: sAppl.settings });
  sAppl2.svc.boot();
  ok(sAppl2.svc.snapshot().notice === null, '★ 同一件事重启后不再重复提示（不唠叨）');

  writeState({ state: 'applied', to: '1.0.0', from: '0.9', at: 'T2' });
  const sOld = mkSvc({ programDir: P3 });
  sOld.svc.boot();
  ok(sOld.svc.snapshot().notice === null,
    '★ 结果记的是**别的版本** → 不吹牛（那说明替换其实没生效，当前跑的还是旧版）');

  writeState({ state: 'failed', to: '1.2.0', from: '1.1.1', at: 'T3', note: '暂存文件校验失败：resources/app.asar' });
  const sFail = mkSvc({ programDir: P3 });
  sFail.svc.boot();
  const nFail = sFail.svc.snapshot().notice;
  ok(!!nFail && nFail.kind === 'failed',
    '★ 上次更新失败**必须**报出来（不报的话用户以为更新成功了，其实还在用旧版）');
  ok(/校验失败/.test(nFail.text), '失败提示带上原始原因', nFail.text);
  ok(/apply-1\.2\.0\.log/.test(nFail.text), '失败提示指出去哪看日志', nFail.text);

  /* ---- C. staged 恢复 / 清理 ---- */
  const stageDir3 = path.join(UPD3, '1.2.0');
  fs.mkdirSync(path.join(stageDir3, 'files'), { recursive: true });
  fs.writeFileSync(path.join(stageDir3, 'apply.json'), JSON.stringify({ schema: 1, to: '1.2.0' }), 'utf8');
  writeState({ state: 'staged', to: '1.2.0', from: '1.1.1', at: 'T4' });
  const sResume = mkSvc({ programDir: P3 });
  sResume.svc.boot();
  const rs = sResume.svc.snapshot();
  ok(rs.status === 'staged' && rs.canApply === true,
    '★ 上次下好了但没重启 → 恢复成"重启即可更新"（不让用户白下 160 MB）');
  ok(rs.latest === '1.2.0', '恢复出的目标版本正确', rs.latest);
  ok(rs.dir === UPD3, '快照里的更新目录就是程序目录下的 .update', rs.dir);
  ok(/上次已下好/.test(rs.reason), '恢复时的说明是人话', rs.reason);

  // 残留：暂存目标是**更老**的版本（比如用户手动换了回旧版）→ 该清掉
  const staleDir = path.join(UPD3, '1.0.0');
  fs.mkdirSync(path.join(staleDir, 'files'), { recursive: true });
  fs.writeFileSync(path.join(staleDir, 'apply.json'), '{"to":"1.0.0"}', 'utf8');
  writeState({ state: 'staged', to: '1.0.0', from: '0.9', at: 'T5' });
  const sStale = mkSvc({ programDir: P3 });
  const br = sStale.svc.boot();
  ok(br.discarded === '1.0.0', '暂存目标是**更老**的版本 → 判为残留');
  ok(!fs.existsSync(staleDir), '★ 残留暂存区被清掉（不把上百 MB 白留在用户盘上）');
  ok(fs.existsSync(stageDir3), '而"比本机新"的那份暂存区留着没动（那是可用的）');
  ok(!fs.existsSync(path.join(UPD3, 'state.json')), '残留的 state.json 一起清掉（否则每次启动都判一遍）');

  /* ---- D. 检查的各条失败路径 ---- */
  const feedThrow = (msg, status) => async () => {
    const e = new Error(msg);
    if (status) e.status = status;
    throw e;
  };
  const s404 = mkSvc({ programDir: P3, getBuffer: feedThrow('HTTP 404', 404) });
  const r404 = await s404.svc.check({ silent: true });
  const s404s = s404.svc.snapshot();
  ok(r404.ok === true && r404.available === false, '★ 更新源还没有清单（404）不算错误');
  ok(s404s.status === 'uptodate' && /还没有发布更新清单/.test(s404s.reason),
    '404 落到"已是最新"并给出人话原因（不然更新器刚上线，用户一启动就看到红报错）');

  const sNet = mkSvc({ programDir: P3, getBuffer: feedThrow('getaddrinfo ENOTFOUND github.com') });
  const rNet = await sNet.svc.check();
  ok(rNet.ok === false && /ENOTFOUND/.test(rNet.reason), '网络异常 → 失败并带上原始原因', rNet.reason);
  ok(sNet.svc.snapshot().status === 'failed', '网络异常后状态 = failed（界面能看到"失败"而不是一直转）');

  const sBadJson = mkSvc({ programDir: P3, getBuffer: async () => Buffer.from('<html>不是 JSON</html>') });
  const rBadJson = await sBadJson.svc.check();
  ok(rBadJson.ok === false && /合法 JSON/.test(rBadJson.reason), '清单不是 JSON → 明确报错', rBadJson.reason);

  const hang = () => new Promise(() => { /* 永远不返回 */ });
  const sHang = mkSvc({ programDir: P3, getBuffer: hang });
  const rHang = await sHang.svc.check({ timeoutMs: 40 });
  ok(rHang.ok === false && /检查超时/.test(rHang.reason), '★ 更新源不响应 → 超时兜住（不会永远停在"正在检查"）',
    rHang.reason);
  ok(sHang.svc.snapshot().status === 'failed' && sHang.svc.snapshot().busy === false,
    '超时后不再显示"进行中"');

  const sBadBase = mkSvc({ programDir: P3, getBuffer: hang, settings: { updateBase: 'ftp://mirror' } });
  const rBadBase = await sBadBase.svc.check();
  ok(rBadBase.ok === false && /http\(s\)/.test(rBadBase.reason), '★ 更新源填错直接明说，不静默回落成默认源',
    rBadBase.reason);
  const bb = sBadBase.svc.snapshot();
  ok(bb.status === 'failed' && bb.base === '' && !!bb.baseError, '快照里两处都如实反映（base 空 + baseError 有值）');

  /* ---- E. 全量路径端到端（真 zip，离线假更新源）---- */
  const fx = probeFx.makeFixture(path.join(TMP, 'updfx'), '1.2.0');
  const rawTransport = probeFx.transport(fx, { slow: false });
  const hits = [];
  const sFull = mkSvc({
    programDir: fx.progDir,
    getBuffer: (u, o) => { hits.push(u); return rawTransport(u, o); },
  });
  sFull.svc.boot();
  const f1 = await sFull.svc.check({ silent: true });
  ok(f1.ok === true && f1.available === true && f1.version === '1.2.0', '检查到新版本 1.2.0（夹具）', f1.reason);
  const fs1 = sFull.svc.snapshot();
  ok(fs1.status === 'available' && fs1.canDownload === true && fs1.canApply === false,
    '状态 = 可下载；此时"重启并更新"还不该出现（还没下）');
  ok(!!fs1.plan && fs1.plan.mode === 'full' && fs1.plan.size === fx.zipBuf.length,
    '方案 = 完整包，大小取自清单');
  ok(fs1.base === updater.DEFAULT_BASE, '快照里的更新源是默认 GitHub（设置里留空）');
  ok(fs1.supported === true && fs1.autoUpdate === true, '快照如实反映"支持自更新 + 自动检查开着"');

  const f2 = await sFull.svc.download();
  ok(f2.ok === true && f2.staged === true && f2.mode === 'full', '★ 下载 + 暂存走通（全量）', f2.reason || '');
  const fs2 = sFull.svc.snapshot();
  ok(fs2.status === 'staged' && fs2.canApply === true && fs2.canDownload === false,
    '状态 = 已就绪，「重启并更新」这时才出现');
  ok(/重启/.test(fs2.reason), '就绪的说明写清了下一步是重启', fs2.reason);
  ok(fs2.progress === null, '下载完成后进度被清空（不留在界面上）');

  const ajFull = readJsonIf(path.join(fx.progDir, '.update', '1.2.0', 'apply.json'));
  ok(!!ajFull && ajFull.mode === 'full' && ajFull.restart === true,
    'apply.json 记了 full，且要求助手换完把自己拉起来');
  ok(!!ajFull && ajFull.writes.length === 2,
    `只摊了真正变了的 2 个文件（实际 ${ajFull ? ajFull.writes.length : '?'}）`);
  ok(!!ajFull && ajFull.deletes.length === 0, '全量路径 deletes 恒为空（不认识的本机文件绝不删）');
  ok(!!ajFull && JSON.stringify(ajFull.protectedTop) === JSON.stringify(datadir.PROTECTED_TOP),
    '受保护名单来自 datadir（编排层没有另写一份）');
  ok(fs.readFileSync(path.join(fx.progDir, 'data', 'config.json'), 'utf8').includes('用户数据'),
    '★ 整条更新流程没碰用户的 data/');

  ok(hits.some(u => /update\.json$/.test(u)), '去更新源取过 update.json');
  ok(hits.some(u => /\.zip$/.test(u)), '也取过绿色版 zip');
  ok(hits.length === 2, `整个"检查 + 下载"只发 2 次请求（实际 ${hits.length}）—— 不多余轮询`);

  const dlPushes = sFull.sent.filter(e => e.u && e.u.status === 'downloading');
  ok(dlPushes.length >= 1, '下载过程中推过状态（界面才有进度可显示）');
  ok(dlPushes.some(e => e.u.progress && e.u.progress.got > 0), '推的快照里带真实进度字节数');
  ok(dlPushes.some(e => e.u.progress && e.u.progress.pct !== null),
    '进度带百分比（不然进度条无从画）');
  ok(dlPushes.length <= 4, `★ 进度事件被节流（${dlPushes.length} 次推送；zip ${fx.zipBuf.length} 字节、切片 64 KiB）`);
  ok(sFull.sent.some(e => e.u && e.u.status === 'available'), '状态迁移经过 available（不是一步跳到 staged）');
  ok(!sFull.sent.some(e => e.ch === 'QUIT'), '★ 下载完**不会**自动退出重启 —— 动手必须等用户点');

  /* ---- F. 交接助手 ---- */
  // ★ 用一个共享的 order 记"谁先谁后"：必须先起助手、再退出自己 —— 顺序反了的话
  //   主进程一走，还没 spawn 的助手就再也没人起了，更新会永远停在"正在退出"。
  const order = [];
  const spawnCalls = [];
  // ★ 真助手起来第一件事就是往暂存区写 apply.log，主进程靠它判断"助手活了没有"。
  //   夹具必须照做，否则活体检查必然判失败（那反而是对的：没日志就是没活）。
  const fakeSpawn = (exe, args, opts) => {
    order.push('spawn');
    spawnCalls.push({ exe, args, opts, unrefed: false });
    const rec = spawnCalls[spawnCalls.length - 1];
    if (fakeSpawn.sayAlive !== false) {
      const plan = readJsonIf(path.join(fx.progDir, '.update', '1.2.0', 'apply.json'));
      try { fs.writeFileSync(path.join(plan.stageDir, 'apply.log'), '助手启动（夹具）\r\n'); } catch { /* noop */ }
    }
    return { pid: 4242, unref() { rec.unrefed = true; }, kill() { rec.killed = true; } };
  };

  // ① 什么都没暂存 → 必须拒绝，且**不能**空转一次退出
  const sEmpty = mkSvc({ programDir: P3, spawn: fakeSpawn, order });
  sEmpty.svc.boot();
  const applyIdle = await sEmpty.svc.applyAndRestart();
  ok(applyIdle.ok === false && /还没有下载好/.test(applyIdle.reason),
    '★ 没暂存就点"重启并更新" → 拒绝（绝不空转一次"退出→什么都没发生"）', applyIdle.reason);
  ok(spawnCalls.length === 0, '被拒绝时不会去起助手进程');
  ok(!sEmpty.sent.some(e => e.ch === 'QUIT'), '被拒绝时不会退出程序');

  // ② 有暂存（上一步全量下载留下的 state.json 还在）→ 真的交接
  const sApply = mkSvc({ programDir: fx.progDir, spawn: fakeSpawn, order });
  ok(sApply.svc.boot().resumed === '1.2.0', '（前置）这份暂存区能被恢复成"已就绪"');
  const applyOk = await sApply.svc.applyAndRestart();
  ok(applyOk.ok === true && applyOk.helperPid === 4242, '★ 有暂存时交接成功并拿到助手 pid', applyOk.reason || '');
  ok(spawnCalls.length === 1, '正好起了一个助手进程（不多不少）');
  const sc = spawnCalls[0];
  ok(/cmd\.exe$/i.test(sc.exe),
    '★ 用**绝对路径**起 cmd 当下"中间父母"（PowerShell 一旦成孤儿就会被结束）', sc.exe);
  // ★★ 1.4.0 真事故的反向守卫：detached 会让 libuv 带上 DETACHED_PROCESS，
  //    powershell.exe 在没有控制台的形态下**一行脚本都不执行就 exit 0** →
  //    「点了重启并更新 → 程序关掉 → 什么都没发生」。
  ok(sc.opts && sc.opts.detached !== true && sc.opts.stdio === 'ignore' && sc.opts.windowsHide === true,
    '★ 起助手**不许**用 detached（会让 PowerShell 静默不执行）+ 忽略 stdio + 隐藏窗口',
    JSON.stringify(sc.opts));
  // ★★ cmd 的 /c 引号规矩与 CRT 的 \" 转义不是一回事：必须整条命令行自己拼 + verbatim
  ok(sc.opts.windowsVerbatimArguments === true,
    '★ windowsVerbatimArguments：命令行整条自己拼（交给 Node 用 \\" 转义会得到一个跑不起来的命令行）');
  ok(sc.unrefed === true, '★ 调了 unref()（否则主进程会等它，退出就卡住）');

  const cmdLine = String(sc.args[sc.args.length - 1]);
  ok(/^\/c ""/.test(cmdLine) && /""$/.test(cmdLine),
    '★ 命令行按 cmd 的规矩用 /c ""…"" 包起来', cmdLine.slice(0, 46) + '…');
  ok(/powershell\.exe"/i.test(cmdLine), '命令行里的 PowerShell 是绝对路径且加了引号');
  ok(cmdLine.includes('-NoProfile') && cmdLine.includes('-NonInteractive'),
    '离线、非交互地跑（不加载用户 profile，不会卡在提示上）');
  ok(/-File "[^"]*apply\.ps1"/.test(cmdLine),
    '★ 脚本走 -File（cmd 命令行 8191 字符上限塞不进 -EncodedCommand 那 13 KB base64）');
  ok(!cmdLine.includes('-EncodedCommand'), '不再用 -EncodedCommand（塞不进 cmd /c）');

  // 落盘的助手脚本：带 BOM（PowerShell 5.1 认 BOM 才按 UTF-8 解析 → 中文路径不会废）
  const aj2 = readJsonIf(path.join(fx.progDir, '.update', '1.2.0', 'apply.json'));
  const ps1Path = path.join(aj2.stageDir, 'apply.ps1');
  ok(fs.existsSync(ps1Path), '助手脚本落成暂存目录里的 apply.ps1（更新成功后随暂存区一起删）');
  const ps1Raw = fs.existsSync(ps1Path) ? fs.readFileSync(ps1Path) : Buffer.alloc(0);
  ok(ps1Raw.length > 3 && ps1Raw[0] === 0xEF && ps1Raw[1] === 0xBB && ps1Raw[2] === 0xBF,
    '★ apply.ps1 以 UTF-8 BOM 开头（不带 BOM 的话 PowerShell 5.1 会按本地代码页解释中文路径）');
  const helperScript = ps1Raw.subarray(3).toString('utf8');
  ok(helperScript.length > 500 && /Assert-Safe/.test(helperScript),
    '★ 助手脚本是完整的那段（守卫、换文件、自检都在）');
  ok(helperScript.includes("'" + fx.progDir + "'"), '助手脚本里带上了真实程序目录');
  ok(helperScript.includes('$restart = $true'), '★ 交接时强制要求"换完把我拉起来"（不是照抄 apply.json）');
  ok(datadir.PROTECTED_TOP.every(p => helperScript.includes(`'${p}'`)),
    '★ 受保护名单由主进程从 datadir 注入到助手脚本里（不是助手自己硬编码）');
  ok(/Move-Item -LiteralPath \$p\.Tmp/.test(helperScript), '用原子 Move 换文件（不留半截 exe）');
  ok(/try \{ Start-Process -FilePath \$appExe \}/.test(helperScript),
    '★ 「拉不起来新版」被单独兜住：文件已经换好了，不能因此谎报更新失败');
  // 退出是延后 300 ms 的（留给渲染层把"正在整理更新…"画出来），所以要等一等
  await new Promise(r => setTimeout(r, 600));
  ok(sApply.sent.some(e => e.ch === 'QUIT'), '交接之后确实退出了自己');
  ok(order.join(',') === 'spawn,quit',
    `★ 顺序是「先起助手，再退出自己」（实际 ${order.join(' → ') || '什么都没发生'}）`);

  // ③ 助手起不来（apply.log 一直没出现）→ 必须**放弃退出**并把原因说出来。
  //    这是 1.4.0 那个 Bug 的兜底：再也不能出现"程序关掉、什么都没发生、重开还是旧版"。
  //    now 注入成"每问一次就跳 5 秒"，这样 4 秒的等待窗口不用真等 4 秒。
  fakeSpawn.sayAlive = false;
  let fakeT = 0;
  const sNoHelper = mkSvc({
    programDir: fx.progDir, spawn: fakeSpawn, order,
    now: () => (fakeT += 5000),
  });
  sNoHelper.svc.boot();
  const applyDead = await sNoHelper.svc.applyAndRestart();
  ok(applyDead.ok === false && /助手没能启动/.test(applyDead.reason),
    '★★ 助手没报活 → 拒绝退出（否则就是"点了更新、程序关掉、什么都没发生"）', applyDead.reason);
  ok(!sNoHelper.sent.some(e => e.ch === 'QUIT'), '★★ 助手没起来时绝不退出程序');
  ok(spawnCalls[spawnCalls.length - 1].killed === true, '助手没起来就把它收掉（不留野进程）');
  ok(sNoHelper.svc.snapshot().status === 'staged', '状态仍是"已就绪"（能再点一次，不用重新下载）');
  fakeSpawn.sayAlive = true;

  /* ---- G. 差量路径（真补丁包）---- */
  const dOldExe = Buffer.from('OLD-EXE-'.repeat(400));
  const dNewExe = Buffer.from(dOldExe); dNewExe.write('NEW', 120, 'utf8');
  const dPak = Buffer.from('NEW-PAK-CONTENT');
  const made2 = vc.makeDirPatch(
    [{ path: 'QuickLaunch.exe', data: dOldExe }],
    [{ path: 'QuickLaunch.exe', data: dNewExe }, { path: 'locales/new.pak', data: dPak }]);
  const P4 = path.join(TMP, 'prog4');
  const putP4 = (rel, content) => {
    const p = path.join(P4, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  putP4('QuickLaunch.exe', dOldExe);
  const deltaMan = mkUpd({
    version: '1.3.0',
    full: { asset: 'QuickLaunch-Green-1.3.0.zip', size: made2.pack.length * 100, sha256: 'b'.repeat(64) },
    files: [
      { path: 'QuickLaunch.exe', size: dNewExe.length, sha256: vc.sha256hex(dNewExe) },
      { path: 'locales/new.pak', size: dPak.length, sha256: vc.sha256hex(dPak) },
    ],
    patches: [{
      from: '1.1.1', asset: 'QuickLaunch-Delta-1.1.1-to-1.3.0.bin',
      size: made2.pack.length, sha256: vc.sha256hex(made2.pack), plan: made2.manifest,
    }],
  });
  const dHits = [];
  const sDelta = mkSvc({
    programDir: P4, getBuffer: (u, o) => {
      dHits.push(u);
      const body = /update\.json$/.test(u)
        ? Buffer.from(JSON.stringify(deltaMan), 'utf8')
        : made2.pack;
      if (o && o.destPath) { fs.writeFileSync(o.destPath, body); return { path: o.destPath, size: body.length, total: body.length }; }
      return body;
    },
  });
  sDelta.svc.boot();
  const d1 = await sDelta.svc.check({ silent: true });
  ok(d1.available === true && d1.plan.mode === 'delta',
    '★ 有对应本机版本的差量且占比够小 → 选增量（用户要的"智能识别"）', d1.plan && d1.plan.reason);
  const dSnap1 = sDelta.svc.snapshot();
  ok(!!dSnap1.plan && dSnap1.plan.mode === 'delta', '快照把方案报成增量（界面才知道要下的是补丁包）');
  ok(dSnap1.plan.size === made2.pack.length, '大小取自补丁包（差量只有几十 KB 时不能显示成 160 MB）');

  const d2 = await sDelta.svc.download();
  ok(d2.ok === true && d2.staged === true && d2.mode === 'delta', '★ 差量路径：下载 + 还原 + 暂存走通', d2.reason || '');
  const ajDelta = readJsonIf(path.join(P4, '.update', '1.3.0', 'apply.json'));
  ok(!!ajDelta && ajDelta.mode === 'delta', 'apply.json 记的是 delta 模式');
  const stgExe2 = readIf(path.join(P4, '.update', '1.3.0', 'files', 'QuickLaunch.exe'));
  ok(!!stgExe2 && stgExe2.equals(dNewExe), '★ 暂存的 exe 是补丁真还原出来的新版（逐字节等于目标）');
  ok(dHits.some(u => /\.bin$/.test(u)) && !dHits.some(u => /\.zip$/.test(u)),
    '★ 走增量时下的是补丁包，**没有**去下 160 MB 的全量 zip');
  ok(dHits.length === 2, `差量路径同样只发 2 次请求（实际 ${dHits.length}）`);

  // 夹在中间的：download 之前不能下
  const sEarly = mkSvc({ programDir: P4, getBuffer: async () => Buffer.from('{}') });
  const eDl = await sEarly.svc.download();
  ok(eDl.ok === false && /先检查更新/.test(eDl.reason), '还没检查就点下载 → 明确拒绝并告诉他先检查', eDl.reason);

  // 下载中途失败 → 落到 failed，且**不**留下半截
  // ★ 先把上一次成功暂存留下的 .update 清掉，否则"没有 apply.json"这条断言是在
  //   看别人的产物（第一次写这条时正是这么假绿的）。
  const stage4 = path.join(P4, '.update');
  fs.rmSync(stage4, { recursive: true, force: true });
  const sDlFail = mkSvc({
    programDir: P4,
    getBuffer: async (u, o) => {
      if (/update\.json$/.test(u)) return Buffer.from(JSON.stringify(deltaMan), 'utf8');
      throw new Error('ECONNRESET');
    },
  });
  sDlFail.svc.boot();
  await sDlFail.svc.check({ silent: true });
  const fDl = await sDlFail.svc.download();
  ok(fDl.ok === false && /ECONNRESET/.test(fDl.reason), '补丁包下载失败 → 失败并带上原始原因', fDl.reason);
  ok(sDlFail.svc.snapshot().status === 'failed', '下载失败后状态 = failed');
  ok(!fs.existsSync(path.join(stage4, '1.3.0', 'apply.json')),
    '★ 下载失败**不留** apply.json（否则下次启动会把它当成"已下好可重启"，换出一份半残）');
  ok(!fs.existsSync(path.join(stage4, 'state.json')),
    '★ 下载失败也不写 state.json（不然下次启动会"恢复"出一个根本不存在的暂存）');
  ok(!fs.existsSync(path.join(stage4, '1.3.0', 'QuickLaunch-Delta-1.1.1-to-1.3.0.bin')),
    '失败后没留下半截的补丁包');

  // 补丁被篡改 → 也要拒绝
  const sTamper = mkSvc({
    programDir: P4,
    getBuffer: async (u, o) => {
      if (/update\.json$/.test(u)) return Buffer.from(JSON.stringify(deltaMan), 'utf8');
      const bad = Buffer.from(made2.pack);
      bad[20] ^= 0xff;
      if (o && o.destPath) { fs.writeFileSync(o.destPath, bad); return { path: o.destPath, size: bad.length, total: bad.length }; }
      return bad;
    },
  });
  sTamper.svc.boot();
  await sTamper.svc.check({ silent: true });
  const fTam = await sTamper.svc.download();
  ok(fTam.ok === false && /sha256/.test(fTam.reason), '★ 补丁包被篡改 → 下载阶段就拦住', fTam.reason);

  /* ---- H. 快照自身的诚实性 ---- */
  const sU = mkSvc({ programDir: P3, form: 'dev' });
  sU.svc.boot();
  ok(sU.svc.snapshot().supported === false, '开发模式不支持自更新');
  ok(sU.svc.canSelfUpdate().ok === false, 'canSelfUpdate 与快照口径一致');
  const sIdle = mkSvc({ programDir: P3, settings: { autoUpdate: false } });
  sIdle.svc.boot();
  ok(sIdle.svc.snapshot().autoUpdate === false, '设置里关掉自动检查 → 快照如实反映');
  // 每个状态都得有人话，界面与诊断信息都直接用 statusText
  const svcStates = Object.values(sU.svc.STATE);
  ok(svcStates.every(s => typeof sU.svc.STATE_TXT[s] === 'string' && sU.svc.STATE_TXT[s].length > 0),
    `${svcStates.length} 个状态每个都有人话文案（界面与诊断信息直接用 statusText）`);

  section('结果');
  console.log(`  \x1b[32m通过 ${pass}\x1b[0m${fail ? ` / \x1b[31m失败 ${fail}\x1b[0m` : ''}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试异常:', e);
  // ★ 崩溃路径也必须清 TMP。不清的话，残留的 mig/data/config.json 会让**下一次**
  //   运行在一条看似无关的断言上报红（"新位置没有配置时会把旧的搬过来"），
  //   排查时会怀疑到刚改的代码上，白费半天。
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清不掉也不能盖住原始异常 */ }
  process.exit(1);
});

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
  },
  shell: {
    openPath: async () => '',
    openExternal: async () => {},
    showItemInFolder: p => { stub.__lastFolder = p; },
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: class { static fromWebContents() { return null; } },
  Tray: class {}, Menu: { buildFromTemplate: () => ({}) }, ipcMain: { handle: () => {} },
  globalShortcut: { register: () => true, unregisterAll: () => {}, isRegistered: () => true },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
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

  section('itemOk 存在性判定');
  ok(store.itemOk({ type: 'url', path: 'https://github.com' }) === true, '网址恒为存在');
  ok(store.itemOk({ type: 'app', path: 'notepad.exe' }) === true, '裸命令名 notepad.exe 命中 System32');
  ok(store.itemOk({ type: 'app', path: 'C:\\__nope__\\x.exe' }) === false, '不存在的绝对路径判为缺失');
  ok(store.itemOk({ type: 'app', path: 'services.msc' }) === true, '.msc 交给 shell 关联');
  ok(store.expandEnv('%SystemRoot%\\System32') === (process.env.SystemRoot + '\\System32'), '环境变量展开');

  section('actions 启动动作');
  const out = path.join(TMP, 'launch-ok.txt');
  try { fs.unlinkSync(out); } catch {}
  let r = await actions.launch({ type: 'cmd', path: `echo ql-ok > "${out}"` });
  ok(r.ok, 'cmd 类型执行返回 ok', r.msg);
  await new Promise(res => setTimeout(res, 700));
  const content = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : '';
  ok(content === 'ql-ok', '命令真的落盘（引号与重定向正确）', JSON.stringify(content));

  r = await actions.launch({ type: 'app', path: 'C:\\__nope__\\nope.exe' });
  ok(!r.ok || typeof r.msg === 'string', '不存在的程序返回可读错误', r.msg);

  r = await actions.launch({ type: 'folder', path: TMP });
  ok(r.ok, '目录类型可打开', r.msg);

  r = await actions.launch({ type: 'url', path: 'github.com' });
  ok(r.ok, '网址自动补 http:// 并交给 shell', r.msg);

  ok(actions.splitArgs('"a b" c --flag=1').join('|') === 'a b|c|--flag=1', 'splitArgs 引号解析');
  ok(path.basename(actions.resolveTarget('notepad.exe')).toLowerCase() === 'notepad.exe',
    'resolveTarget 解析裸命令名');

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
  ok(bacts.join(',') === 'new,newgroup,multiselect,scan,settings', '空白菜单动作 = new,newgroup,multiselect,scan,settings', bacts.join(','));

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

  // 上限保护
  const many = await importer.buildItems({
    urls: Array.from({ length: 60 }, (_, i) => `https://h${i}.example.com`), existing: [],
  });
  ok(many.items.length === importer.MAX_ITEMS, `单次上限 ${importer.MAX_ITEMS} 项`);

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
  ok(/function onGridPointerDown[\s\S]{0,160}state\.editMode\) return/.test(appSrc),
    '编辑模式下不触发长按拖动');

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
  const iGlobalEsc = appSrc.indexOf("if (e.key === 'Escape') {\n      if (state.dlgCancel)");
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

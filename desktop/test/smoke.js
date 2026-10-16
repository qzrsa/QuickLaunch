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

  /* ★ 从源码里抠出这几个纯函数真跑，不另写"镜像实现"（镜像实现永远通过 = 没测）。
     它们只依赖 FORM_TXT / PREVIEW，抠出来就能跑。 */
  const fnSrc = n => {
    const m = appSrc.match(new RegExp(`function ${n}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`));
    return m ? m[0] : '';
  };
  const formMapSrc = (appSrc.match(/const FORM_TXT = \{[\s\S]*?\n\};/) || [''])[0];
  const parts = ['FORM_TXT', 'formText', 'statusText', 'dataWarnText', 'aboutGroups', 'envLines'];
  const got = {
    FORM_TXT: formMapSrc,
    formText: fnSrc('formText'),
    statusText: fnSrc('statusText'),
    dataWarnText: fnSrc('dataWarnText'),
    aboutGroups: fnSrc('aboutGroups'),
    envLines: fnSrc('envLines'),
  };
  const missingSrc = parts.filter(n => !got[n]);
  ok(missingSrc.length === 0, '6 段源码都抠出来了', missingSrc.join(',') || 'ok');
  ok((appSrc.match(/FORM_TXT/g) || []).length === 2,
    'FORM_TXT 只有一份（定义 + formText 里取用）；状态行和「关于」共用它',
    `出现 ${(appSrc.match(/FORM_TXT/g) || []).length} 次`);

  if (missingSrc.length === 0) {
    const mk = preview => new Function('PREVIEW',
      [formMapSrc, got.formText, got.statusText, got.dataWarnText, got.aboutGroups, got.envLines].join('\n')
      + '\nreturn { formText, statusText, dataWarnText, aboutGroups, envLines };')(preview);
    const A = mk(false);

    // 运行形态四种标签
    ok(A.formText({ form: 'installed' }) === '安装版', 'installed → 安装版');
    ok(A.formText({ form: 'green' }) === '绿色版', 'green → 绿色版');
    ok(/便携版/.test(A.formText({ form: 'portable' })), 'portable → 便携版');
    ok(A.formText({ form: 'dev' }) === '开发模式', 'dev → 开发模式');
    ok(A.formText({ packaged: true }) === '已打包' && A.formText({}) === '开发模式',
      '未知 form 时按 packaged 兜底');

    // 状态行：版本 · 运行形态，且绝不出现「已连接」
    ok(A.statusText({ version: '1.0.2', form: 'installed' }) === 'v1.0.2 · 安装版',
      '状态行 = 「v版本 · 运行形态」');
    ok(!/已连接/.test(A.statusText({ version: '1.0.2', form: 'installed' })),
      '状态行不再出现「已连接」（程序不联网，那词会被读成在线状态）');
    ok(A.statusText({ version: '1.0.2', form: 'green' }) === 'v1.0.2 · 绿色版', '绿色版状态行');
    ok(A.statusText(null) === '初始化…', 'info 还没到手时说「初始化…」，不谎报运行形态');
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
  ok(/API\.on\('ql:second-instance'[\s\S]{0,300}statusText\(info\)/.test(appSrc),
    '提示文案复用 statusText（与侧栏状态行、「关于」同一份实现）');
  ok(/^function lastToast/m.test(appSrc),
    'lastToast 提到顶层（探针共用一份，不再每个探针各拷一遍）');

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

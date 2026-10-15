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
  ok(bacts.join(',') === 'new,newgroup,scan,settings', '空白菜单动作 = new,newgroup,scan,settings', bacts.join(','));

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

  section('结果');
  console.log(`  \x1b[32m通过 ${pass}\x1b[0m${fail ? ` / \x1b[31m失败 ${fail}\x1b[0m` : ''}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });

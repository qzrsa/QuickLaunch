'use strict';
/**
 * 快速启动 QuickLaunch · Electron 主进程
 * 负责：无边框窗口、托盘常驻、全局热键、开机自启、IPC 路由
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, globalShortcut, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./lib/store');
const actions = require('./lib/actions');
const scanner = require('./lib/scan');
const menus = require('./lib/menus');
const importer = require('./lib/importer');

const ROOT = path.join(__dirname, '..');
// ★ 打包后 build/ 不在 asar 里 —— 图标必须由 package.json 的 extraResources
//   落到 resources/icon.ico，否则托盘和窗口图标全是空白（之前就漏了这一步）。
const ICON = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : path.join(ROOT, 'build', 'icon.ico');
// 兜底：万一图标文件缺失，用内嵌的 16×16 PNG，保证永远不会出现"空白图标"
const FALLBACK_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACgUlEQVR42k2RvYtdVRRH12+fcz8mGQ3GMY4gDDIgsRjMDBaxsrSw8XMIQQv/hohgYcSUQtq0VkEckBAIEqsEIlgICVonRZp0kckw773ce88+2+I90GKXi71YPwFc+G6+3zftlXDflkcyJIVoNGAhonYoAioRLle1R4tFufzjte5An3///BNL+SBFsjoNJEQSzGfivb0ZSXDvz3VeWAMvUKdA0eBTrWWo+0blagqzOj13QyjAEHjh/G7Lu3sdUQpUgQdUKOPkqmYWXM2CrToNGJYMMEGZxOaGs3O2A8TmxsDhYUMCwgWV5KWg0FZWgDAIEGDAMMBbO4VfblUIOLtduft7x4lWRAEcVJe2mSoACAggEE2C2fHAnXunoML53WdkreMThAMr2AJy9SVsQIQIwWIevPZqz0fvjwAoev6YwfoaRBUWoJVx9gkqkJYrgUSZCm+8nnln9yQA9x/MCS9QG1RZhQYLYaUEPkEpS72jI7Hz5sje2z3u4A6753rO7YzMj0XW/2DAfNJqXyijEWXgi89azAyJ1YmLF1uyBqj6Dw6w8OVnBRw9Cz79oPLKhvHr7aeYgRn8dvsfXjotPvzYmR9DthUMGKsg05jYfHnBiX7gq28qN272jGNhmgq3bnZ8+3XQtQNnzszxaWmgENlWNZOCaUxc/3mdbB34wJMnhZTE7LihUceNnxIn15ykJWxANvS4sWYr6uhl6tNaC01yDp8mHj4cyQbjvOPF05XwTJ0yRnibLNVSH5tClxS1NqlNiYoiCIe+yfz9oPDX/ULfpmWnGpiCNllSUBV2SQAXvhz2+zZfwWNbUZOFZJHItiCFwHsSgUEkzFvjURn98g/X88G/wY1J7zcGVIcAAAAASUVORK5CYII=';
/** 取应用图标：优先磁盘文件，缺失则退到内嵌兜底，绝不返回空白 */
function appIcon() {
  let img = null;
  try { img = nativeImage.createFromPath(ICON); } catch { /* noop */ }
  if (img && !img.isEmpty()) return img;
  console.warn('[icon] 磁盘图标缺失，改用内嵌兜底图标 ·', ICON);
  try { return nativeImage.createFromDataURL(FALLBACK_ICON); } catch { return nativeImage.createEmpty(); }
}
const START_HIDDEN = process.argv.includes('--hidden');
const SHOT_ARG = process.argv.find(a => a.startsWith('--shot'));
// 开发期自检：--shot[=文件名] 以 0 透明度显示窗口、截取渲染画面后自动退出
const SHOT = !app.isPackaged && SHOT_ARG ? (SHOT_ARG.split('=')[1] || 'page.png') : null;
// --shot 的伴生开关：配合 --shot 使用，让渲染层显示「最大化/还原」中的还原图标
const WIN_STATE_DEMO = !!SHOT && process.argv.includes('--winstate-max');
// 开发期自检：--menu-probe 不真正弹菜单，只校验渲染层传来的右键载荷是否完整
const MENU_PROBE = process.argv.includes('--menu-probe');
// 开发期自检：--import-probe 合成一次拖放，验证拖入导入链路（不写入配置）
const IMPORT_PROBE = process.argv.includes('--import-probe');
// 开发期自检：--drag-probe 合成一次长按拖动，验证排序与垃圾桶删除（默认不写入配置）
// --drag-probe=real 会真的写盘（只写 dev 的 .tmpdata/userData，用于端到端验证）
const DRAG_PROBE_ARG = process.argv.find(a => a.startsWith('--drag-probe'));
const DRAG_PROBE = !!DRAG_PROBE_ARG;
const DRAG_PROBE_REAL = DRAG_PROBE_ARG === '--drag-probe=real';
// 开发期自检：--group-probe 合成「新建分组 → 重名拦截 → 删除分组」，验证侧栏增删链路（会写 dev 配置）
const GROUP_PROBE = process.argv.includes('--group-probe');
// 开发期自检：--info-probe 打开「关于」窗口 + 设置面板，打印运行环境信息并各截一张图
// （验的是数据目录落在哪、四种运行形态标签对不对、状态行文案、设置里已无环境块）
const INFO_PROBE = process.argv.includes('--info-probe');
// 开发期自检：--rail-probe 灌一大堆分组，量侧栏几何（溢出/滚动条/底部栏/新建分组是否可见）
// （只在内存里改 groups，不写盘）
const RAIL_PROBE = process.argv.includes('--rail-probe');
// 开发期自检：--select-probe 验「启动分组设置」+「多选编辑模式」整条链路（会写 dev 配置）
const SELECT_PROBE = process.argv.includes('--select-probe');

function probeMenu(kind, payload, tpl) {
  const acts = tpl.filter(i => typeof i.click === 'function').map(i => i.click());
  console.log(`[menu-probe] ${kind} 载荷=${JSON.stringify(payload)} 动作=[${acts.join(',')}]`);
  return null;
}

/** 造几条尽量真实的拖放样例：家目录、当前 exe、一个真实 .lnk、一个网址 */
function probeSamplePaths() {
  const paths = [];
  const urls = ['https://github.com/qzrsa'];
  try { paths.push(app.getPath('home')); } catch { /* noop */ }
  paths.push(process.execPath);

  const roots = [process.env.ProgramData, process.env.APPDATA]
    .filter(Boolean)
    .map(d => path.join(d, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));

  outer:
  for (const r of roots) {
    const stack = [[r, 1]];
    while (stack.length) {
      const [d, depth] = stack.pop();
      if (depth > 4) continue;
      let es = [];
      try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of es) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) stack.push([f, depth + 1]);
        else if (e.name.toLowerCase().endsWith('.lnk')) { paths.push(f); break outer; }
      }
    }
  }
  return { paths, urls };
}

let win = null;
let tray = null;
let quitting = false;
let hotkeyFail = '';
let lastBounds = null;

/* ------------------------------------------------------------ 数据目录
 * 打包后把 Electron 的 userData 放到**程序自己所在目录**：
 *   安装版 → 安装目录、绿色版 → 运行目录、便携版 → 便携版 exe 所在目录。
 * 决策与回落逻辑都在 src/lib/datadir.js（可离线单测），这里只负责把
 * Electron 的实际路径喂进去、把结果落到 app.setPath。
 * 开发态仍旧放项目内 .tmpdata/userData：一是别污染真实配置，二是 %APPDATA% 在受限
 * 环境下不可写会导致单实例锁创建失败而直接退出（见铁律二）。 */
const datadir = require('./lib/datadir');

/** 程序所在目录。便携版必须优先用 PORTABLE_EXECUTABLE_DIR，
 *  否则拿到的是临时解包目录 —— 数据会跟着临时目录一起被删。 */
function programDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  try { return path.dirname(app.getPath('exe')); } catch { return path.dirname(process.execPath); }
}

/** 数据目录的落点与原因，ql:info 会原样吐给设置面板 */
let dataLocation = { dir: '', inProgramDir: false, note: '' };

function setupDataDir() {
  let legacy = '';
  try { legacy = app.getPath('userData'); } catch { /* noop */ }   // 必须在 setPath 之前取

  dataLocation = datadir.resolveDataDir({
    isPackaged: app.isPackaged,
    devDataDir: path.join(ROOT, '.tmpdata', 'userData'),
    legacyDir: legacy,
    programDir: programDir(),
  });

  if (dataLocation.inProgramDir) {
    try { fs.mkdirSync(dataLocation.dir, { recursive: true }); } catch { /* noop */ }
    if (datadir.migrateLegacyConfig(dataLocation.dir, legacy)) {
      console.log('[data] 已把旧配置迁到程序目录:', path.join(legacy, 'config.json'), '->', dataLocation.dir);
    }
  } else if (app.isPackaged) {
    console.warn('[data] 数据未落在程序目录 ·', dataLocation.note, '· 实际 =', dataLocation.dir);
  }

  try { app.setPath('userData', dataLocation.dir); } catch (e) {
    console.error('[data] setPath 失败，改用系统默认目录:', e.message);
    dataLocation = { dir: legacy, inProgramDir: false, note: 'setPath 失败，已回落到系统目录' };
  }
}

setupDataDir();

/** 运行形态：给设置面板显示用。安装版靠程序目录里有没有卸载器来认。 */
function appForm() {
  if (!app.isPackaged) return 'dev';
  if (process.env.PORTABLE_EXECUTABLE_DIR) return 'portable';
  try {
    const hasUninstaller = fs.readdirSync(programDir())
      .some(n => /^Uninstall.*\.exe$/i.test(n));
    return hasUninstaller ? 'installed' : 'green';
  } catch { return 'green'; }
}

/* ---------------------------------------------------- 路径与自启 */

function launcherExePath() {
  // 便携版：PORTABLE_EXECUTABLE_FILE 指向原始 exe，而非临时解包目录
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function applyAutostart(enabled) {
  try {
    const target = launcherExePath();
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: target,
      args: ['--hidden'],
    });
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

function autostartState() {
  try {
    const s = app.getLoginItemSettings({ path: launcherExePath(), args: ['--hidden'] });
    return !!s.openAtLogin;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------- 窗口 */

function createWindow() {
  const cfg = store.load();
  const b = cfg.settings.windowBounds || {};

  win = new BrowserWindow({
    width: b.width || 1180,
    height: b.height || 764,
    x: b.x, y: b.y,
    minWidth: 860,
    minHeight: 560,
    frame: false,
    show: false,
    backgroundColor: cfg.settings.theme === 'dark' ? '#0a0d13' : '#eef1f8',
    icon: appIcon(),
    title: '快速启动',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));

  // 开发期把渲染进程日志转到终端，便于排错
  win.webContents.on('console-message', (...args) => {
    if (app.isPackaged) return;
    const d = args[0];
    const msg = (d && typeof d === 'object' && 'message' in d) ? d.message : args[2];
    const lvl = (d && typeof d === 'object' && 'level' in d) ? d.level : args[1];
    console.log(`[renderer:${lvl}] ${msg}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[window] 加载失败 ${code} ${desc} ${url}`);
  });

  // 把文件拖进窗口时 Chromium 默认会导航到 file:// ，直接掐掉
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  // --menu-probe：加载完成后让渲染层在真实 DOM 上派发右键事件，跑完自动退出
  if (MENU_PROBE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => win.webContents.send('ql:menu-probe'), 1500);
      setTimeout(() => quitApp(), 6000);
    });
  }

  // --import-probe：合成一次拖入，验证「拖放 → 路径提取 → IPC → 分类」整条链路
  if (IMPORT_PROBE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try { win.setOpacity(0); } catch { /* noop */ }   // 提前隐藏，顺便给合成留时间
        win.webContents.send('ql:import-probe', probeSamplePaths());
      }, 1500);
      // 渲染层会在 dragenter 后停留 1.5s 再 drop，趁遮罩显示时截一张图
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          const out = path.join(ROOT, '.tmpdata', 'shot-drop.png');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, img.toPNG());
          console.log('[import-probe] 遮罩截图 ->', out);
        } catch (e) { console.error('[import-probe] 截图失败:', e.message); }
        try { win.setOpacity(1); } catch { /* noop */ }
      }, 2600);
      setTimeout(() => quitApp(), 9000);
    });
  }

  // --drag-probe / --group-probe 共用的截图通道：
  // 由渲染层在准确时刻主动触发（主进程自己掐 setTimeout 会被节流/漂移）
  if (DRAG_PROBE || GROUP_PROBE || INFO_PROBE || RAIL_PROBE || SELECT_PROBE) {
    // 打包态下 ROOT 在 asar 内部，写不进去 —— 逐级找一个能写的目录，
    // 免得探针"静默失败"让人以为没问题。
    const shotBase = (() => {
      const cands = [path.join(ROOT, '.tmpdata')];
      try { cands.push(path.join(path.dirname(process.execPath), '.probe-shot')); } catch { /* noop */ }
      try { cands.push(path.join(app.getPath('temp'), 'quicklaunch-probe')); } catch { /* noop */ }
      for (const d of cands) if (datadir.ensureWritable(d)) return d;
      return app.getPath('temp');
    })();
    ipcMain.handle('ql:probe-shot', async (_e, name) => {
      try {
        const img = await win.webContents.capturePage();
        const out = path.join(shotBase, name);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, img.toPNG());
        console.log(`[probe] 截图 -> ${out}`);
        return { ok: true, out };
      } catch (e) {
        console.error('[probe] 截图失败:', e.message);
        return { ok: false, msg: e.message };
      }
    });
  }

  // --info-probe：打开「关于」→ 打印运行环境 → 截图 → 关掉再开设置面板 → 截图
  if (INFO_PROBE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try { win.setOpacity(0); } catch { /* noop */ }
        win.webContents.send('ql:info-probe');
      }, 1200);
      setTimeout(() => quitApp(), 20000);
    });
  }

  // --rail-probe：灌一堆分组 → 量侧栏几何（溢出 / 滚动条 / 底部栏 / 新建分组可见性）→ 截图
  if (RAIL_PROBE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try { win.setOpacity(0); } catch { /* noop */ }
        win.webContents.send('ql:rail-probe');
      }, 1200);
      setTimeout(() => quitApp(), 25000);
    });
  }

  // --select-probe：验「启动分组设置」+「多选编辑模式」整条链路 → 截图
  if (SELECT_PROBE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try { win.setOpacity(0); } catch { /* noop */ }
        // ★ 探针期间把窗口设成不可聚焦：opacity:0 只是"看不见"，窗口仍然是
        //   可聚焦的 —— 用户在外面打字时按键会落到这个隐形窗口里（实测会打进
        //   搜索框，把列表过滤成 0 张卡，探针就"莫名其妙"全绿/全红）。
        try { win.setFocusable(false); } catch { /* noop */ }
        win.webContents.send('ql:select-probe');
      }, 1200);
      // ★ 看门狗必须比探针最坏耗时宽裕得多：这条探针有 4 次截图，每次都要
      //   等 toast 散掉 + 卡片入场动画播完（最多 ~4s），跑满约 25~30s。
      //   之前给 40s，结果两次被掐在"还原配置"之前 —— 探针结果不可信不说，
      //   dev 配置还留了污染（18 项变 14 项）。掐死前一定要吼一声。
      setTimeout(() => {
        console.error('[probe] ★ select-probe 超时 90s 仍未跑完，强制退出：'
          + '本次结果不可信，且 dev 配置可能没还原（先用 .tmpdata/cfg.snap.bak 恢复）');
        quitApp();
      }, 90000);
    });
  }

  // --group-probe：合成「新建分组 → 重名拦截 → 删除分组」
  if (GROUP_PROBE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try { win.setOpacity(0); } catch { /* noop */ }
        win.webContents.send('ql:group-probe');
      }, 1200);
      setTimeout(() => quitApp(), 22000);
    });
  }

  // --drag-probe：合成长按拖动，验证「长按 1.5s → 拖动 → 让位 → 排序/删除」
  if (DRAG_PROBE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try { win.setOpacity(0); } catch { /* noop */ }
        win.webContents.send('ql:drag-probe', { real: DRAG_PROBE_REAL });
      }, 1500);
      setTimeout(() => quitApp(), 30000);   // 兜底：探针异常时别把窗口挂死
    });
  }
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[window] 渲染进程退出:', details && details.reason);
  });

  win.once('ready-to-show', () => {
    if (!START_HIDDEN) showWindow();
  });

  if (SHOT) {
    win.once('ready-to-show', async () => {
      win.setOpacity(0);          // 对用户不可见，但 Chromium 仍在渲染
      win.show();
      await new Promise(r => setTimeout(r, 1600));
      // --shot 的伴生开关：--winstate-max 让渲染层以为窗口已最大化。
      // 直接推 ql:win-state 而不是真的 win.maximize()，这样窗口尺寸不变、
      // 截图裁剪坐标可复用，同时仍然完整走「IPC → setWinMaxIcon → CSS 类」这条真实链路。
      if (WIN_STATE_DEMO) {
        win.webContents.send('ql:win-state', { maximized: true });
        await new Promise(r => setTimeout(r, 260));
      }
      try {
        const img = await win.webContents.capturePage();
        const out = path.join(ROOT, '.tmpdata', SHOT);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, img.toPNG());
        console.log('[shot] ->', out);
      } catch (e) {
        console.error('[shot] 失败:', e.message);
      }
      setTimeout(() => quitApp(), 200);
    });
  }

  win.on('maximize', () => win.webContents.send('ql:win-state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('ql:win-state', { maximized: false }));

  const persistBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const cfg2 = store.load();
    cfg2.settings.windowBounds = win.getNormalBounds();
    try { store.save(cfg2); } catch { /* noop */ }
  };
  win.on('resize', () => { clearTimeout(lastBounds); lastBounds = setTimeout(persistBounds, 500); });
  win.on('move', () => { clearTimeout(lastBounds); lastBounds = setTimeout(persistBounds, 500); });

  win.on('close', e => {
    if (quitting) return;
    const closeAction = store.load().settings.closeAction || 'tray';
    if (closeAction === 'tray') {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // 留一条启动日志：窗口到底有没有真的显示出来，是"启动就静默退出 / 只进托盘"
  // 这类问题唯一能一眼看出来的信号（外面用 Win32 查 MainWindowHandle 对
  // 无边框窗口并不可靠，实测正常显示时也常常读到 0）。
  console.log('[win] 已显示窗口 isVisible=' + win.isVisible() + ' title=' + JSON.stringify(win.getTitle()));
  if (!win.webContents.isLoading()) win.webContents.send('ql:focus-search');
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible() && win.isFocused() && !win.isMinimized()) win.hide();
  else showWindow();
}

/* ---------------------------------------------------- 托盘 */

function topItems(cfg, n = 10) {
  const mode = cfg.settings.trayQuick || 'top';
  if (mode === 'none') return [];
  const all = [];
  cfg.groups.forEach(g => g.items.forEach(i => all.push(i)));
  if (mode === 'favorites') return all.filter(i => i.favorite).slice(0, n);
  return all.slice().sort((a, b) => (b.useCount || 0) - (a.useCount || 0)).slice(0, n);
}

function trayImage() {
  const img = appIcon();
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function buildTray() {
  if (!tray) return;
  const cfg = store.load();
  const quick = topItems(cfg);
  const running = !!(win && win.isVisible());

  const template = [
    {
      label: running ? '隐藏快速启动' : '显示快速启动',
      click: () => toggleWindow(),
    },
    { type: 'separator' },
  ];

  if (quick.length) {
    template.push({
      label: '快速启动',
      submenu: quick.map(i => ({
        label: `${i.icon || '🚀'}  ${i.name}`,
        toolTip: i.path,
        click: () => runAndBump(i),
      })),
    });
    template.push({ type: 'separator' });
  }

  template.push(
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: autostartState(),
      click: mi => {
        applyAutostart(mi.checked);
        const c = store.load();
        c.settings.autostart = mi.checked;
        store.save(c);
        if (win) win.webContents.send('ql:settings-changed', c.settings);
      },
    },
    {
      label: '打开配置目录',
      click: () => shell.openPath(store.configDir()),
    },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() },
  );

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(`快速启动 · QuickLaunch${running ? '' : '（已隐藏）'}`);
}

function createTray() {
  try {
    tray = new Tray(trayImage());
  } catch (e) {
    console.error('[tray] 创建失败:', e.message);
    return;
  }
  tray.on('click', () => toggleWindow());
  tray.on('double-click', () => showWindow());
  buildTray();
}

/* ---------------------------------------------------- 热键 */

function applyHotkey(accel, enabled) {
  globalShortcut.unregisterAll();
  hotkeyFail = '';
  if (!enabled || !accel) return { ok: true, msg: '已关闭' };
  let ok = false;
  try {
    ok = globalShortcut.register(accel, () => toggleWindow());
  } catch (e) {
    hotkeyFail = e.message;
    return { ok: false, msg: '热键格式无效：' + e.message };
  }
  if (!ok) {
    hotkeyFail = '可能已被其他程序占用';
    return { ok: false, msg: `注册失败，${hotkeyFail}` };
  }
  return { ok: true, msg: `已绑定 ${accel}` };
}

/* ---------------------------------------------------- 启动并计数 */

async function runAndBump(item) {
  const res = await actions.launch(item);
  if (res.ok && item.id) {
    try {
      const cfg = store.load();
      for (const g of cfg.groups) {
        for (const i of g.items) {
          if (i.id === item.id) {
            i.useCount = (i.useCount || 0) + 1;
            i.lastUsed = Math.floor(Date.now() / 1000);
          }
        }
      }
      store.save(cfg);
      if (win && !win.isDestroyed()) win.webContents.send('ql:config-changed');
      buildTray();
    } catch { /* noop */ }
  }
  return res;
}

/* ---------------------------------------------------- 原生右键菜单 */

/**
 * 弹出原生菜单并把用户选择回传给渲染层。
 * 用 Promise 包装：菜单项点击 resolve(动作名)，菜单关闭（未选中）resolve(null)。
 */
function popupMenu(evt, template) {
  return new Promise(resolve => {
    let done = false;
    const pick = a => { if (!done) { done = true; resolve(a); } };

    // 递归包装：子菜单里的 click 也必须回传动作（否则点了没反应）
    const wrap = items => items.map(it => {
      const o = Object.assign({}, it);
      if (Array.isArray(it.submenu)) o.submenu = wrap(it.submenu);
      if (typeof it.click === 'function') {
        const fn = it.click;
        o.click = () => pick(fn());
      }
      return o;
    });

    const menu = Menu.buildFromTemplate(wrap(template));
    menu.popup({
      window: BrowserWindow.fromWebContents(evt.sender) || undefined,
      callback: () => pick(null),
    });
  });
}

/* ---------------------------------------------------- IPC */

function registerIpc() {
  ipcMain.handle('ql:config:get', () => store.annotate(store.load()));

  ipcMain.handle('ql:config:save', (_e, cfg) => {
    try {
      if (!cfg || !Array.isArray(cfg.groups)) return { ok: false, msg: '配置结构不正确' };
      store.save(cfg);
      buildTray();
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: e.message };
    }
  });

  ipcMain.handle('ql:run', (_e, item) => runAndBump(item));
  ipcMain.handle('ql:folder', (_e, p) => actions.openContaining(p));
  ipcMain.handle('ql:pick', (e, kind) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    return actions.pick(kind, w);
  });
  ipcMain.handle('ql:scan', (_e, force) => scanner.scan(!!force));

  /* 拖入导入 */
  ipcMain.handle('ql:import', async (_e, payload) => {
    const { paths = [], urls = [], groupId = null, dryRun = false } = payload || {};
    if (!paths.length && !urls.length) return { ok: true, added: 0, skipped: [], failed: [] };

    const cfg = store.load();
    const existing = cfg.groups.flatMap(g => g.items || []);
    const r = await importer.buildItems({ paths, urls, existing });

    if (dryRun) {
      console.log('[import-probe] 目标分组 =', groupId || '(未指定 → 拖入的快捷方式)');
      console.log('[import-probe] 待导入 =', JSON.stringify(r.items.map(i => ({
        name: i.name, type: i.type, icon: i.icon, path: i.path, args: i.args || '', cwd: i.cwd || '',
      }))));
      console.log('[import-probe] 重复跳过 =', JSON.stringify(r.skipped),
        ' 无法识别 =', JSON.stringify(r.failed));
      return { ok: true, dryRun: true, added: r.items.length, skipped: r.skipped, failed: r.failed };
    }

    if (!r.items.length) {
      return { ok: true, added: 0, skipped: r.skipped, failed: r.failed };
    }

    // 指定了分组就用它；否则落到「拖入的快捷方式」（没有则创建）
    let g = groupId ? cfg.groups.find(x => x.id === groupId) : null;
    if (groupId && !g) {
      // 拖到了虚拟视图（全部/最近/收藏）或已删除的分组 → 走默认分组
      groupId = null;
    }
    if (!g) g = store.ensureGroup(cfg, 'dropped', '拖入的快捷方式', '📥');

    const ids = [];
    // 新项插到最前，拖完立刻能看见
    for (const it of r.items.slice().reverse()) {
      const created = store.newItem(it.name, it.icon, it.type, it.path, {
        args: it.args || '', cwd: it.cwd || '', desc: it.desc || '',
      });
      g.items.unshift(created);
      ids.push({ id: created.id, groupId: g.id });
    }
    store.save(cfg);
    return { ok: true, added: ids.length, ids, groupId: g.id, groupName: g.name, skipped: r.skipped, failed: r.failed };
  });

  ipcMain.handle('ql:settings:set', (_e, patch) => {
    const cfg = store.load();
    Object.assign(cfg.settings, patch || {});
    store.save(cfg);

    const out = { ok: true, settings: cfg.settings };
    if ('hotkey' in patch || 'hotkeyEnabled' in patch) {
      const r = applyHotkey(cfg.settings.hotkey, cfg.settings.hotkeyEnabled);
      out.hotkey = r;
    }
    if ('autostart' in patch) {
      const r = applyAutostart(cfg.settings.autostart);
      if (!r.ok) out.ok = false, out.msg = r.msg;
    }
    buildTray();
    return out;
  });

  ipcMain.handle('ql:win', (_e, cmd) => {
    if (!win) return { ok: false };
    if (cmd === 'minimize') win.minimize();
    else if (cmd === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (cmd === 'close') win.close();
    else if (cmd === 'toggle') toggleWindow();
    return { ok: true, maximized: win.isMaximized() };
  });

  ipcMain.handle('ql:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    packaged: app.isPackaged,
    form: appForm(),                      // dev / portable / installed / green
    exePath: launcherExePath(),
    configFile: store.configFile(),
    configDir: store.configDir(),
    dataDir: dataLocation.dir,             // 数据实际落点
    dataInProgramDir: dataLocation.inProgramDir,
    dataNote: dataLocation.note,
    autostart: autostartState(),
    hotkeyFail,
    hotkeys: globalShortcut.isRegistered(store.load().settings.hotkey || ''),
  }));

  ipcMain.handle('ql:open-config-dir', () => shell.openPath(store.configDir()));
  ipcMain.handle('ql:open-external', (_e, url) => shell.openExternal(url));
  ipcMain.handle('ql:quit', () => { quitApp(); return { ok: true }; });
  ipcMain.handle('ql:hide', () => { if (win) win.hide(); return { ok: true }; });

  /* 右键菜单 */
  ipcMain.handle('ql:card-menu', (evt, item) => {
    if (MENU_PROBE) return probeMenu('card', item, menus.cardMenuTemplate(item || {}));
    return popupMenu(evt, menus.cardMenuTemplate(item || {}));
  });
  ipcMain.handle('ql:group-menu', (evt, info) => {
    if (MENU_PROBE) return probeMenu('group', info, menus.groupMenuTemplate(info || {}));
    return popupMenu(evt, menus.groupMenuTemplate(info || {}));
  });
  ipcMain.handle('ql:blank-menu', evt => {
    if (MENU_PROBE) return probeMenu('blank', null, menus.blankMenuTemplate());
    return popupMenu(evt, menus.blankMenuTemplate());
  });

  ipcMain.handle('ql:edit-menu', evt => {
    const wc = evt.sender;
    Menu.buildFromTemplate([
      { label: '剪切', role: 'cut' },
      { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' },
      { type: 'separator' },
      { label: '全选', role: 'selectAll' },
    ]).popup({ window: BrowserWindow.fromWebContents(wc) || undefined });
    return { ok: true };
  });

  ipcMain.handle('ql:clipboard', (_e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  });
}

function quitApp() {
  quitting = true;
  globalShortcut.unregisterAll();
  try { if (tray) tray.destroy(); } catch { /* noop */ }
  app.quit();
}

/* ---------------------------------------------------- 生命周期 */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    store.init();
    registerIpc();
    createWindow();
    createTray();

    const cfg = store.load();
    if (cfg.settings.hotkeyEnabled) {
      const r = applyHotkey(cfg.settings.hotkey, true);
      if (!r.ok) console.warn('[hotkey]', r.msg);
    }
    // 便携版首次运行：如配置里标记了自启，确保注册项指向当前 exe
    if (cfg.settings.autostart) applyAutostart(true);

    app.on('activate', () => showWindow());
  });

  app.on('window-all-closed', () => {
    // 托盘常驻，不随窗口关闭退出
    if (quitting) app.quit();
  });

  app.on('before-quit', () => { quitting = true; });
}

process.on('uncaughtException', e => console.error('[main] 未捕获异常:', e));

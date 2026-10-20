'use strict';
/**
 * 配置存储：读写 userData/config.json
 * 首次运行会尝试从 exe 同级目录或开发目录导入已有 config.json。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const resolveLib = require('./resolve');

const PALETTE = ['#3b6cf6', '#7c5cff', '#12b886', '#ff8a3d',
  '#f2506e', '#14b8c4', '#f0b429', '#8b8f9a'];

let configPath = null;

function expandEnv(p) {
  if (!p) return '';
  let s = String(p);
  if (s.startsWith('~')) s = path.join(app.getPath('home'), s.slice(1));
  s = s.replace(/%([^%]+)%/g, (m, name) => {
    const v = process.env[name] || process.env[name.toUpperCase()];
    return v === undefined ? m : v;
  });
  return s;
}

function pathExists(p) {
  if (!p) return false;
  const s = expandEnv(p);
  if (/^https?:\/\//i.test(s)) return true;
  // 裸命令名（powershell.exe / python.exe / wt.exe）只存在于 PATH 里，
  // 以前只查 System32 与 SystemRoot，于是卡片把一堆装好的程序标成「路径不存在」。
  return resolveLib.exists(s);
}

const SHELL_EXT = ['.msc', '.cpl', '.appref-ms', '.url', '.lnk'];

function itemOk(item) {
  const type = item.type || 'app';
  // 网址没有本地文件；命令是**一整行 shell 语句**，本来就没有"路径"可查。
  // 这里必须与 keep() 的保留条件保持一致，否则「本机磁盘」这种
  // `explorer.exe "shell:MyComputerFolder"` 会被标成「路径不存在」。
  if (type === 'url' || type === 'cmd') return true;
  const p = expandEnv((item.path || '').trim());
  if (!p) return false;
  if (pathExists(p)) return true;
  const low = p.toLowerCase();
  if (SHELL_EXT.some(e => low.endsWith(e))) return true;
  return false;
}

function uid() { return crypto.randomBytes(4).toString('hex'); }

function newItem(name, icon, type, p, extra = {}) {
  return Object.assign({
    id: uid(), name, icon, type, path: p,
    args: '', cwd: '', desc: '', elevate: false, console: false,
    favorite: false, useCount: 0, lastUsed: 0, createdAt: Math.floor(Date.now() / 1000),
  }, extra);
}

function keep(list) {
  return list.filter(i => pathExists(i.path) || (i.type === 'url' || i.type === 'cmd'));
}

function dedupeName(list) {
  const seen = new Set();
  return list.filter(i => {
    const k = i.name + '|' + i.type;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function buildGroups() {
  const home = app.getPath('home');
  const VSC = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe')];

  let groups = [
    {
      id: 'files', name: '文件与目录', icon: '📁', color: PALETTE[0],
      items: keep([
        newItem('下载', '📥', 'folder', path.join(home, 'Downloads'), { desc: 'Downloads' }),
        newItem('桌面', '🗂️', 'folder', path.join(home, 'Desktop'), { desc: 'Desktop' }),
        newItem('文档', '📄', 'folder', path.join(home, 'Documents'), { desc: 'Documents' }),
        newItem('工作区', '🧰', 'folder', 'D:\\WorkBuddy', { desc: 'D:\\WorkBuddy' }),
        newItem('本机磁盘', '💽', 'cmd', 'explorer.exe "shell:MyComputerFolder"', { desc: '资源管理器 · 此电脑' }),
      ]),
    },
    {
      id: 'tools', name: '系统工具', icon: '🛠️', color: PALETTE[2],
      items: keep([
        newItem('任务管理器', '📊', 'app', 'taskmgr.exe'),
        newItem('服务', '🔧', 'app', 'services.msc'),
        newItem('设备管理器', '🖨️', 'app', 'devmgmt.msc'),
        newItem('注册表编辑器', '🗝️', 'app', 'regedit.exe'),
        newItem('计算器', '🧮', 'app', 'calc.exe'),
        newItem('记事本', '📝', 'app', 'notepad.exe'),
        newItem('终端', '🖥️', 'app', 'wt.exe'),
        newItem('控制面板', '🎛️', 'cmd', 'control.exe', { desc: 'Control Panel' }),
      ]),
    },
    {
      id: 'dev', name: '开发', icon: '💻', color: PALETTE[1],
      items: keep([
        newItem('VS Code', '💻', 'app', VSC[0]),
        newItem('PowerShell', '⚡', 'app', 'powershell.exe'),
        newItem('命令提示符', '▪️', 'app', 'cmd.exe'),
        newItem('Python', '🐍', 'app', 'python.exe'),
        newItem('Git Bash', '🐙', 'app', 'C:\\Program Files\\Git\\git-bash.exe'),
      ]),
    },
    {
      // 顺序有讲究：Google 第一、百度第二（用户明确要求）。
      // 已有配置不会因为改了这里就自动重排 —— 见下面的 WEB_TOP / ensureWebOrder()。
      id: 'web', name: '常用网站', icon: '🌐', color: PALETTE[5],
      items: [
        newItem('Google', '🔍', 'url', 'https://www.google.com/', { desc: 'google.com' }),
        newItem('百度', '🐾', 'url', 'https://www.baidu.com/', { desc: 'baidu.com' }),
        newItem('GitHub', '🐙', 'url', 'https://github.com/qzrsa', { desc: 'github.com' }),
        newItem('阿里云控制台', '☁️', 'url', 'https://ecs.console.aliyun.com/', { desc: 'ecs.console.aliyun.com' }),
        newItem('腾讯云 EdgeOne', '🌀', 'url', 'https://console.cloud.tencent.com/edgeone', { desc: 'console.cloud.tencent.com' }),
        newItem('WorkBuddy 文档', '📘', 'url', 'https://www.workbuddy.cn/docs/workbuddy/Overview', { desc: 'workbuddy.cn/docs' }),
      ],
    },
  ];

  groups = groups.map(g => Object.assign({}, g, { items: dedupeName(g.items) }))
    .filter(g => g.items.length);
  return groups;
}

function defaultConfig() {
  return {
    version: 2,
    settings: {
      theme: 'light',
      sort: 'custom',
      // Alt+Space 常被系统/输入法/其他工具占用（本机实测被占），
      // 默认改用 Ctrl+Alt+Space：冲突概率低，且单手可及。
      hotkey: 'Ctrl+Alt+Space',
      hotkeyEnabled: true,
      autostart: false,
      closeAction: 'tray',
      trayQuick: 'top',
      hoverActions: false,
      // 界面动画开关：卡片入场 pop、toast 滑入滑出、分组 rise 等装饰性动画。
      // 关闭后这些效果都不播（transition 即时反馈保留），界面更"实"、拖动完不再闪。
      animations: true,
      // 启动时停在哪个分组：
      //   'last' = 记住上次打开的那个（默认，避免每次都被踢回「全部」）
      //   'all' / 'recent' / 'fav' = 固定虚拟视图
      //   'g:<分组id>' = 固定到某个真实分组
      // lastGroup 只在 startGroup==='last' 时有意义，但一直跟着写，
      // 这样用户切回「记住上次」时立刻就是上次的位置。
      startGroup: 'last',
      lastGroup: 'all',
      // 启动时静默检查一次更新。**默认开**，且只在启动时查这一次 ——
      // 不轮询、不常驻、不后台盯着；查到也不自动下载，动手永远等用户点。
      autoUpdate: true,
      // 更新源。留空 = GitHub Release 的 latest/download。
      // 允许改成镜像/代理：本机实测国内直连 GitHub 资产常断流，
      // 而"更新器只能用某个镜像"是最容易被忽略的失败原因，所以做成显式配置项。
      updateBase: '',
      // 上一次已经弹过提示的更新结果（形如 `applied|1.2.0|<时间>`）。
      // 靠它让"更新成功/失败"的提示**只出现一次**，跨重启也不会重复。
      lastUpdateNotice: '',
      // 图标提取逻辑的版本号（和 renderer 的 ICON_REV 对齐）。升级后老数据会自动补一次：
      //  rev 2：`<=1.3.1` 给 `.lnk` 提的是通用占位图（不追目标）
      //  rev 3：`<=1.4.3` 给 `.url` 一律写 🌐
      //  rev 4：`<=1.4.4` 的 `.exe` 走 app.getFileIcon，成片是同一张"窗口+蓝块"
      iconRev: 1,
    },
    groups: buildGroups(),
  };
}

function candidateConfigFiles() {
  const out = [];
  const dirs = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) dirs.push(process.env.PORTABLE_EXECUTABLE_DIR);
  try { dirs.push(path.dirname(app.getPath('exe'))); } catch { /* noop */ }
  dirs.push(path.resolve(__dirname, '..', '..', '..'));  // desktop/src/lib -> 项目根
  for (const d of dirs) out.push(path.join(d, 'config.json'));
  return out;
}

function init() {
  configPath = path.join(app.getPath('userData'), 'config.json');

  if (!fs.existsSync(configPath)) {
    // 尝试导入既有的 config.json（旧 Web 版 / 便携版同级目录）
    for (const c of candidateConfigFiles()) {
      try {
        if (!fs.existsSync(c) || path.resolve(c) === path.resolve(configPath)) continue;
        const raw = JSON.parse(fs.readFileSync(c, 'utf8'));
        if (raw && Array.isArray(raw.groups)) {
          const merged = Object.assign(defaultConfig(), raw);
          merged.settings = Object.assign(defaultConfig().settings, raw.settings || {});
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8');
          console.log('[store] 已导入既有配置:', c);
          break;
        }
      } catch { /* 忽略，继续下一个候选 */ }
    }
  }
  if (!fs.existsSync(configPath)) save(defaultConfig());
  return configPath;
}

function load() {
  if (!configPath) init();
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!cfg || !Array.isArray(cfg.groups)) throw new Error('结构不正确');
    cfg.settings = Object.assign(defaultConfig().settings, cfg.settings || {});
    // 补齐旧版本缺失字段
    cfg.groups.forEach(g => (g.items || []).forEach(i => {
      if (typeof i.favorite !== 'boolean') i.favorite = false;
      if (typeof i.useCount !== 'number') i.useCount = 0;
      if (typeof i.lastUsed !== 'number') i.lastUsed = 0;
    }));
    return cfg;
  } catch (e) {
    try {
      const bak = configPath.replace(/\.json$/, `.broken.${Date.now()}.json`);
      fs.copyFileSync(configPath, bak);
      console.error('[store] 配置损坏，已备份到', bak, e.message);
    } catch { /* noop */ }
    const cfg = defaultConfig();
    save(cfg);
    return cfg;
  }
}

function save(cfg) {
  if (!configPath) init();
  const tmp = configPath + '.tmp';
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, configPath);
  return true;
}

function annotate(cfg) {
  cfg.groups.forEach(g => (g.items || []).forEach(i => {
    try { i._exists = itemOk(i); } catch { i._exists = true; }
  }));
  return cfg;
}

/** 按 id 找分组，没有就以给定外观创建（用于「拖入的快捷方式」这类按需分组） */
function ensureGroup(cfg, id, name, icon, colorIdx = 4) {
  let g = (cfg.groups || []).find(x => x.id === id);
  if (!g) {
    g = { id, name, icon, color: PALETTE[colorIdx % PALETTE.length], items: [] };
    cfg.groups.push(g);
  }
  if (!Array.isArray(g.items)) g.items = [];
  return g;
}

function configDir() { return configPath ? path.dirname(configPath) : app.getPath('userData'); }
function configFile() { return configPath || init(); }

/** 判断"同一个启动项"的指纹：类型 + 路径（大小写不敏感）。改过名字也算同一项。 */
function itemKey(i) {
  return `${(i && i.type) || 'app'}|${String((i && i.path) || '').toLowerCase()}`;
}

/**
 * 恢复默认分组 / 默认启动项 —— **只补不删**，幂等。
 *
 * 用途：用户「全选 → 删除」把「文件与目录 / 系统工具 / 开发 / 常用网站」误删之后，
 * 一键把它们找回来。刻意不做"清空重来"：那会把用户自己建的分组、改过的名字、
 * 挑过的图标、收藏与使用次数一起冲掉 —— 恢复应该是加法，不是重置。
 *
 * 规则：
 *  - 分组 id 已存在 → 只补它缺的默认项，追加到**末尾**（按 type|path 去重，改过名也不重复）
 *  - 分组不存在 → 整组追加到**末尾**（不打乱用户自己的分组顺序）
 *  - 用户自建的分组、自己加的项、所有设置，一律不碰
 *  - `dropped` / `scanned` 这类"按需生成"的分组不在默认里，不会被凭空造出来
 *
 * @returns {{groupsAdded:number, itemsAdded:number, groups:string[]}}
 */
function restoreDefaults(cfg) {
  const out = { groupsAdded: 0, itemsAdded: 0, groups: [] };
  if (!cfg || !Array.isArray(cfg.groups)) return out;

  for (const d of buildGroups()) {
    let g = cfg.groups.find(x => x && x.id === d.id);
    if (!g) {
      g = {
        id: d.id, name: d.name, icon: d.icon, color: d.color,
        items: (d.items || []).map(i => Object.assign({}, i)),
      };
      cfg.groups.push(g);
      out.groupsAdded++;
      out.itemsAdded += g.items.length;
      out.groups.push(`${g.name}（+${g.items.length}）`);
      continue;
    }
    if (!Array.isArray(g.items)) g.items = [];
    const have = new Set(g.items.map(itemKey));
    let n = 0;
    for (const di of (d.items || [])) {
      const k = itemKey(di);
      if (have.has(k)) continue;
      g.items.push(Object.assign({}, di));
      have.add(k);
      n++;
    }
    if (n) {
      out.itemsAdded += n;
      out.groups.push(`${g.name}（+${n}）`);
    }
  }
  return out;
}

/* ---------------------------------------------- 常用网站：前两项固定 */

/**
 * 「常用网站」第一项 = Google、第二项 = 百度。
 *
 * ★ 光改 `buildGroups()` 只对新装生效 —— 配置一旦落盘就再也不看默认值了，
 *   老用户永远是当初那套顺序（GitHub / 阿里云在最前）。所以这里补一次
 *   **一次性修正**，开关是 `settings.webOrderRev`：
 *    - 已有的 Google / 百度 → **移**到最前两位（不重新造，收藏与使用次数都留着）
 *    - 没有 → 补在第一位 / 第二位
 *    - 认项**按网址域名**，不按名字：用户把「百度」改名成「搜中文」也认得出
 *    - 其余项（含用户自建的）保持原来的相对顺序，一个都不删
 *    - 只跑一次；跑完置 rev，之后用户自己怎么排都不再干预
 */
const WEB_ORDER_REV = 1;

/** 取网址的 host（小写、去 www、去端口）。不是 http(s) 开头的返回 ''。 */
function hostOf(p) {
  const m = String(p || '').trim().match(/^[a-z]+:\/\/([^/?#]+)/i);
  if (!m) return '';
  return m[1].toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
}

const WEB_TOP = [
  { name: 'Google', icon: '🔍', path: 'https://www.google.com/', desc: 'google.com',
    test: h => /^google\.[a-z.]+$/.test(h) },
  { name: '百度', icon: '🐾', path: 'https://www.baidu.com/', desc: 'baidu.com',
    test: h => /^baidu\.com$/.test(h) },
];

/**
 * @returns {{changed:boolean, added:number, moved:number, note:string}}
 *   changed=true 表示 cfg 被改动过（含仅仅置了 rev），调用方据此决定要不要写盘。
 */
function ensureWebOrder(cfg) {
  const out = { changed: false, added: 0, moved: 0, note: '' };
  if (!cfg || typeof cfg !== 'object') return out;
  if (!cfg.settings || typeof cfg.settings !== 'object') cfg.settings = {};

  // 修正过就再也不动它 —— 之后是用户自己的顺序
  if (Number(cfg.settings.webOrderRev || 0) >= WEB_ORDER_REV) return out;

  cfg.settings.webOrderRev = WEB_ORDER_REV;
  out.changed = true;

  const g = Array.isArray(cfg.groups) ? cfg.groups.find(x => x && x.id === 'web') : null;
  if (!g || !Array.isArray(g.items)) {
    // 分组被删掉 / 还没建：只打标记。恢复默认时会按新顺序整组补回来
    out.note = '没有「常用网站」分组，只记标记';
    return out;
  }

  const posBefore = new Map();
  g.items.forEach((i, n) => { if (i) posBefore.set(i, n); });

  const rest = g.items.slice();
  const head = [];
  for (const t of WEB_TOP) {
    const idx = rest.findIndex(i => i && i.type === 'url' && t.test(hostOf(i.path)));
    if (idx >= 0) head.push(rest.splice(idx, 1)[0]);
    else { head.push(newItem(t.name, t.icon, 'url', t.path, { desc: t.desc })); out.added++; }
  }
  // 已有项里真的被挪了位置的有几个（只用于日志，别拿它当"变没变"的判据）
  head.forEach((i, n) => { if (posBefore.has(i) && posBefore.get(i) !== n) out.moved++; });

  g.items = head.concat(rest);
  out.note = `新增 ${out.added} 项、挪动 ${out.moved} 项`;
  return out;
}

module.exports = {
  init, load, save, annotate, defaultConfig, buildGroups, ensureGroup, restoreDefaults,
  ensureWebOrder, WEB_TOP, hostOf, WEB_ORDER_REV,
  expandEnv, pathExists, itemOk, uid, newItem,
  configDir, configFile, PALETTE,
};

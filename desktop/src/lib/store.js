'use strict';
/**
 * 配置存储：读写 userData/config.json
 * 首次运行会尝试从 exe 同级目录或开发目录导入已有 config.json。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

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
  const candidates = [s];
  // 裸命令名：交给 PATH 与系统关联判断
  if (!path.isAbsolute(s) && !s.includes(path.sep)) {
    candidates.push(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', s));
    candidates.push(path.join(process.env.SystemRoot || 'C:\\Windows', s));
  }
  return candidates.some(c => { try { return fs.existsSync(c); } catch { return false; } });
}

const SHELL_EXT = ['.msc', '.cpl', '.appref-ms', '.url', '.lnk'];

function itemOk(item) {
  const p = expandEnv((item.path || '').trim());
  if (!p) return false;
  if ((item.type || 'app') === 'url') return true;
  if (pathExists(p)) return true;
  const low = p.toLowerCase();
  if (SHELL_EXT.some(e => low.endsWith(e))) return true;
  if (!p.includes(path.sep) && !path.basename(p).includes('.')) return true;
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
      id: 'web', name: '常用网站', icon: '🌐', color: PALETTE[5],
      items: [
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
      // 图标提取逻辑的版本号。<=1.3.1 给 `.lnk` 提的是通用占位图（不追目标），
      // 升到 2 之后老数据会自动补一次（见 renderer 的 reextractIcons）。
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

module.exports = {
  init, load, save, annotate, defaultConfig, ensureGroup,
  expandEnv, pathExists, itemOk, uid, newItem,
  configDir, configFile, PALETTE,
};

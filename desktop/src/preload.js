'use strict';
/** 渲染进程 ↔ 主进程 的安全桥（contextIsolation，无 nodeIntegration） */

const { contextBridge, ipcRenderer } = require('electron');

// webUtils 用来把拖入的 File 对象换成真实磁盘路径
// （Electron 32 起已移除 File.path，必须走这个 API）
let webUtils = null;
try { webUtils = require('electron').webUtils; } catch { /* 老版本或沙箱禁用时降级 */ }

// ★ 主进程 webContents.send 的**每一个**频道都必须在这里登记，否则 API.on 会静默
//   返回一个空函数：探针看起来"跑了"，其实渲染层一个字都没收到（perf-probe 栽过）。
//   smoke.js 有一条断言会拿 main.js 里所有 send('ql:…') 跟这张表逐一对账。
const EVENTS = ['ql:win-state', 'ql:focus-search', 'ql:config-changed', 'ql:settings-changed', 'ql:menu-probe', 'ql:import-probe', 'ql:import-progress', 'ql:drag-probe', 'ql:group-probe', 'ql:info-probe', 'ql:rail-probe', 'ql:select-probe', 'ql:second-instance', 'ql:second-probe', 'ql:update-state', 'ql:update-available', 'ql:update-probe', 'ql:perf-probe'];

contextBridge.exposeInMainWorld('ql', {
  /* 配置 */
  getConfig: () => ipcRenderer.invoke('ql:config:get'),
  saveConfig: cfg => ipcRenderer.invoke('ql:config:save', cfg),
  restoreDefaults: () => ipcRenderer.invoke('ql:config:restore-defaults'),

  /* 动作 */
  run: item => ipcRenderer.invoke('ql:run', item),
  openFolder: p => ipcRenderer.invoke('ql:folder', p),
  pick: kind => ipcRenderer.invoke('ql:pick', kind),
  scan: force => ipcRenderer.invoke('ql:scan', force),
  iconDefault: p => ipcRenderer.invoke('ql:icon:default', p),
  // 网址 / 协议链接（steam://）的图标：主进程拿 URL 去桌面/开始菜单里找同 URL 的
  // `.url`，读它 IconFile 指的图（getFileIcon 对 .url 只回通用图标，见 lib/urlshortcut.js）
  iconUrl: p => ipcRenderer.invoke('ql:icon:url', p),
  // `.url` 网址项自愈（修被套错的协议 + 补 IconFile 图标）。逻辑全在主进程，
  // 渲染层只叫一声 —— 要读盘、要 nativeImage，而且「修协议」的正则只该有一份。
  healUrls: () => ipcRenderer.invoke('ql:heal:urls'),
  iconPick: () => ipcRenderer.invoke('ql:icon:pick'),

  /* 设置 */
  setSettings: patch => ipcRenderer.invoke('ql:settings:set', patch),

  /* 拖入导入 */
  pathForFile: file => {
    try { return (webUtils && webUtils.getPathForFile(file)) || ''; }
    catch { return ''; }
  },
  importDropped: payload => ipcRenderer.invoke('ql:import', payload),
  canResolvePath: !!webUtils,

  /* dev 自检：由渲染层在"准确的时刻"触发截图（主进程定时器会被节流/漂移，不可靠） */
  probeShot: name => ipcRenderer.invoke('ql:probe-shot', name),

  /* 右键菜单 */
  cardMenu: item => ipcRenderer.invoke('ql:card-menu', item),
  groupMenu: info => ipcRenderer.invoke('ql:group-menu', info),
  blankMenu: () => ipcRenderer.invoke('ql:blank-menu'),
  editMenu: () => ipcRenderer.invoke('ql:edit-menu'),
  copyText: text => ipcRenderer.invoke('ql:clipboard', text),

  /* 窗口 */
  win: cmd => ipcRenderer.invoke('ql:win', cmd),
  hide: () => ipcRenderer.invoke('ql:hide'),

  /* 环境 */
  info: () => ipcRenderer.invoke('ql:info'),
  openConfigDir: () => ipcRenderer.invoke('ql:open-config-dir'),
  openExternal: url => ipcRenderer.invoke('ql:open-external', url),
  quit: () => ipcRenderer.invoke('ql:quit'),

  /* 自更新（state 只读；check/download 不动本机；只有 apply 会动手并退出） */
  updateState: () => ipcRenderer.invoke('ql:update:state'),
  updateCheck: () => ipcRenderer.invoke('ql:update:check'),
  updateDownload: () => ipcRenderer.invoke('ql:update:download'),
  updateApply: () => ipcRenderer.invoke('ql:update:apply'),

  /* 事件订阅（白名单） */
  on: (channel, cb) => {
    if (!EVENTS.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});

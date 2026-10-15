'use strict';
/** 渲染进程 ↔ 主进程 的安全桥（contextIsolation，无 nodeIntegration） */

const { contextBridge, ipcRenderer } = require('electron');

// webUtils 用来把拖入的 File 对象换成真实磁盘路径
// （Electron 32 起已移除 File.path，必须走这个 API）
let webUtils = null;
try { webUtils = require('electron').webUtils; } catch { /* 老版本或沙箱禁用时降级 */ }

const EVENTS = ['ql:win-state', 'ql:focus-search', 'ql:config-changed', 'ql:settings-changed', 'ql:menu-probe', 'ql:import-probe', 'ql:drag-probe', 'ql:group-probe', 'ql:info-probe'];

contextBridge.exposeInMainWorld('ql', {
  /* 配置 */
  getConfig: () => ipcRenderer.invoke('ql:config:get'),
  saveConfig: cfg => ipcRenderer.invoke('ql:config:save', cfg),

  /* 动作 */
  run: item => ipcRenderer.invoke('ql:run', item),
  openFolder: p => ipcRenderer.invoke('ql:folder', p),
  pick: kind => ipcRenderer.invoke('ql:pick', kind),
  scan: force => ipcRenderer.invoke('ql:scan', force),

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

  /* 事件订阅（白名单） */
  on: (channel, cb) => {
    if (!EVENTS.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});

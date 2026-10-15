'use strict';
/**
 * 原生右键菜单模板（纯数据，不依赖 electron，便于单测）。
 * click 返回「动作名」字符串，由主进程 popupMenu 回传给渲染层执行。
 *
 * 卡片动作： launch | elevate | folder | copy | fav | edit | del
 * 分组动作： new | newgroup | rename | color:#rrggbb | del
 * 空白动作： new | newgroup | scan | settings
 */

const DEFAULT_COLORS = [
  { name: '蓝', value: '#3b6cf6' }, { name: '紫', value: '#7c5cff' },
  { name: '绿', value: '#12b886' }, { name: '橙', value: '#ff8a3d' },
  { name: '红', value: '#f2506e' }, { name: '青', value: '#14b8c4' },
  { name: '黄', value: '#f0b429' }, { name: '灰', value: '#8b8f9a' },
];

function cardMenuTemplate(item) {
  const t = (item && item.type) || 'app';
  const p = String((item && item.path) || '');
  const isUrl = t === 'url';
  const canFolder = !isUrl && !!p && !/^https?:/i.test(p) && t !== 'cmd';
  const canElevate = !isUrl && ['app', 'cmd', 'script'].includes(t);
  const missing = item && item._exists === false;

  const tpl = [{ label: missing ? '启动（路径可能不存在）' : '启动', click: () => 'launch' }];
  if (canElevate) tpl.push({ label: '以管理员身份运行', click: () => 'elevate' });
  tpl.push({ type: 'separator' });
  if (canFolder) tpl.push({ label: '打开所在位置', click: () => 'folder' });
  tpl.push({ label: '复制路径', click: () => 'copy' });
  tpl.push({ label: (item && item.favorite) ? '取消收藏' : '加入收藏', click: () => 'fav' });
  tpl.push({ label: '编辑…', click: () => 'edit' });
  tpl.push({ type: 'separator' });
  tpl.push({ label: '删除', click: () => 'del' });
  return tpl;
}

function groupMenuTemplate(info) {
  info = info || {};
  const colors = Array.isArray(info.colors) && info.colors.length ? info.colors : DEFAULT_COLORS;
  return [
    { label: `${info.icon || '📦'}  ${info.name || '分组'}`, enabled: false },
    { type: 'separator' },
    { label: '在此分组新建启动项', click: () => 'new' },
    { type: 'separator' },
    { label: '新建分组…', click: () => 'newgroup' },
    { label: '重命名分组…', click: () => 'rename' },
    {
      label: '更换颜色',
      submenu: colors.map(c => ({
        label: c.name,
        type: 'radio',
        checked: c.value === info.color,
        click: () => 'color:' + c.value,
      })),
    },
    { type: 'separator' },
    { label: `删除分组（含 ${info.count || 0} 项）`, click: () => 'del' },
  ];
}

function blankMenuTemplate() {
  return [
    { label: '新建启动项', click: () => 'new' },
    { label: '新建分组…', click: () => 'newgroup' },
    { type: 'separator' },
    { label: '扫描本机软件…', click: () => 'scan' },
    { type: 'separator' },
    { label: '设置…', click: () => 'settings' },
  ];
}

module.exports = { cardMenuTemplate, groupMenuTemplate, blankMenuTemplate, DEFAULT_COLORS };

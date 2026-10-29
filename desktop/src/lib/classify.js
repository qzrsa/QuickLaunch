'use strict';
/**
 * 智能分类引擎（纯函数，零 electron 依赖，方便单测）。
 *
 * 设计原则：**宁可落桶，也不分错**。只认确定性信号，拿不准一律返回 null（落「拖入的快捷方式」）。
 *
 * 判定顺序（越靠前越确定，命中即返回）：
 *   1. 类型规则 —— url→常用网站、folder→文件与目录、script→开发（这仨和路径无关，100% 确定）
 *   2. 系统目录 —— 路径在 System32 / SystemApps 下，或 .msc / .cpl（确定性信号）
 *   3. 关键词表 —— 云端 classify.json 的软件类别（游戏/设计/办公/媒体/社交…），按数组顺序匹配
 *   4. 兜底 —— null（不猜）
 *
 * 关键词表（rules）结构：`{ version, rules: [{ group, icon, match: string[] }] }`。
 * group 是「目标分组名」—— 调用方按名字去找现有分组（含默认组）或新建。
 * 这样默认组「系统工具 / 开发」也能被关键词表命中时复用，而不是另起一个同名的组。
 */

const path = require('path');

/* 内置兜底表：打包进程序，离线永远可用。云端 classify.json 是它的超集/更新版。
   关键词一律小写、按**路径子串**匹配（不是文件名），写目录级特征最稳。 */
const BUILTIN_RULES = [
  { group: '游戏', icon: '🎮', match: ['\\steam\\', 'steamapps', 'epic games', 'wegame', 'ubisoft', 'riot games', 'battlenet', 'gog galaxy', 'origin games', '\\games\\', '\\game\\'] },
  { group: '设计', icon: '🎨', match: ['adobe', 'autodesk', 'corel', 'affinity', 'blender foundation', 'figma', 'sketchup'] },
  { group: '办公', icon: '📝', match: ['microsoft office', 'wps office', 'libreoffice', 'kingsoft', 'onenote', 'notion', 'typora'] },
  { group: '开发', icon: '💻', match: ['nodejs', '\\python', 'python3', '\\git\\', 'visual studio', 'vs code', 'jetbrains', 'android studio', 'goland', 'pycharm', 'intellij', 'eclipse', '\\mingw', '\\go\\', '\\rust\\', '\\java\\', 'sublime text', '\\vim\\', 'neovim', '\\npm\\'] },
  { group: '媒体', icon: '🎬', match: ['potplayer', 'vlc', 'obs studio', 'spotify', 'foobar2000', 'mpc-hc', 'k-lite', '\\mpv\\', '\\obs\\'] },
  { group: '社交', icon: '💬', match: ['wechat', '\\qq\\', 'tencent', 'telegram', 'discord', 'dingtalk', 'feishu', 'lark', '\\wecom\\'] },
];

/* 类型规则命中的目标组名（必须与 store.buildGroups 的默认组名一字不差） */
const TYPE_GROUP = {
  url: { name: '常用网站', icon: '🌐' },
  folder: { name: '文件与目录', icon: '📁' },
  script: { name: '开发', icon: '💻' },
};

const SYS_GROUP = { name: '系统工具', icon: '🛠️' };

/** 校验并解析云端分类表。结构不对返回 null（调用方退回缓存/内置表）。 */
function parseRules(jsonText) {
  try {
    const o = JSON.parse(String(jsonText || ''));
    if (!o || typeof o !== 'object') return null;
    if (!Array.isArray(o.rules)) return null;
    const rules = [];
    for (const r of o.rules) {
      if (!r || typeof r.group !== 'string' || !r.group.trim()) return null;
      if (!Array.isArray(r.match)) return null;
      const match = r.match
        .map(k => String(k).trim().toLowerCase())
        .filter(Boolean);
      if (!match.length) return null;
      rules.push({ group: r.group.trim(), icon: String(r.icon || '📦'), match });
    }
    if (!rules.length) return null;
    return { version: Number(o.version) || 0, rules };
  } catch {
    return null;
  }
}

/** 内置表 → 与云端表同构（parseRules 已归一化，这里直接返回一份干净的副本）。 */
function builtinRules() {
  return parseRules(JSON.stringify({ version: 0, rules: BUILTIN_RULES }));
}

/**
 * 给一个启动项判分类。
 * @param {{type?:string, path?:string}} item  只需要 type / path
 * @param {{rules:Array}} rules                已 parseRules 过的规则表
 * @returns {{name:string, icon:string}|null}  目标分组名（+图标）；null = 不猜，落桶
 */
function classifyItem(item, rules) {
  if (!item) return null;
  const type = item.type || 'app';

  // 1) 类型规则：与路径无关，最确定
  if (TYPE_GROUP[type]) return TYPE_GROUP[type];

  const raw = String(item.path || '').trim();
  if (!raw) return null;
  // 含环境变量没展开的路径，不猜（展开后再跑一次才是真路径）
  if (raw.includes('%')) return null;
  // 归一化分隔符 + 小写，后续匹配统一用 /
  const p = raw.replace(/\\/g, '/').toLowerCase();

  // 2) 系统目录 / 管理单元
  if (/\.(msc|cpl)$/.test(p) || p.includes('/system32/') || p.includes('/windows/systemapps/')) {
    return SYS_GROUP;
  }

  // 3) 关键词表（顺序即优先级，命中第一个就停）
  const list = (rules && Array.isArray(rules.rules)) ? rules.rules : [];
  for (const r of list) {
    if (!r || !Array.isArray(r.match)) continue;
    if (r.match.some(k => matchPath(p, k))) return { name: r.group, icon: r.icon || '📦' };
  }

  return null;
}

/** 归一化路径分隔符后做子串匹配（测试与关键词都容忍 / 与 \ 混写）。 */
function matchPath(p, keyword) {
  const a = String(p || '').replace(/\\/g, '/').toLowerCase();
  const b = String(keyword || '').replace(/\\/g, '/').toLowerCase();
  return a.includes(b);
}

/**
 * 计算「一键整理」要移动的项（纯函数，落地由调用方做）。
 * @param {Array} groups   [{id,name,items:[{id,name,type,path}],auto?}]
 * @param {object} rules   parseRules 结果
 * @param {string[]} [defaultIds]  默认组的 id 集合（这些组 + auto 组 = 可整理）
 * @returns {{itemId:string,name:string,fromGid:string,fromGname:string,toName:string,toIcon:string}[]}
 * 规则：
 *  - 自定义组（非默认 id、无 auto 标记）里的项一律不碰 —— 尊重用户手动摆放
 *  - 拿不准（classifyItem 返回 null）的项不动
 *  - 已经在正确组（组名 == 目标组名）的项不动
 */
function computeMoves(groups, rules, defaultIds) {
  const defaults = new Set(defaultIds || ['files', 'tools', 'dev', 'web', 'dropped']);
  const moves = [];
  for (const g of (groups || [])) {
    if (!g || !Array.isArray(g.items)) continue;
    if (!defaults.has(g.id) && g.auto !== true) continue;   // 自定义组不碰
    for (const it of g.items) {
      const c = classifyItem(it, rules);
      if (!c) continue;
      if (c.name === g.name) continue;
      moves.push({ itemId: it.id, name: it.name, fromGid: g.id, fromGname: g.name, toName: c.name, toIcon: c.icon });
    }
  }
  return moves;
}

module.exports = {
  BUILTIN_RULES, TYPE_GROUP, SYS_GROUP,
  parseRules, builtinRules, classifyItem, matchPath, computeMoves,
};

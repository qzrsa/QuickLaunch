'use strict';
/**
 * 智能分类引擎（纯函数，零 electron 依赖，方便单测）。
 *
 * 设计原则：**宁可落桶，也不分错**。只认确定性信号，拿不准的软件（.exe）落「软件」组，
 * 其余（file 等）落「拖入的快捷方式」。
 *
 * 判定顺序（越靠前越确定，命中即返回）：
 *   1. 类型规则 —— url→网站、folder→文件与目录、script→开发（和路径无关，100% 确定）
 *   2. 开发扩展名 —— .e/.ec（易语言源文件）→ 开发
 *   3. 文档扩展名 —— txt/ini/word/pdf/xml/json/lua… → 文本文档
 *   4. 系统目录 —— System32 / SystemApps，或 .msc/.cpl → 系统工具
 *   5. 关键词表 —— 云端 classify.json 的软件类别（游戏/设计/办公/媒体/下载/AI…），按数组顺序匹配
 *   6. 兜底 —— app（.exe）→ 软件；其余 null（不猜）
 *
 * 关键词表（rules）结构：`{ version, rules: [{ group, icon, match: string[] }] }`。
 * group 是「目标分组名」—— 调用方按名字去找现有分组（含默认组）或新建。
 * 这样默认组「系统工具 / 开发」也能被关键词表命中时复用，而不是另起一个同名的组。
 */

const path = require('path');

/* 内置兜底表：打包进程序，离线永远可用。云端 classify.json 是它的超集/更新版。
   关键词一律小写、按**路径子串**匹配（不是文件名），写目录级特征最稳。
   ★ 泛化特征词（v1.8.0）：一个词覆盖一类，而不是逐个精确项目名 ——
     downloader→下载、ocr→办公、office→办公套件、mpc/mpv/ffmpeg→媒体、blender→设计 等。 */
const BUILTIN_RULES = [
  { group: '游戏', icon: '🎮', match: ['\\steam\\', 'steamapps', 'epic games', 'wegame', 'ubisoft', 'riot games', 'battlenet', 'gog galaxy', 'origin games', '\\games\\', '\\game\\'] },
  { group: '设计', icon: '🎨', match: ['adobe', 'autodesk', 'corel', 'affinity', 'blender', 'figma', 'sketchup'] },
  { group: '办公', icon: '📝', match: ['office', 'wps', 'libreoffice', 'kingsoft', 'onenote', 'notion', 'typora', 'ocr'] },
  { group: '开发', icon: '💻', match: ['nodejs', '\\python', 'python3', '\\git\\', 'visual studio', 'vs code', 'jetbrains', 'android studio', 'goland', 'pycharm', 'intellij', 'eclipse', '\\mingw', '\\go\\', '\\rust\\', '\\java\\', 'sublime text', '\\vim\\', 'neovim', '\\npm\\', 'poetry', 'hexo', 'rustscan'] },
  { group: '媒体', icon: '🎬', match: ['potplayer', 'vlc', 'obs studio', 'spotify', 'foobar2000', 'mpc', 'k-lite', 'mpv', 'ffmpeg', 'handbrake', 'video2x', '\\obs\\'] },
  { group: '下载', icon: '⬇️', match: ['\\thunder\\', 'thunder network', 'download manager', '\\idm\\', 'qbittorrent', 'bitcomet', '\\utorrent\\', 'motrix', 'aria2', 'transmission', 'deluge', 'bilidown', 'downloader', 'baidunetdisk', 'aliyundrive', '\\quark\\', 'quarkcloud', 'nutstore', '\\onedrive\\', '\\weiyun\\', '\\ecloud\\', 'dropbox', 'google drive', 'googledrive', '\\mega\\'] },
  { group: 'AI', icon: '🤖', match: ['llama', 'gpt', 'chatgpt', 'openai', 'claude', 'ollama', 'whisper', 'rvc', 'stable diffusion', 'sd-webui', 'comfyui', 'gemini'] },
  { group: '系统工具', icon: '🛠️', match: ['cleaner', 'monitor', 'scrcpy'] },
  { group: '社交', icon: '💬', match: ['wechat', '\\qq\\', 'tencent', 'telegram', 'discord', 'dingtalk', 'feishu', 'lark', '\\wecom\\'] },
];

/* 类型规则命中的目标组名（必须与 store.buildGroups 的默认组名一字不差） */
const TYPE_GROUP = {
  url: { name: '网站', icon: '🌐' },
  folder: { name: '文件与目录', icon: '📁' },
  script: { name: '开发', icon: '💻' },
};

const SYS_GROUP = { name: '系统工具', icon: '🛠️' };

/* 文档类文件：扩展名是确定性信号（和路径无关），txt/ini/word/markdown/pdf/办公表格 等归「文本文档」。
   与「系统工具」同级，都是不用猜的硬规则。 */
const DOC_GROUP = { name: '文本文档', icon: '📄' };
const DOC_EXT = [
  // 纯文本 / 标记 / 配置
  '.txt', '.ini', '.md', '.markdown', '.log',
  '.xml', '.json', '.yaml', '.yml', '.toml',
  // Word / 排版 / 电子书
  '.doc', '.docx', '.pdf', '.rtf', '.odt', '.wps', '.pages',
  '.tex', '.epub', '.mobi',
  // 表格 / 数据
  '.csv', '.tsv', '.xls', '.xlsx', '.xlsm', '.xlsb', '.ods', '.et',
  // 演示
  '.ppt', '.pptx', '.pps', '.ppsx', '.dps',
  // 脚本（用户归入文档类）
  '.lua',
];

/* 易语言源文件：.e / .ec 归「开发」（v2.0.0 起不再单独成组，用户点名合并）。
   扩展名极短但高度专属，优先于通用文档扩展名。 */
const DEV_GROUP = { name: '开发', icon: '💻' };
const DEV_EXT = ['.e', '.ec'];

/* 拿不准的软件（.exe 等 app 类型）→ 落「软件」组。v2.0.0 新增：普通软件有了明确落点，
   不用再挤「拖入的快捷方式」。 */
const SOFTWARE_GROUP = { name: '软件', icon: '🚀' };

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

  // 2) 易语言源文件（.e / .ec，扩展名高度专属，优先于通用文档）→ 开发
  if (DEV_EXT.some(ext => p.endsWith(ext))) return DEV_GROUP;

  // 3) 文档扩展名（确定性信号，和路径无关）
  if (DOC_EXT.some(ext => p.endsWith(ext))) return DOC_GROUP;

  // 4) 系统目录 / 管理单元
  if (/\.(msc|cpl)$/.test(p) || p.includes('/system32/') || p.includes('/windows/systemapps/')) {
    return SYS_GROUP;
  }

  // 5) 关键词表（顺序即优先级，命中第一个就停）
  const list = (rules && Array.isArray(rules.rules)) ? rules.rules : [];
  for (const r of list) {
    if (!r || !Array.isArray(r.match)) continue;
    if (r.match.some(k => matchPath(p, k))) return { name: r.group, icon: r.icon || '📦' };
  }

  // 6) 拿不准的软件（app 类型）→ 「软件」组；其余（file 等）仍 null 不猜
  if (type === 'app') return SOFTWARE_GROUP;

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
  const defaults = new Set(defaultIds || ['files', 'tools', 'dev', 'web', 'apps', 'dropped']);
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
  BUILTIN_RULES, TYPE_GROUP, SYS_GROUP, DOC_GROUP, DOC_EXT, DEV_GROUP, DEV_EXT, SOFTWARE_GROUP,
  parseRules, builtinRules, classifyItem, matchPath, computeMoves,
};

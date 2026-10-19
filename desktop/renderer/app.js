/* ============================================================
   快速启动 · QuickLaunch 桌面版  —  渲染层逻辑
   通过 preload 暴露的 window.ql 与主进程通信。
   在普通浏览器中打开时会自动切换到「预览模式」（内存假数据）。
   ============================================================ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const TYPE_INFO = {
  app:    { label: '应用', icon: '🚀', ph: 'C:\\Program Files\\App\\App.exe  或  notepad.exe',
            tip: '<b>应用</b>：填 .exe / .lnk / .msc 的完整路径，或直接写系统命令名（如 notepad.exe、taskmgr.exe）。' },
  folder: { label: '目录', icon: '📁', ph: 'D:\\WorkBuddy 或 %USERPROFILE%\\Downloads',
            tip: '<b>目录</b>：用资源管理器打开该文件夹，支持 %环境变量%。' },
  url:    { label: '网址', icon: '🌐', ph: 'https://github.com/',
            tip: '<b>网址</b>：用默认浏览器打开，可直接写域名。' },
  cmd:    { label: '命令', icon: '⌨️', ph: 'explorer.exe "shell:MyComputerFolder"',
            tip: '<b>命令</b>：整行交给 cmd 执行，可写管道与多条命令。' },
  script: { label: '脚本', icon: '📜', ph: 'D:\\scripts\\run.py',
            tip: '<b>脚本</b>：按扩展名自动匹配解释器 —— .py→Python、.bat/.cmd→cmd、.ps1→PowerShell、.js→Node。' },
  file:   { label: '文件', icon: '📄', ph: 'D:\\docs\\note.md',
            tip: '<b>文件</b>：用系统默认程序打开该文件。' },
};

const ICONS = ['🚀','💻','📁','🌐','🛠️','⚙️','🎮','🎵','🎬','📝','📊','📈','🔧','🧰','📦',
               '🐍','🐙','☁️','⚡','🔥','🎯','📸','💬','📧','🗂️','🖥️','🎨','🧪','🔒','⏱️',
               '⭐','🩺','🧮','📐','🛰️','🧩','🔍','🎛️','💾','🪟'];

const PALETTE = ['#3b6cf6','#7c5cff','#12b886','#ff8a3d','#f2506e','#14b8c4','#f0b429','#8b8f9a'];
const COLOR_NAMES = [
  { name: '蓝', value: '#3b6cf6' }, { name: '紫', value: '#7c5cff' },
  { name: '绿', value: '#12b886' }, { name: '橙', value: '#ff8a3d' },
  { name: '红', value: '#f2506e' }, { name: '青', value: '#14b8c4' },
  { name: '黄', value: '#f0b429' }, { name: '灰', value: '#8b8f9a' },
];

/* ★★ API / PREVIEW 必须放在 PALETTE / ICONS / COLOR_NAMES **之后**再初始化：
   预览模式下 `createMockBridge()` 会**立刻**执行，而它里面的假数据用到了 PALETTE ——
   放在文件最上面就会踩 TDZ（`Cannot access 'PALETTE' before initialization`），
   整个渲染层直接白屏。桌面版因为有 window.ql 走不到这条路，所以这个坑只在预览模式炸。 */
const API = window.ql || createMockBridge();
const PREVIEW = !!API.__mock;

const state = {
  config: null,
  active: 'all',
  q: '',
  sort: 'custom',
  editing: null,
  scan: [],
  scanPicked: new Set(),
  scanQuery: '',
  // 正在把扫描结果写进分组：期间要显示进度、禁掉「取消/导入」、锁住弹窗。
  // ★ 没有这个标记时，导入两百多项（每项都要异步提图标）要十几秒，
  //   用户会以为卡住了 —— 再点一次「导入到分组」就重复导入，点「取消」也会丢进度。
  importing: false,
  info: null,
  capturedHotkey: null,
  dlgCancel: null,
  dropGroupId: null,
  dropDryRun: false,
  importingDrop: false,   // 拖入导入进行中：再拖一次直接忽略，免得同一批导两遍
  drag: null,
  suppressClick: false,
  dragDryRun: false,
  probeMode: false,
  editMode: false,        // 多选编辑模式
  picked: new Set(),      // 编辑模式下勾选的启动项 id
  // 清理无效项：rows = 扫描结果（certain + unsure），picked 只放用户勾的 id，
  // last = 这一轮真的删掉的东西（撤销就用它，不读磁盘上的备份文件）。
  prune: { rows: [], picked: new Set(), last: null, busy: false },
  update: null,           // 自更新快照（主进程推过来的，界面只读）
};

/* ------------------------------------------------------------ 基础 */

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const uid = () => Math.random().toString(16).slice(2, 10);

/** 判断一项的图标是否为「图片型」dataURL（区别于 emoji 字符串） */
const isImageIcon = ic => typeof ic === 'string' && /^data:image\//i.test(ic);

/** 卡片/弹窗的图标 HTML：图片型 → <img>，否则按 emoji 文本渲染 */
function iconHtml(item, fallback) {
  const ic = (item && item.icon) || '';
  if (isImageIcon(ic)) return `<img class="tile-img" src="${ic}" alt="" decoding="async">`;
  return esc(ic || fallback || '');
}

/* ------------------------------------------------------- 图标自愈 */

/**
 * 旧版本（≤1.3.1）给 `.lnk` 提图标时**不追目标**，只拿到一张 32×32 的通用占位图 ——
 * 本机 232 个已安装软件里有 173 个共用同一张，界面上看着就是"图标一片空白"。
 * 提取逻辑修好之后，老数据还得补一次，但**不能见图就重提**（会冲掉用户自己挑的表情/图片）。
 *
 * 判据：同一张图被 ≥3 个程序类条目（`.lnk` / `.exe` / `.url`）共用 = 一定是系统通用图。
 * 用户自己挑的 emoji 不是图片；自己选的图片几乎不可能几十个条目共用同一张。
 * 幂等：真图标重提还是它自己，来回跑不会把数据搅乱。
 *
 * rev 3（v1.4.4）：`.url`（Steam / 游戏平台快捷方式）以前一律是 🌐，路径还被套了一层
 * `http://`。这一版补一次「修协议 + 取 IconFile 真图标」，见 healUrlItems。
 * rev 4（v1.4.5）：`app.getFileIcon` 在本机会对**大量正常程序**只回一张 32×32 通用图标
 * （成片"白板"）。改由主进程自己解 PE 资源取图标后，`.exe` 那批也要补一次 ——
 * 所以判据从"只挑 .lnk"放宽到 `.lnk / .exe / .url`。
 */
const ICON_REV = 4;

/** 会被"通用图标"污染的路径类型：快捷方式 / 可执行文件 / 网址快捷方式 */
const GENERIC_ICON_PATH = /\.(lnk|exe|url)$/i;

function placeholderIconItems() {
  const use = new Map();
  const all = allItems();
  for (const { i } of all) {
    const ic = i.icon || '';
    if (isImageIcon(ic)) use.set(ic, (use.get(ic) || 0) + 1);
  }
  return all.filter(({ i }) => {
    const ic = i.icon || '';
    return isImageIcon(ic) && (use.get(ic) || 0) >= 3 && GENERIC_ICON_PATH.test(i.path || '');
  });
}

/**
 * 重新提取"占位图标"那批条目的图标。
 * @param {{quiet?:boolean}} [opts] quiet = 没人点按钮，别弹"正在…"和"没有要修的"
 * @returns {Promise<number>} 真正改掉的个数
 */
async function reextractIcons(opts = {}) {
  if (!state.config.settings) state.config.settings = {};
  const targets = placeholderIconItems();
  if (!targets.length) {
    state.config.settings.iconRev = ICON_REV;
    await API.saveConfig(state.config);
    if (!opts.quiet) toast('info', '没有需要修复的图标', '图标都已经是各自程序自己的了');
    return 0;
  }
  if (!opts.quiet) toast('info', `正在重新提取 ${targets.length} 个图标…`, '走一遍开始菜单里的快捷方式');

  const generic = new Set(targets.map(t => t.i.icon));
  let changed = 0;
  let cleared = 0;
  const queue = targets.slice();
  // 小并发：解 PE / 读 ico 都是同步小活，两百多项串行太慢；并发再大容易把主进程顶住。
  const worker = async () => {
    while (queue.length) {
      const { i } = queue.shift();
      try {
        const r = await API.iconDefault(i.path);
        if (r && r.ok && r.dataUrl) {
          if (r.dataUrl !== i.icon) { i.icon = r.dataUrl; changed++; }
        } else if (generic.has(i.icon)) {
          // 真图标取不到（例如 Win10 的 notepad.exe 只是个转发壳，或者这个 .url 本来
          // 就没有 IconFile）→ 与其留一张通用"白板"，不如退回 emoji：看着像特意选的。
          // ★ 按 **路径** 判断而不是 i.type：从开始菜单扫进来的 `.url` 记的是 type='app'，
          //   照 type 走会给所有网页快捷方式挂 🚀（第一版就是这么错的）。
          const p = String(i.path || '');
          i.icon = /\.url$/i.test(p) ? '🌐'
            : (i.type === 'folder' || /[\\/]$/.test(p)) ? '📁' : '🚀';
          cleared++;
        }
      } catch { /* 单个失败不影响其它 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, targets.length) }, worker));

  state.config.settings.iconRev = ICON_REV;
  const saved = await API.saveConfig(state.config);
  if (!saved.ok) return toast('bad', '图标提取完了但保存失败', saved.msg), 0;
  if (changed || cleared) await refresh();
  toast('ok', changed || cleared ? `已修复 ${changed + cleared} 个图标` : '图标都是对的',
    `检查了 ${targets.length} 个程序${cleared ? ` · ${cleared} 个没自带图标，已退回表情` : ''}`);
  return changed + cleared;
}

/**
 * `.url`（Internet 快捷方式）自愈 —— Steam / FeverGames / 各类游戏平台拖进来的那批。
 *
 * 两个毛病，都是 v1.4.4 之前留下的：
 *  1) `URL=steam://rungameid/400040` 被当成裸网址又套了一层 → `http://steam://…`，点了打不开；
 *  2) 图标一律写死 🌐 → 本机 11 个游戏在界面上是 11 个一模一样的大地球。
 *     （`.url` 里其实写着 `IconFile=…\.ico`，以前没人读。）
 *
 * ★ 逻辑全在主进程（`ql:heal:urls`）：要读盘、要 nativeImage，渲染层做不到；
 *   也避免"修协议"的正则在这儿和 lib 里各写一份。渲染层只管叫一声。
 * ★ 只改「协议被套错」和「图标还不是图片」的项，用户自己挑的 emoji 不动。
 * @returns {Promise<{fixedPath:number, fixedIcon:number}>}
 */
async function healUrlItems() {
  if (PREVIEW) return { fixedPath: 0, fixedIcon: 0 };
  try {
    const r = await API.healUrls();
    if (r && (r.fixedPath || r.fixedIcon)) {
      console.log(`[quicklaunch] .url 自愈：修协议 ${r.fixedPath} 项 / 补图标 ${r.fixedIcon} 项`);
      await refresh();
    }
    return r || { fixedPath: 0, fixedIcon: 0 };
  } catch (e) {
    // 别静默：preload 少暴露一个方法（曾经就是漏了 healUrls）会让自愈"永远没生效"
    console.warn('[quicklaunch] .url 自愈失败:', e && e.message);
    return { fixedPath: 0, fixedIcon: 0 };
  }
}

/**
 * 「重新提取图标」按钮与启动时的一次性自愈，都从这里走：
 * `.url` 先修协议 + 补图标，再补 `.lnk` 那批占位图。
 * @param {{quiet?:boolean}} [opts]
 */
async function healAllIcons(opts = {}) {
  const r = await healUrlItems();
  const lnk = await reextractIcons({ quiet: true });
  const total = (r.fixedIcon || 0) + lnk;
  if (!opts.quiet) {
    toast(total ? 'ok' : 'info',
      total ? `已修复 ${total} 个图标` : '没有需要修复的图标',
      r.fixedPath ? `顺带纠正了 ${r.fixedPath} 个被套错协议的链接` : '桌面与开始菜单里的快捷方式都看过了');
  }
  return total;
}

function toast(kind, title, text = '') {
  const icons = { ok: '✓', bad: '!', info: 'i' };
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<div class="t-ic">${icons[kind] || 'i'}</div>
    <div class="t-txt"><b>${esc(title)}</b>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); },
    kind === 'bad' ? 4200 : 2400);
}

/** 最近一条提示的纯文本（探针断言用）。提成顶层函数，别让每个探针各拷一份。 */
function lastToast() {
  const ts = document.querySelectorAll('#toasts .toast');
  const t = ts[ts.length - 1];
  return t ? t.textContent.replace(/\s+/g, ' ').trim() : '(无)';
}

function allItems() {
  const out = [];
  state.config.groups.forEach(g => g.items.forEach(i => out.push({ g, i })));
  return out;
}

function findItem(id) {
  for (const g of state.config.groups) {
    const i = g.items.find(x => x.id === id);
    if (i) return { g, i };
  }
  return null;
}

const byRecent = (a, b) => (b.i ? b.i.lastUsed : b.lastUsed) - (a.i ? a.i.lastUsed : a.lastUsed);

function recentItems() {
  return allItems().filter(({ i }) => i.lastUsed > 0).sort(byRecent).slice(0, 12);
}

function favItems() {
  return allItems().filter(({ i }) => i.favorite);
}

function shortPath(p) {
  const s = String(p || '');
  return s.length > 62 ? s.slice(0, 28) + '…' + s.slice(-30) : s;
}

/* 拖入时用于给 URL / 路径起名字（预览模式也用到） */
function hostOfString(u) {
  try { return new URL(u).hostname.replace(/^www\./i, '') || u; } catch { return String(u || ''); }
}

function nameOfPath(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const seg = s.split(/[\\/]/).pop() || s;
  return seg.replace(/\.[^.]+$/, '') || seg;
}

/* ------------------------------------------------------------ 侧栏 */

function renderNav() {
  const total = allItems().length;
  const rows = [];

  rows.push(navRow('all', '🗂️', '全部', total));
  rows.push(navRow('recent', '🕘', '最近使用', recentItems().length));
  rows.push(navRow('fav', '⭐', '收藏', favItems().length));

  rows.push('<div class="nav-label">分组</div>');
  state.config.groups.forEach(g => {
    rows.push(`<button class="nav-item ${state.active === g.id ? 'active' : ''}"
        data-nav="${esc(g.id)}" draggable="true" style="--c:${esc(g.color || PALETTE[0])}" title="${esc(g.name)}">
      <i class="dot"></i><span class="nm">${esc(g.name)}</span>
      <span class="cnt">${g.items.length}</span>
    </button>`);
  });
  // 新建分组：常驻在分组列表末尾，不用再去翻右键菜单
  rows.push(`<button class="nav-item nav-new" id="navNewGroup" title="新建分组">
    <i class="ic">＋</i><span class="nm">新建分组</span></button>`);

  $('#nav').innerHTML = rows.join('');
}

function navRow(id, ic, name, count) {
  return `<button class="nav-item ${state.active === id ? 'active' : ''}" data-nav="${id}">
    <i class="ic">${ic}</i><span class="nm">${esc(name)}</span><span class="cnt">${count}</span></button>`;
}

/** 拖动左侧分组改变顺序（v1.4.7）。
 *  `state.config.groups` 的数组顺序就是侧栏显示顺序，splice 移动即可；
 *  落盘后主进程的 config-changed 广播会再 refresh 一次（与新建/删除分组同一套）。 */
function reorderGroup(fromId, toId, before) {
  const gs = state.config.groups;
  const from = gs.findIndex(x => x.id === fromId);
  const to = gs.findIndex(x => x.id === toId);
  if (from < 0 || to < 0 || from === to) return;
  const [moving] = gs.splice(from, 1);
  let at = gs.findIndex(x => x.id === toId);
  if (!before) at += 1;
  gs.splice(at, 0, moving);
  renderNav();                 // 立即更新侧栏，先给反馈
  render({ noAnim: true });    // 「全部」视图下主区的分组 section 顺序也跟着变
  API.saveConfig(state.config).catch(() => { /* 没存上也不影响本次使用 */ });
}

/* ------------------------------------------------------------ 主区 */

/** 视图 id 是否有效：三个内置视图，或一个真实存在的分组。
 *  分组被删掉后，配置里可能还留着它的 id —— 这里必须兜底。 */
function isViewId(v) {
  if (v === 'all' || v === 'recent' || v === 'fav') return true;
  return !!(state.config && state.config.groups.some(g => g.id === v));
}

/** 设置里存的分组编码 → 实际视图 id。
 *  真实分组统一带 `g:` 前缀写入（见 persistLastGroup / renderStartGroupOptions），
 *  为的是别让某个分组 id 撞上 all / recent / fav 这类保留字。
 *  ★ startGroup 与 lastGroup **用的是同一套编码，两处都必须解** ——
 *    只解 startGroup 会让「记住上次打开的分组」（默认值！）永远回落到「全部」。 */
function viewFromCode(v) {
  return String(v || '').startsWith('g:') ? String(v).slice(2) : String(v || '');
}

/** 实际视图 id → 设置里存的编码（与 viewFromCode 严格互逆） */
function viewToCode(view) {
  return (view === 'all' || view === 'recent' || view === 'fav') ? view : 'g:' + view;
}

/** 设置里存的分组选择 → 实际视图 id。 */
function startViewFromSettings(s) {
  s = s || {};
  const raw = s.startGroup || 'last';
  const want = viewFromCode(raw === 'last' ? (s.lastGroup || 'all') : raw);
  return isViewId(want) ? want : 'all';
}

function viewGroups() {
  if (state.active === 'recent') {
    return [{ id: '_recent', name: '最近使用', icon: '🕘', color: PALETTE[7], items: recentItems().map(x => x.i) }];
  }
  if (state.active === 'fav') {
    return [{ id: '_fav', name: '收藏', icon: '⭐', color: PALETTE[6], items: favItems().map(x => x.i) }];
  }
  if (state.active === 'all') return state.config.groups;
  return state.config.groups.filter(g => g.id === state.active);
}

// 拼音搜索（v1.4.6）：中文名 → 全拼 + 首字母，两个都拿来匹配。
// ★ 依赖 index.html 里先引入的 pinyin-pro（window.pinyinPro），只在名字含中文时才转换，
//   结果按 name 缓存（名字不常变，搜索时上千项反复问，不缓存会卡）。
const pinyinCache = new Map();
function pinyinKeys(name) {
  if (!name || !window.pinyinPro) return '';
  let k = pinyinCache.get(name);
  if (k !== undefined) return k;
  k = '';
  if (/[\u4e00-\u9fff]/.test(name)) {
    try {
      const opt = { toneType: 'none', type: 'string' };
      const full = window.pinyinPro.pinyin(name, opt).replace(/\s+/g, '').toLowerCase();
      const first = window.pinyinPro.pinyin(name, { ...opt, pattern: 'first' })
        .replace(/\s+/g, '').toLowerCase();
      k = full + '\u0000' + first;
    } catch { k = ''; }
  }
  pinyinCache.set(name, k);
  if (pinyinCache.size > 4096) pinyinCache.clear();
  return k;
}

function matches(item) {
  if (!state.q) return true;
  const q = state.q.toLowerCase().trim();
  if (!q) return true;
  const name = item.name || '';
  const hay = [
    name.toLowerCase(),
    (item.path || '').toLowerCase(),
    (item.desc || '').toLowerCase(),
    (item.args || '').toLowerCase(),
  ];
  // 拼音只对「纯字母/数字的查询词」有意义：查中文时走 name 本体就够了，别再白白转换拼音
  if (!/[\u4e00-\u9fff]/.test(q)) hay.push(pinyinKeys(name));
  return hay.some(h => h.includes(q));
}

function sortItems(list) {
  const arr = [...list];
  if (state.sort === 'name') arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  else if (state.sort === 'recent') arr.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  else if (state.sort === 'uses') arr.sort((a, b) => (b.useCount || 0) - (a.useCount || 0));
  return arr;
}

function cardHTML(item, color, delay) {
  const t = TYPE_INFO[item.type] ? item.type : 'app';
  const sub = item.desc || shortPath(item.path) || '';
  const missing = item._exists === false;
  const foot = missing ? '<span class="missing">路径不存在</span>'
    : (item.favorite ? '<span class="star-on">★ 已收藏</span>' : '')
      + (item.useCount ? `<span class="uses">用过 ${item.useCount} 次</span>` : '');
  // 编辑模式：卡片变成"可勾选"，左上角显示勾选框。
  // 勾选框只在编辑模式渲染（而不是常驻 + CSS 隐藏），这样非编辑态完全没有多余 DOM。
  const picked = state.picked.has(item.id);
  const cls = 'card' + (state.editMode ? ' pickable' : '') + (picked ? ' picked' : '');
  const pickMark = state.editMode
    ? '<span class="pick" aria-hidden="true"><svg viewBox="0 0 12 12"><path d="M2.4 6.2l2.3 2.4 4.7-5.2"/></svg></span>'
    : '';
  return `<article class="${cls}" tabindex="0" data-id="${esc(item.id)}"
    aria-selected="${picked ? 'true' : 'false'}"
    style="--c:${esc(color)};animation-delay:${delay}ms">
    ${pickMark}
    <div class="card-acts">
      <button class="act" data-act="open" title="启动">▶</button>
      <button class="act" data-act="folder" title="打开所在位置">📂</button>
      <button class="act" data-act="fav" title="${item.favorite ? '取消收藏' : '加入收藏'}">${item.favorite ? '★' : '☆'}</button>
      <button class="act" data-act="edit" title="编辑">✎</button>
      <button class="act del" data-act="del" title="删除">🗑</button>
    </div>
    <div class="card-top">
      <div class="tile">${iconHtml(item, TYPE_INFO[t].icon)}</div>
      <div class="card-meta">
        <h3 title="${esc(item.name)}">${esc(item.name || '未命名')}</h3>
        <p title="${esc(item.path)}">${esc(sub)}</p>
      </div>
    </div>
    <div class="card-foot">
      <span class="badge">${TYPE_INFO[t].label}</span>
      ${foot}
    </div>
  </article>`;
}

const ADD_CARD = `<article class="card add" data-add="1" tabindex="0">
  <div class="plus">＋</div><span>新建启动项</span></article>`;

function render(opts) {
  const host = $('#gridHost');
  // 搜索逐字过滤时 opts.noAnim = true：不要每敲一个键就把所有卡片的入场动画重播一遍
  // （上千张卡同时闪 pop 是纯闪烁）。非搜索的重绘不传 → 正常播入场动画。
  host.classList.toggle('no-anim', !!(opts && opts.noAnim));

  if (!state.config) {
    host.innerHTML = `<div class="grid">${'<div class="skeleton"></div>'.repeat(8)}</div>`;
    return;
  }

  const groups = viewGroups();
  const sections = groups.map(g => ({
    g, items: sortItems((g.items || []).filter(matches)),
  })).filter(s => s.items.length || (!state.q && state.active !== 'recent' && state.active !== 'fav'));

  const totalShown = sections.reduce((n, s) => n + s.items.length, 0);

  const cur = state.active === 'all' ? null
    : state.active === 'recent' ? { name: '最近使用', icon: '🕘' }
      : state.active === 'fav' ? { name: '收藏', icon: '⭐' }
        : state.config.groups.find(g => g.id === state.active);
  $('#groupTitle').textContent = (cur ? `${cur.icon || ''} ${cur.name}` : '🗂️ 全部').trim();
  $('#groupSub').textContent = state.q
    ? `找到 ${totalShown} 个匹配项`
    : `${totalShown} 个启动项 · ${state.config.groups.length} 个分组`;

  if (!totalShown && !sections.length) {
    host.innerHTML = '';
    $('#empty').hidden = false;
    if (state.q) {
      $('#emptyIcon').textContent = '🔍';
      $('#emptyTitle').textContent = '没有匹配的启动项';
      $('#emptyText').textContent = `没有找到包含「${state.q}」的名称、路径或描述。`;
    } else if (state.active === 'fav') {
      $('#emptyIcon').textContent = '⭐';
      $('#emptyTitle').textContent = '还没有收藏项';
      $('#emptyText').textContent = '把鼠标移到卡片上，点 ☆ 加入收藏。收藏项会出现在托盘右键菜单里。';
    } else {
      $('#emptyIcon').textContent = '🗂️';
      $('#emptyTitle').textContent = '这里还没有内容';
      $('#emptyText').textContent = '点击右上角「新建」添加启动项，或用左侧「扫描本机软件」自动导入已安装的程序。';
    }
    return;
  }
  $('#empty').hidden = true;

  const perSection = state.active === 'all' && !state.q && state.sort === 'custom' && sections.length > 1;
  let html = '';
  let n = 0;
  // 编辑模式下不显示「新建启动项」卡片：那一格点下去是"新建"而不是"勾选"，很容易误触
  const canAdd = !state.editMode;

  if (perSection) {
    sections.forEach(({ g, items }) => {
      if (!items.length) return;
      html += `<div class="section-head"><span>${esc(g.icon || '')} ${esc(g.name)}</span><span class="line"></span></div>`;
      html += `<div class="grid" data-gid="${esc(g.id)}" style="margin-bottom:24px">`
        + items.map(i => cardHTML(i, g.color || PALETTE[0], Math.min(n++ * 20, 400))).join('')
        + `</div>`;
    });
    if (canAdd) html += `<div class="grid">${ADD_CARD}</div>`;
  } else {
    const flat = sections.flatMap(s => s.items.map(i => cardHTML(i, s.g.color || PALETTE[0], Math.min(n++ * 20, 400))));
    const showAdd = canAdd && state.active !== 'recent' && state.active !== 'fav';
    // 只有"整格恰好属于同一个真实分组"时才允许拖动排序，
    // 否则（搜索/非自定义排序把多个分组压平）顺序无法映射回数据
    const gids = new Set(sections.map(s => s.g.id));
    const gridGid = gids.size === 1 ? [...gids][0] : '';
    html = `<div class="grid" data-gid="${esc(gridGid)}">${flat.join('')}${showAdd ? ADD_CARD : ''}</div>`;
  }
  host.innerHTML = html;
  updateEditBar();
}

/* ------------------------------------------------------------ 主题 */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('#btnTheme');
  btn.firstChild.textContent = theme === 'dark' ? '☀️' : '🌙';
  const s = btn.querySelector('span');
  if (s) s.textContent = theme === 'dark' ? '浅色模式' : '深色模式';
}

/** 最大化 / 还原 图标切换。
 *  图标是内联 SVG，靠 .is-max 类在「方框」和「双框」之间切换 —— 不要再用
 *  textContent 写 ❐/☐ 字符（字体不覆盖时会变豆腐块或空白）。 */
function setWinMaxIcon(max) {
  const b = $('#wcMax');
  if (!b) return;
  b.classList.toggle('is-max', !!max);
  b.title = max ? '向下还原' : '最大化';
}

/** 把设置反映到 DOM 上（目前只有「悬停显示卡片快捷按钮」） */
function applySettingsToDom(settings) {
  document.body.classList.toggle('hover-actions', !!(settings && settings.hoverActions));
}

/* ------------------------------------------------------------ 编辑弹窗 */

function renderTypeChips() {
  $('#fTypes').innerHTML = Object.entries(TYPE_INFO)
    .map(([k, v]) => `<button class="type-chip" data-type="${k}">${v.icon} ${v.label}</button>`).join('');
}

function setType(t) {
  $$('#fTypes .type-chip').forEach(b => b.classList.toggle('on', b.dataset.type === t));
  const info = TYPE_INFO[t];
  $('#fPath').placeholder = info.ph;
  $('#typeTip').innerHTML = info.tip;
  $('#btnBrowse').style.display = (t === 'url' || t === 'cmd') ? 'none' : '';
  $('#fPathHint').textContent = t === 'url' ? '输入网址' : (t === 'cmd' ? '输入完整命令行' : '支持 %环境变量%');
  state.editing.item.type = t;
}

function openEdit(item, groupId) {
  const isNew = !item;
  const gid = groupId || (state.config.groups[0] && state.config.groups[0].id) || '';
  state.editing = {
    isNew, groupId: gid,
    item: item ? JSON.parse(JSON.stringify(item)) : {
      id: uid(), name: '', icon: '🚀', type: 'app', path: '',
      args: '', cwd: '', desc: '', elevate: false, console: false,
      favorite: false, useCount: 0, lastUsed: 0,
    },
  };
  const it = state.editing.item;

  $('#editTitle').textContent = isNew ? '新建启动项' : '编辑启动项';
  $('#editSub').textContent = isNew ? '配置名称、类型与目标路径' : (it.name || '');
  $('#editIc').innerHTML = isNew ? '＋' : (isImageIcon(it.icon) ? `<img class="mh-img" src="${it.icon}" alt="">` : esc(it.icon || '✎'));

  $('#fName').value = it.name || '';
  $('#fArgs').value = it.args || '';
  $('#fCwd').value = it.cwd || '';
  $('#fDesc').value = it.desc || '';
  $('#fPath').value = it.path || '';
  $('#fElevate').checked = !!it.elevate;
  $('#fConsole').checked = !!it.console;
  $('#fFav').checked = !!it.favorite;

  $('#fGroup').innerHTML = state.config.groups
    .map(g => `<option value="${esc(g.id)}">${esc(g.icon || '')} ${esc(g.name)}</option>`).join('')
    + '<option value="__new__">＋ 新建分组…</option>';
  $('#fGroup').value = gid;
  $('#newGroupField').hidden = true;
  $('#fNewGroup').value = '';

  renderTypeChips();
  setType(it.type || 'app');
  renderIconPicker(it.icon);

  $('#editOverlay').hidden = false;
  setTimeout(() => $('#fName').focus(), 60);
}

function renderIconPicker(current) {
  const img = isImageIcon(current);
  $('#fIcons').innerHTML = ICONS
    .map(e => `<button class="icon-btn ${(!img && e === current) ? 'on' : ''}" data-emoji="${e}">${e}</button>`).join('');
  $('#fIcHint').textContent = img ? '当前是自定义图片，点击下方可更换/还原' : '';
}

/** 设置图标后统一刷新弹窗预览、emoji 选中态与提示（图片/emoji 两种形态都走这） */
function applyIcon(value) {
  state.editing.item.icon = value;
  $('#editIc').innerHTML = isImageIcon(value) ? `<img class="mh-img" src="${value}" alt="">` : esc(value || '✎');
  renderIconPicker(value);
}

function closeEdit() { $('#editOverlay').hidden = true; state.editing = null; }

function collectForm() {
  const it = state.editing.item;
  it.name = $('#fName').value.trim();
  it.path = $('#fPath').value.trim();
  it.args = $('#fArgs').value.trim();
  it.cwd = $('#fCwd').value.trim();
  it.desc = $('#fDesc').value.trim();
  it.elevate = $('#fElevate').checked;
  it.console = $('#fConsole').checked;
  it.favorite = $('#fFav').checked;
  return it;
}

async function saveEdit() {
  const it = collectForm();
  if (!it.name) return toast('bad', '请填写名称');
  if (!it.path) return toast('bad', '请填写目标路径');

  let gid = $('#fGroup').value;
  if (gid === '__new__') {
    const name = $('#fNewGroup').value.trim();
    if (!name) return toast('bad', '请填写新分组名称');
    const ng = { id: 'g' + uid(), name, icon: '📦', color: PALETTE[state.config.groups.length % PALETTE.length], items: [] };
    state.config.groups.push(ng);
    gid = ng.id;
  }

  delete it._exists;
  if (!state.editing.isNew) {
    state.config.groups.forEach(g => { g.items = g.items.filter(x => x.id !== it.id); });
  }
  const g = state.config.groups.find(x => x.id === gid);
  if (!g) return toast('bad', '分组不存在');
  g.items.push(it);

  const r = await API.saveConfig(state.config);
  if (!r.ok) return toast('bad', '保存失败', r.msg);
  toast('ok', state.editing.isNew ? '已创建' : '已保存', it.name);
  closeEdit();
  await refresh();
}

/* ------------------------------------------------------------ 动作 */

async function runItem(id, item) {
  let target = item;
  if (!target) {
    const f = findItem(id);
    if (!f) return toast('bad', '找不到启动项');
    target = f.i;
  }
  const r = await API.run(target);
  if (r.ok) {
    toast('ok', '已启动', r.name || target.name || '');
    // ★ 这里**不要**再 refresh()。主进程 runAndBump 已经把 useCount+1 写盘并广播
    //   ql:config-changed（见 main.js），渲染层收到后走 softSync 就地改「用过 N 次」。
    //   以前这里又 refresh 一次 = 点一下卡片整块重绘两遍，界面上就是"闪一下"。
  } else {
    toast('bad', '启动失败', r.msg);
  }
}

async function toggleFav(id) {
  const f = findItem(id);
  if (!f) return;
  f.i.favorite = !f.i.favorite;
  await API.saveConfig(state.config);
  toast('ok', f.i.favorite ? '已加入收藏' : '已取消收藏', f.i.name);
  await refresh();
}

function confirmDialog({ icon = '🗑️', title, text, okText = '删除', danger = true }) {
  return new Promise(resolve => {
    $('#cfIc').textContent = icon;
    $('#cfTitle').textContent = title;
    $('#cfText').textContent = text || '';
    $('#cfYes').textContent = okText;
    $('#cfYes').className = 'btn sm ' + (danger ? 'danger' : 'primary');
    $('#confirmOverlay').hidden = false;
    const done = v => {
      $('#confirmOverlay').hidden = true;
      $('#cfYes').onclick = $('#cfNo').onclick = null;
      state.dlgCancel = null;
      resolve(v);
    };
    state.dlgCancel = () => done(false);
    $('#cfYes').onclick = () => done(true);
    $('#cfNo').onclick = () => done(false);
  });
}

/** 单行输入弹窗，返回输入内容或 null */
function promptDialog({ icon = '✎', title, sub = '', label = '名称', value = '', placeholder = '' }) {
  return new Promise(resolve => {
    $('#pmIc').textContent = icon;
    $('#pmTitle').textContent = title;
    $('#pmSub').textContent = sub;
    $('#pmLabel').textContent = label;
    const input = $('#pmInput');
    input.value = value;
    input.placeholder = placeholder;
    $('#promptOverlay').hidden = false;
    setTimeout(() => { input.focus(); input.select(); }, 60);

    const done = v => {
      $('#promptOverlay').hidden = true;
      $('#pmOk').onclick = null;
      input.onkeydown = null;
      state.dlgCancel = null;
      resolve(v);
    };
    state.dlgCancel = () => done(null);
    $('#pmOk').onclick = () => done(input.value.trim() || null);
    input.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(input.value.trim() || null); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
    };
  });
}

/** 把原生右键菜单返回的动作落到具体操作上 */
async function cardAction(act, id) {
  const f = findItem(id);
  if (!f) return;
  const it = f.i;
  switch (act) {
    case 'launch': return runItem(id);
    case 'elevate':
      return runItem(null, Object.assign({}, it, { elevate: true, id: null, name: `${it.name}（管理员）` }));
    case 'folder': {
      const r = await API.openFolder(it.path);
      if (!r.ok) toast('bad', '无法定位', r.msg);
      return;
    }
    case 'copy':
      await API.copyText(it.path);
      return toast('ok', '已复制路径', shortPath(it.path));
    case 'fav': return toggleFav(id);
    case 'edit': return openEdit(it, f.g.id);
    case 'del': return deleteItem(id);
    // 右键「多选编辑」：进编辑模式并顺手选中这一项，省得再点一下
    case 'multiselect': return setEditMode(true, id);
    default: return undefined;
  }
}

/** 新建分组：侧栏「＋ 新建分组」和右键菜单都走这里 */
async function createGroup() {
  const name = await promptDialog({
    icon: '📦', title: '新建分组', sub: '起个名字，之后可随时重命名或删除',
    label: '分组名称', value: '', placeholder: '例如：游戏 / 开发工具',
  });
  if (!name) return;
  if (state.config.groups.some(g => g.name === name)) {
    return toast('bad', '已有同名分组', name);
  }
  const ng = {
    id: 'g' + uid(), name, icon: '📦',
    color: PALETTE[state.config.groups.length % PALETTE.length],
    items: [],
  };
  state.config.groups.push(ng);
  const r = await API.saveConfig(state.config);
  if (!r.ok) {
    state.config.groups = state.config.groups.filter(x => x.id !== ng.id);
    return toast('bad', '创建失败', r.msg);
  }
  state.active = ng.id;          // 建完直接切过去，方便马上往里加东西
  state.q = '';
  if ($('#q')) $('#q').value = '';
  toast('ok', '已新建分组', name);
  await refresh();
}

async function groupAction(act, gid) {
  const g = state.config.groups.find(x => x.id === gid);
  if (!g) return;

  if (act === 'new') return openEdit(null, gid);
  if (act === 'newgroup') return createGroup();
  if (act === 'rename') {
    const name = await promptDialog({
      title: '重命名分组', sub: `当前：${g.name}`, label: '分组名称', value: g.name,
    });
    if (!name || name === g.name) return;
    g.name = name;
    await API.saveConfig(state.config);
    renderNav();
    toast('ok', '已重命名', name);
    return;
  }
  if (act.startsWith('color:')) {
    g.color = act.slice(6);
    await API.saveConfig(state.config);
    renderNav();
    render();
    return;
  }
  if (act === 'del') {
    const ok = await confirmDialog({
      icon: '📦', title: '删除整个分组？',
      text: `「${g.name}」及其中的 ${g.items.length} 个启动项都会被移除。`,
      okText: '删除分组',
    });
    if (!ok) return;
    state.config.groups = state.config.groups.filter(x => x.id !== gid);
    await API.saveConfig(state.config);
    if (state.active === gid) state.active = 'all';
    toast('ok', '已删除分组', g.name);
    await refresh();
    return;
  }
}

async function blankMenu() {
  const act = await API.blankMenu();
  if (act === 'new') {
    const gid = (state.active === 'all' || state.active === 'recent' || state.active === 'fav') ? null : state.active;
    openEdit(null, gid);
  } else if (act === 'newgroup') createGroup();
  else if (act === 'scan') openScan();
  else if (act === 'prune') openPrune();
  else if (act === 'multiselect') setEditMode(true);
  else if (act === 'settings') openSettings();
}

async function deleteItem(id) {
  const f = findItem(id);
  if (!f) return;
  const ok = await confirmDialog({
    title: '删除这个启动项？',
    text: `${f.i.name}（${shortPath(f.i.path)}）`,
  });
  if (!ok) return;
  f.g.items = f.g.items.filter(x => x.id !== id);
  const r = await API.saveConfig(state.config);
  if (!r.ok) return toast('bad', '删除失败', r.msg);
  toast('ok', '已删除', f.i.name);
  await refresh();
}

/* ------------------------------------------------------------ 多选编辑模式 */

/** 进入 / 退出多选编辑。
 *  退出时一定清空勾选 —— 不然下次进来会带着上一次看不见的残留选中，
 *  用户以为只删了自己刚点的那几个，实际连上次的一起删了。 */
function setEditMode(on, preselectId) {
  state.editMode = !!on;
  state.picked = new Set();
  if (state.editMode && preselectId && findItem(preselectId)) state.picked.add(preselectId);

  document.body.classList.toggle('edit-mode', state.editMode);
  $('#btnSelect').classList.toggle('on', state.editMode);
  $('#btnSelect').setAttribute('aria-pressed', state.editMode ? 'true' : 'false');
  $('#editBar').hidden = !state.editMode;
  if (state.editMode) renderMoveOptions();
  render();
  updateEditBar();
}

/** 底部操作栏的可用状态：一个都没选时，批量动作变灰（点了也不会静默失败） */
function updateEditBar() {
  const bar = $('#editBar');
  if (!bar) return;
  const n = state.picked.size;
  $('#ebCount').textContent = n ? `已选 ${n} 项` : '未选中';
  bar.dataset.empty = n ? '0' : '1';
}

/** 勾选 / 取消勾选。只改这一张卡的 class，不整块重绘
 *  （重绘会让所有卡片重新播一遍 pop 入场动画，多选时闪得厉害）。 */
function togglePick(id) {
  if (!id) return;
  if (state.picked.has(id)) state.picked.delete(id);
  else state.picked.add(id);
  const card = $$('.card[data-id]').find(c => c.dataset.id === id);
  if (card) {
    const on = state.picked.has(id);
    card.classList.toggle('picked', on);
    card.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  updateEditBar();
}

/** 当前勾选项对应的真实 {分组, 启动项}。
 *  遍历真实 groups 而不是当前视图 —— 「最近使用 / 收藏」是虚拟视图，
 *  里面的项其实散落在各个分组，按视图找会漏。 */
function pickedPairs() {
  const out = [];
  state.config.groups.forEach(g => g.items.forEach(i => {
    if (state.picked.has(i.id)) out.push({ g, i });
  }));
  return out;
}

/** 当前列表里可见的项（全选只选看得见的，而不是整个配置） */
function visibleItemIds() {
  return $$('.card[data-id]').map(c => c.dataset.id);
}

function renderMoveOptions() {
  const sel = $('#ebMove');
  if (!sel) return;
  sel.innerHTML = '<option value="">移动到分组…</option>'
    + state.config.groups.map(g =>
      `<option value="${esc(g.id)}">${esc(g.icon || '📦')} ${esc(g.name)}</option>`).join('');
}

async function batchFavorite(on) {
  const pairs = pickedPairs();
  if (!pairs.length) return toast('bad', '先勾选要操作的启动项');
  let changed = 0;
  pairs.forEach(({ i }) => { if (!!i.favorite !== on) { i.favorite = on; changed++; } });
  if (!changed) return toast('info', on ? '选中项都已经在收藏里' : '选中项都不在收藏里');
  const r = await API.saveConfig(state.config);
  if (!r.ok) return toast('bad', '保存失败', r.msg);
  toast('ok', on ? `已收藏 ${changed} 项` : `已取消收藏 ${changed} 项`);
  await refresh();      // 勾选状态在 state.picked 里，重绘后会自动带上
}

/**
 * 把一批启动项移进指定分组（**唯一实现**：浮动栏的「移动分组」与多选拖到侧栏共用）。
 *
 * @param {string} gid 目标分组 id
 * @param {string[]} ids 要移动的启动项 id（可以跨分组）
 * @param {{quiet?:boolean}} [opts]
 * @returns {Promise<number>} 实际移动的项数
 */
async function moveItemsTo(gid, ids, opts) {
  const dest = state.config.groups.find(g => g.id === gid);
  if (!dest) { toast('bad', '目标分组不存在'); return 0; }

  const want = new Set(ids || []);
  const found = [];
  if (want.size) {
    state.config.groups.forEach(g => (g.items || []).forEach(i => {
      if (want.has(i.id)) found.push({ g, i });
    }));
  }
  // 已经在目标分组里的不算"移动"（先摘后加会把它们摘没，必须排除）
  const moving = found.filter(p => p.g.id !== gid);
  if (!moving.length) {
    if (!(opts && opts.quiet)) toast('info', '这些项已经都在这个分组里了', dest.name);
    return 0;
  }

  moving.forEach(({ g, i }) => { g.items = g.items.filter(x => x.id !== i.id); });
  moving.forEach(({ i }) => dest.items.push(i));

  const r = await API.saveConfig(state.config);
  if (!r.ok) { toast('bad', '移动失败', r.msg); return 0; }
  toast('ok', moving.length === 1
    ? `已移到「${dest.name}」`
    : `已移动 ${moving.length} 项到「${dest.name}」`);

  /* ★ 移走之后这些项可能已经不在当前视图里了（停在某个分组时最典型）。
     这时若不取消勾选，下一轮批量删除/收藏会作用到"看不见的项"上（铁律八第 2 条）。 */
  const stillVisible = state.active === 'all' || state.active === 'recent'
    || state.active === 'fav' || state.active === gid;
  if (!stillVisible && state.picked.size) {
    state.picked.clear();
    updateEditBar();
  }
  await refresh();
  return moving.length;
}

async function batchMove(gid) {
  const pairs = pickedPairs();
  if (!pairs.length) return toast('bad', '先勾选要操作的启动项');
  await moveItemsTo(gid, pairs.map(p => p.i.id));
}

async function batchDelete() {
  const pairs = pickedPairs();
  if (!pairs.length) return toast('bad', '先勾选要删除的启动项');
  const names = pairs.map(p => p.i.name || '未命名');
  const head = names.slice(0, 5).join('、');
  const ok = await confirmDialog({
    icon: '🗑️',
    title: `删除选中的 ${pairs.length} 个启动项？`,
    text: names.length > 5 ? `${head} 等共 ${names.length} 项` : head,
    okText: `删除 ${pairs.length} 项`,
  });
  if (!ok) return;
  const ids = new Set(pairs.map(p => p.i.id));
  pairs.forEach(({ g }) => { g.items = g.items.filter(x => !ids.has(x.id)); });
  const r = await API.saveConfig(state.config);
  if (!r.ok) return toast('bad', '删除失败', r.msg);
  toast('ok', `已删除 ${ids.size} 项`);
  state.picked.clear();
  await refresh();
  updateEditBar();
}

/* ------------------------------------------------------------ 长按拖动排序 */

const HOLD_MS = 500;          // 普通模式：长按 0.5 秒进入拖动模式
const HOLD_MS_EDIT = 300;     // 多选模式：点卡片是勾选，想拖动只需按住 0.3 秒
const MOVE_TOLERANCE = 8;     // 长按期间允许的手抖幅度（px）
// 拖动时底部会预留一条「死区」放垃圾桶（CSS 里 body.card-dragging .content 的 margin-bottom）。
// 这条带子里永远没有卡片，所以只有指针进到条内才可能判定为删除 ——
// 从根上杜绝「想拖到底部一行的卡片、结果被当成丢进垃圾桶」的误删。
const STRIP_H = 88;           // 必须与 style.css 中的 margin-bottom 一致
const TRASH_PAD_X = 26;       // 垃圾桶命中区左右外扩（px），纵向不再外扩

let hold = null;              // { card, id, x0, y0, lastX, lastY, timer }

/** 只有"自定义顺序 + 无搜索 + 整格同属一个真实分组"时才允许重排 */
function sortableGidOf(card) {
  if (!card || state.sort !== 'custom' || state.q) return null;
  const grid = card.closest('.grid');
  const gid = grid && grid.dataset.gid;
  if (!gid) return null;
  return state.config.groups.some(g => g.id === gid) ? gid : null;
}

/* ------------------------------------ 拖动到左侧分组：移进去（v1.5.3 多选批量 / v1.5.4 单张） */

/**
 * 指针下是不是左侧某个**真实分组**。
 *
 * 用 `elementFromPoint` 现取，不缓存矩形：侧栏能滚动，缓存一次就会失准。
 * 被拖的卡片是 `pointer-events:none`（见 `.card.dragging`），所以不会挡住命中。
 * 「全部 / 最近使用 / 收藏」是虚拟视图，没有 items 可放，一律不算目的地。
 */
function groupAtPoint(x, y) {
  const rail = document.querySelector('.rail');
  if (!rail) return null;
  const r = rail.getBoundingClientRect();
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
  const el = document.elementFromPoint(x, y);
  const btn = el && el.closest ? el.closest('[data-nav]') : null;
  if (!btn) return null;
  return state.config.groups.find(g => g.id === btn.dataset.nav) || null;
}

/** 这次拖动会带走哪些项：被拖的卡已勾选 = 全部勾选项，否则就它自己 */
function dragIds(d) {
  if (d && d.id && state.picked.has(d.id)) return [...state.picked];
  return (d && d.id) ? [d.id] : [];
}

/** 这次拖动会移动几项 */
function dragMoveCount(d) {
  return dragIds(d).length || 1;
}

/**
 * 拖到这个分组上**会不会真的发生移动**。
 *
 * 普通模式下把卡片拖到自己所在的分组上（或整批勾选项都已在该分组里）时，
 * 高亮一个"松手也不会变"的落点只会误导人 —— 干脆不高亮，也不接管这次拖动。
 */
function dragWouldMove(d, gid) {
  const dest = state.config.groups.find(g => g.id === gid);
  if (!dest) return false;
  const have = new Set((dest.items || []).map(i => i.id));
  return dragIds(d).some(id => !have.has(id));
}

/** 高亮"松手就会移进去"的那个分组；传 null 清掉 */
function paintGroupDrop(gid, count) {
  $$('.nav-item.drop-target').forEach(el => {
    el.classList.remove('drop-target');
    el.removeAttribute('data-drop-label');
  });
  if (!gid) return;
  const btn = document.querySelector(`.nav-item[data-nav="${gid}"]`);
  if (!btn) return;
  btn.classList.add('drop-target');
  // 单张时写「移到这里」更像人话；成批才报数量
  btn.dataset.dropLabel = count > 1 ? `移入 ${count} 项` : '移到这里';
}

function cancelHold(reason) {
  if (!hold) return;
  clearTimeout(hold.timer);
  hold.card.classList.remove('holding');
  hold.card.style.removeProperty('--hold');
  if (state.probeMode) console.log('[hold] 长按被打断:', reason || '未说明原因');
  hold = null;
}

/** 这张卡片该按住多久才进拖动模式；返回 0 = 这里不启动拖动。
 *
 *  - 普通模式：一律 0.5 秒（v1.5.6 从 1.5 秒调短，用户要求）。★ 即使当前网格**不能排序**
 *    （全部/最近/收藏视图），也要能长按 —— 那时的拖动是「拖到底部垃圾桶删除」或
 *    「拖到左侧分组移进去」，不能因为没有 data-gid 就禁掉。
 *  - 多选模式：点卡片是「勾选」，所以只要 0.3 秒（用户要求）。
 *    ★ v1.5.3 起，虚拟视图（全部/最近/收藏）里也接管：那里虽然不能排序，
 *      但可以**拖到左侧分组批量移进去** —— 跨分组整理就靠这条路径。
 */
function holdMsFor(card) {
  if (!state.editMode) return HOLD_MS;
  return state.q ? 0 : HOLD_MS_EDIT;   // 搜索结果里拖动没有意义，勾选保持零延迟
}

function onGridPointerDown(e) {
  if (e.button !== 0) return;                    // 只认左键
  const card = e.target.closest('.card');
  if (!card || card.dataset.add || !card.dataset.id) return;
  if (e.target.closest('.act')) return;          // 右上角快捷按钮不参与长按

  // ★ v1.5.0：多选模式下也允许拖动排序（按住 0.3 秒）。这里不再按 editMode 直接 return。
  const holdMs = holdMsFor(card);
  if (!holdMs) return;

  cancelHold('又按下了另一张卡片');
  card.style.setProperty('--hold', holdMs + 'ms');
  card.classList.add('holding');
  const h = {
    card, id: card.dataset.id, x0: e.clientX, y0: e.clientY,
    lastX: e.clientX, lastY: e.clientY, timer: null,
  };
  h.timer = setTimeout(() => { if (hold === h) startDrag(h); }, holdMs);
  hold = h;
  if (state.probeMode) console.log('[hold] 开始长按', card.querySelector('h3')?.textContent, '@', e.clientX, e.clientY, '时长', holdMs);
}

function onDocPointerMove(e) {
  if (state.probeMode && e.isTrusted) return;    // 探针期间忽略真实鼠标，保证可复现
  if (hold) {
    const dx = e.clientX - hold.x0;
    const dy = e.clientY - hold.y0;
    if (Math.abs(dx) > MOVE_TOLERANCE || Math.abs(dy) > MOVE_TOLERANCE) {
      cancelHold(`指针移动超过阈值 dx=${dx} dy=${dy}`);   // 手移开了 → 当作普通点击/滚动
      return;
    }
    hold.lastX = e.clientX; hold.lastY = e.clientY;
    return;
  }
  if (state.drag) moveDrag(e);
}

function onDocPointerUp(e) {
  if (state.probeMode && e.isTrusted) return;
  if (hold) cancelHold('指针抬起');
  if (state.drag) endDrag(e);
}

function startDrag(h) {
  const card = h.card;

  // 拖动现在有三件事可做：具体分组里**排序**、拖到底部**删除**、拖到左侧分组**移走**。
  // 所以这里不再因为「这个网格不能排序」就拒绝 —— 虚拟视图（全部/最近/收藏）也能拖去分组。
  const gid = sortableGidOf(card);

  card.classList.remove('holding');
  card.style.removeProperty('--hold');

  // ★ 必须在写任何拖动样式**之前**抓原始内联样式。
  //   抓晚了会把下面那组 left/top/width/height 一起存进去，松手恢复时
  //   卡片就带着 position:relative 的 left/top 偏移 —— 表现就是
  //   "原地长按后松手，图标跑到别的位置去了"（只有顺序没变、不触发重渲染时才看得见）。
  const origStyle = card.getAttribute('style') || '';
  const rect = card.getBoundingClientRect();

  const ph = document.createElement('div');
  ph.className = 'card-slot';
  ph.style.width = rect.width + 'px';
  ph.style.height = rect.height + 'px';
  card.parentElement.insertBefore(ph, card);

  card.classList.add('dragging');
  card.style.left = rect.left + 'px';
  card.style.top = rect.top + 'px';
  card.style.width = rect.width + 'px';
  card.style.height = rect.height + 'px';

  document.body.classList.add('card-dragging');
  // 多选模式：不出垃圾桶 —— 那里已经有「删除」按钮，免得「想挪个位置」变成「删了一项」。
  // 底部那条 88px 的死区是给垃圾桶留的，这里也不需要（CSS 用 card-drag-no-trash 覆盖掉）。
  document.body.classList.toggle('card-drag-no-trash', !!state.editMode);
  const trash = $('#trash');
  let trashRect = null;
  if (trash && state.editMode) {
    trash.hidden = true;
    trash.classList.remove('hot');
  } else if (trash) {
    trash.hidden = false;
    trash.classList.remove('hot');
    if ($('#trashTxt')) $('#trashTxt').textContent = '拖到这里删除';
    // 只量这一次：.hot 的 scale(1.14) 会让 rect 变大，每帧实时量会造成
    // "越靠近越容易判中" 的正反馈，命中区会在手指边自己膨胀
    trashRect = trash.getBoundingClientRect();
  }

  state.suppressClick = true;      // 别让松手后的 click 把程序启动了
  state.drag = {
    id: h.id, card, ph,
    gid, sortable: !!gid,
    origStyle,
    dx: h.lastX - rect.left, dy: h.lastY - rect.top,
    x0: h.lastX, y0: h.lastY, moved: false,
    overTrash: false, trashRect,
    overGid: null,           // 多选：当前悬停的目标分组（松手就移进去）
  };
  hold = null;
  moveDrag({ clientX: h.lastX, clientY: h.lastY });
}

function moveDrag(e) {
  const d = state.drag;
  if (!d) return;
  const x = e.clientX, y = e.clientY;

  // 真的挪动过没有：多选模式下「按久了却没动」要当成一次点选（见 endDrag）
  if (!d.moved && (Math.abs(x - d.x0) > 6 || Math.abs(y - d.y0) > 6)) d.moved = true;

  d.card.style.left = (x - d.dx) + 'px';
  d.card.style.top = (y - d.dy) + 'px';

  /* 垃圾桶命中：只认「底部预留条」（STRIP_H）+ 垃圾桶左右的横向容错。
     纵向先卡死在条内 —— 条里永远没有卡片，所以「想拖到底部一行的卡片」
     不可能被误判成删除。垃圾桶 pointer-events:none 不抢事件，这里用矩形判定。 */
  const trash = $('#trash');
  let over = false;
  if (d.trashRect && y >= window.innerHeight - STRIP_H) {
    over = x >= d.trashRect.left - TRASH_PAD_X && x <= d.trashRect.right + TRASH_PAD_X;
  }
  if (over !== d.overTrash) {
    d.overTrash = over;
    if (trash) trash.classList.toggle('hot', over);
    const t = $('#trashTxt');
    if (t) t.textContent = over ? '松手删除' : '拖到这里删除';
  }

  /* ★ 拖到左侧分组 = 移进去（v1.5.3 多选批量 / v1.5.4 普通模式单张）。
     普通模式原先只有"排序 / 丢垃圾桶"两种语义，现在补上第三种；
     但**垃圾桶优先**：指针在底部那条删除带里时一概不判定分组，避免"想删却移走"。
     一旦悬在分组上就**停止实时让位**：那是排序语义，此刻应该表达"移走"。
     ★ dragWouldMove：拖到自己所在的分组（或整批都已在里面）不高亮 ——
       高亮一个"松手也不会变"的落点只会误导人。 */
  const g = d.overTrash ? null : groupAtPoint(x, y);
  const overGid = (g && dragWouldMove(d, g.id)) ? g.id : null;
  if (overGid !== d.overGid) {
    d.overGid = overGid;
    paintGroupDrop(overGid, dragMoveCount(d));
    // ★ 指针在侧栏上时，被拖的卡片正好盖住目标分组那一行 —— 高亮被挡在下面，
    //   用户根本看不见"会移去哪儿"。这里让卡片淡出并往右下方闪开一点，
    //   目标行（以及它的「移到这里 / 移入 N 项」）就露出来了。
    d.card.classList.toggle('over-group', !!overGid);
  }
  if (overGid) return;

  /* 实时让位：把占位格挪到指针位置 */
  if (!d.sortable || d.overTrash) return;
  const grid = d.ph.parentElement;
  if (!grid) return;
  const under = document.elementFromPoint(x, y);
  if (!under || !under.closest) return;
  if (under.closest('.card-slot')) return;       // 指针在占位格上，不用动

  const target = under.closest('.card:not(.dragging):not([data-add])');
  if (target && target.parentElement === grid) {
    const r = target.getBoundingClientRect();
    const after = x > r.left + r.width / 2;
    grid.insertBefore(d.ph, after ? target.nextSibling : target);
  } else if (under.closest('.grid') === grid) {
    // 落在网格空白处：排到最后一个真实卡片之后（即"新建"卡之前）
    const last = [...grid.querySelectorAll('.card:not([data-add])')].pop();
    if (last && last.nextSibling !== d.ph) grid.insertBefore(d.ph, last.nextSibling);
  }
}

/** 把被拖卡片恢复原状（不改数据） */
function resetDraggedCard(d) {
  d.ph.remove();
  d.card.classList.remove('dragging');
  d.card.classList.remove('over-group');
  d.card.setAttribute('style', d.origStyle);
  // 兜底：拖动期间的定位样式只应活在 .dragging 里。万一 origStyle 抓早了/抓晚了
  // 混进 left/top/width/height，这里再清一次，避免卡片带着 relative 偏移停在别处。
  d.card.style.removeProperty('left');
  d.card.style.removeProperty('top');
  d.card.style.removeProperty('width');
  d.card.style.removeProperty('height');
  document.body.classList.remove('card-dragging');
  document.body.classList.remove('card-drag-no-trash');
  paintGroupDrop(null);
  const trash = $('#trash');
  if (trash) { trash.hidden = true; trash.classList.remove('hot'); }
}

function abortDrag() {
  const d = state.drag;
  if (!d) return;
  state.drag = null;
  resetDraggedCard(d);
}

async function endDrag(e) {
  const d = state.drag;
  if (!d) return;
  state.drag = null;
  // 松手后的 click 会在本帧之后到达，留个窗口把它吃掉
  setTimeout(() => { state.suppressClick = false; }, 500);

  const overTrash = d.overTrash;
  const ph = d.ph;
  const grid = ph ? ph.parentElement : null;

  // ★ 关键：拖动期间被拖卡片只是"视觉上"position:fixed，DOM 里仍留在原位置，
  //   真正移动的只有占位格。若直接读 querySelectorAll 会拿到原顺序 → 排序永远不生效。
  //   先把卡片落回占位格处，再读顺序。
  if (grid && ph.parentElement === grid) grid.replaceChild(d.card, ph);

  const ids = grid ? [...grid.querySelectorAll('.card[data-id]')].map(c => c.dataset.id) : [];
  const dry = !!state.dragDryRun;
  resetDraggedCard(d);

  // ★ 按住够久却**一步都没挪** → 这不算拖动，只是"按得慢了一点"。
  //   - 多选模式：当成一次点选（否则手按重一点既没排序、也没勾上）；
  //   - 普通模式：当成一次启动。★ v1.5.6 起门槛从 1.5s 缩到 0.5s，慢速点击会变常见，
  //     不补这一下的话，按超过半秒再松手就变成"点了没反应"。
  //   真的拖动必然伴随位移（moveDrag 里 >6px），所以不会误伤拖拽。
  if (!d.moved && !overTrash && !dry && !state.probeMode) {
    if (state.editMode) togglePick(d.id);
    else runItem(d.id);
    return;
  }

  if (dry || state.probeMode) {
    console.log('[drag-probe] 判定 =', overTrash ? '删除' : '排序',
      '| 可排序 =', d.sortable, '| gid =', d.gid || '(无)',
      '| 新顺序 =', ids.join(','));
  }
  if (dry) return;

  if (overTrash) return trashItem(d.id);

  /* ★ 松手时指针停在左侧分组上 → 移进去（普通模式单张 / 多选整批）。
     被拖的卡已勾选就整批走；没勾选就只移它自己（"拖谁移谁"）。
     落点在目标分组自身上时 moveItemsTo 会因为"已经在里面"返回 0，这里补一句提示。 */
  if (d.overGid) {
    const target = state.config.groups.find(g => g.id === d.overGid);
    const moving = dragIds(d);
    if (target && moving.length) {
      const n = await moveItemsTo(d.overGid, moving, { quiet: true });
      if (!n) toast('info', '已经在这个分组里了', target.name);
    }
    return;
  }

  if (!d.sortable) {
    // 「全部 / 最近 / 收藏」里拖到空白处：多选时只为"拖到分组"，静默；
    // 普通模式提醒一下 —— 顺带告诉他还有"拖到左侧分组"这条路。
    if (!state.editMode) {
      toast('info', '这里不支持拖动排序', '想换分组就直接拖到左侧的分组上；想排序请进入具体分组');
    }
    return;
  }

  const g = state.config.groups.find(x => x.id === d.gid);
  if (!g) return;
  const before = g.items.map(i => i.id).join(',');
  const byId = new Map(g.items.map(i => [i.id, i]));
  const next = ids.map(id => byId.get(id)).filter(Boolean);
  // 保底：DOM 里没出现的项补回末尾，绝不因为读 DOM 而丢项
  g.items.forEach(i => { if (!next.includes(i)) next.push(i); });
  if (next.map(i => i.id).join(',') === before) return;   // 顺序没变，不写盘

  g.items = next;
  const r = await API.saveConfig(state.config);
  if (!r.ok) {
    toast('bad', '排序保存失败', r.msg);
    await refresh();
    return;
  }
  await refresh();
  toast('ok', '顺序已更新', `${g.name} · ${g.items.length} 项`);
}

async function trashItem(id) {
  const f = findItem(id);
  if (!f) return;
  f.g.items = f.g.items.filter(x => x.id !== id);
  const r = await API.saveConfig(state.config);
  if (!r.ok) return toast('bad', '删除失败', r.msg);
  toast('ok', '已删除', f.i.name);
  await refresh();
}

/* ------------------------------------------------------------ 拖入导入 */

let dragDepth = 0;

/** 拖的是文件或链接才响应（选中文字拖拽不理会） */
function dragPayloadTypes(e) {
  const dt = e.dataTransfer;
  if (!dt || !dt.types) return [];
  return [...dt.types];
}

function isImportDrag(e) {
  const t = dragPayloadTypes(e);
  return t.includes('Files') || t.includes('text/uri-list');
}

function fileUrlToPath(u) {
  let s = String(u).replace(/^file:\/{2,3}/i, '');
  try { s = decodeURIComponent(s); } catch { /* 保留原串 */ }
  s = s.replace(/\//g, '\\');
  if (/^\\[a-zA-Z]:/.test(s)) s = s.slice(1);   // \D:\x → D:\x
  return s;
}

/** 从拖放事件里取出本地路径与网址；优先用 Electron 的 webUtils 拿真实路径 */
function extractDrop(e) {
  const paths = [];
  const urls = [];
  const dt = e.dataTransfer;
  if (!dt) return { paths, urls };

  const files = dt.files ? [...dt.files] : [];
  if (files.length && API.canResolvePath) {
    for (const f of files) {
      const p = API.pathForFile(f);
      if (p) paths.push(p);
    }
  }

  const text = (dt.getData('text/uri-list') || '') + '\n' + (dt.getData('text/plain') || '');
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    if (/^https?:\/\//i.test(s)) { if (!urls.includes(s)) urls.push(s); continue; }
    if (/^file:\/\//i.test(s)) {
      const p = fileUrlToPath(s);
      if (p && !paths.includes(p)) paths.push(p);
      continue;
    }
    // 纯文本形式的绝对路径（有些来源只给 text/plain）
    if (/^[a-zA-Z]:[\\/]/.test(s) && !paths.includes(s)) paths.push(s);
  }
  return { paths, urls };
}

function dropTargetInfo(e) {
  const nav = e.target && e.target.closest ? e.target.closest('[data-nav]') : null;
  const g = nav && state.config
    ? state.config.groups.find(x => x.id === nav.dataset.nav)
    : null;
  return g ? { id: g.id, name: g.name, icon: g.icon || '📦', el: nav } : null;
}

function showDropVeil() { const el = $('#dropVeil'); if (el) el.hidden = false; }
function hideDropVeil() { const el = $('#dropVeil'); if (el) el.hidden = true; }

/* ---- 拖入导入进度（v1.4.9）----
   拖几十上百项时，主进程要逐项解析快捷方式、提图标，没有反馈就像卡死。
   解析阶段给不定长滑块，提图标阶段给真实百分比（主进程 ql:import-progress 推过来）。 */
function setDropProgress(phase, done, total) {
  const box = $('#dropProgress');
  if (!box) return;
  box.hidden = false;
  const bar = $('#dropBar');
  const txt = $('#dropProgressText');
  const pctEl = $('#dropProgressPct');
  if (phase === 'resolve') {
    if (bar) { bar.classList.add('indeterminate'); bar.style.width = ''; }
    if (txt) txt.textContent = total > 1 ? `正在解析 ${total} 项…` : '正在解析…';
    if (pctEl) pctEl.textContent = '';
    return;
  }
  if (bar) { bar.classList.remove('indeterminate'); }
  const pct = total ? Math.round((done / total) * 100) : 0;
  if (bar) bar.style.width = pct + '%';
  if (txt) {
    txt.textContent = phase === 'done'
      ? `已完成 ${total} 项`
      : `正在导入并提取图标… ${done} / ${total}`;
  }
  if (pctEl) pctEl.textContent = pct + '%';
}

function showDropProgress() {
  const veil = $('#dropVeil');
  if (!veil) return;
  veil.hidden = false;
  veil.classList.add('is-importing');
  const t = $('#dropTitle'); if (t) t.textContent = '正在导入…';
  const s = $('#dropSub'); if (s) s.textContent = '请稍候，正在解析快捷方式并提取图标';
  const ic = $('#dropIc'); if (ic) ic.textContent = '📥';
  setDropProgress('resolve', 0, 0);
}

function hideDropProgress() {
  const veil = $('#dropVeil');
  if (veil) { veil.hidden = true; veil.classList.remove('is-importing'); }
  const box = $('#dropProgress');
  if (box) box.hidden = true;
}

function markDropTarget(target) {
  $$('.nav-item.drop-on').forEach(el => el.classList.remove('drop-on'));
  state.dropGroupId = target ? target.id : null;
  if (target && target.el) target.el.classList.add('drop-on');
  const t = $('#dropTitle'); const s = $('#dropSub'); const ic = $('#dropIc');
  if (!t) return;
  if (target) {
    t.textContent = `放入分组：${target.name}`;
    s.textContent = '松开鼠标即导入到该分组';
    if (ic) ic.textContent = target.icon;
  } else {
    t.textContent = '松开即可导入';
    s.textContent = '或用鼠标拖到左侧分组上，指定放入哪个分组';
    if (ic) ic.textContent = '📥';
  }
}

function resetDrag() {
  dragDepth = 0;
  state.dropGroupId = null;
  hideDropVeil();
  $$('.nav-item.drop-on').forEach(el => el.classList.remove('drop-on'));
}

async function handleDrop(e) {
  const target = dropTargetInfo(e);
  const { paths, urls } = extractDrop(e);
  const dry = !!state.dropDryRun;
  state.dropDryRun = false;
  resetDrag();

  if (!paths.length && !urls.length) {
    toast('bad', '没有识别到可导入的内容', '支持快捷方式、程序、文件夹与网址');
    return;
  }
  // 导入中又拖进来一批：直接忽略（否则两批同时写配置，还会互相抢进度条）
  if (state.importingDrop) return;

  console.log('[drop] 识别到', paths.length, '个路径 /', urls.length, '个网址');

  state.importingDrop = true;
  if (!dry) showDropProgress();

  let r;
  try {
    r = await API.importDropped({ paths, urls, groupId: target ? target.id : null, dryRun: dry });
  } catch (err) {
    state.importingDrop = false;
    hideDropProgress();
    return toast('bad', '导入失败', (err && err.message) || '');
  }
  state.importingDrop = false;
  hideDropProgress();

  if (!r.ok) return toast('bad', '导入失败', r.msg || '');
  if (r.dryRun) {
    console.log('[drop] 探针模式：已送达主进程，未写入配置');
    return;
  }

  if (!r.added) {
    const why = (r.skipped && r.skipped.length)
      ? `已在列表中：${r.skipped.slice(0, 3).join('、')}${r.skipped.length > 3 ? ' 等' : ''}`
      : '没有可导入的项';
    return toast('info', '没有新增启动项', why);
  }

  // 跳到落点分组，保证新卡片一定在视野里
  if (r.groupId) state.active = r.groupId;
  await refresh();

  const ids = new Set((r.ids || []).map(x => x.id));
  $$('.card', $('#gridHost')).forEach(c => {
    if (ids.has(c.dataset.id)) c.classList.add('flash');
  });

  const tail = [];
  if (r.skipped && r.skipped.length) tail.push(`跳过重复 ${r.skipped.length} 项`);
  if (r.failed && r.failed.length) tail.push(`无法识别 ${r.failed.length} 项`);
  if (r.truncated) tail.push(`超出上限 ${r.truncated} 项未导入`);
  toast('ok', `已导入 ${r.added} 个启动项`,
    `分组：${r.groupName || '拖入的快捷方式'}${tail.length ? ' · ' + tail.join(' · ') : ''}`);
}

/* ------------------------------------------------------------ 扫描 */

function renderScanList() {
  const q = state.scanQuery.toLowerCase();
  const list = state.scan.filter(it =>
    !q || it.name.toLowerCase().includes(q) || it.path.toLowerCase().includes(q));
  $('#scanList').innerHTML = list.length ? list.map(it => {
    const on = state.scanPicked.has(it.path);
    return `<div class="scan-item ${on ? 'on' : ''}" data-path="${esc(it.path)}">
      <div class="cb">${on ? '✓' : ''}</div>
      <div class="si-txt"><b>${esc(it.name)}</b><span>${esc(it.path)}</span></div>
      <span class="src-tag">${esc(it.source)}</span>
    </div>`;
  }).join('') : '<div style="padding:30px;text-align:center;color:var(--text-3);font-size:13px">没有匹配的软件</div>';
  $('#scanCount').textContent = `已选 ${state.scanPicked.size} 项 · 共 ${state.scan.length} 个候选`;
}

async function openScan() {
  if (state.importing) return;   // 导入中重开会把进度和已冻结的勾选一起冲掉
  $('#scanOverlay').hidden = false;
  $('#scanSub').textContent = '正在读取开始菜单与注册表…';
  $('#scanList').innerHTML = '<div class="skeleton" style="height:56px;margin-bottom:6px"></div>'.repeat(6);
  state.scanPicked = new Set();
  const items = await API.scan(false);
  state.scan = items || [];
  $('#scanSub').textContent = `共找到 ${state.scan.length} 个候选程序，勾选后导入`;
  renderScanList();
}

/** 导入期间锁住扫描弹窗：这时正在逐项提图标 + 最后写盘，关掉就是丢进度。 */
function overlayLocked(o) {
  return !!(state.importing && o && o.id === 'scanOverlay');
}

/** 进度条 + 计数。total 为 0 时按 0% 处理，不除零。 */
function setScanProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const bar = $('#scanBar');
  if (bar) bar.style.width = pct + '%';
  const t = $('#scanProgressText');
  if (t) t.textContent = done >= total ? `已完成 ${total} 项，正在保存…` : `正在导入并提取图标… ${done} / ${total}`;
  const p = $('#scanProgressPct');
  if (p) p.textContent = pct + '%';
}

/**
 * 进出"导入中"状态：显示/收起进度条，并把所有会打断导入的入口一起禁掉
 * （取消 / 关闭叉 / 全选 / 全不选 / 筛选 / 列表勾选 / 导入按钮）。
 */
function setScanBusy(on) {
  state.importing = !!on;
  ['#btnScanImport', '#btnScanAll', '#btnScanNone', '#scanQ'].forEach(sel => {
    const el = $(sel);
    if (el) el.disabled = !!on;
  });
  const ov = $('#scanOverlay');
  if (ov) ov.querySelectorAll('[data-close]').forEach(b => { b.disabled = !!on; });
  const imp = $('#btnScanImport');
  if (imp) imp.textContent = on ? '正在导入…' : '导入到分组';
  const box = $('#scanProgress');
  if (box) box.hidden = !on;
  if (on) setScanProgress(0, 1);
  if (ov) ov.classList.toggle('is-busy', !!on);
}

async function importScan() {
  // ★ 三重保险：正在导入时再点一次直接不理（否则会重复导入一整批）
  if (state.importing) return;
  if (!state.scanPicked.size) return toast('info', '还没有勾选任何软件');

  let g = state.config.groups.find(x => x.id === 'scanned');
  if (!g) {
    g = { id: 'scanned', name: '已安装软件', icon: '📦', color: PALETTE[2], items: [] };
    state.config.groups.push(g);
  }

  // 先把要导入的挑出来（按列表顺序），勾选集合在这一刻就"冻结"了
  const have = new Set(allItems().map(x => (x.i.path || '').toLowerCase()));
  const picked = [];
  for (const it of state.scan) {
    if (!state.scanPicked.has(it.path)) continue;
    const key = it.path.toLowerCase();
    if (have.has(key)) continue;
    have.add(key);            // 同一次勾选里若有重复路径，也只加一次
    picked.push(it);
  }
  if (!picked.length) {
    $('#scanOverlay').hidden = true;
    return toast('info', '这些软件都已经在列表里了', '没有重复添加');
  }

  // 先按顺序把槽位占好，再并发去提图标；结果写回各自的槽位 → 顺序与候选列表一致
  const slots = picked.map(it => ({
    id: uid(), name: it.name, icon: '🚀', type: 'app', path: it.path,
    args: '', cwd: '', desc: it.source, elevate: false, console: false,
    favorite: false, useCount: 0, lastUsed: 0,
  }));

  const total = slots.length;
  let done = 0;
  setScanBusy(true);
  const queue = slots.slice();
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      // 尝试提取程序自带默认 ICO（取不到就保持 emoji 兜底）
      try {
        const r = await API.iconDefault(s.path);
        if (r && r.ok && r.dataUrl) s.icon = r.dataUrl;
      } catch { /* 单项失败不影响整批 */ }
      done++;
      setScanProgress(done, total);
    }
  };
  // 6 路并发：两百多项串行要十几秒，用户会以为卡死
  await Promise.all(Array.from({ length: Math.min(6, total) }, worker));

  g.items.push(...slots);
  setScanProgress(total, total);
  const r = await API.saveConfig(state.config);
  setScanBusy(false);
  if (!r.ok) return toast('bad', '导入失败', r.msg);
  $('#scanOverlay').hidden = true;
  toast('ok', `已导入 ${slots.length} 个启动项`, '分组：已安装软件');
  state.active = 'scanned';
  await refresh();
}

/* ------------------------------------------------------------ 清理无效项 */
/*
 * 分流规则**只在主进程**（src/lib/prune.js）：这里只负责展示、勾选、发 id。
 * ★ 默认只勾「确定失效」那一组；存疑组（U 盘没插 / 网络盘 / 裸命令 / 没权限）
 *   一律不预选，勾了也只能由用户自己动手 —— 误删的代价远大于多点两下。
 */

const PRUNE_HINT_OK = '路径不存在';
const PRUNE_HINT_WARN = '存疑，默认不动';

function pruneRows() {
  return state.prune.rows || [];
}

function renderPruneList() {
  const rows = pruneRows();
  const certain = rows.filter(r => r.level === 'certain');
  const unsure = rows.filter(r => r.level === 'unsure');

  const line = r => {
    const on = state.prune.picked.has(r.id);
    return `<div class="scan-item ${on ? 'on' : ''} ${r.level === 'unsure' ? 'warn' : ''}" data-id="${esc(r.id)}">
      <div class="cb">${on ? '✓' : ''}</div>
      <div class="si-txt"><b>${esc(r.name)}<span class="gsrc">${esc(r.gname)}</span></b>
        <span>${esc(r.path || '（空）')}</span></div>
      <span class="src-tag ${r.level === 'unsure' ? 'warn' : 'bad'}">${esc(r.reason)}</span>
    </div>`;
  };

  let html = '';
  if (certain.length) {
    html += `<div class="prune-sec"><span>确定失效 · ${certain.length}</span>
      <em>路径真的不存在了，可以安全清理</em></div>` + certain.map(line).join('');
  }
  if (unsure.length) {
    html += `<div class="prune-sec warn"><span>存疑 · ${unsure.length}</span>
      <em>${PRUNE_HINT_WARN}：看不到 ≠ 不存在，确认过再勾</em></div>` + unsure.map(line).join('');
  }
  if (!rows.length) {
    html = `<div class="prune-empty">没有发现无效项 —— 每一项的路径都还在。</div>`;
  }
  $('#pruneList').innerHTML = html;

  const n = state.prune.picked.size;
  $('#pruneCount').textContent = rows.length
    ? `已选 ${n} 项 · 确定失效 ${certain.length} 项 / 存疑 ${unsure.length} 项`
    : '已选 0 项';
  const go = $('#btnPruneGo');
  if (go) {
    go.disabled = !n || state.prune.busy;
    go.textContent = n ? `清理选中 ${n} 项` : '清理选中项';
  }
  $('#btnPruneAll').disabled = !certain.length || state.prune.busy;
  $('#btnPruneNone').disabled = !n || state.prune.busy;
}

async function openPrune() {
  state.prune = { rows: [], picked: new Set(), last: null, busy: false };
  $('#pruneOverlay').hidden = false;
  $('#pruneResult').hidden = true;
  $('#pruneList').hidden = false;
  $('#pruneBar').hidden = false;
  $('#btnPruneUndo').hidden = true;
  $('#btnPruneGo').hidden = false;
  $('#pruneSub').textContent = '正在逐项检查路径…';
  $('#pruneList').innerHTML = '<div class="skeleton" style="height:56px;margin-bottom:6px"></div>'.repeat(4);
  $('#pruneCount').textContent = '已选 0 项';

  const r = await API.scanInvalid();
  if (!r || !r.ok) {
    $('#pruneSub').textContent = '检查失败：' + ((r && r.msg) || '未知错误');
    $('#pruneList').innerHTML = '<div class="prune-empty">没能读出清单，请稍后再试。</div>';
    return;
  }
  state.prune.rows = [
    ...(r.certain || []).map(x => Object.assign({ level: 'certain' }, x)),
    ...(r.unsure || []).map(x => Object.assign({ level: 'unsure' }, x)),
  ];
  // ★ 默认只勾「确定失效」
  state.prune.picked = new Set((r.certain || []).map(x => x.id));
  const n = state.prune.rows.length;
  $('#pruneSub').textContent = n
    ? `共 ${n} 项需要看一眼：${(r.certain || []).length} 项确定失效、${(r.unsure || []).length} 项存疑`
    : '每一项的路径都还在，不用清理';
  renderPruneList();
}

function togglePrunePick(id) {
  if (state.prune.busy) return;
  if (state.prune.picked.has(id)) state.prune.picked.delete(id);
  else state.prune.picked.add(id);
  renderPruneList();
}

async function runPrune() {
  if (state.prune.busy) return;
  const ids = [...state.prune.picked];
  if (!ids.length) return toast('info', '还没有勾选任何项');

  const rows = pruneRows().filter(r => state.prune.picked.has(r.id));
  const sure = rows.filter(r => r.level === 'certain').length;
  const doubt = rows.length - sure;
  const sample = rows.slice(0, 4).map(r => `· ${r.name}`).join('\n');
  const ok = await confirmDialog({
    icon: '🧹',
    title: `清理这 ${rows.length} 项？`,
    text: `会从各自的分组里移除。清理前会把完整内容备份到 data\\backup\\，清理完可以一键撤销。`
      + (doubt ? `\n\n其中 ${doubt} 项属于「存疑」（${sure} 项确定失效）—— 存疑项请你再确认一遍真的不需要了。` : '')
      + `\n\n${sample}${rows.length > 4 ? '\n· …' : ''}`,
    okText: '清理',
  });
  if (!ok) return;

  state.prune.busy = true;
  renderPruneList();
  const r = await API.pruneInvalid(ids);
  state.prune.busy = false;

  if (!r || !r.ok) {
    renderPruneList();
    return toast('bad', '清理失败', (r && r.msg) || '未知错误');
  }

  const removed = r.removed || [];
  state.prune.last = removed.length ? removed : null;
  // 主进程可能因为"重判后已经不算失效"而跳过一些，如实告诉用户
  const skipped = r.skipped || [];
  $('#pruneList').hidden = true;
  $('#pruneBar').hidden = true;
  $('#pruneResult').hidden = false;
  $('#pruneResult').innerHTML = removed.length
    ? `<div class="prune-done">
         <div class="pd-ic">✓</div>
         <div>
           <b>已清理 ${removed.length} 项</b>
           <p>备份：<code>${esc(r.backup || '')}</code></p>
           ${skipped.length ? `<p class="muted-note">另有 ${skipped.length} 项在复查时已不算失效，没有动：${esc(skipped.map(s => s.name).slice(0, 6).join('、'))}</p>` : ''}
           <p class="muted-note">需要的话，点右下角「撤销这次清理」就能原样放回去。</p>
         </div>
       </div>`
    : `<div class="prune-empty">没有动任何东西：这些项在复查时都已经不算失效了。</div>`;
  $('#pruneCount').textContent = removed.length ? `已清理 ${removed.length} 项` : '未改动';
  $('#btnPruneGo').hidden = true;
  $('#btnPruneUndo').hidden = !removed.length;
  $('#pruneSub').textContent = removed.length ? '清理完成' : '没有需要清理的项';

  if (removed.length) {
    toast('ok', `已清理 ${removed.length} 项`, '可在弹窗里撤销');
    await refresh();
  }
}

async function undoPrune() {
  const last = state.prune.last;
  if (!last || !last.length) return;
  const ok = await confirmDialog({
    icon: '↩️',
    title: `把 ${last.length} 项放回去？`,
    text: '会按清理前的位置放回各自的分组（顺序追加到该分组末尾）。',
    okText: '撤销清理',
    danger: false,
  });
  if (!ok) return;
  const r = await API.restoreItems(last.map(x => ({ gid: x.gid, item: x.item })));
  if (!r || !r.ok) return toast('bad', '撤销失败', (r && r.msg) || '未知错误');
  state.prune.last = null;
  $('#btnPruneUndo').hidden = true;
  $('#pruneOverlay').hidden = true;
  toast('ok', `已放回 ${r.restored || 0} 项`);
  await refresh();
}

/* ------------------------------------------------------------ 设置 */

function accelFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  const k = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta', 'CapsLock'].includes(k)) return null;
  let key = k;
  if (k === ' ') key = 'Space';
  else if (k.length === 1) key = k.toUpperCase();
  else {
    const map = {
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Escape: 'Esc', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace',
      Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
      PageUp: 'PageUp', PageDown: 'PageDown',
    };
    key = map[k] || (k.startsWith('F') && k.length <= 3 ? k : '');
  }
  if (!key) return null;
  if (!mods.length) return null;
  return mods.join('+') + '+' + key;
}

/** 填充「启动时打开」下拉。真实分组的 option.value 用 viewToCode 那套编码（g: 前缀）。 */
function renderStartGroupOptions(current) {
  const sel = $('#sStartGroup');
  const fixed = [
    ['last', '记住上次打开的分组（推荐）'],
    ['all', '全部'],
    ['recent', '最近使用'],
    ['fav', '收藏'],
  ];
  let html = fixed.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('');
  if (state.config.groups.length) {
    html += '<optgroup label="指定分组">'
      + state.config.groups.map(g =>
        // option.value 走 viewToCode，和 startViewFromSettings 的读法是同一套编码
        `<option value="${esc(viewToCode(g.id))}">${esc(g.icon || '📦')} ${esc(g.name)}</option>`).join('')
      + '</optgroup>';
  }
  sel.innerHTML = html;
  // 上次选的分组可能已经被删了 —— 退回「记住上次」，别留一个空选项
  const want = current || 'last';
  sel.value = [...sel.options].some(o => o.value === want) ? want : 'last';
}

async function openSettings() {
  const s = state.config.settings;
  $('#sHotkey').value = s.hotkey || '';
  $('#sHotkeyOn').checked = !!s.hotkeyEnabled;
  $('#sAutostart').checked = !!s.autostart;
  $('#sCloseAction').value = s.closeAction || 'tray';
  $('#sTrayQuick').value = s.trayQuick || 'top';
  $('#sHoverActs').checked = !!s.hoverActions;
  $('#sAutoUpdate').checked = s.autoUpdate !== false;
  $('#sUpdateBase').value = s.updateBase || '';
  setUpdateBaseMsg('', '');
  renderStartGroupOptions(s.startGroup);
  state.capturedHotkey = s.hotkey || '';
  setHotkeyMsg('', '');

  state.info = await API.info();
  const i = state.info;
  // 设置里只保留「数据没落在程序目录」这一条需要用户知道的信息；
  // 其余运行环境细节在「关于」窗口里（点左下角版本号）。
  const warn = dataWarnText(i);
  const dw = $('#setDataWarn');
  dw.hidden = !warn;
  if (warn) dw.innerHTML = `<b>数据未写在程序目录</b>　${esc(warn)}`;

  if (i.hotkeyFail) setHotkeyMsg(`热键注册失败：${i.hotkeyFail}`, 'warn');
  $('#setOverlay').hidden = false;
}

/** 运行形态的中文名。**只有这一份** —— 侧栏状态行、「关于」窗口、复制的诊断信息
 *  全从 formText() 取，免得两边各写一套、迟早不一致。 */
const FORM_TXT = {
  dev: '开发模式',
  portable: '便携版（单文件 exe）',
  installed: '安装版',
  green: '绿色版',
};

function formText(i) {
  const f = i && i.form;
  return FORM_TXT[f] || ((i && i.packaged) ? '已打包' : '开发模式');
}

/** 侧栏底部状态行的文案。**它不是网络状态** —— 程序唯一的网络行为是启动时查一次更新。
 *  这里只写版本号（运行形态在「关于」里有，首页不必重复；查到新版本时再追加「· 可更新」），
 *  点它打开「关于」。state.info 还没到手时只能说「初始化…」，不能先猜一个版本号出来。 */
function statusText(i) {
  if (PREVIEW) return '预览模式（非桌面版）';
  if (!i || !i.version) return '初始化…';
  return `v${i.version}`;
}

/** 「关于」窗口的内容，按语义分三组。抽成独立函数有两个原因：
 *  ① --info-probe 能直接验它（渲染层最容易出的错就是主进程少给一个字段 → 打出 undefined）；
 *  ② 界面渲染和「复制诊断信息」共用同一份数据，不会一个改了另一个没改。 */
function aboutGroups(i) {
  return [
    { title: '程序', rows: [
      { k: '版本', v: `v${i.version}` },
      { k: '运行形态', v: formText(i) },
      { k: '可执行文件', v: i.exePath },
    ] },
    { title: '环境', rows: [
      { k: 'Electron', v: i.electron },
      { k: 'Chromium', v: i.chrome },
      { k: 'Node', v: i.node },
    ] },
    { title: '数据', rows: [
      { k: '数据目录', v: i.dataDir || '(未知)' },
      { k: '配置文件', v: i.configFile },
      { k: '开机自启', v: i.autostart ? '已启用' : '未启用' },
    ] },
  ];
}

/** 数据没落在程序目录时的说明文字；正常情况返回空串。
 *  设置面板的警示条、状态行的黄点、「关于」里的提示、复制的诊断信息
 *  四处共用它 —— 判断条件只写一遍。 */
function dataWarnText(i) {
  return (i && i.packaged && !i.dataInProgramDir) ? (i.dataNote || '数据未写在程序目录') : '';
}

/** 组装「关于」的纯文本。「复制诊断信息」和 --info-probe 都走它，
 *  验的就是用户真会贴出去的那段字（不能有 undefined）。 */
function envLines(i) {
  const lines = [];
  aboutGroups(i).forEach(g => {
    lines.push(`【${g.title}】`);
    g.rows.forEach(r => lines.push(`${r.k.padEnd(10)}${r.v}`));
  });
  // 更新信息也进诊断信息：用户报"更新失败"时，这段字里有状态、更新源和日志目录
  const u = state.update || (i && i.update);
  if (u) {
    lines.push('【更新】');
    updateRows(u).forEach(r => lines.push(`${r.k.padEnd(10)}${r.v}`));
  }
  const warn = dataWarnText(i);
  if (warn) lines.push(`注意      ${warn}`);
  return lines;
}

/** 打开「关于」：渲染分组表格 + 更新块 + 数据回落提示。 */
async function openAbout() {
  state.info = await API.info();
  const i = state.info;
  // 主进程在响应里带了一份更新快照；只有在本地还没有（或还没收到事件）时才采用它，
  // 免得用一份更旧的快照盖掉刚推过来的新状态。
  if (i.update && !state.update) state.update = i.update;
  $('#abVer').textContent = `v${i.version}`;
  $('#abSub').textContent = `${formText(i)} · Electron ${i.electron}`;
  $('#abGrid').innerHTML = aboutGroups(i).map(g => `
    <section class="about-sec">
      <h3>${esc(g.title)}</h3>
      ${g.rows.map(r => `<div class="about-row"><span class="k">${esc(r.k)}</span>`
        + `<span class="v">${esc(r.v)}</span></div>`).join('')}
    </section>`).join('');
  renderUpdate();
  const warn = dataWarnText(i);
  const wb = $('#abWarn');
  wb.hidden = !warn;
  if (warn) wb.innerHTML = `<b>数据未写在程序目录</b>　${esc(warn)}`;
  $('#aboutOverlay').hidden = false;
  return i;
}

/** 复制诊断信息到剪贴板（走主进程 clipboard，file:// 下 navigator.clipboard 不稳）。 */
async function copyDiag() {
  if (!state.info) { try { state.info = await API.info(); } catch { /* 忽略 */ } }
  if (!state.info) { toast('bad', '拿不到运行环境信息'); return; }
  let r = null;
  try { r = await API.copyText(envLines(state.info).join('\n')); } catch { /* 忽略 */ }
  if (r && r.ok) toast('ok', '诊断信息已复制');
  else toast('bad', '复制失败', '可以手动选中文字后 Ctrl+C。');
}

function setHotkeyMsg(msg, cls) {
  const el = $('#hotkeyMsg');
  el.textContent = msg;
  el.className = 'hint-line' + (cls ? ' ' + cls : '');
}

/* ------------------------------------------------------------ 自更新
 *
 * 界面**不自己拼更新状态** —— 主进程推的快照（state.update）是唯一来源：
 * 只有它知道清单、方案、进度、暂存区。这里只做两件事：把快照画出来、把用户的
 * 点击转成一个 API 调用。
 *
 * ★ 下载与安装永远等用户点（检查才是自动的）。所以这里的按钮不是"装饰"：
 *   「下载」和「重启并更新」是用户唯一的动手入口，必须一直看得见。
 */

const seenNotices = new Set();      // 已弹过的"上次更新结果"（按 notice.key 去重）
const announcedVers = new Set();    // 已提示过的新版本号（同一个版本不唠叨第二次）

/** 状态行是否该显示"可更新"。只有"发现了"和"已下好"两种算 ——
 *  「已是最新」不值得占用侧栏唯一那行字。 */
function updAlert(u) {
  return !!u && u.supported && (u.status === 'available' || u.status === 'staged');
}

/** 侧栏底部状态行：版本 · 运行形态（· 可更新）。
 *  ★ 为什么把更新提示也放这行：这是唯一常驻的位置。更新默认**不自动下载**，
 *    不提示的话用户永远不会知道有新版本 —— 那就等于没有这个功能。 */
function paintStatusLine() {
  const conn = $('#conn');
  if (!conn) return;
  const i = state.info;
  const u = state.update;
  const warn = i ? dataWarnText(i) : '';
  const alert = updAlert(u);
  conn.className = 'conn ' + (warn ? 'warn' : alert ? 'upd' : 'ok');
  conn.querySelector('span').textContent = statusText(i) + (alert ? ' · 可更新' : '');
  const bits = [];
  if (warn) bits.push(warn);
  if (alert) {
    bits.push(u.status === 'staged'
      ? `已下好 v${u.latest}，重启即可更新`
      : `发现新版本 v${u.latest}，在「关于」里下载`);
  }
  conn.title = bits.length ? `查看版本与运行环境（${bits.join('；')}）` : '查看版本与运行环境';
}

/** 「关于」里的更新块。独立成函数是因为主进程推新状态时要能**原地重绘**，
 *  而不是重开一次窗口。 */
function renderUpdate() {
  const box = $('#abUpd');
  if (!box) return;
  const u = state.update;
  const st = $('#abUpdState');
  const msg = $('#abUpdMsg');
  const bar = $('#abUpdBar');

  if (!u) {
    st.textContent = '—';
    st.className = 'upd-state';
    msg.innerHTML = '<span>还拿不到更新状态。</span>';
  } else if (!u.supported) {
    st.textContent = '不支持';
    st.className = 'upd-state off';
    msg.innerHTML = `<span>${esc(u.unsupportedReason || '当前运行形态不支持自动更新。')}</span>`;
  } else {
    st.textContent = u.statusText;
    st.className = 'upd-state'
      + (updAlert(u) ? ' hot' : (u.status === 'failed' ? ' bad' : ''));
    const head = [];
    if (u.latest) head.push(`目标 v${u.latest}`);
    if (u.plan) head.push(`${u.plan.mode === 'delta' ? '增量包' : '完整包'} ${u.plan.sizeText}`);
    if (u.checkedAtText) head.push(`上次检查 ${u.checkedAtText}`);
    const rows = [];
    if (head.length) rows.push(`<b>${esc(head.join(' · '))}</b>`);
    // 下载中就把进度数字写在这里 —— 进度条只给出"多长"，说不出"多少 MB"
    if (u.progress && u.progress.text) rows.push(`<span>${esc(u.progress.text)}</span>`);
    if (u.reason) rows.push(`<span>${esc(u.reason)}</span>`);
    if (u.baseError) rows.push(`<span class="bad">更新源配置有误：${esc(u.baseError)}</span>`);
    msg.innerHTML = rows.join('') || '<span>还没有检查过更新。</span>';
  }

  const p = u && u.progress;
  bar.hidden = !p;
  if (p) $('#abUpdBarIn').style.width = (p.pct == null ? 100 : p.pct) + '%';

  const check = $('#abUpdCheck');
  check.disabled = !(u && u.canCheck);
  check.textContent = u && u.status === 'checking' ? '检查中…' : '检查更新';
  $('#abUpdDown').hidden = !(u && u.canDownload);
  $('#abUpdApply').hidden = !(u && u.canApply);
  // 有暂存区或有失败记录时才给"打开更新目录" —— 那里有 apply-<版本>.log
  $('#abUpdLog').hidden = !(u && (u.status === 'staged' || u.status === 'failed'));
}

/** 收到一份新快照：存下来 → 重绘关于块 → 重绘状态行 → 该提示的提示一次 */
function applyUpdateState(u) {
  state.update = u || null;
  renderUpdate();
  paintStatusLine();
  if (!u) return;

  // ① 上次更新的结果（更新成功 / 上次失败）—— 主进程已保证"只报一次"，这里再去一次重
  if (u.notice && u.notice.key && !seenNotices.has(u.notice.key)) {
    seenNotices.add(u.notice.key);
    toast(u.notice.kind === 'failed' ? 'bad' : 'ok', u.notice.title, u.notice.text || '');
  }
  // ② 发现新版本 → 提示一次（同一个版本只说一次；用户点「检查更新」时也走这里）
  if (u.status === 'available' && u.latest && !announcedVers.has(u.latest)) {
    announcedVers.add(u.latest);
    toast('info', `发现新版本 v${u.latest}`, '在「关于」里可以下载；下载与安装都由你决定。');
  }
}

/** 主动向主进程要一次最新快照（事件可能在我们注册之前就推过了） */
async function refreshUpdateState() {
  try { applyUpdateState(await API.updateState()); } catch { /* 拿不到就保持现状 */ }
}

/** 供「关于」和「复制诊断信息」共用的更新信息行。★ 值一律是字符串：
 *  这里出现一个 undefined，整段诊断信息就废了（--info-probe 专门盯这个）。 */
function updateRows(u) {
  if (!u) return [{ k: '更新', v: '(未就绪)' }];
  return [
    { k: '自更新', v: u.supported ? '支持' : `不支持：${u.unsupportedReason || '未知原因'}` },
    { k: '更新状态', v: u.statusText + (u.latest ? `（目标 v${u.latest}）` : '') },
    { k: '更新源', v: u.baseError ? `配置有误：${u.baseError}` : (u.base || '(默认)') },
    { k: '自动检查', v: u.autoUpdate ? '已开启（仅启动时一次）' : '已关闭' },
    { k: '上次检查', v: u.checkedAtText || '尚未检查' },
    { k: '更新目录', v: u.dir || '(未知)' },
  ];
}

function setUpdateBaseMsg(msg, cls) {
  const el = $('#updateBaseMsg');
  if (!el) return;
  el.textContent = msg;
  el.className = 'hint-line' + (cls ? ' ' + cls : '');
}

/** 绑定「关于」里的更新按钮。**只在这里绑一次**（renderUpdate 只改内容不改结构）。 */
function bindUpdate() {
  $('#abUpdCheck').addEventListener('click', async () => {
    const r = await API.updateCheck();
    if (r && r.unsupported) return;              // 不支持时状态块里已经写清原因，不再弹
    if (!r || !r.ok) return toast('bad', '检查更新失败', (r && r.reason) || '');
    // ★ 「发现新版本」**只由 applyUpdateState 报一次**：它按版本号去重，而且自动检查、
    //   手动检查、主进程主动推送三条路都汇到它那里。这里再弹一条就会同屏出现两个气泡
    //   （--update-probe 的截图里真的同时拍到过两个"发现新版本 v1.2.0"）。
    //   只有「已是最新」要在这里说 —— 它是对"你点了这个按钮"的回执，没有别的来源。
    if (!r.available) toast('ok', '已是最新版本', r.reason || '');
  });

  $('#abUpdDown').addEventListener('click', async () => {
    toast('info', '开始下载', '下完还需要你点一次「重启并更新」才会换文件。');
    const r = await API.updateDownload();
    if (!r || !r.ok) toast('bad', '下载没成功', (r && r.reason) || '');
  });

  $('#abUpdApply').addEventListener('click', async () => {
    const yes = await confirmDialog({
      icon: '⬆',
      title: '重启并更新？',
      text: '程序会立刻退出，由一个后台助手替换文件，然后自动重新打开。'
        + '替换过程不会碰你的配置（data 目录）。',
      okText: '重启并更新',
      danger: false,
    });
    if (!yes) return;
    // 主进程要先确认后台助手真的起来了才退出（最多几秒）—— 这段空档必须有反馈，
    // 否则界面看起来就像"点了没反应"。
    toast('info', '正在交接更新助手', '确认助手已启动后，程序会自动退出并替换文件。');
    const r = await API.updateApply();
    if (!r || !r.ok) toast('bad', '没能开始更新', (r && r.reason) || '');
  });

  $('#abUpdLog').addEventListener('click', () => {
    const dir = state.update && state.update.dir;
    if (!dir) return;
    API.openFolder(dir).then(r => { if (!r || !r.ok) toast('bad', '打不开更新目录'); });
  });
}

/**
 * 「恢复默认分组」：误删「文件与目录 / 系统工具 / 开发 / 常用网站」之后的后悔药。
 * ★ 只补不删（主进程 store.restoreDefaults）：用户自建的分组、改过的名字、
 *   收藏与使用次数都不动 —— 恢复是加法，不是重置。
 */
async function restoreDefaultGroups() {
  const yes = await confirmDialog({
    icon: '♻️',
    title: '恢复默认分组？',
    text: '会把缺失的默认分组与默认启动项补回来。不会删除、重命名或修改你现有的任何分组和启动项。',
    okText: '恢复',
    danger: false,
  });
  if (!yes) return;

  const r = await API.restoreDefaults();
  if (!r || r.ok === false) return toast('bad', '恢复失败', (r && r.msg) || '');
  if (!r.groupsAdded && !r.itemsAdded) {
    return toast('info', '已经是默认状态', '没有缺失的默认分组或启动项');
  }
  await refresh();
  renderStartGroupOptions(state.config.settings.startGroup);
  toast('ok', `已补回 ${r.itemsAdded} 个默认启动项`, r.groups.join('、'));
}

async function saveSettings() {
  const updateBase = $('#sUpdateBase').value.trim();
  if (updateBase && !/^https?:\/\//i.test(updateBase)) {
    setUpdateBaseMsg('更新源要以 http:// 或 https:// 开头；留空表示用官方 GitHub。', 'warn');
    return toast('bad', '更新源不合法', '改好再保存。');
  }
  setUpdateBaseMsg('', '');
  const patch = {
    hotkey: state.capturedHotkey || '',
    hotkeyEnabled: $('#sHotkeyOn').checked,
    autostart: $('#sAutostart').checked,
    closeAction: $('#sCloseAction').value,
    trayQuick: $('#sTrayQuick').value,
    hoverActions: $('#sHoverActs').checked,
    autoUpdate: $('#sAutoUpdate').checked,
    updateBase,
    startGroup: $('#sStartGroup').value || 'last',
    theme: document.documentElement.dataset.theme,
  };
  const r = await API.setSettings(patch);
  if (!r.ok) return toast('bad', '保存失败', r.msg);
  Object.assign(state.config.settings, r.settings || patch);
  applySettingsToDom(state.config.settings);

  if (r.hotkey) {
    if (r.hotkey.ok && patch.hotkeyEnabled && patch.hotkey) {
      setHotkeyMsg(r.hotkey.msg, 'good');
      toast('ok', '设置已保存', r.hotkey.msg);
    } else if (!r.hotkey.ok) {
      setHotkeyMsg(r.hotkey.msg, 'warn');
      toast('bad', '热键未生效', r.hotkey.msg);
    } else {
      setHotkeyMsg('已关闭全局热键', '');
      toast('ok', '设置已保存');
    }
  } else {
    toast('ok', '设置已保存');
  }
  $('#setOverlay').hidden = true;
}

/* ------------------------------------------------------------ 数据 */

/**
 * 把「只有计数变了」的新配置就地同步到界面，返回 true 表示不需要重绘（v1.5.2）。
 *
 * 起因：点一张卡片启动，主进程会给它 `useCount+1` / `lastUsed=now` 然后广播
 * `ql:config-changed`。以前收到广播就 `render()` 整块重建 —— 卡片全部重新创建、
 * 入场动画重播、每个 `<img>` 图标重新解码，观感就是"点一下软件，界面闪一下"。
 * 但真正要变的只有卡片上那一行「用过 N 次」。
 *
 * 判断方式：把三个纯计数/临时字段抹平成同一个值后做整体比对。
 * 只要别处还有任何差异（改名、增删、分组、设置……），就返回 false，让调用方老老实实重绘 ——
 * 宁可多绘一次，也不能漏掉用户的改动。
 *
 * ★ 按「使用次数 / 最近使用」排序时直接返回 false：顺序本身依赖这两个字段，
 *   就地改文本会和实际顺序对不上（这时走 noAnim 重绘，不播动画）。
 */
function softSync(next) {
  const cur = state.config;
  if (!cur || !next || !Array.isArray(next.groups)) return false;
  if (state.q) return false;                                    // 搜索中：匹配结果可能变
  if (state.sort === 'uses' || state.sort === 'recent') return false;

  const flatten = cfg => JSON.stringify(cfg, (k, v) =>
    (k === 'useCount' || k === 'lastUsed' || k === '_exists') ? 0 : v);
  if (flatten(cur) !== flatten(next)) return false;             // 还有别的变化 → 去重绘

  // 到这里可以确定：差异只可能在计数上。逐张卡片改文本。
  const oldUse = new Map();
  cur.groups.forEach(g => (g.items || []).forEach(i => oldUse.set(i.id, i.useCount || 0)));

  const updates = [];
  for (const g of next.groups) {
    for (const i of (g.items || [])) {
      if ((oldUse.get(i.id) || 0) === (i.useCount || 0)) continue;
      const card = document.querySelector(`.card[data-id="${i.id}"]`);
      if (!card) continue;                                      // 不在当前视图里，无所谓
      const el = card.querySelector('.uses');
      if (!el) {
        if (!i.useCount) continue;
        // 第一次用（0 → 1 次）原来没有这个节点。与其整块重绘，不如就地补一个 ——
        // 位置与 cardHTML 一致（`.card-foot` 里的最后一个）。缺路径的卡不显示计数。
        if (card.querySelector('.missing')) continue;
        const foot = card.querySelector('.card-foot');
        if (!foot) return false;                                // 认不出的结构 → 老实重绘
        const span = document.createElement('span');
        span.className = 'uses';
        span.textContent = `用过 ${i.useCount} 次`;
        foot.appendChild(span);
        continue;
      }
      updates.push([el, i.useCount]);
    }
  }
  for (const [el, n] of updates) el.textContent = `用过 ${n} 次`;
  state.config = next;
  return true;
}

async function refresh(opts) {
  const next = await API.getConfig();
  // ★ v1.5.2：只有「用过 N 次 / 最近使用」这类计数变了的话，就地问一句卡片文本就够了。
  //   以前每次 config-changed 都整块重绘 —— 卡片全部重建、入场动画重播、图标重新解码，
  //   观感就是"点一下软件，界面闪一下"（点一次会走两遍，见 runItem 的注释）。
  if (opts && opts.soft && softSync(next)) return;
  state.config = next;
  state.sort = state.config.settings.sort || 'custom';
  $('#sort').value = state.sort;
  applyTheme(state.config.settings.theme || 'light');
  applySettingsToDom(state.config.settings);
  if (opts && opts.initView) {
    // 只在首次加载时套用「启动时打开」设置 —— 之后的 refresh 不能把用户
    // 手动切过去的视图又拽回来
    state.active = startViewFromSettings(state.config.settings);
  } else if (!isViewId(state.active)) {
    // 当前视图可能已经不存在了（分组被删 / 被别处改掉），兜底回「全部」
    state.active = 'all';
  }
  renderNav();
  render({ noAnim: !!(opts && (opts.noAnim || opts.soft)) });
  // 绿点 = 一切正常；红点 = 数据没落在程序目录（回落 %APPDATA%）；
  // 蓝点 = 有新版本可更新。文案是「版本 · 运行形态（· 可更新）」，点它打开「关于」。
  // ★ 这里曾经写「已连接」，会被读成"连上了服务器"——程序除了查更新不联网，已改掉。
  paintStatusLine();
}

async function persistSettings() {
  state.config.settings.theme = document.documentElement.dataset.theme;
  state.config.settings.sort = state.sort;
  const r = await API.setSettings({
    theme: state.config.settings.theme,
    sort: state.config.settings.sort,
  });
  if (!r.ok) await API.saveConfig(state.config);
}

/** 记住当前视图，供「启动时打开 → 记住上次打开的分组」使用。
 *  值与设置面板里的 startGroup 是同一套编码（见 viewToCode / viewFromCode）。
 *  只在真的变了才写盘 —— 每次点侧栏都写一遍太浪费（主进程那边还会重建托盘）。 */
function persistLastGroup(view) {
  const s = state.config && state.config.settings;
  if (!s) return;
  const enc = viewToCode(view);
  if (s.lastGroup === enc) return;
  s.lastGroup = enc;
  API.setSettings({ lastGroup: enc }).catch(() => { /* 记不住也不影响使用 */ });
}
const rememberGroup = persistLastGroup;

/* ------------------------------------------------------------ 事件 */

function bind() {
  /* 卡片 */
  $('#gridHost').addEventListener('click', e => {
    // 拖动/长按刚结束，别把这次 click 当启动
    if (state.suppressClick) {
      state.suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // 编辑模式：点卡片 = 勾选/取消勾选。必须排在「新建卡片」和右上角按钮之前，
    // 否则会误触发启动或编辑。
    if (state.editMode) {
      const pickable = e.target.closest('.card[data-id]');
      if (!pickable) return;
      e.preventDefault();
      return togglePick(pickable.dataset.id);
    }
    const add = e.target.closest('[data-add]');
    if (add) {
      const gid = (state.active === 'all' || state.active === 'recent' || state.active === 'fav') ? null : state.active;
      return openEdit(null, gid);
    }
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    const actBtn = e.target.closest('.act');
    if (actBtn) {
      e.stopPropagation();
      const act = actBtn.dataset.act;
      if (act === 'open') runItem(id);
      else if (act === 'fav') toggleFav(id);
      else if (act === 'del') deleteItem(id);
      else if (act === 'edit') { const f = findItem(id); if (f) openEdit(f.i, f.g.id); }
      else if (act === 'folder') {
        const f = findItem(id);
        if (!f) return;
        API.openFolder(f.i.path).then(r => { if (!r.ok) toast('bad', '无法定位', r.msg); });
      }
      return;
    }
    runItem(id);
  });

  $('#gridHost').addEventListener('keydown', e => {
    const card = e.target.closest('.card');
    if (!card) return;
    const cards = $$('.card', $('#gridHost'));
    const idx = cards.indexOf(card);
    // 编辑模式下 Enter/空格 = 勾选，而不是启动
    if (state.editMode) {
      if ((e.key === 'Enter' || e.key === ' ') && card.dataset.id) {
        e.preventDefault();
        return togglePick(card.dataset.id);
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const nx = cards[Math.min(idx + 1, cards.length - 1)];
        if (nx) nx.focus();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const pv = cards[Math.max(idx - 1, 0)];
        if (pv) pv.focus();
        return;
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (card.dataset.add) {
        const gid = (state.active === 'all' || state.active === 'recent' || state.active === 'fav') ? null : state.active;
        openEdit(null, gid);
      } else runItem(card.dataset.id);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nx = cards[Math.min(idx + 1, cards.length - 1)];
      if (nx) nx.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const pv = cards[Math.max(idx - 1, 0)];
      if (pv) pv.focus();
    } else if (e.key === 'Delete' && card.dataset.id) {
      deleteItem(card.dataset.id);
    } else if ((e.key === 'e' || e.key === 'E') && card.dataset.id) {
      const f = findItem(card.dataset.id);
      if (f) openEdit(f.i, f.g.id);
    } else if ((e.key === 'f' || e.key === 'F') && card.dataset.id) {
      toggleFav(card.dataset.id);
    }
  });

  /* 导航 */
  $('#nav').addEventListener('click', e => {
    if (e.target.closest('#navNewGroup')) { e.stopPropagation(); return createGroup(); }
    const btn = e.target.closest('[data-nav]');
    if (!btn) return;
    state.active = btn.dataset.nav;
    state.q = '';
    $('#q').value = '';
    // 换了视图就把勾选清掉：不然不可见的选中项会被一起批量删/移，属于数据事故
    if (state.editMode && state.picked.size) { state.picked.clear(); }
    rememberGroup(state.active);
    render();
  });

  /* 侧栏分组拖动排序（v1.4.7）：只有真实分组能拖、能当落点，
     「全部/最近/收藏」三个虚拟视图和「新建分组」都不参与 —— 顺序就是 groups 数组顺序。 */
  let dragNavId = null;
  const navGroupAt = e => {
    const btn = e.target.closest('[data-nav]');
    if (!btn) return null;
    return state.config.groups.find(g => g.id === btn.dataset.nav) || null;
  };
  const clearDropLine = () => {
    $$('.nav-item.drop-before, .nav-item.drop-after').forEach(el =>
      el.classList.remove('drop-before', 'drop-after'));
  };

  $('#nav').addEventListener('dragstart', e => {
    const g = navGroupAt(e);
    if (!g) { e.preventDefault(); return; }        // 虚拟视图 / 新建分组不许拖
    dragNavId = g.id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', g.id); } catch { /* Firefox 需要，缺了不触发拖 */ }
    }
    // 源行半透明：等下一帧再上，否则拖影会带上这个透明度
    const el = e.target.closest('[data-nav]');
    requestAnimationFrame(() => el && el.classList.add('dragging'));
  });

  $('#nav').addEventListener('dragover', e => {
    if (!dragNavId) return;
    const g = navGroupAt(e);
    clearDropLine();
    if (!g || g.id === dragNavId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const el = e.target.closest('[data-nav]');
    const rect = el.getBoundingClientRect();
    el.classList.add((e.clientY - rect.top) < rect.height / 2 ? 'drop-before' : 'drop-after');
  });

  $('#nav').addEventListener('drop', e => {
    const fromId = dragNavId;
    const g = navGroupAt(e);
    dragNavId = null;
    clearDropLine();
    $$('.nav-item.dragging').forEach(el => el.classList.remove('dragging'));
    if (!fromId || !g || g.id === fromId) return;
    e.preventDefault();
    const el = e.target.closest('[data-nav]');
    const rect = el.getBoundingClientRect();
    reorderGroup(fromId, g.id, (e.clientY - rect.top) < rect.height / 2);
  });

  $('#nav').addEventListener('dragend', () => {
    dragNavId = null;
    clearDropLine();
    $$('.nav-item.dragging').forEach(el => el.classList.remove('dragging'));
  });

  /* 搜索 */
  const q = $('#q');
  q.addEventListener('input', () => {
    state.q = q.value.trim();
    // 同理：列表内容变了，看不见的勾选不能留
    if (state.editMode && state.picked.size) state.picked.clear();
    render({ noAnim: true });   // 逐字过滤别重播入场动画（上千张卡会闪）
  });
  q.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = $('.card', $('#gridHost'));
      if (first) first.focus();
    } else if (e.key === 'Enter') {
      const first = $('.card:not(.add)', $('#gridHost'));
      if (first && first.dataset.id) runItem(first.dataset.id);
    }
  });

  $('#sort').addEventListener('change', e => { state.sort = e.target.value; render(); persistSettings(); });
  $('#btnAdd').addEventListener('click', () => {
    const gid = (state.active === 'all' || state.active === 'recent' || state.active === 'fav') ? null : state.active;
    openEdit(null, gid);
  });
  $('#btnTheme').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    persistSettings();
  });
  $('#btnSettings').addEventListener('click', openSettings);

  /* 多选编辑 */
  $('#btnSelect').addEventListener('click', () => setEditMode(!state.editMode));
  $('#ebDone').addEventListener('click', () => setEditMode(false));
  $('#ebAll').addEventListener('click', () => {
    visibleItemIds().forEach(id => state.picked.add(id));
    render();
    updateEditBar();
  });
  $('#ebNone').addEventListener('click', () => {
    state.picked.clear();
    render();
    updateEditBar();
  });
  $('#ebFavOn').addEventListener('click', () => batchFavorite(true));
  $('#ebFavOff').addEventListener('click', () => batchFavorite(false));
  $('#ebDel').addEventListener('click', batchDelete);
  $('#ebMove').addEventListener('change', async e => {
    const gid = e.target.value;
    e.target.value = '';            // 立刻复位，避免"选过一次就不能再选同一项"
    if (gid) await batchMove(gid);
  });

  /* 窗口控制 */
  $('#wcMin').addEventListener('click', () => API.win('minimize'));
  $('#wcMax').addEventListener('click', async () => {
    const r = await API.win('maximize');
    setWinMaxIcon(r && r.maximized);
  });
  $('#wcClose').addEventListener('click', () => API.win('close'));

  /* 扫描 */
  $('#btnScan').addEventListener('click', openScan);
  $('#scanQ').addEventListener('input', e => { state.scanQuery = e.target.value.trim(); renderScanList(); });
  $('#scanList').addEventListener('click', e => {
    if (state.importing) return;   // 导入中不再改勾选（这一批已经冻结了）
    const row = e.target.closest('.scan-item');
    if (!row) return;
    const p = row.dataset.path;
    state.scanPicked.has(p) ? state.scanPicked.delete(p) : state.scanPicked.add(p);
    renderScanList();
  });
  $('#btnScanAll').addEventListener('click', () => { state.scan.forEach(i => state.scanPicked.add(i.path)); renderScanList(); });
  $('#btnScanNone').addEventListener('click', () => { state.scanPicked.clear(); renderScanList(); });
  $('#btnScanImport').addEventListener('click', importScan);

  /* 清理无效项 */
  $('#btnPruneInvalid').addEventListener('click', openPrune);
  $('#pruneList').addEventListener('click', e => {
    const row = e.target.closest('.scan-item');
    if (row && row.dataset.id) togglePrunePick(row.dataset.id);
  });
  $('#btnPruneAll').addEventListener('click', () => {
    if (state.prune.busy) return;
    // 只全选「确定失效」，存疑永远不跟着全选
    pruneRows().filter(r => r.level === 'certain').forEach(r => state.prune.picked.add(r.id));
    renderPruneList();
  });
  $('#btnPruneNone').addEventListener('click', () => {
    if (state.prune.busy) return;
    state.prune.picked.clear();
    renderPruneList();
  });
  $('#btnPruneGo').addEventListener('click', runPrune);
  $('#btnPruneUndo').addEventListener('click', undoPrune);

  /* 右键菜单 */
  document.addEventListener('contextmenu', async e => {
    const el = e.target;
    if (!(el instanceof Element)) return;

    // 输入框：走系统编辑菜单（剪切/复制/粘贴/全选）
    if (el.closest('input, textarea')) {
      e.preventDefault();
      API.editMenu();
      return;
    }

    // 卡片
    const card = el.closest('.card');
    if (card) {
      e.preventDefault();
      if (card.dataset.add) return blankMenu();
      const f = findItem(card.dataset.id);
      if (!f) return blankMenu();
      const act = await API.cardMenu(Object.assign({}, f.i, { groupId: f.g.id }));
      if (act) await cardAction(act, card.dataset.id);
      return;
    }

    // 侧栏分组
    const navBtn = el.closest('[data-nav]');
    if (navBtn) {
      e.preventDefault();
      const g = state.config.groups.find(x => x.id === navBtn.dataset.nav);
      // 「全部 / 最近使用 / 收藏」是虚拟视图，没有分组实体 → 退回空白菜单
      if (!g) return blankMenu();
      const act = await API.groupMenu({
        id: g.id, name: g.name, icon: g.icon,
        count: g.items.length, colors: COLOR_NAMES,
      });
      if (act) await groupAction(act, g.id);
      return;
    }

    // 空白区域
    if (el.closest('.content')) {
      e.preventDefault();
      blankMenu();
    }
  });

  /* 长按拖动排序 / 拖入垃圾桶删除 */
  $('#gridHost').addEventListener('pointerdown', onGridPointerDown);
  document.addEventListener('pointermove', onDocPointerMove);
  document.addEventListener('pointerup', onDocPointerUp);
  document.addEventListener('pointercancel', e => {
    if (state.probeMode && e.isTrusted) return;
    cancelHold('pointercancel');
    abortDrag();
  });
  window.addEventListener('blur', () => {
    if (state.probeMode) return;
    cancelHold('窗口失焦');
    abortDrag();
  });

  /* 拖入导入 */
  document.addEventListener('dragenter', e => {
    if (!isImportDrag(e)) return;
    dragDepth++;
    if (dragDepth === 1) markDropTarget(dropTargetInfo(e));
    showDropVeil();
  });

  document.addEventListener('dragover', e => {
    if (!isImportDrag(e)) return;
    e.preventDefault();                    // 不阻止默认行为，drop 不会触发
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    markDropTarget(dropTargetInfo(e));
  });

  document.addEventListener('dragleave', e => {
    if (!isImportDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) resetDrag();
  });

  document.addEventListener('drop', e => {
    if (!isImportDrag(e)) return;
    e.preventDefault();                    // 别让 Chromium 导航到 file://
    handleDrop(e);
  });

  // 拖到窗口外松手 / 切走窗口时，dragleave 可能收不到 → 兜底复位
  window.addEventListener('blur', resetDrag);
  window.addEventListener('dragend', resetDrag);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { resetDrag(); cancelHold('Esc'); abortDrag(); }
  });

  /* 编辑弹窗 */
  $('#fTypes').addEventListener('click', e => {
    const b = e.target.closest('[data-type]');
    if (b) setType(b.dataset.type);
  });
  $('#fIcons').addEventListener('click', e => {
    const b = e.target.closest('[data-emoji]');
    if (!b) return;
    applyIcon(b.dataset.emoji);
  });
  // 还原为程序自带的默认 ICO（取不到时保持原图标）
  $('#btnIconDefault').addEventListener('click', async () => {
    const it = state.editing && state.editing.item;
    if (!it) return;
    const p = $('#fPath').value.trim();
    if (!p) return toast('bad', '请先填写目标路径', '“还原默认图标”需要程序路径');
    const r = await API.iconDefault(p);
    if (r && r.ok && r.dataUrl) applyIcon(r.dataUrl);
    else toast('info', '未取到默认图标', '保持当前图标');
  });
  // 从图片文件选一个做自定义图标
  $('#btnIconPick').addEventListener('click', async () => {
    const r = await API.iconPick();
    if (r && r.ok && r.dataUrl) applyIcon(r.dataUrl);
    else if (r && r.canceled) { /* 用户取消 */ }
    else toast('bad', '选择图片失败', (r && r.msg) || '');
  });
  // 清掉自定义图片，回到类型默认 emoji
  $('#btnIconClear').addEventListener('click', () => {
    const it = state.editing && state.editing.item;
    if (!it) return;
    applyIcon((TYPE_INFO[it.type || 'app'] || {}).icon || '🚀');
  });
  $('#fGroup').addEventListener('change', e => {
    $('#newGroupField').hidden = e.target.value !== '__new__';
    if (e.target.value === '__new__') $('#fNewGroup').focus();
  });
  $('#btnBrowse').addEventListener('click', async () => {
    const t = $('#fTypes .type-chip.on').dataset.type;
    const kind = t === 'folder' ? 'dir' : (t === 'script' ? 'script' : 'file');
    const p = await API.pick(kind);
    if (p) {
      $('#fPath').value = p;
      if (!$('#fName').value) {
        $('#fName').value = p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
      }
    }
  });
  $('#btnSave').addEventListener('click', saveEdit);
  $('#btnTest').addEventListener('click', () => {
    const it = collectForm();
    if (!it.path) return toast('bad', '请先填写路径');
    runItem(null, it);
  });

  /* 设置弹窗 */
  const hk = $('#sHotkey');
  hk.addEventListener('focus', () => { hk.value = '按下组合键…'; hk.dataset.capturing = '1'; });
  hk.addEventListener('keydown', e => {
    e.preventDefault();
    if (e.key === 'Escape') { hk.blur(); hk.value = state.capturedHotkey || ''; return; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      state.capturedHotkey = '';
      hk.value = '（未设置）';
      setHotkeyMsg('热键已清除，保存后生效', '');
      return;
    }
    const accel = accelFromEvent(e);
    if (accel) {
      state.capturedHotkey = accel;
      hk.value = accel;
      setHotkeyMsg(`将绑定 ${accel}，保存后生效`, '');
    } else {
      setHotkeyMsg('需要包含至少一个修饰键（Ctrl / Alt / Shift / Win）', 'warn');
    }
  });
  hk.addEventListener('blur', () => {
    hk.dataset.capturing = '';
    if (!state.capturedHotkey) hk.value = '';
    else hk.value = state.capturedHotkey;
  });
  $('#btnHotkeyClear').addEventListener('click', () => {
    state.capturedHotkey = '';
    $('#sHotkey').value = '';
    setHotkeyMsg('热键已清除，保存后生效', '');
  });
  $('#btnOpenCfg').addEventListener('click', () => API.openConfigDir());
  $('#btnSetSave').addEventListener('click', saveSettings);
  // 手动修图标：只补"占位图 / 网址还挂着 emoji"那批，不会冲掉用户自己挑的表情/图片
  $('#btnReextractIcons').addEventListener('click', () => { healAllIcons(); });
  // 恢复默认分组：误删「文件与目录 / 系统工具 / 开发 / 常用网站」的后悔药（只补不删）
  $('#btnRestoreDefaults').addEventListener('click', () => { restoreDefaultGroups(); });

  /* 「关于」的两个入口：设置页脚的按钮，和侧栏底部那条状态行。
     状态行只在桌面版可点 —— 预览模式没有主进程，点开也拿不到真信息。 */
  $('#btnAbout').addEventListener('click', () => { openAbout(); });
  $('#btnAboutCopy').addEventListener('click', copyDiag);
  $('#conn').addEventListener('click', () => { if (!PREVIEW) openAbout(); });

  /* 弹窗关闭 */
  $$('[data-close]').forEach(b => b.addEventListener('click', () => {
    const ov = b.closest('.overlay');
    if (overlayLocked(ov)) return;   // 导入中：关掉就是丢进度，按钮此时也是 disabled
    ov.hidden = true;
    state.editing = null;
  }));
  $$('.overlay').forEach(o => o.addEventListener('mousedown', e => {
    if (e.target !== o) return;
    if (overlayLocked(o)) return;
    if (o.id === 'confirmOverlay' || o.id === 'promptOverlay') {
      if (state.dlgCancel) state.dlgCancel();
      return;
    }
    o.hidden = true;
    state.editing = null;
  }));

  /* 全局快捷键 */
  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    const anyOpen = $$('.overlay').some(o => !o.hidden);

    if (e.key === '/' && !typing && !anyOpen) { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }

    /* 编辑模式下的快捷键。整块放在下面的 Esc 处理之前，
       否则 Esc 会先去清搜索词 / 隐藏窗口，退不出编辑模式。

       ★ Esc 这一条**不能**被 `typing` 挡住：程序启动就会自动聚焦搜索框，
         而右键「多选编辑…」不会移走焦点 —— 此时按 Esc 若被拦下，就会落到
         下面那条「清搜索词 / 隐藏窗口」上：用户想退出编辑，窗口却没了。
         所以 Esc 只要求「没有弹窗」，并且顺手把焦点从输入框上摘掉。

       其余按键必须保留 !typing：编辑模式下在搜索框里打字时，
       Ctrl+A 会被当成"全选启动项"、退格会被当成"批量删除"，那是数据事故。 */
    if (state.editMode && !anyOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setEditMode(false);
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        return;
      }
      if (!typing) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
          e.preventDefault();
          visibleItemIds().forEach(id => state.picked.add(id));
          render();
          return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && state.picked.size) {
          e.preventDefault();
          batchDelete();
          return;
        }
      }
    }

    if (e.key === 'Escape') {
      if (state.dlgCancel) { state.dlgCancel(); return; }
      // 导入中不许关扫描弹窗（正逐项提图标 + 最后要写盘，关掉就是丢进度）
      const scanOv = $('#scanOverlay');
      if (state.importing && scanOv && !scanOv.hidden) { e.preventDefault(); return; }
      if (anyOpen) {
        $$('.overlay').forEach(o => { if (!overlayLocked(o)) o.hidden = true; });
        state.editing = null;
      } else if (state.q) {
        state.q = ''; $('#q').value = ''; render();
      } else if (!PREVIEW) {
        API.hide();
      }
      return;
    }
    if (e.key === 'n' && !typing && !anyOpen) {
      e.preventDefault();
      const gid = (state.active === 'all' || state.active === 'recent' || state.active === 'fav') ? null : state.active;
      openEdit(null, gid);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openSettings(); }
  });

  /* 主进程事件 */
  API.on('ql:win-state', p => setWinMaxIcon(p && p.maximized));
  API.on('ql:focus-search', () => setTimeout(() => { $('#q').focus(); $('#q').select(); }, 60));
  // ★ soft：先问一句「是不是只有计数变了」。是 → 就地改文本，一次重绘都不做（不闪）；
  //   不是（改了名 / 增删项 / 动设置）→ 照常重绘，只是不播入场动画。
  API.on('ql:config-changed', () => refresh({ soft: true }));

  /* 拖入导入进度：主进程逐项提图标时推百分比（见 main.js ql:import） */
  API.on('ql:import-progress', p => {
    if (!p || !state.importingDrop) return;
    setDropProgress(p.phase || 'icons', p.done || 0, p.total || 0);
  });
  API.on('ql:settings-changed', p => {
    if (!p) return;
    Object.assign(state.config.settings, p);
    $('#sAutostart').checked = !!p.autostart;
  });

  /* 自更新：主进程是唯一的状态源，这里只接快照 */
  API.on('ql:update-state', u => applyUpdateState(u));
  bindUpdate();

  /* 有人又启动了一次程序，本次启动被交接给了**这个**已经在跑的实例。
     必须说清楚，否则用户双击新版 exe 时看到的是旧版窗口，会以为新功能没做
     （单实例锁按 userData 上锁，同一目录里的不同版本共用一把锁 —— 真踩过）。
     文案 = 版本 + 运行形态：这条提示的全部意义就是让你分清"占着锁的是哪个版本"，
     所以它比侧栏状态行多带一个 formText()。 */
  API.on('ql:second-instance', info => {
    if (!info) return;
    toast('info', '已有一个实例在运行',
      `v${info.version || '?'} · ${formText(info)}　·　刚才那次启动已交给它。`
      + '若你启动的是另一个版本，请先在托盘图标上右键退出，再打开新的。');
  });

  // 自更新界面自检（仅 --update-probe 时由主进程触发）：
  // 用**完全离线**的假更新源（src/lib/update-probe.js）把
  // 「检查 → 发现新版本 → 下载 → 已就绪」整条界面链路跑一遍并逐状态截图。
  // ★ 走的是真实按钮（真的 click），不是直接调 API —— 验的就是"用户点得到、点了有用"。
  API.on('ql:update-probe', async () => {
    state.probeMode = true;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const snap = async (f, tag) => {
      const r = await API.probeShot(f);
      console.log(`[update-probe] 截图 ${tag} =`, r && r.ok ? 'ok' : ('失败 ' + (r && r.msg)));
    };
    const dump = tag => {
      const u = state.update || {};
      const btn = id => {
        const el = $(id);
        return !el ? '(无)' : (el.hidden ? '隐藏' : (el.disabled ? '灰' : '可点'));
      };
      console.log(`[update-probe] --- ${tag} ---`);
      console.log('[update-probe]   状态 =', u.status, '|', u.statusText,
        '| 目标 =', u.latest || '-', '| 方案 =', u.plan ? `${u.plan.mode} ${u.plan.sizeText}` : '-');
      console.log('[update-probe]   块内文案 =', JSON.stringify((($('#abUpdMsg') || {}).textContent) || ''));
      console.log('[update-probe]   按钮：检查 =', btn('#abUpdCheck'), '| 下载 =', btn('#abUpdDown'),
        '| 重启并更新 =', btn('#abUpdApply'));
      const connTxt = $('#conn').querySelector('span').textContent;
      console.log('[update-probe]   状态行 =', JSON.stringify(connTxt),
        '| 带可更新标记 =', /可更新/.test(connTxt),
        '| 点色 =', $('#conn').className);
      return u;
    };

    await openAbout();
    await sleep(300);
    console.log('[update-probe] 关于窗口可见 =', !$('#aboutOverlay').hidden,
      '| 更新块可见 =', !!$('#abUpd') && !$('#abUpd').hidden);
    dump('① 检查之前');

    // ② 点「检查更新」
    $('#abUpdCheck').click();
    await sleep(1200);
    const u2 = dump('② 检查之后');
    console.log('[update-probe] 检查后判定 =',
      '发现新版本 =', u2.status === 'available',
      '| 下载按钮出现 =', !$('#abUpdDown').hidden,
      '| 提示 =', lastToast());
    await snap('shot-upd-available.png', '发现新版本');

    // ③ 点「下载」→ 下载 + 校验 + 摊进暂存区
    $('#abUpdDown').click();
    await sleep(2500);
    const u3 = dump('③ 下载之后');
    console.log('[update-probe] 下载后判定 =',
      '已就绪 =', u3.status === 'staged',
      '| 重启按钮出现 =', !$('#abUpdApply').hidden,
      '| 下载按钮收起 =', $('#abUpdDown').hidden,
      '| 提示 =', lastToast());
    await snap('shot-upd-staged.png', '已就绪');

    // ④ 诊断信息里必须带上更新一段，且没有 undefined
    const lines = envLines(state.info);
    const updAt = lines.indexOf('【更新】');
    const seg = updAt < 0 ? [] : lines.slice(updAt, updAt + updateRows(state.update).length + 1);
    console.log('[update-probe] 诊断信息含更新段 =', updAt > 0, '| 行数 =', seg.length);
    seg.forEach(l => console.log('[update-probe]   ' + l));
    console.log('[update-probe] 更新段无 undefined =', seg.every(l => !/undefined|null|NaN/.test(l)));
    console.log('[update-probe] done');
  });

  // 单实例交接自检（仅 --second-probe 时由主进程触发）：截图看提示有没有出来
  API.on('ql:second-probe', async () => {
    state.probeMode = true;
    await new Promise(r => setTimeout(r, 600));   // 等 toast 入场动画
    const t = lastToast();
    console.log('[second-probe] 提示文案 =', JSON.stringify(t));
    console.log('[second-probe] 提示说明去哪跑新版 =', /托盘图标上右键退出/.test(t));
    console.log('[second-probe] 隐形窗口没吞掉输入 =', state.q === '', '| 搜索词 =', JSON.stringify(state.q));
    const r = await API.probeShot('shot-second.png');
    console.log('[second-probe] 截图 =', r && r.ok ? 'ok' : ('失败 ' + (r && r.msg)));
    console.log('[second-probe] done');
  });
}

/* ------------------------------------------------------------ 浏览器预览兜底 */

function createMockBridge() {
  const KEY = 'ql-mock-config';

  function demoConfig() {
    return {
      version: 2,
      settings: { theme: 'light', sort: 'custom', hotkey: 'Ctrl+Alt+Space', hotkeyEnabled: true, autostart: false, closeAction: 'tray', trayQuick: 'top', hoverActions: false, startGroup: 'last', lastGroup: 'all' },
      groups: [
        {
          id: 'files', name: '文件与目录', icon: '📁', color: PALETTE[0],
          items: [
            { id: 'a1', name: '下载', icon: '📥', type: 'folder', path: 'C:\\Users\\QZRS\\Downloads', args: '', cwd: '', desc: 'Downloads', favorite: true, useCount: 12, lastUsed: 1792100000, elevate: false, console: false },
            { id: 'a2', name: '工作区', icon: '🧰', type: 'folder', path: 'D:\\WorkBuddy', args: '', cwd: '', desc: 'D:\\WorkBuddy', favorite: false, useCount: 31, lastUsed: 1792150000, elevate: false, console: false },
            { id: 'a3', name: '本机磁盘', icon: '💽', type: 'cmd', path: 'explorer.exe "shell:MyComputerFolder"', args: '', cwd: '', desc: '资源管理器 · 此电脑', favorite: false, useCount: 4, lastUsed: 1792110000, elevate: false, console: false },
            // 预览用的"失效项"样例：__gone 只有假桥认（真机由 src/lib/prune.js 判），
            // 用来在浏览器里演示「清理无效项」弹窗，不会影响桌面版。
            { id: 'a9', name: '旧版工具（示例）', icon: '🧹', type: 'app', path: 'C:\\Program Files\\OldTool\\old.exe', args: '', cwd: '', desc: '', favorite: false, useCount: 0, lastUsed: 0, elevate: false, console: false, __gone: true },
          ],
        },
        {
          id: 'dev', name: '开发', icon: '💻', color: PALETTE[1],
          items: [
            { id: 'b1', name: 'VS Code', icon: '💻', type: 'app', path: 'C:\\Users\\QZRS\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', args: '', cwd: '', desc: '', favorite: true, useCount: 57, lastUsed: 1792160000, elevate: false, console: false },
            { id: 'b2', name: 'PowerShell', icon: '⚡', type: 'app', path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: '', cwd: '', desc: '', favorite: false, useCount: 9, lastUsed: 1792140000, elevate: false, console: false },
            { id: 'b3', name: '发布脚本', icon: '📜', type: 'script', path: 'D:\\WorkBuddy\\deploy\\build.py', args: '--release', cwd: '', desc: '一键打包', favorite: false, useCount: 3, lastUsed: 1792100000, elevate: false, console: true },
          ],
        },
        {
          id: 'web', name: '常用网站', icon: '🌐', color: PALETTE[5],
          items: [
            { id: 'c0a', name: 'Google', icon: '🔍', type: 'url', path: 'https://www.google.com/', args: '', cwd: '', desc: 'google.com', favorite: false, useCount: 34, lastUsed: 1792170000, elevate: false, console: false },
            { id: 'c0b', name: '百度', icon: '🐾', type: 'url', path: 'https://www.baidu.com/', args: '', cwd: '', desc: 'baidu.com', favorite: false, useCount: 28, lastUsed: 1792168000, elevate: false, console: false },
            { id: 'c1', name: 'GitHub', icon: '🐙', type: 'url', path: 'https://github.com/qzrsa', args: '', cwd: '', desc: 'github.com', favorite: false, useCount: 21, lastUsed: 1792165000, elevate: false, console: false },
            { id: 'c2', name: '阿里云控制台', icon: '☁️', type: 'url', path: 'https://ecs.console.aliyun.com/', args: '', cwd: '', desc: 'ecs.console.aliyun.com', favorite: false, useCount: 6, lastUsed: 1792130000, elevate: false, console: false },
          ],
        },
      ],
    };
  }

  let cfg = null;
  try { cfg = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { cfg = null; }
  if (!cfg || !Array.isArray(cfg.groups)) cfg = demoConfig();

  const clone = o => JSON.parse(JSON.stringify(o));
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* noop */ } };

  const sampleScan = [
    { name: 'Visual Studio Code', path: 'C:\\Users\\QZRS\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', source: '开始菜单' },
    { name: 'Google Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', source: '注册表' },
    { name: '7-Zip 26.03 (x64)', path: 'C:\\Program Files\\7-Zip\\7zFM.exe', source: '注册表' },
    { name: 'Steam', path: 'C:\\Program Files (x86)\\Steam\\steam.exe', source: '开始菜单' },
  ];

  let hinted = false;
  const previewMenuHint = () => {
    if (hinted) return;
    hinted = true;
    toast('info', '预览模式', '原生右键菜单只在桌面版可用，这里仅演示界面。');
  };

  /** 预览模式下的更新快照：桌面形态不支持的形态就是"不支持"，
   *  所以这里给的就是用户真会在浏览器预览里看到的那种状态（而不是编一个假的"有新版本"）。 */
  const mockUpdate = () => ({
    supported: false, unsupportedReason: '预览模式（非桌面版）不做自更新',
    form: 'dev', myVersion: '1.0.0', autoUpdate: true,
    base: '（预览模式）', baseError: '', status: 'unsupported',
    statusText: '当前形态不支持自动更新', latest: '', reason: '',
    plan: null, progress: null, checkedAt: 0, checkedAtText: '',
    busy: false, canCheck: false, canDownload: false, canApply: false,
    notice: null, dir: '（预览模式）',
  });

  return {
    __mock: true,
    getConfig: async () => { cfg.groups.forEach(g => g.items.forEach(i => { i._exists = true; })); return clone(cfg); },
    saveConfig: async c => { cfg = clone(c); save(); return { ok: true }; },
    /* 预览模式：按 demoConfig 的默认分组"只补不删"，与桌面版语义一致 */
    restoreDefaults: async () => {
      const defs = demoConfig().groups;
      let groupsAdded = 0, itemsAdded = 0;
      const touched = [];
      for (const d of defs) {
        let g = cfg.groups.find(x => x.id === d.id);
        if (!g) {
          const ng = clone(d);
          cfg.groups.push(ng);
          groupsAdded++;
          itemsAdded += ng.items.length;
          touched.push(`${ng.name}（+${ng.items.length}）`);
          continue;
        }
        if (!Array.isArray(g.items)) g.items = [];
        const key = i => `${i.type}|${String(i.path || '').toLowerCase()}`;
        const have = new Set(g.items.map(key));
        let n = 0;
        for (const di of d.items) {
          const k = key(di);
          if (have.has(k)) continue;
          g.items.push(clone(di));
          have.add(k);
          n++;
        }
        if (n) { itemsAdded += n; touched.push(`${g.name}（+${n}）`); }
      }
      save();
      return { ok: true, groupsAdded, itemsAdded, groups: touched };
    },
    run: async item => ({ ok: true, msg: `预览模式：不会真正启动 ${item.name || ''}` }),
    openFolder: async () => ({ ok: true, msg: '预览模式' }),
    pick: async () => '',
    iconDefault: async () => ({ ok: false }),  // 预览模式不读盘
    iconPick: async () => ({ ok: false, canceled: true }),  // 预览模式不读盘
    scan: async () => clone(sampleScan),
    /* 预览模式：只演示界面。真判据在 src/lib/prune.js，浏览器里没法读盘，
       所以给两条"确定失效"+ 一条"存疑"做样例，清理时从 demo 配置里摘掉。 */
    scanInvalid: async () => {
      const rows = [];
      cfg.groups.forEach(g => g.items.forEach(i => {
        if (i.__gone) {
          rows.push({ id: i.id, name: i.name, path: i.path, type: i.type, gid: g.id, gname: g.name, reason: '路径不存在' });
        }
      }));
      const first = cfg.groups[0] && cfg.groups[0].items[0];
      if (first && !first.__gone) {
        rows.push({ id: first.id, name: first.name, path: first.path, type: first.type, gid: cfg.groups[0].id, gname: cfg.groups[0].name, reason: '所在磁盘（Z:）现在没接入' });
      }
      const certain = rows.filter(r => r.reason === '路径不存在');
      const unsure = rows.filter(r => r.reason !== '路径不存在');
      return { ok: true, certain, unsure };
    },
    pruneInvalid: async ids => {
      const want = new Set(ids || []);
      const removed = [];
      cfg.groups.forEach(g => {
        const keep = [];
        g.items.forEach(i => {
          if (want.has(i.id)) removed.push({ gid: g.id, gname: g.name, item: clone(i) });
          else keep.push(i);
        });
        g.items = keep;
      });
      save();
      return { ok: true, removed, skipped: [], backup: '（预览模式不写备份）' };
    },
    restoreItems: async pairs => {
      let restored = 0;
      (pairs || []).forEach(p => {
        const g = cfg.groups.find(x => x.id === p.gid);
        if (!g || !p.item) return;
        if (cfg.groups.some(x => x.items.some(i => i.id === p.item.id))) return;
        g.items.push(clone(p.item));
        restored++;
      });
      save();
      return { ok: true, restored };
    },
    /* 预览模式：没有 webUtils，路径由 text/uri-list 回退提供 */
    canResolvePath: false,
    pathForFile: () => '',
    importDropped: async ({ paths = [], urls = [], groupId = null } = {}) => {
      const target = cfg.groups.find(g => g.id === groupId)
        || cfg.groups.find(g => g.id === 'dropped')
        || (cfg.groups.push({ id: 'dropped', name: '拖入的快捷方式', icon: '📥', color: PALETTE[4], items: [] }),
            cfg.groups[cfg.groups.length - 1]);
      const ids = [];
      const mk = (name, type, p, icon) => {
        const it = { id: 'd' + Math.random().toString(16).slice(2, 8), name, icon, type, path: p, args: '', cwd: '', desc: '', favorite: false, useCount: 0, lastUsed: 0, elevate: false, console: false };
        target.items.unshift(it);
        ids.push({ id: it.id, groupId: target.id });
      };
      urls.forEach(u => mk(hostOfString(u), 'url', u, '🌐'));
      paths.forEach(p => {
        const isDir = /[\\/]$/.test(p) || !/\.[a-z0-9]{1,5}$/i.test(p);
        mk(nameOfPath(p), isDir ? 'folder' : 'file', p, isDir ? '📁' : '📄');
      });
      save();
      return { ok: true, added: ids.length, ids, groupId: target.id, groupName: target.name, skipped: [], failed: [] };
    },
    setSettings: async patch => { Object.assign(cfg.settings, patch); save(); return { ok: true, settings: clone(cfg.settings), hotkey: { ok: true, msg: '预览模式：不注册真实热键' } }; },
    win: async () => ({ ok: true, maximized: false }),
    hide: async () => ({ ok: true }),
    /* 预览模式没有原生菜单，直接返回 null（不执行动作） */
    cardMenu: async () => { previewMenuHint(); return null; },
    groupMenu: async () => { previewMenuHint(); return null; },
    blankMenu: async () => { previewMenuHint(); return null; },
    editMenu: async () => ({ ok: true }),
    copyText: async t => { try { await navigator.clipboard.writeText(String(t || '')); } catch { /* noop */ } return { ok: true }; },
    info: async () => ({
      version: '1.0.0', electron: '（预览）', chrome: '（预览）', node: '（预览）',
      platform: 'browser', packaged: false, form: 'dev', exePath: '（预览模式，无桌面进程）',
      configFile: 'localStorage: ql-mock-config', configDir: '（预览模式）',
      dataDir: '（预览模式）', dataInProgramDir: false, dataNote: '预览模式',
      autostart: false, hotkeyFail: '', hotkeys: false,
      update: mockUpdate(),
    }),
    updateState: async () => mockUpdate(),
    updateCheck: async () => ({ ok: false, unsupported: true, reason: '预览模式不做自更新' }),
    updateDownload: async () => ({ ok: false, reason: '预览模式不做自更新' }),
    updateApply: async () => ({ ok: false, reason: '预览模式不做自更新' }),
    openConfigDir: async () => ({ ok: true }),
    openExternal: async () => ({ ok: true }),
    quit: async () => ({ ok: true }),
    on: () => () => {},
  };
}

/* ------------------------------------------------------------ 启动 */

(function init() {
  window.addEventListener('error', e => {
    console.error('[renderer] 未捕获错误:', e.message, `${e.filename}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', e => {
    console.error('[renderer] Promise 未处理:', (e.reason && (e.reason.stack || e.reason.message)) || e.reason);
  });

  applyTheme('light');
  bind();

  (async () => {
    try { state.info = await API.info(); } catch { /* 忽略 */ }
    // 更新状态要主动要一次：主进程可能在渲染层注册监听之前就推过了
    // （启动时的收尾与静默检查都比首次渲染早）。
    if (state.info && state.info.update) applyUpdateState(state.info.update);
    else await refreshUpdateState();
    await refresh({ initView: true });
    // 一次性补图标：<=1.3.1 给 .lnk 提的是通用占位图、<=1.4.3 给 .url 提的是 🌐（见 healAllIcons）。
    // 放到首屏渲染之后、且只跑一次 —— 别让启动变慢，也别每次都重扫。
    if (Number((state.config.settings || {}).iconRev || 1) < ICON_REV) {
      setTimeout(() => { healAllIcons({ quiet: true }).catch(() => {}); }, 900);
    }
    console.log(`[quicklaunch] 渲染层就绪 · ${PREVIEW ? 'preview' : 'desktop'} · `
      + `${state.config.groups.length} 组 / ${allItems().length} 项 · 起始视图 ${state.active}`);
  })();

  // 右键菜单链路自检（仅 --menu-probe 时由主进程触发）：
  // 在真实 DOM 上派发 contextmenu，验证「事件 → IPC → 主进程载荷」整条链路。
  API.on('ql:menu-probe', async () => {
    const fire = el => el && el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));

    const firstGroupId = state.config.groups[0] && state.config.groups[0].id;
    const cases = [
      ['card', document.querySelector('.card:not([data-add])')],
      ['group', document.querySelector(`[data-nav="${firstGroupId}"]`)],
      ['virtual', document.querySelector('[data-nav="all"]')],
      ['blank', document.querySelector('.content')],
    ];
    for (const [name, el] of cases) {
      if (!el) { console.log(`[menu-probe] ${name} 未找到目标元素`); continue; }
      fire(el);
      await new Promise(r => setTimeout(r, 350)); // 等主进程回执
    }
    console.log('[menu-probe] done');
  });

  // 拖入导入链路自检（仅 --import-probe 时由主进程触发）：
  // 用 DataTransfer 合成 uri-list，在真实 DOM 上派发 dragenter/dragover/drop，
  // 走完「事件 → 路径提取 → IPC → 主进程分类」整条链路（dryRun，不落盘）。
  API.on('ql:import-probe', async data => {
    const { paths = [], urls = [] } = data || {};
    const toUri = p => encodeURI('file:///' + String(p).replace(/\\/g, '/'));
    const lines = [...paths.map(toUri), ...urls];

    const dt = new DataTransfer();
    dt.setData('text/uri-list', lines.join('\r\n'));
    dt.setData('text/plain', lines.join('\r\n'));

    const el = $('#content') || document.body;
    const fire = (type, node) => (node || el).dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, dataTransfer: dt, clientX: 40, clientY: 40,
    }));

    state.dropDryRun = true;           // 探针不写配置
    fire('dragenter');
    fire('dragover');
    const veil = document.getElementById('dropVeil');
    console.log('[import-probe] 已派发 dragenter/dragover，共', lines.length, '条 uri',
      '| veil存在=', !!veil,
      '| hidden=', veil ? veil.hidden : 'n/a',
      '| display=', veil ? getComputedStyle(veil).display : 'n/a');
    await new Promise(r => setTimeout(r, 1500));   // 留时间给主进程截图
    fire('drop');
    console.log('[import-probe] 阶段A 完成：落在空白区');

    // 阶段 B：拖到左侧真实分组上，验证「指定分组」分支与落点高亮
    await new Promise(r => setTimeout(r, 400));
    const nav = [...document.querySelectorAll('[data-nav]')]
      .find(x => state.config.groups.some(g => g.id === x.dataset.nav));
    if (nav) {
      const g = state.config.groups.find(x => x.id === nav.dataset.nav);
      state.dropDryRun = true;
      fire('dragenter', nav);
      fire('dragover', nav);
      console.log('[import-probe] 阶段B 悬停分组=', g.name,
        '| drop-on 高亮数=', document.querySelectorAll('.nav-item.drop-on').length,
        '| 提示文案=', ($('#dropTitle') || {}).textContent);
      await new Promise(r => setTimeout(r, 200));
      fire('drop', nav);
      console.log('[import-probe] 阶段B 完成：落在分组', g.name);
    } else {
      console.log('[import-probe] 阶段B 跳过：侧栏没有分组');
    }
  });

  // 运行环境面板自检（仅 --info-probe 时由主进程触发）：
  // 走真实 openSettings()，把 envLines() 的结果打出来并截图。
  // 重点验：数据目录有没有落到程序目录、三种运行形态标签对不对、
  // 有没有哪个字段是 undefined（主进程少给字段就会露馅）。
  API.on('ql:info-probe', async () => {
    state.probeMode = true;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const i = await openAbout();
    await sleep(200);

    console.log('[info-probe] 关于窗口可见 =', !$('#aboutOverlay').hidden);
    const lines = envLines(i);
    lines.forEach(l => console.log('[info-probe]   ' + l));
    const bad = lines.filter(l => /undefined|null|NaN/.test(l));
    console.log('[info-probe] 字段完整 =', bad.length === 0,
      bad.length ? '| 可疑行 = ' + bad.join(' / ') : '');

    // 表格是真的画出来了，不只是数据对了
    const want = aboutGroups(i).reduce((n, g) => n + g.rows.length, 0);
    const got = document.querySelectorAll('#abGrid .about-row').length;
    console.log('[info-probe] 关于窗口条目 =', got, '/ 期望', want, '| 一致 =', got === want);

    // 状态行只留版本号（运行形态归「关于」），也不能再出现误导人的「已连接」
    const connTxt = $('#conn').querySelector('span').textContent;
    const wantConn = statusText(i);
    console.log('[info-probe] 状态行 =', JSON.stringify(connTxt),
      '| 期望 =', JSON.stringify(wantConn),
      '| 通过 =', connTxt === wantConn && !/已连接/.test(connTxt));

    // 回归守卫：设置面板里不该再有那块只读的运行环境文本
    console.log('[info-probe] 设置面板已无环境块 =', !$('#envBox'));
    console.log('[info-probe] 数据随程序走 =', !!i.dataInProgramDir, '| 说明 =', i.dataNote);

    await sleep(200);
    const r1 = await API.probeShot('shot-about.png');
    console.log('[info-probe] 截图 关于 =', r1 && r1.ok ? 'ok' : ('失败 ' + (r1 && r1.msg)));

    // 设置面板：数据回落时才有警示条 + 状态行黄点，正常情况两者都不出现。
    // 这一条同时验「警示条和状态点是同一份判断」（dataWarnText）。
    $('#aboutOverlay').hidden = true;
    await openSettings();
    await sleep(200);
    const wantWarn = !!dataWarnText(i);
    const dotWarn = $('#conn').classList.contains('warn');
    console.log('[info-probe] 设置面板可见 =', !$('#setOverlay').hidden,
      '| 警示条显示 =', !$('#setDataWarn').hidden, '(期望', wantWarn + ')',
      '| 状态点 =', dotWarn ? 'warn' : 'ok', '| 与警示条一致 =', dotWarn === wantWarn);
    await sleep(200);
    const r2 = await API.probeShot('shot-settings.png');
    console.log('[info-probe] 截图 设置 =', r2 && r2.ok ? 'ok' : ('失败 ' + (r2 && r2.msg)));
    console.log('[info-probe] done');
  });

  // 侧栏溢出自检（仅 --rail-probe 时由主进程触发）：
  // 灌一大堆分组（**只在内存里改 groups，不写盘**），量「侧栏有没有被撑破、
  // 能不能滚、底部栏和「新建分组」是否还在视野里」。
  API.on('ql:rail-probe', async () => {
    state.probeMode = true;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const $el = s => document.querySelector(s);
    const inView = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.top >= -0.5 && r.bottom <= innerHeight + 0.5 && r.height > 0;
    };

    const snapshot = JSON.parse(JSON.stringify(state.config.groups));
    const N = 24;

    await sleep(300);
    const nav = $el('#nav'), rail = $el('.rail'), foot = $el('.rail-foot'), app = $el('.app');

    // ★ 窗口内 != 列表里看得见。分组行的裁剪边界是 #nav 的滚动视口，
    //   拿 innerHeight 去判断会把滚出去的行也算成"可见"（踩过这个坑）。
    const inNav = el => {
      const r = el.getBoundingClientRect(), s = nav.getBoundingClientRect();
      return r.height > 0 && r.top >= s.top - 0.5 && r.bottom <= s.bottom + 0.5;
    };

    const dump = tag => {
      const nb = $el('#navNewGroup');
      const rows = Array.from(nav.querySelectorAll('.nav-item'));
      console.log(`[rail-probe] --- ${tag} ---`);
      console.log('[rail-probe]   窗口高        =', innerHeight);
      console.log('[rail-probe]   .app  高/滚   =', app.clientHeight, '/', app.scrollHeight,
        '| 撑破窗口 =', app.scrollHeight > app.clientHeight + 1);
      console.log('[rail-probe]   .rail 高/滚   =', rail.clientHeight, '/', rail.scrollHeight,
        '| 撑破窗口 =', rail.scrollHeight > rail.clientHeight + 1);
      console.log('[rail-probe]   #nav  clientHeight=' + nav.clientHeight,
        'scrollHeight=' + nav.scrollHeight,
        'scrollTop=' + Math.round(nav.scrollTop),
        'overflowY=' + getComputedStyle(nav).overflowY,
        '| 出现滚动条 =', nav.scrollHeight > nav.clientHeight + 1);
      console.log('[rail-probe]   列表内可见行   =', rows.filter(inNav).length, '/', rows.length,
        '（裁到 #nav 视口里数）');
      const h = rows.length ? Math.round(rows[0].getBoundingClientRect().height) : 0;
      console.log('[rail-probe]   行高          =', h, '（应为 40；被压扁说明 flex-shrink 没关掉）',
        h === 40 ? 'OK' : '★ 异常');
      console.log('[rail-probe]   「新建分组」可见 =', inView(nb),
        '| 在列表视口内 =', inNav(nb),
        '| top/bottom =', nb ? Math.round(nb.getBoundingClientRect().top) + '/' + Math.round(nb.getBoundingClientRect().bottom) : '-');
      console.log('[rail-probe]   底部栏可见     =', inView(foot),
        foot ? '| top/bottom = ' + Math.round(foot.getBoundingClientRect().top) + '/' + Math.round(foot.getBoundingClientRect().bottom) : '');
      return { nb, foot };
    };

    console.log('[rail-probe] 起始分组数 =', snapshot.length, '→ 灌到', N);
    state.config.groups = Array.from({ length: N }, (_, i) => ({
      id: 'probe-rail-' + i, name: '溢出测试分组 ' + String(i + 1).padStart(2, '0'),
      color: PALETTE[i % PALETTE.length], icon: '📦', items: [],
    }));
    renderNav();
    await sleep(200);
    const top0 = nav.scrollTop;
    dump('灌入 ' + N + ' 个分组，未滚动');

    await sleep(150);
    await API.probeShot('shot-rail-overflow.png');
    console.log('[rail-probe] 截图 shot-rail-overflow.png');

    // 滚到底，看「新建分组」能不能露出来
    nav.scrollTop = nav.scrollHeight;
    await sleep(200);
    console.log('[rail-probe] 滚动生效 =', nav.scrollTop > top0, '(', top0, '->', Math.round(nav.scrollTop), ')');
    dump('滚到底之后');
    await sleep(150);
    await API.probeShot('shot-rail-scrolled.png');
    console.log('[rail-probe] 截图 shot-rail-scrolled.png');

    // 还原（内存还原 + 重绘，磁盘上从来没动过）
    state.config.groups = snapshot;
    renderNav();
    await sleep(200);
    console.log('[rail-probe] 已还原分组数 =', state.config.groups.length,
      '| 侧栏行数 =', nav.querySelectorAll('.nav-item').length);
    console.log('[rail-probe] done');
  });

  // 规模性能自检（仅 --perf-probe 时由主进程触发）：
  // 灌 100 / 500 / 1000 / 2000 个启动项（**只在内存里改 groups，从不写盘**），量三件事：
  //   ① 全量重绘 render() 的同步耗时（构建 HTML 串 → 解析 → 插入 DOM）
  //   ② 强制布局耗时（innerHTML 只到"解析完"为止，布局是懒的，不强制量不到真实成本）
  //   ③ 每次敲键的过滤重绘耗时 + 该次重绘同时启动的 CSS 动画条数
  // 再加一段滚动主线程代价。A/B 是"关掉 content-visibility（模拟旧版） vs 已发布样式"，
  // 以及"正常 vs #gridHost.no-anim"的动画条数对照 —— 全部只信同步数据，不用 rAF。
  API.on('ql:perf-probe', async () => {
    // ★ 第一行就吼一声：没看到这行 = 事件根本没送到渲染层（多半是 preload 白名单漏登记），
    //   看到这行之后的沉默才是"跑得慢"。这两种情况在日志里必须能一眼分开。
    console.log('[perf-probe] 收到事件，开始（这条日志同时证明 preload 白名单已放行）');
    state.probeMode = true;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const host = () => document.querySelector('#gridHost');
    const content = () => document.querySelector('#content');
    const r2 = x => Math.round(x * 100) / 100;

    // 磁盘上从来不动：整段跑完按快照还原（和 rail-probe 一个套路）
    const snapshot = JSON.parse(JSON.stringify(state.config.groups));
    const snapState = { active: state.active, q: state.q, sort: state.sort };

    const mkItem = (gi, ii) => ({
      id: `perf-${gi}-${ii}`,
      name: `压力测试项 ${gi + 1}-${ii + 1}`,
      path: `D:\\Tools\\App${gi}_${ii}\\app.exe`,
      desc: `这一行是给匹配函数够用的描述文本 ${ii}`,
      args: '', type: 'app', icon: ICONS[ii % ICONS.length],
      favorite: ii % 7 === 0, useCount: ii % 13, lastUsed: 0,
    });
    const mkGroups = (nG, perG) => Array.from({ length: nG }, (_, gi) => ({
      id: `perf-g-${gi}`, name: `性能分组 ${gi + 1}`,
      color: PALETTE[gi % PALETTE.length], icon: '📦',
      items: Array.from({ length: perG }, (_, ii) => mkItem(gi, ii)),
    }));

    /** 量一次 render()：① 构建+解析+插入 ② 强制样式计算+布局 ③ 这次重绘起了多少条动画。
     *  ★ 不强制布局就只量到"把 HTML 串塞进去"那一步，真实成本会被低估一截。 */
    const cost = () => {
      const t0 = performance.now();
      render();
      const t1 = performance.now();
      void host().offsetHeight;          // 强制布局
      const t2 = performance.now();
      return { build: t1 - t0, layout: t2 - t1, total: t2 - t0,
               anim: document.getAnimations().length };
    };
    /** 重复 k 次取中位数：耗时受 GC 与调度影响，单次取样会被尖刺带跑。 */
    const costN = (k = 5) => {
      const rs = [];
      for (let i = 0; i < k; i++) rs.push(cost());
      const med = f => { const a = rs.map(f).sort((x, y) => x - y); return r2(a[a.length >> 1]); };
      return { build: med(r => r.build), layout: med(r => r.layout), total: med(r => r.total),
               worst: r2(Math.max(...rs.map(r => r.total))), anim: rs[0].anim };
    };
    const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
    const line = (tag, c) => console.log(
      `[perf-probe] ${pad(tag, 22)}`
      + `构建 ${pad(c.build, 7)}ms | 布局 ${pad(c.layout, 7)}ms`
      + ` | 合计 ${pad(c.total, 8)}ms | 最差 ${pad(c.worst, 8)}ms`
      + ` | 动画 ${pad(c.anim, 4)} 条`);

    /** 探一下这个隐形窗口还会不会继续出帧。
     *  ★ 必须带硬超时：opacity:0 的窗口实测只出第一帧，rAF 回调永远不会来，
     *    直接 await rAF 会把探针挂死（探针手册里记过这个坑）。出不了帧就老实说
     *    "绘制没法量"，而不是拿主线程耗时冒充绘制耗时。 */
    const framesAlive = () => new Promise(resolve => {
      let done = false;
      const to = setTimeout(() => { if (!done) { done = true; resolve(0); } }, 700);
      let n = 0;
      const tick = () => {
        if (++n >= 2) { if (!done) { done = true; clearTimeout(to); resolve(n); } return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    /** 滚动一屏：改 scrollTop 后强制布局，量主线程那一半代价。 */
    const scrollTest = label => {
      const c = content();
      const canScroll = c.scrollHeight - c.clientHeight;
      const steps = 12;
      const times = [];
      for (let i = 1; i <= steps; i++) {
        const t0 = performance.now();
        c.scrollTop = Math.round(canScroll * i / steps);
        void c.offsetHeight;
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      console.log(`[perf-probe] ${pad('滚动 ' + label, 22)}`
        + `可滚 ${pad(canScroll, 7)}px | 每步中位 ${pad(r2(times[times.length >> 1]), 7)}ms`
        + ` | 最差 ${pad(r2(times[times.length - 1]), 7)}ms`);
      c.scrollTop = 0;
      return r2(times[times.length >> 1]);
    };

    /** 模拟逐字输入：每次按键就是一次同步 render()，量"手到屏幕"前被阻塞多久。 */
    const typeTest = async (text, label) => {
      const q = document.querySelector('#q');
      let acc = '';
      const times = [];
      for (const ch of text) {
        acc += ch;
        const t0 = performance.now();
        q.value = acc;
        state.q = acc;
        render();
        void host().offsetHeight;
        times.push(performance.now() - t0);
        await sleep(6);        // 模拟真实敲键间隔；不 sleep 会连成一坨，量出来的不是用户体感
      }
      const sorted = times.slice().sort((a, b) => a - b);
      const shown = host().querySelectorAll('.card[data-id]').length;
      console.log(`[perf-probe] ${pad('逐字输入 ' + label, 22)}`
        + `「${text}」每次阻塞 ${times.map(t => Math.round(t)).join('/')} ms`
        + ` | 中位 ${r2(sorted[sorted.length >> 1])}ms | 命中 ${shown} 张卡`);
      return times;
    };

    const domStats = tag => {
      const h = host();
      console.log(`[perf-probe] ${pad('DOM ' + tag, 22)}`
        + `卡片 ${pad(h.querySelectorAll('.card[data-id]').length, 5)}`
        + ` | 元素总数 ${pad(h.querySelectorAll('*').length, 6)}`
        + ` | 每卡约 ${Math.round(h.querySelectorAll('*').length / Math.max(1, h.querySelectorAll('.card[data-id]').length))} 个`);
    };

    /** 原地注入/移除样式（改内存里的一份 <style>，不落盘），用于同一次运行做 A/B。
     *  content-visibility 已经**永久写进 style.css**，所以这里的 A/B 是：
     *   基线 = 关掉它（模拟旧版），对照 = 恢复已发布样式。 */
    const styleOn = (id, css) => {
      document.getElementById(id)?.remove();
      const st = document.createElement('style');
      st.id = id;
      st.textContent = css;
      document.head.appendChild(st);
      return st;
    };
    const cvOff = () => styleOn('perf-cv-off',
      '#gridHost .card{content-visibility:visible !important;contain-intrinsic-size:none !important;}');
    const cvOn = () => { document.getElementById('perf-cv-off')?.remove(); };

    // ★ 这里**故意不**用 requestAnimationFrame 量帧间隔 / 滚动流畅度：
    //   探针窗口 opacity:0，背景节流会在一段时间后把 setTimeout/rAF 压到近乎停摆
    //   （实测出现过"注入后 500 项 → 1000 项之间凭空卡 60 秒"），rAF 帧率在这个环境里
    //   测出来是节流噪声而不是真实性能。所以本探针只信两种**同步**数据：
    //   ① performance.now() 量的主线程 build/layout 耗时（真正的卡顿来源）
    //   ② document.getAnimations().length（重绘启动了多少条 CSS 动画）
    //   帧级的"滚起来卡不卡"只能靠真机肉眼 + 截图，别在这里用 rAF 冒充。

    console.log('[perf-probe] ===== 起始状态 =====');
    await sleep(300);
    console.log('[perf-probe] 起始分组/项目 =',
      state.config.groups.length, '/', state.config.groups.reduce((n, g) => n + g.items.length, 0),
      '| active =', state.active, '| sort =', state.sort);
    console.log('[perf-probe] 窗口内容区 =', content().clientWidth + 'x' + content().clientHeight,
      'px | 单个 .card 高度 =',
      (() => { const c = host().querySelector('.card'); return c ? Math.round(c.getBoundingClientRect().height) : '-'; })());

    const alive = await framesAlive();
    console.log('[perf-probe] 隐形窗口是否继续出帧 =', alive ? ('是（' + alive + ' 帧）') : '否（只出首帧）',
      '→ 帧率测量', alive ? '看似可用，但背景节流随时会把它掐断' : '★ 不可用（这是常态）',
      '，本探针统一只报同步主线程耗时');

    /* ---- 阶段 A：基线 = 关掉 content-visibility（模拟旧版），随规模看曲线 ---- */
    const SCALES = [
      { nG: 1, perG: 100, tag: '1 组 × 100' },
      { nG: 5, perG: 100, tag: '5 组 × 100' },
      { nG: 10, perG: 100, tag: '10 组 × 100' },
      { nG: 20, perG: 100, tag: '20 组 × 100' },
    ];
    cvOff();
    const baseResults = [];
    for (const s of SCALES) {
      state.config.groups = mkGroups(s.nG, s.perG);
      renderNav();
      await sleep(120);
      const c = costN(5);
      console.log(`[perf-probe] ---- 基线 ${s.tag}（共 ${s.nG * s.perG} 项）----`);
      line(s.tag, c);
      domStats(s.tag);
      baseResults.push({ ...s, total: s.nG * s.perG, c });
      if (s.nG === 10) {
        scrollTest(s.tag);
        // ★ 截图前必须等入场动画播完（延迟最长 400ms + pop 340ms ≈ 740ms），
        //   否则拍到的是 opacity:0 的延迟期，看起来像"卡片没渲染"——
        //   content-vis 开启后 scrollTest 几乎瞬间完成，这个坑必踩（第一版就栽在这）。
        await sleep(1200);
        await API.probeShot('shot-perf-1000-before.png');
        console.log('[perf-probe] 截图 shot-perf-1000-before.png');
      }
    }

    /* ---- 阶段 B：1000 项下的逐字输入（模拟"筛选几乎不缩小"的最坏情况）---- */
    state.config.groups = mkGroups(10, 100);
    renderNav();
    const qBox = document.querySelector('#q');
    state.q = ''; qBox.value = '';
    render();
    await sleep(200);
    console.log('[perf-probe] ---- 基线 1000 项：逐字输入 ----');
    await typeTest('压力', '最坏（筛选不缩小）');
    state.q = ''; qBox.value = '';
    render();
    await sleep(200);
    await typeTest('App3_7', '收窄（命中少量）');

    /* ---- 阶段 C：恢复已发布样式（content-visibility 开）—— A/B ---- */
    state.q = ''; qBox.value = '';
    render();
    await sleep(200);
    cvOn();
    await sleep(120);
    console.log('[perf-probe] 已恢复 style.css 里的 content-visibility');
    console.log('[perf-probe] 生效检查 = content-visibility:',
      getComputedStyle(host().querySelector('.card')).contentVisibility);

    const fixResults = [];
    for (const s of SCALES) {
      state.config.groups = mkGroups(s.nG, s.perG);
      renderNav();
      await sleep(120);
      const c = costN(5);
      console.log(`[perf-probe] ---- content-vis 开 ${s.tag}（共 ${s.nG * s.perG} 项）----`);
      line(s.tag, c);
      fixResults.push({ ...s, total: s.nG * s.perG, c });
      if (s.nG === 10) {
        scrollTest(s.tag);
        await sleep(1200);          // 同上：等入场动画播完再拍，两张图才可比
        await API.probeShot('shot-perf-1000-after.png');
        console.log('[perf-probe] 截图 shot-perf-1000-after.png');
      }
    }

    state.config.groups = mkGroups(10, 100);
    renderNav();
    await sleep(150);
    console.log('[perf-probe] ---- content-vis 开 1000 项：逐字输入 ----');
    await typeTest('压力', '最坏（筛选不缩小）');

    /* ---- 阶段 D：入场动画是不是独立的问题 ----
     * 阶段 C 已经给出一个反直觉结论：注入 content-visibility 后动画条数**没变**
     * （1004 → 1004）。因为 content-visibility 跳过的是卡片的"内容"布局/绘制，
     * 而 pop 动画挂在 .card 元素自己身上 —— 所以每次重绘仍会创建约 1000 条动画，
     * 逐字搜索时它们一起重播，等于每敲一个键上千张卡闪一遍。这里直接验证修复
     * （#gridHost.no-anim，搜索重绘时由 render({noAnim}) 挂上）的效果。 */
    state.q = ''; qBox.value = '';
    state.config.groups = mkGroups(10, 100);
    renderNav();
    await sleep(200);

    const animCount = (noAnim) => { render({ noAnim: !!noAnim }); void host().offsetHeight; return document.getAnimations().length; };
    const animOn = animCount(false);
    const animOff = animCount(true);
    animCount(false);
    console.log('[perf-probe] 1000 项一次重绘的动画条数：正常 render() =', animOn,
      '| render({noAnim:true}) =', animOff,
      '→ 逐字搜索走 no-anim，把 ~1000 条 pop 动画从每次敲键里拿掉');
    await sleep(150);

    /* ---- 对照表 ---- */
    console.log('[perf-probe] ===== A/B 对照（合计耗时中位数）=====');
    baseResults.forEach((b, i) => {
      const f = fixResults[i];
      const drop = b.c.total ? Math.round((1 - f.c.total / b.c.total) * 100) : 0;
      console.log(`[perf-probe]   ${pad(b.tag, 14)} 基线 ${pad(b.c.total, 8)}ms`
        + ` → content-vis 开 ${pad(f.c.total, 8)}ms  (${drop >= 0 ? '降' : '升'} ${Math.abs(drop)}%)`
        + ` | 动画 ${b.c.anim} → ${f.c.anim}`);
    });

    /* ---- 还原（内存还原 + 重绘，磁盘从未被动过）---- */
    cvOn();
    state.config.groups = snapshot;
    state.active = snapState.active;
    state.q = snapState.q;
    state.sort = snapState.sort;
    state.picked.clear();
    qBox.value = '';
    renderNav();
    render();
    await sleep(200);
    console.log('[perf-probe] 已还原 分组/项目 =',
      state.config.groups.length, '/', state.config.groups.reduce((n, g) => n + g.items.length, 0),
      '| 临时样式已清 =', !document.querySelector('#perf-cv-off'),
      '| 卡片数 =', host().querySelectorAll('.card[data-id]').length);
    console.log('[perf-probe] done');
    // ★ 主动退出：不然探针跑完应用还挂着 300s 看门狗，期间它占着单实例锁，
    //   下一次探针会立刻静默退出（第二次实测栽在这 —— 日志只有一行"用时=347ms"）。
    API.quit().catch(() => { /* 进程正在退出，属正常 */ });
  });

  // 「启动时打开哪个分组」+「多选编辑模式」自检（仅 --select-probe 时由主进程触发）：
  //   A 段：startViewFromSettings 的解析表（纯函数，含"指定分组已被删"的兜底）
  //         + 设置面板下拉 → 保存 → 真的落盘
  //   B 段：合成「进多选 → 点卡片勾选 → 批量收藏 → 批量移动 → 批量删除 → Esc 退出」
  //         **真的走 saveConfig**（只动 dev 的 .tmpdata/userData）
  // 整段跑完把配置完完整整还原（内存 + 磁盘各一次），跑之前外面还会先备份 config.json。
  API.on('ql:select-probe', async () => {
    state.probeMode = true;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const $el = s => document.querySelector(s);
    const cardEls = () => Array.from(document.querySelectorAll('.card[data-id]'));
    /** 清掉搜索态。
     *  ★ 探针窗口是 opacity:0 但仍然可聚焦的，用户在外面打字时按键会落进
     *    搜索框 → state.q 变非空 → matches() 全假 → 网格渲染出 0 张卡，
     *    整段探针会"无缘无故"失败（真踩过）。主进程那边已经把探针窗口设成
     *    不可聚焦，这里再兜一层：每个阶段开始前把搜索态清零并记录。 */
    const clearQuery = () => {
      if (state.q) console.log('[select-probe] 搜索框被外部输入污染了:', JSON.stringify(state.q), '→ 已清空');
      state.q = ''; $el('#q').value = ''; $el('#q').blur();
    };
    clearQuery();
    await sleep(200);
    if (!cardEls().length) render();
    console.log('[select-probe] 起始 卡片数 =', cardEls().length,
      '| active =', state.active, '| q =', JSON.stringify(state.q));
    const snap = async (file, label) => {
      const t0 = performance.now();
      // 1) 截"干净"的图：提示气泡浮在操作栏右边，会盖住「完成」按钮。
      //    ★ 不要写"轮询等它自己消失"——那是个几十次 sleep 的循环，慢且不确定；
      //      直接临时藏起来、拍完还原，效果一样但代价是常数级。
      const toastBox = $el('#toasts');
      const prevVis = toastBox ? toastBox.style.visibility : '';
      if (toastBox) toastBox.style.visibility = 'hidden';
      // 2) 等卡片入场动画播完：卡片带 0~400ms 的 animation-delay 加一段 pop 时长，
      //    抢在动画中间截会拍出"只有分组标题、卡片全是空白"的图（★ 真踩过：
      //    拍出来的 README 配图里一张卡都没有）。这里不光等，还要验。
      await sleep(800);
      const opaqueNow = () => {
        const cs = cardEls();
        return { n: cs.length, painted: cs.filter(c => Number(getComputedStyle(c).opacity) > 0.98).length };
      };
      let st = opaqueNow();
      if (st.n && st.painted < st.n) {
        console.log('[select-probe] ★ 截图前有', st.n - st.painted, '/', st.n, '张卡片还没画出来 → 再等 800ms');
        await sleep(800);
        st = opaqueNow();
      }
      const r = await API.probeShot(file);
      if (toastBox) toastBox.style.visibility = prevVis;
      console.log('[select-probe] 截图', label, '->', r && r.ok ? 'ok' : ('失败 ' + (r && r.msg)),
        '| 已画出卡片 =', st.painted, '/', st.n,
        '| 耗时', Math.round(performance.now() - t0), 'ms',
        st.n && st.painted < st.n ? '★ 截图可能是空的' : '');
    };
    // 只看磁盘上的真实内容 —— state 里自洽的断言没有意义
    const disk = () => API.getConfig();

    const backup = JSON.parse(JSON.stringify(state.config));
    const restore = async () => {
      if (state.editMode) setEditMode(false);
      state.config = JSON.parse(JSON.stringify(backup));
      const r = await API.saveConfig(state.config);
      await refresh();
      const d = await disk();
      const same = JSON.stringify(d.groups) === JSON.stringify(backup.groups)
        && JSON.stringify(d.settings) === JSON.stringify(backup.settings);
      console.log('[select-probe] 还原配置 =', r.ok ? 'ok' : ('失败 ' + r.msg),
        '| 与起始快照一致 =', same,
        '| 启动分组 =', d.settings.startGroup, '| 上次分组 =', d.settings.lastGroup);
    };

    try {
      await sleep(300);

      /* ============ A：启动分组设置 ============ */
      const gid = (state.config.groups[0] || {}).id;
      console.log('[select-probe] A0 起始 settings.startGroup =',
        state.config.settings.startGroup, '| lastGroup =', state.config.settings.lastGroup,
        '| 分组数 =', state.config.groups.length, '| 首组 id =', gid || '(无)');

      const cases = [
        [{ startGroup: 'last', lastGroup: 'g:' + gid }, gid, '记住上次 → 上次那个分组'],
        [{ startGroup: 'last', lastGroup: 'fav' }, 'fav', '记住上次 → 上次停在虚拟视图'],
        [{ startGroup: 'last' }, 'all', '记住上次但没记录过'],
        [{ startGroup: 'fav' }, 'fav', '固定收藏'],
        [{ startGroup: 'all' }, 'all', '固定全部'],
        [{ startGroup: 'recent' }, 'recent', '固定最近使用'],
        [{ startGroup: 'g:' + gid }, gid, '固定到指定分组'],
        [{ startGroup: 'g:不存在的分组' }, 'all', '指定的分组已被删'],
        [{ startGroup: 'last', lastGroup: 'g:不存在的分组' }, 'all', '上次的分组已被删'],
        [{}, 'all', '空的 settings'],
      ];
      let bad = 0;
      cases.forEach(([s, want, label]) => {
        const got = startViewFromSettings(s);
        const okCase = got === want;
        if (!okCase) bad++;
        console.log('[select-probe] A1', okCase ? 'OK  ' : '★FAIL', label,
          '=>', JSON.stringify(got), '（期望', want + '）');
      });
      console.log('[select-probe] A1 解析表通过 =', cases.length - bad, '/', cases.length);

      if (!gid) { console.log('[select-probe] ★ 没有分组，跳过指定分组的界面链路'); }
      else {
        await openSettings();
        await sleep(220);
        const sel = $el('#sStartGroup');
        const vals = Array.from(sel.options).map(o => o.value);
        console.log('[select-probe] A2 下拉已填充 =', vals.length, '项',
          '| 含 last/all/recent/fav =',
          ['last', 'all', 'recent', 'fav'].every(v => vals.includes(v)),
          '| 含指定分组 g:' + gid + ' =', vals.includes('g:' + gid),
          '| 当前值 =', sel.value);
        await snap('shot-select-startgroup.png', '设置面板「启动时打开」');

        sel.value = 'g:' + gid;
        $el('#btnSetSave').click();
        await sleep(700);
        const after = await disk();
        console.log('[select-probe] A3 保存后 state.startGroup =', state.config.settings.startGroup,
          '| 磁盘 startGroup =', after.settings.startGroup,
          '| 面板已关闭 =', $el('#setOverlay').hidden,
          '| 提示 =', lastToast());

        // 首次加载才套用；之后手动切视图不能被拽回去
        await refresh({ initView: true });
        const applied = state.active;
        state.active = 'all';
        await refresh();
        const keptManual = state.active;
        await refresh({ initView: true });
        const reapplied = state.active;
        console.log('[select-probe] A4 initView 套用 =', applied === gid,
          '| 之后手动切走不被拽回 =', keptManual === 'all',
          '| 再次 initView 重新套用 =', reapplied === gid);
        // 收尾：把 startGroup 还原成「记住上次」，别让后面的 B 段落在怪视图上
        await API.setSettings({ startGroup: backup.settings.startGroup });
        state.config.settings.startGroup = backup.settings.startGroup;
        state.active = 'all';
        await refresh();
      }

      /* ============ B：多选编辑模式 ============ */
      clearQuery();        // 回到干净搜索态，别让外部干扰把列表抽空
      await refresh();     // 回到「全部」，保证格子是满的
      await sleep(200);
      const ids0 = allItems().map(x => x.i.id);
      console.log('[select-probe] B0 起始启动项 =', ids0.length, '| 卡片数 =', cardEls().length,
        '| editMode =', state.editMode, '| 操作栏隐藏 =', $el('#editBar').hidden);
      if (!ids0.length) {
        console.log('[select-probe] ★ 没有启动项，B 段无法进行');
      } else {
        /* B1 进入编辑模式 */
        $el('#btnSelect').click();
        await sleep(260);
        console.log('[select-probe] B1 editMode =', state.editMode,
          '| body.edit-mode =', document.body.classList.contains('edit-mode'),
          '| 按钮 .on =', $el('#btnSelect').classList.contains('on'),
          '| aria-pressed =', $el('#btnSelect').getAttribute('aria-pressed'),
          '| 操作栏可见 =', !$el('#editBar').hidden,
          '| data-empty =', $el('#editBar').dataset.empty,
          '| 计数 =', $el('#ebCount').textContent,
          '| 「新建启动项」卡片数 =', document.querySelectorAll('.card.add[data-add]').length, '（应为 0）',
          '| 勾选标记数 =', document.querySelectorAll('.card[data-id] .pick').length,
          '| 移动下拉项 =', $el('#ebMove').options.length - 1, '（应等于分组数）');

        /* B2 点卡片勾选（走真实 click 分支，不是直接调 togglePick） */
        const cards = cardEls();
        console.log('[select-probe] B2 点击前 卡片数 =', cards.length,
          '| active =', state.active, '| q =', JSON.stringify(state.q),
          '| editMode =', state.editMode,
          '| suppressClick =', state.suppressClick,
          '| 首张 id =', cards[0] ? cards[0].dataset.id : '(无)');
        const pickIds = cards.slice(0, Math.min(3, cards.length)).map(c => c.dataset.id);
        pickIds.forEach((id, k) => {
          // 每轮都重新查一次：万一中间有 refresh() 把卡片换掉，
          // 还拿着旧引用点会打在已脱离文档的节点上（事件不会冒泡到 #gridHost），
          // 表现为"点了没反应"，很难查。
          const c = cardEls().find(x => x.dataset.id === id);
          if (!c) {
            console.log('[select-probe] B2 第', k + 1, '张（' + id + '）已不在 DOM 里，跳过');
            return;
          }
          c.click();
          console.log('[select-probe] B2 点第', k + 1, '张（' + id + '）→ 勾选数 =', state.picked.size,
            '| 该卡有 .picked =', c.classList.contains('picked'));
        });
        await sleep(260);
        console.log('[select-probe] B2 勾选数 =', state.picked.size, '/', pickIds.length,
          '| 与点击目标一致 =', pickIds.every(id => state.picked.has(id)),
          '| .card.picked 数 =', document.querySelectorAll('.card.picked').length,
          '| data-empty =', $el('#editBar').dataset.empty,
          '| 计数 =', $el('#ebCount').textContent,
          '| 视图未被切走 =', state.active,
          '| 无「启动失败」提示 =', !/启动|失败|不存在/.test(lastToast()));
        await snap('shot-select-picked.png', '多选：已勾选 3 项');

        /* B3 取消勾选一张，确认能反选 */
        const first = cardEls().find(x => x.dataset.id === pickIds[0]);
        if (first) first.click();
        await sleep(200);
        console.log('[select-probe] B3 反选后勾选数 =', state.picked.size,
          '（应为', pickIds.length - 1, '）| .card.picked =', document.querySelectorAll('.card.picked').length);
        if (first) first.click();
        await sleep(180);

        /* B4 全选 / 清空 */
        $el('#ebAll').click();
        await sleep(220);
        const allN = state.picked.size;
        const visN = cardEls().length;
        console.log('[select-probe] B4 全选后 =', allN, '/ 可见卡片', visN,
          '| 一致 =', allN === visN && visN > 0,
          visN === 0 ? '★ 列表里一张卡都没有（active=' + state.active + ' q=' + JSON.stringify(state.q) + '）' : '');
        $el('#ebNone').click();
        await sleep(220);
        console.log('[select-probe] B4 清空后 =', state.picked.size, '（应为 0）',
          '| data-empty =', $el('#editBar').dataset.empty,
          '| 批量动作已置灰 =',
          getComputedStyle($el('#ebDel')).pointerEvents === 'none');

        /* B5 批量收藏 / 取消收藏 */
        pickIds.forEach(id => { const c = cardEls().find(x => x.dataset.id === id); if (c) c.click(); });
        await sleep(220);
        if (!state.picked.size) {
          // 勾不上就不许往下走：后面的批量操作在"零选中"下会"通过"得毫无意义
          console.log('[select-probe] ★ B5 一项都没勾上，批量收藏 / 移动 / 删除全部跳过（不算通过）',
            '| 卡片数 =', cardEls().length, '| active =', state.active, '| q =', JSON.stringify(state.q));
        } else {
          $el('#ebFavOn').click();
          await sleep(700);
          let d1 = await disk();
          const favOn = pickIds.every(id => {
            const f = d1.groups.flatMap(g => g.items).find(i => i.id === id);
            return f && f.favorite === true;
          });
          console.log('[select-probe] B5 收藏 =', favOn, '| 提示 =', lastToast());
          $el('#ebFavOff').click();
          await sleep(700);
          d1 = await disk();
          const favOff = pickIds.every(id => {
            const f = d1.groups.flatMap(g => g.items).find(i => i.id === id);
            return f && f.favorite === false;
          });
          console.log('[select-probe] B5 取消收藏 =', favOff, '| 提示 =', lastToast());

          /* B6 批量移动分组 */
          const pairs = pickedPairs();
          const fromIds = [...new Set(pairs.map(p => p.g.id))];
          const dest = state.config.groups.find(g => !fromIds.includes(g.id));
          if (!pairs.length || !dest) {
            console.log('[select-probe] B6 跳过批量移动 | 选中项 =', pairs.length, '| 可用目标组 =', dest ? 1 : 0);
          } else {
            const moveIds = pairs.map(p => p.i.id);
            const mv = $el('#ebMove');
            mv.value = dest.id;
            mv.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(800);
            const d2 = await disk();
            const landed = moveIds.every(id =>
              (d2.groups.find(g => g.id === dest.id).items || []).some(i => i.id === id));
            const left = fromIds.every(o =>
              !(d2.groups.find(g => g.id === o).items || []).some(i => moveIds.includes(i.id)));
            console.log('[select-probe] B6 移动', moveIds.length, '项 → 目标 =', dest.name,
              '| 已落进目标组 =', landed, '| 已离开原组 =', left,
              '| 提示 =', lastToast(), '| 下拉已复位 =', mv.value === '');
            await snap('shot-select-moved.png', '多选：批量移动之后');
          }

          /* B7 批量删除（确认框那一关也要走） */
          const remaining = cardEls();
          const delIds = remaining.slice(0, 2).map(c => c.dataset.id);
          $el('#ebNone').click();
          await sleep(200);
          delIds.forEach(id => { const c = cardEls().find(x => x.dataset.id === id); if (c) c.click(); });
          await sleep(220);
          console.log('[select-probe] B7 待删 =', delIds.length, '| 勾选 =', state.picked.size);
          $el('#ebDel').click();
          await sleep(400);
          const cf = $el('#confirmOverlay');
          console.log('[select-probe] B7 确认框可见 =', !!cf && !cf.hidden,
            '| 标题 =', ($el('#cfTitle') || {}).textContent || '(空)',
            '| 文案 =', ($el('#cfText') || {}).textContent || '(空)',
            '| 按钮 =', ($el('#cfYes') || {}).textContent || '(空)');
          await snap('shot-select-del.png', '多选：批量删除确认');
          $el('#cfYes').click();
          await sleep(1000);
          const d3 = await disk();
          const gone = delIds.length > 0 &&
            delIds.every(id => !d3.groups.flatMap(g => g.items).some(i => i.id === id));
          console.log('[select-probe] B7 已从磁盘删除 =', gone,
            '| 勾选已清空 =', state.picked.size === 0,
            '| 提示 =', lastToast());
        }

        /* B8 切视图会清空勾选（避免"以为只删了眼前这几个"） */
        await refresh();
        await sleep(200);
        const c8 = cardEls()[0];
        if (c8) c8.click();
        await sleep(180);
        const before8 = state.picked.size;
        const otherNav = $el('[data-nav="recent"]');
        if (otherNav) otherNav.click();
        await sleep(300);
        console.log('[select-probe] B8 切视图前勾选 =', before8,
          '→ 切视图后 =', state.picked.size, '（应为 0）',
          '| 仍处于编辑模式 =', state.editMode);

        /* B9 Esc 退出编辑模式。
           ★ 刻意把焦点放回搜索框、并留一个非空搜索词：程序启动会自动聚焦搜索框，
             而右键「多选编辑…」不会移走焦点，所以"进编辑模式时焦点在搜索框里"
             是真实会走到的路径。曾经 Esc 被 typing 挡住 → 落到"清搜索词 / 隐藏窗口"
             那条分支上：用户想退出编辑，窗口却没了。这里用非空搜索词把它抓出来。 */
        const qBox = $el('#q');
        qBox.value = 'probe-esc';
        state.q = 'probe-esc';
        qBox.focus();
        const aeTag = document.activeElement
          ? document.activeElement.tagName + (document.activeElement.id ? '#' + document.activeElement.id : '')
          : '(null)';
        const openOv = $$('.overlay').filter(o => !o.hidden).map(o => o.id);
        console.log('[select-probe] B9 派发 Esc 前 activeElement =', aeTag,
          '| 未关闭的 overlay =', openOv.join(',') || '(无)',
          '| 搜索词 =', JSON.stringify(state.q));
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
        }));
        await sleep(300);
        console.log('[select-probe] B9 Esc 后 editMode =', state.editMode,
          '| body.edit-mode =', document.body.classList.contains('edit-mode'),
          '| 操作栏隐藏 =', $el('#editBar').hidden,
          '| 按钮 .on =', $el('#btnSelect').classList.contains('on'),
          '| 勾选残留 =', state.picked.size,
          '| 卡片上 .pick 残留 =', document.querySelectorAll('.card .pick').length,
          '| 焦点已从搜索框摘掉 =', document.activeElement !== qBox,
          '| 搜索词没被 Esc 清掉 =', state.q === 'probe-esc');
        // 收尾：把搜索词清掉，好检查「新建启动项」卡片有没有回来
        state.q = ''; qBox.value = '';
        await refresh();
        await sleep(200);
        console.log('[select-probe] B9 退出后「新建启动项」卡片已回来 =',
          document.querySelectorAll('.card.add[data-add]').length > 0,
          '| 启动项数 =', allItems().length);

        /* B10 反向验证：编辑模式下在搜索框里打字时，Delete / Ctrl+A 必须被拦住 ——
           否则"想删几个字"会变成"批量删启动项"，属于数据事故。 */
        setEditMode(true);
        await sleep(240);
        const c10 = cardEls()[0];
        if (c10) c10.click();
        await sleep(180);
        $el('#q').focus();
        const n10 = state.picked.size;
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Delete', code: 'Delete', keyCode: 46, bubbles: true,
        }));
        await sleep(300);
        console.log('[select-probe] B10 搜索框聚焦时按 Delete：勾选', n10, '→', state.picked.size,
          '（应保持不变）| 弹出了删除确认框 =', !$el('#confirmOverlay').hidden);
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true, bubbles: true,
        }));
        await sleep(250);
        console.log('[select-probe] B10 搜索框聚焦时按 Ctrl+A：勾选仍为', state.picked.size,
          '（应保持不变，没被当成"全选启动项"）');
        $el('#q').blur();
        setEditMode(false);
        await sleep(200);
      }
    } catch (e) {
      console.log('[select-probe] ★ 异常:', (e && e.message) || e);
    } finally {
      await restore();
      console.log('[select-probe] done');
      // ★ 探针跑完自己退出，不要靠主进程的看门狗当"结束信号"：
      //   看门狗定小了会把探针掐在"还原配置"之前（dev 配置留污染），
      //   定大了又白等。自己宣布结束才是确定的。
      //   不 await：进程一开始退出，这个 invoke 的应答就可能永远回不来。
      API.quit().catch(() => { /* 进程正在退出，属正常 */ });
    }
  });

  // 分组增删自检（仅 --group-probe 时由主进程触发）：
  // 合成「点 ＋ 新建分组 → 填名 → 确定 → 重名再试 → 点该组 ✕ → 确认删除」，
  // **真的走 saveConfig**（只动 dev 的 .tmpdata/userData），验证侧栏增删整条链路。
  API.on('ql:group-probe', async () => {
    state.probeMode = true;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const snap = async (file, label) => {
      await sleep(150);
      const r = await API.probeShot(file);
      console.log('[group-probe] 截图', label, '->', r && r.ok ? 'ok' : ('失败 ' + (r && r.msg)));
    };
    const ids = () => state.config.groups.map(g => g.id);
    const LAST_TOAST = () => {
      const ts = document.querySelectorAll('#toasts .toast');
      const t = ts[ts.length - 1];
      return t ? t.textContent.replace(/\s+/g, ' ').trim() : '(无)';
    };

    await sleep(300);
    const before = ids();
    console.log('[group-probe] 起始分组数 =', before.length,
      '| 侧栏行内 ✕ 数 =', document.querySelectorAll('[data-del-group]').length, '（应为 0）',
      '| 「＋ 新建分组」存在 =', !!document.querySelector('#navNewGroup'));

    /* ---- A：侧栏按钮新建分组 ---- */
    const newBtn = document.querySelector('#navNewGroup');
    if (!newBtn) { console.log('[group-probe] ★ 找不到「新建分组」按钮，终止'); return; }
    newBtn.click();
    await sleep(300);
    const pm = document.querySelector('#promptOverlay');
    console.log('[group-probe] A 对话框可见 =', !!pm && !pm.hidden,
      '| 标题 =', (document.querySelector('#pmTitle') || {}).textContent || '(空)',
      '| 输入框已聚焦 =', document.activeElement === document.querySelector('#pmInput'));
    await snap('shot-group-new.png', '新建分组对话框');

    const NM = '探针分组';
    document.querySelector('#pmInput').value = NM;
    document.querySelector('#pmOk').click();
    await sleep(600);

    const ng = state.config.groups.find(g => g.name === NM);
    const after = ids();
    console.log('[group-probe] A 新建后分组数 =', after.length,
      '| 新增 id =', after.filter(x => !before.includes(x)).join(',') || '(无)',
      '| 侧栏出现 =', !!(ng && document.querySelector(`[data-nav="${ng.id}"]`)),
      '| 已切换过去 =', !!(ng && state.active === ng.id),
      '| 卡片区标题 =', (document.querySelector('#groupTitle') || {}).textContent);
    if (!ng) { console.log('[group-probe] ★ 新建失败，终止'); return; }

    /* ---- B：重名必须被拦住 ---- */
    document.querySelector('#navNewGroup').click();
    await sleep(300);
    document.querySelector('#pmInput').value = NM;
    document.querySelector('#pmOk').click();
    await sleep(400);
    console.log('[group-probe] B 重名后分组数 =', state.config.groups.length,
      '（应仍为', after.length, '）| 提示 =', LAST_TOAST());

    /* ---- C：删除该分组（走右键菜单背后的同一条 groupAction('del') 路径）----
       侧栏不再放行内 ✕，删除入口只有右键菜单；原生菜单是系统绘制的没法合成点击，
       所以这里直接调菜单会触发的同一个函数，验证的是同一段删除逻辑。 */
    console.log('[group-probe] C 侧栏行内 ✕ 已移除 =',
      !document.querySelector('[data-del-group]'),
      '| 分组右键菜单仍含删除 =', '见 smoke/menu-probe');
    // 注意不能 await：groupAction('del') 会一直挂到确认框被点掉，
    // await 在这里就等于"等一个还没出现的点击"，探针会被自己的看门狗收尸。
    const delDone = groupAction('del', ng.id);
    await sleep(300);
    const cf = document.querySelector('#confirmOverlay');
    console.log('[group-probe] C 确认框可见 =', !!cf && !cf.hidden,
      '| 文案 =', (document.querySelector('#cfText') || {}).textContent || '(空)',
      '| 按钮 =', (document.querySelector('#cfYes') || {}).textContent);
    await snap('shot-group-del.png', '删除分组确认');

    document.querySelector('#cfYes').click();
    await delDone;            // 确认之后才轮到它跑完
    await sleep(400);
    const back = ids();
    console.log('[group-probe] C 删除后分组数 =', back.length,
      '| 与起始一致 =', back.join(',') === before.join(','),
      '| 侧栏已移除 =', !document.querySelector(`[data-nav="${ng.id}"]`),
      '| 当前视图 =', state.active);
    console.log('[group-probe] done');
  });

  // 长按拖动自检（仅 --drag-probe 时由主进程触发）：
  // 合成真实 PointerEvent 走完「长按 0.5s → 进入拖动 → 让位 → 松手」，
  // 阶段1 验证排序判定，阶段2 验证拖入垃圾桶；dryRun，不写配置。
  API.on('ql:drag-probe', async (opt) => {
    state.probeMode = true;
    const real = !!(opt && opt.real);      // real 模式：真的走 saveConfig，用于端到端验证
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const pe = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: 0, buttons: 1, pointerId: 7, pointerType: 'mouse', isPrimary: true,
    });
    const center = el => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    };
    // 瞄准卡片右侧 80% 处：落在中心点上会命中"插到前面"的边界，顺序看起来没变，
    // 断言就没意义了。靠右侧才能真的把卡片挪到目标之后。
    const afterPoint = el => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width * 0.8), y: Math.round(r.top + r.height / 2) };
    };
    const nameOf = c => {
      const h = c.querySelector('h3');
      return h ? h.textContent : '(无名)';
    };
    // 等一小会儿再让主进程截图 —— 主进程自己掐定时器会被节流/漂移，
    // 之前"垃圾桶高亮"那张图总是拍到拖动开始之前，就栽在这上面。
    // 注意别用 requestAnimationFrame：opacity 0 的窗口只出一帧就停，会直接把探针挂死。
    const settle = () => new Promise(r => setTimeout(r, 150));
    const snap = async (file, label) => {
      await settle();
      const tr = $('#trash');
      console.log('[drag-probe] 截图前[' + label + ']',
        '| body.card-dragging =', document.body.classList.contains('card-dragging'),
        '| trash.hidden =', tr ? tr.hidden : 'n/a',
        '| trash.display =', tr ? getComputedStyle(tr).display : 'n/a',
        '| trash.opacity =', tr ? getComputedStyle(tr).opacity : 'n/a',
        '| 桶class =', tr ? tr.className : 'n/a',
        '| 内容区底边 =', Math.round($('#content').getBoundingClientRect().bottom),
        '| .card.dragging 数 =', document.querySelectorAll('.card.dragging').length,
        '| 占位格数 =', document.querySelectorAll('.card-slot').length);
      const r = await API.probeShot(file);
      console.log('[drag-probe] 截图', label, '->', r && r.ok ? 'ok' : ('失败 ' + (r && r.msg)));
    };

    state.dragDryRun = !real;
    console.log('[drag-probe] 模式 =', real ? 'R（真的写盘）' : 'dry（不写盘）');

    // 必须取同一个网格里的两张卡，否则跨分组拖动会被判定为无效落点
    const gridEl = [...document.querySelectorAll('.grid[data-gid]')].find(g =>
      g.dataset.gid
      && state.config.groups.some(x => x.id === g.dataset.gid)
      && g.querySelectorAll('.card[data-id]').length >= 2);
    const cards = gridEl ? [...gridEl.querySelectorAll('.card[data-id]')] : [];
    if (cards.length < 2) {
      console.log('[drag-probe] 同一分组内卡片不足 2 张，跳过');
      return;
    }
    console.log('[drag-probe] 测试网格 gid =', gridEl.dataset.gid,
      '| 卡片 =', cards.map(nameOf).join(' / '));

    /* ---- 阶段 1：长按后拖到另一张卡片上 ---- */
    const src = cards[0];
    const dst = cards[Math.min(2, cards.length - 1)];
    const p0 = center(src);
    console.log('[drag-probe] 阶段1 长按', nameOf(src), HOLD_MS + 'ms…');
    src.dispatchEvent(pe('pointerdown', p0.x, p0.y));
    await sleep(200);
    console.log('[drag-probe]   holding 类 =', src.classList.contains('holding'),
      '| 进度条时长 =', src.style.getPropertyValue('--hold'));

    await sleep(3200);
    const trashEl = $('#trash');
    const d1 = state.drag;
    console.log('[drag-probe]   已进入拖动 =', !!d1,
      '| card.dragging =', src.classList.contains('dragging'),
      '| 垃圾桶可见 =', !!trashEl && !trashEl.hidden,
      '| 占位格 =', !!document.querySelector('.card-slot'));

    const p1 = afterPoint(dst);
    console.log('[drag-probe]   拖到', nameOf(dst), '右侧 →', p1.x, p1.y);
    document.dispatchEvent(pe('pointermove', p1.x, p1.y));
    await sleep(120);
    const grid = d1 && d1.ph ? d1.ph.parentElement : null;
    const order = grid ? [...grid.children].map(n => n.classList.contains('card-slot') ? '[占位]' : nameOf(n)) : [];
    console.log('[drag-probe]   拖动中网格顺序 =', order.join(' → '));

    await snap('shot-drag-sort.png', '拖动让位');
    document.dispatchEvent(pe('pointerup', p1.x, p1.y));
    await sleep(400);

    /* ---- 阶段 2：长按后拖进底部垃圾桶 ---- */
    // real 模式下阶段1 会触发 refresh() 重渲染，早先抓的节点已脱离 DOM，
    // 必须在阶段2 重新取活节点，否则合成事件落在游离节点上（探针假阴性）。
    const liveGrid = document.querySelector(`.grid[data-gid="${gridEl.dataset.gid}"]`);
    const liveCards = liveGrid ? [...liveGrid.querySelectorAll('.card[data-id]')] : cards;
    const src2 = liveCards[1] || cards[1];
    const p2 = center(src2);
    console.log('[drag-probe] 阶段2 长按', nameOf(src2), HOLD_MS + 'ms…');
    src2.dispatchEvent(pe('pointerdown', p2.x, p2.y));
    await sleep(3200);

    const t = trashEl ? center(trashEl) : { x: 0, y: 0 };
    document.dispatchEvent(pe('pointermove', t.x, t.y));
    await sleep(150);
    console.log('[drag-probe]   垃圾桶 hot =', !!trashEl && trashEl.classList.contains('hot'),
      '| 文案 =', ($('#trashTxt') || {}).textContent);

    await snap('shot-drag-trash.png', '垃圾桶高亮');
    document.dispatchEvent(pe('pointerup', t.x, t.y));
    await sleep(400);

    /* ---- 阶段 3：回归护栏 —— 拖到底部区域绝不能被误判成删除 ----
       用户实际踩到的坑：拖到另一张卡上松手，结果被删了。
       根因：旧命中区（垃圾桶 ±14px、再被 .hot 的 scale 放大）正好压在
       网格最后一行卡片上。修复后拖动时内容区整体上收 STRIP_H，条内再无卡片。
       这里 x 故意取**垃圾桶所在的窗口中心线**，只把 y 抬到条上方一点点：
       于是"没被删"只能归因于 y 护栏，而不是 x 恰好没对上。 */
    await sleep(300);
    const liveGrid3 = document.querySelector(`.grid[data-gid="${gridEl.dataset.gid}"]`);
    const cards3 = liveGrid3 ? [...liveGrid3.querySelectorAll('.card[data-id]')] : [];
    if (cards3.length) {
      const src3 = cards3[0];
      const p0b = center(src3);
      console.log('[drag-probe] 阶段3 长按', nameOf(src3), '…（底部误删护栏）');
      src3.dispatchEvent(pe('pointerdown', p0b.x, p0b.y));
      await sleep(2400);                       // 等长按生效 + 内容区上收完成

      // ★ 必须在拖动开始**之后**量，否则拿到的是没上收的旧布局
      const cr3 = $('#content').getBoundingClientRect();
      const stripTop = window.innerHeight - STRIP_H;
      const tr3 = $('#trash');
      const r3 = tr3 ? tr3.getBoundingClientRect() : null;
      console.log('[drag-probe]   不变量 内容区底边', Math.round(cr3.bottom), '<= 预留条顶', stripTop,
        '=>', cr3.bottom <= stripTop ? '成立（条内无卡片）' : '★不成立');

      // A 点：与垃圾桶同一条竖线，但刚好落在预留条上方（旧代码里这一带就是误删区）
      const pA = {
        x: Math.round(window.innerWidth / 2),
        y: Math.round(Math.min(cr3.bottom, stripTop)) - 6,
      };
      document.dispatchEvent(pe('pointermove', pA.x, pA.y));
      await sleep(100);
      console.log('[drag-probe]   A点(', pA.x, ',', pA.y, ') 桶x区间 =',
        r3 ? Math.round(r3.left) + '~' + Math.round(r3.right) : 'n/a',
        '| 在条内 =', pA.y >= stripTop,
        '| 垃圾桶 hot =', !!tr3 && tr3.classList.contains('hot'));

      // B 点：内容里**最低的那张卡**的中心 —— 也就是用户想去"其他位置"
      let lowest = null;
      for (const c of document.querySelectorAll('.card[data-id]')) {
        if (c === src3) continue;
        const r = c.getBoundingClientRect();
        if (r.bottom <= stripTop && (!lowest || r.bottom > lowest.getBoundingClientRect().bottom)) lowest = c;
      }
      if (lowest) {
        const pB = center(lowest);
        document.dispatchEvent(pe('pointermove', pB.x, pB.y));
        await sleep(100);
        console.log('[drag-probe]   B点 最低卡', nameOf(lowest), '(', pB.x, ',', pB.y, ')',
          '| 垃圾桶 hot =', !!tr3 && tr3.classList.contains('hot'));
        document.dispatchEvent(pe('pointerup', pB.x, pB.y));
      } else {
        console.log('[drag-probe]   B点 跳过：没有第二张卡');
        document.dispatchEvent(pe('pointerup', pA.x, pA.y));
      }
      await sleep(400);
    }

    /* ---- 阶段 4：原地长按后直接松手 —— 卡片必须回到原位 ----
       用户实际报的坑：长按后一松手，图标跑到别的位置去了。
       根因是 origStyle 抓取时机太晚，把拖动用的 left/top/width/height 也存了进去；
       而"原地松手"顺序没变、不触发 refresh，脏样式就一直留在卡片上。 */
    await sleep(300);
    const g4 = document.querySelector(`.grid[data-gid="${gridEl.dataset.gid}"]`);
    const c4 = g4 ? g4.querySelector('.card[data-id]') : null;
    if (c4) {
      const before = c4.getBoundingClientRect();
      const p4 = center(c4);
      console.log('[drag-probe] 阶段4 原地长按', nameOf(c4), HOLD_MS + 'ms 后直接松手…');
      c4.dispatchEvent(pe('pointerdown', p4.x, p4.y));
      await sleep(HOLD_MS + 600);
      const mid = c4.getBoundingClientRect();
      document.dispatchEvent(pe('pointerup', p4.x, p4.y));
      await sleep(300);
      const after = c4.getBoundingClientRect();
      const st = c4.getAttribute('style') || '';
      const drift = Math.round(Math.hypot(after.left - before.left, after.top - before.top));
      const staleAll = [...document.querySelectorAll('.card[data-id]')]
        .filter(c => /(^|;)\s*(left|top)\s*:/.test(c.getAttribute('style') || '')).length;
      console.log('[drag-probe]   拖动中(', Math.round(mid.left), ',', Math.round(mid.top), ')',
        '→ 松手后(', Math.round(after.left), ',', Math.round(after.top), ')',
        '| 原始(', Math.round(before.left), ',', Math.round(before.top), ')',
        '| 漂移 =', drift + 'px',
        '| 残留内联 left/top =', /(^|;)\s*(left|top)\s*:/.test(st),
        '| .dragging =', c4.classList.contains('dragging'));
      console.log('[drag-probe]   全文档残留内联 left/top 的卡片数 =', staleAll, '（应为 0）');
    }

    if (real) {
      // real 模式：磁盘上的配置此时应已变（阶段1 换位、阶段2 删除各写了一次）
      const cfg = await API.getConfig();
      const g = (cfg.groups || []).find(x => x.id === gridEl.dataset.gid);
      console.log('[drag-probe] 落盘校验 gid =', gridEl.dataset.gid,
        '| 剩余项 =', (g ? g.items.length : 'n/a'),
        '| 顺序 =', (g ? g.items.map(i => i.name).join(' → ') : 'n/a'));
    }
    console.log('[drag-probe] done');
  });
})();

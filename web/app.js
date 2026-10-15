/* ============================================================
   快速启动 · QuickLaunch  —  前端逻辑
   ============================================================ */

const TOKEN = document.querySelector('meta[name="ql-token"]').content;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const TYPE_INFO = {
  app:    { label: '应用', icon: '🚀', ph: 'C:\\Program Files\\App\\App.exe  或  notepad.exe',
            tip: '<b>应用</b>：填写 .exe / .lnk / .msc 的完整路径，或直接写系统命令名（如 notepad.exe、taskmgr.exe）。' },
  folder: { label: '目录', icon: '📁', ph: 'D:\\WorkBuddy 或 %USERPROFILE%\\Downloads',
            tip: '<b>目录</b>：点击后直接用资源管理器打开该文件夹。支持 %环境变量%。' },
  url:    { label: '网址', icon: '🌐', ph: 'https://github.com/',
            tip: '<b>网址</b>：用默认浏览器打开链接，可直接写域名。' },
  cmd:    { label: '命令', icon: '⌨️', ph: 'explorer.exe "shell:MyComputerFolder"',
            tip: '<b>命令</b>：整行交给 cmd 执行，可写管道与多个命令。' },
  script: { label: '脚本', icon: '📜', ph: 'D:\\scripts\\run.py',
            tip: '<b>脚本</b>：按扩展名自动匹配解释器 —— .py→Python、.bat/.cmd→cmd、.ps1→PowerShell、.js→Node。' },
  file:   { label: '文件', icon: '📄', ph: 'D:\\docs\\note.md',
            tip: '<b>文件</b>：用系统默认程序打开该文件。' },
};

const ICONS = ['🚀','💻','📁','🌐','🛠️','⚙️','🎮','🎵','🎬','📝','📊','📈','🔧','🧰','📦',
               '🐍','🐙','☁️','⚡','🔥','🎯','📸','💬','📧','🗂️','🖥️','🎨','🧪','🔒','⏱️',
               '⭐','🩺','🧮','📐','🛰️','🧩','🔍','🎛️','💾','🪟'];

const PALETTE = ['#3b6cf6','#7c5cff','#12b886','#ff8a3d','#f2506e','#14b8c4','#f0b429','#8b8f9a'];

const state = {
  config: null,
  active: 'all',
  q: '',
  sort: 'custom',
  editing: null,      // {item, groupId, isNew}
  scan: [],           // 扫描候选
  scanPicked: new Set(),
  scanQuery: '',
};

/* ------------------------------------------------------------ 基础工具 */

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, body) {
  const opt = { headers: { 'Content-Type': 'application/json', 'X-QL-Token': TOKEN } };
  if (body !== undefined) { opt.method = 'POST'; opt.body = JSON.stringify(body); }
  const res = await fetch(path, opt);
  const data = await res.json().catch(() => ({ ok: false, msg: '响应解析失败' }));
  return data;
}

function toast(kind, title, text = '') {
  const icons = { ok: '✓', bad: '!', info: 'i' };
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<div class="t-ic">${icons[kind] || 'i'}</div>
    <div class="t-txt"><b>${esc(title)}</b>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, kind === 'bad' ? 4200 : 2400);
}

const uid = () => Math.random().toString(16).slice(2, 10);

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

function recentItems() {
  return allItems()
    .filter(({ i }) => i.lastUsed > 0)
    .sort((a, b) => b.i.lastUsed - a.i.lastUsed)
    .slice(0, 12)
    .map(({ g, i }) => ({ g, i }));
}

function shortPath(p) {
  if (!p) return '';
  const s = String(p);
  return s.length > 62 ? s.slice(0, 28) + '…' + s.slice(-30) : s;
}

/* ------------------------------------------------------------ 渲染：侧栏 */

function renderNav() {
  const total = allItems().length;
  const recent = recentItems().length;
  const nav = $('#nav');
  const rows = [];

  rows.push(`<button class="nav-item ${state.active === 'all' ? 'active' : ''}" data-nav="all">
      <i class="ic">🗂️</i><span class="nm">全部</span><span class="cnt">${total}</span></button>`);
  rows.push(`<button class="nav-item ${state.active === 'recent' ? 'active' : ''}" data-nav="recent">
      <i class="ic">🕘</i><span class="nm">最近使用</span><span class="cnt">${recent}</span></button>`);

  rows.push('<div class="nav-label">分组</div>');
  state.config.groups.forEach(g => {
    const c = g.color || PALETTE[0];
    rows.push(`<button class="nav-item ${state.active === g.id ? 'active' : ''}"
        data-nav="${g.id}" style="--c:${c}" title="${esc(g.name)}">
      <i class="ic">${esc(g.icon || '📦')}</i>
      <span class="nm">${esc(g.name)}</span>
      <span class="cnt">${g.items.length}</span>
    </button>`);
  });

  nav.innerHTML = rows.join('');

  nav.onclick = e => {
    const btn = e.target.closest('[data-nav]');
    if (!btn) return;
    state.active = btn.dataset.nav;
    state.q = '';
    $('#q').value = '';
    render();
  };
}

/* ------------------------------------------------------------ 渲染：主区 */

function viewGroups() {
  if (state.active === 'recent') {
    return [{ id: '_recent', name: '最近使用', icon: '🕘', color: '#8b8f9a', items: recentItems().map(x => x.i) }];
  }
  if (state.active === 'all') return state.config.groups;
  return state.config.groups.filter(g => g.id === state.active);
}

function matches(item) {
  if (!state.q) return true;
  const q = state.q.toLowerCase();
  return (item.name || '').toLowerCase().includes(q)
    || (item.path || '').toLowerCase().includes(q)
    || (item.desc || '').toLowerCase().includes(q)
    || (item.args || '').toLowerCase().includes(q);
}

function sortItems(list) {
  const s = state.sort;
  const arr = [...list];
  if (s === 'name') arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  else if (s === 'recent') arr.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  else if (s === 'uses') arr.sort((a, b) => (b.useCount || 0) - (a.useCount || 0));
  return arr;
}

function cardHTML(item, color, delay) {
  const t = TYPE_INFO[item.type] ? item.type : 'app';
  const sub = item.desc || shortPath(item.path) || '';
  const missing = item._exists === false;
  const uses = item.useCount ? `<span class="uses">用过 ${item.useCount} 次</span>` : '';
  return `<article class="card" tabindex="0" data-id="${esc(item.id)}" style="--c:${color};animation-delay:${delay}ms">
    <div class="card-acts">
      <button class="act" data-act="open" title="启动">▶</button>
      <button class="act" data-act="folder" title="打开所在位置">📂</button>
      <button class="act" data-act="edit" title="编辑">✎</button>
      <button class="act" data-act="del" title="删除">🗑</button>
    </div>
    <div class="card-top">
      <div class="tile">${esc(item.icon || TYPE_INFO[t].icon)}</div>
      <div class="card-meta">
        <h3 title="${esc(item.name)}">${esc(item.name || '未命名')}</h3>
        <p title="${esc(item.path)}">${esc(sub)}</p>
      </div>
    </div>
    <div class="card-foot">
      <span class="badge">${TYPE_INFO[t].label}</span>
      ${missing ? '<span class="missing">路径不存在</span>' : uses}
    </div>
  </article>`;
}

const ADD_CARD = `<article class="card add" data-add="1" tabindex="0">
  <div class="plus">＋</div><span>新建启动项</span></article>`;

function render() {
  const grid = $('#grid');
  const groups = viewGroups();

  const sections = groups.map(g => ({
    g,
    items: sortItems((g.items || []).filter(matches)),
  })).filter(s => s.items.length || (!state.q && state.active !== 'recent'));

  const totalShown = sections.reduce((n, s) => n + s.items.length, 0);

  // 标题
  const cur = state.active === 'all' ? null
    : state.active === 'recent' ? { name: '最近使用', icon: '🕘' }
      : state.config.groups.find(g => g.id === state.active);
  $('#groupTitle').textContent = cur ? `${cur.icon || ''} ${cur.name}`.trim() : '🗂️ 全部';
  $('#groupSub').textContent = state.q
    ? `找到 ${totalShown} 个匹配项`
    : `${totalShown} 个启动项 · ${state.config.groups.length} 个分组`;

  // 骨架屏
  if (!state.config) { grid.innerHTML = '<div class="skeleton"></div>'.repeat(8); return; }

  // 空状态
  if (!totalShown && !sections.length) {
    grid.innerHTML = '';
    $('#empty').hidden = false;
    if (state.q) {
      $('#emptyIcon').textContent = '🔍';
      $('#emptyTitle').textContent = '没有匹配的启动项';
      $('#emptyText').textContent = `没有找到包含「${state.q}」的名称、路径或描述。`;
    } else {
      $('#emptyIcon').textContent = '🗂️';
      $('#emptyTitle').textContent = '这里还没有内容';
      $('#emptyText').textContent = '点击右上角「新建」添加启动项，或用左侧「扫描本机软件」自动导入已安装的程序。';
    }
    return;
  }
  $('#empty').hidden = true;

  // 多分组分区展示
  const perSection = state.active === 'all' && !state.q && state.sort === 'custom' && sections.length > 1;
  let html = '';
  let n = 0;
  if (perSection) {
    sections.forEach(({ g, items }) => {
      if (!items.length) return;
      html += `<div class="section-head"><span>${esc(g.icon || '')} ${esc(g.name)}</span><span class="line"></span></div>`;
      html += `<div class="grid" style="margin-bottom:26px">`
        + items.map(i => cardHTML(i, g.color || PALETTE[0], Math.min(n++ * 22, 420))).join('')
        + `</div>`;
    });
    if (state.active === 'all') html += `<div class="grid">${ADD_CARD}</div>`;
  } else {
    html = `<div class="grid">`
      + sections.flatMap(s => s.items.map(i => cardHTML(i, s.g.color || PALETTE[0], Math.min(n++ * 22, 420)))).join('')
      + (state.active === 'recent' ? '' : ADD_CARD)
      + `</div>`;
  }
  grid.innerHTML = html;
}

/* ------------------------------------------------------------ 侧栏 / 主题 */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#btnTheme').firstChild.textContent = theme === 'dark' ? '☀️' : '🌙';
  const span = $('#btnTheme').querySelector('span');
  if (span) span.textContent = theme === 'dark' ? '浅色模式' : '深色模式';
  localStorage.setItem('ql-theme', theme);
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
    isNew,
    groupId: gid,
    item: item ? JSON.parse(JSON.stringify(item)) : {
      id: uid(), name: '', icon: '🚀', type: 'app', path: '',
      args: '', cwd: '', desc: '', elevate: false, console: false,
      useCount: 0, lastUsed: 0,
    },
  };
  const it = state.editing.item;

  $('#editTitle').textContent = isNew ? '新建启动项' : '编辑启动项';
  $('#editSub').textContent = isNew ? '配置名称、类型与目标路径' : (it.name || '');
  $('#editIc').textContent = isNew ? '＋' : (it.icon || '✎');

  $('#fName').value = it.name || '';
  $('#fArgs').value = it.args || '';
  $('#fCwd').value = it.cwd || '';
  $('#fDesc').value = it.desc || '';
  $('#fPath').value = it.path || '';
  $('#fElevate').checked = !!it.elevate;
  $('#fConsole').checked = !!it.console;

  $('#fGroup').innerHTML = state.config.groups
    .map(g => `<option value="${g.id}">${esc(g.icon || '')} ${esc(g.name)}</option>`).join('')
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
  $('#fIcons').innerHTML = ICONS
    .map(e => `<button class="icon-btn ${e === current ? 'on' : ''}" data-emoji="${e}">${e}</button>`)
    .join('');
}

function closeEdit() {
  $('#editOverlay').hidden = true;
  state.editing = null;
}

function collectForm() {
  const it = state.editing.item;
  it.name = $('#fName').value.trim();
  it.path = $('#fPath').value.trim();
  it.args = $('#fArgs').value.trim();
  it.cwd = $('#fCwd').value.trim();
  it.desc = $('#fDesc').value.trim();
  it.elevate = $('#fElevate').checked;
  it.console = $('#fConsole').checked;
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
  if (state.editing.isNew) {
    const g = state.config.groups.find(x => x.id === gid);
    if (!g) return toast('bad', '分组不存在');
    g.items.push(it);
  } else {
    // 先从所有分组移除，再插入目标分组（支持跨组移动）
    state.config.groups.forEach(g => { g.items = g.items.filter(x => x.id !== it.id); });
    const g = state.config.groups.find(x => x.id === gid);
    if (!g) return toast('bad', '分组不存在');
    g.items.push(it);
  }

  const r = await api('/api/config', { config: state.config });
  if (!r.ok) return toast('bad', '保存失败', r.msg);
  toast('ok', state.editing.isNew ? '已创建' : '已保存', it.name);
  closeEdit();
  await refresh();
}

/* ------------------------------------------------------------ 启动 / 删除 */

async function runItem(id, item) {
  let payload;
  if (item) payload = { item };
  else {
    const found = findItem(id);
    if (!found) return toast('bad', '找不到启动项');
    payload = { item: found.i };
  }
  const r = await api('/api/run', payload);
  if (r.ok) {
    toast('ok', '已启动', r.name || '');
    if (!item) refresh();
  } else {
    toast('bad', '启动失败', r.msg);
  }
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
      resolve(v);
    };
    $('#cfYes').onclick = () => done(true);
    $('#cfNo').onclick = () => done(false);
  });
}

async function deleteItem(id) {
  const found = findItem(id);
  if (!found) return;
  const ok = await confirmDialog({
    title: '删除这个启动项？',
    text: `${found.i.name}（${shortPath(found.i.path)}）`,
    okText: '删除',
  });
  if (!ok) return;
  found.g.items = found.g.items.filter(x => x.id !== id);
  const r = await api('/api/config', { config: state.config });
  if (!r.ok) return toast('bad', '删除失败', r.msg);
  toast('ok', '已删除', found.i.name);
  await refresh();
}

async function deleteGroup(gid) {
  const g = state.config.groups.find(x => x.id === gid);
  if (!g) return;
  const ok = await confirmDialog({
    icon: '📦', title: '删除整个分组？',
    text: `「${g.name}」及其中的 ${g.items.length} 个启动项都会被移除。`,
    okText: '删除分组',
  });
  if (!ok) return;
  state.config.groups = state.config.groups.filter(x => x.id !== gid);
  await api('/api/config', { config: state.config });
  if (state.active === gid) state.active = 'all';
  toast('ok', '已删除分组', g.name);
  await refresh();
}

/* ------------------------------------------------------------ 扫描导入 */

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
  $('#scanOverlay').hidden = false;
  $('#scanSub').textContent = '正在读取开始菜单与注册表…';
  $('#scanList').innerHTML = '<div class="skeleton" style="height:60px;margin-bottom:6px"></div>'.repeat(6);
  state.scanPicked = new Set();
  const r = await api('/api/scan', { force: false });
  if (!r.ok) {
    $('#scanSub').textContent = r.msg || '扫描失败';
    $('#scanList').innerHTML = '';
    return toast('bad', '扫描失败', r.msg);
  }
  state.scan = r.items || [];
  $('#scanSub').textContent = `共找到 ${state.scan.length} 个候选程序，勾选后导入`;
  renderScanList();
}

async function importScan() {
  if (!state.scanPicked.size) return toast('info', '还没有勾选任何软件');
  // 复用或创建「已安装软件」分组
  let g = state.config.groups.find(x => x.id === 'scanned');
  if (!g) {
    g = { id: 'scanned', name: '已安装软件', icon: '📦', color: PALETTE[2], items: [] };
    state.config.groups.push(g);
  }
  const have = new Set(allItems().map(x => (x.i.path || '').toLowerCase()));
  let added = 0;
  for (const it of state.scan) {
    if (!state.scanPicked.has(it.path)) continue;
    if (have.has(it.path.toLowerCase())) continue;
    have.add(it.path.toLowerCase());
    g.items.push({
      id: uid(), name: it.name, icon: '🚀', type: 'app', path: it.path,
      args: '', cwd: '', desc: it.source, elevate: false, console: false,
      useCount: 0, lastUsed: 0,
    });
    added++;
  }
  const r = await api('/api/config', { config: state.config });
  if (!r.ok) return toast('bad', '导入失败', r.msg);
  $('#scanOverlay').hidden = true;
  toast('ok', `已导入 ${added} 个启动项`, '分组：已安装软件');
  state.active = 'scanned';
  await refresh();
}

/* ------------------------------------------------------------ 数据加载 */

async function refresh() {
  const r = await api('/api/config');
  if (!r.ok) {
    setConn(false, '读取配置失败');
    toast('bad', '读取配置失败', r.msg);
    return;
  }
  state.config = r.config;
  state.sort = state.config.settings.sort || 'custom';
  $('#sort').value = state.sort;
  applyTheme(state.config.settings.theme || localStorage.getItem('ql-theme') || 'light');
  renderNav();
  render();
}

async function ping() {
  try {
    const r = await api('/api/ping');
    if (r.ok) setConn(true, `${r.host} · ${r.time.slice(11, 16)}`);
    else setConn(false, '服务异常');
  } catch {
    setConn(false, '连接已断开');
  }
}

function setConn(ok, text) {
  const el = $('#conn');
  el.className = 'conn ' + (ok ? 'ok' : 'bad');
  el.querySelector('span').textContent = text;
}

async function persistSettings() {
  state.config.settings.theme = document.documentElement.dataset.theme;
  state.config.settings.sort = state.sort;
  await api('/api/config', { config: state.config });
}

/* ------------------------------------------------------------ 事件绑定 */

function bind() {
  // 卡片交互
  $('#grid').addEventListener('click', e => {
    const add = e.target.closest('[data-add]');
    if (add) return openEdit(null, state.active === 'all' || state.active === 'recent' ? null : state.active);

    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;

    const actBtn = e.target.closest('.act');
    if (actBtn) {
      e.stopPropagation();
      const act = actBtn.dataset.act;
      if (act === 'open') runItem(id);
      else if (act === 'edit') {
        const f = findItem(id);
        if (f) openEdit(f.i, f.g.id);
      } else if (act === 'del') deleteItem(id);
      else if (act === 'folder') {
        const f = findItem(id);
        if (!f) return;
        api('/api/folder', { path: f.i.path }).then(r => {
          if (!r.ok) toast('bad', '无法定位', r.msg);
        });
      }
      return;
    }
    runItem(id);
  });

  $('#grid').addEventListener('keydown', e => {
    const card = e.target.closest('.card');
    if (!card) return;
    const cards = $$('#grid .card');
    const idx = cards.indexOf(card);
    if (e.key === 'Enter') { e.preventDefault(); card.dataset.add ? openEdit(null, null) : runItem(card.dataset.id); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nx = cards[Math.min(idx + 1, cards.length - 1)];
      nx && nx.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const pv = cards[Math.max(idx - 1, 0)];
      pv && pv.focus();
    } else if (e.key === 'Delete') {
      if (card.dataset.id) deleteItem(card.dataset.id);
    } else if (e.key === 'e' && !card.dataset.add) {
      const f = findItem(card.dataset.id);
      if (f) openEdit(f.i, f.g.id);
    }
  });

  // 搜索
  const q = $('#q');
  q.addEventListener('input', () => { state.q = q.value.trim(); render(); });
  q.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = $('#grid .card');
      first && first.focus();
    }
  });

  // 排序
  $('#sort').addEventListener('change', e => {
    state.sort = e.target.value;
    render();
    persistSettings();
  });

  // 新建
  $('#btnAdd').addEventListener('click', () =>
    openEdit(null, (state.active === 'all' || state.active === 'recent') ? null : state.active));

  // 主题
  $('#btnTheme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    persistSettings();
  });

  // 退出服务
  $('#btnQuit').addEventListener('click', async () => {
    const ok = await confirmDialog({
      icon: '⏻', title: '退出快速启动服务？',
      text: '关闭后本页面将无法再启动程序，双击 Start.bat 可重新启动。',
      okText: '退出服务',
    });
    if (!ok) return;
    setConn(false, '服务已退出');
    try { await api('/api/quit', {}); } catch { /* 进程已退出 */ }
  });

  // 扫描
  $('#btnScan').addEventListener('click', openScan);
  $('#scanQ').addEventListener('input', e => { state.scanQuery = e.target.value.trim(); renderScanList(); });
  $('#scanList').addEventListener('click', e => {
    const row = e.target.closest('.scan-item');
    if (!row) return;
    const p = row.dataset.path;
    state.scanPicked.has(p) ? state.scanPicked.delete(p) : state.scanPicked.add(p);
    renderScanList();
  });
  $('#btnScanAll').addEventListener('click', () => {
    state.scan.forEach(it => state.scanPicked.add(it.path));
    renderScanList();
  });
  $('#btnScanNone').addEventListener('click', () => { state.scanPicked.clear(); renderScanList(); });
  $('#btnScanImport').addEventListener('click', importScan);

  // 编辑弹窗
  $('#fTypes').addEventListener('click', e => {
    const b = e.target.closest('[data-type]');
    if (b) setType(b.dataset.type);
  });
  $('#fIcons').addEventListener('click', e => {
    const b = e.target.closest('[data-emoji]');
    if (!b) return;
    state.editing.item.icon = b.dataset.emoji;
    renderIconPicker(b.dataset.emoji);
  });
  $('#fName').addEventListener('input', e => { $('#editIc').textContent = state.editing.item.icon; });
  $('#fGroup').addEventListener('change', e => {
    $('#newGroupField').hidden = e.target.value !== '__new__';
    if (e.target.value === '__new__') $('#fNewGroup').focus();
  });
  $('#btnBrowse').addEventListener('click', async () => {
    const kind = $('#fTypes .type-chip.on').dataset.type === 'folder' ? 'dir' : 'file';
    const r = await api('/api/pick', { kind });
    if (r.ok && r.path) {
      $('#fPath').value = r.path;
      if (!$('#fName').value) {
        const base = r.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
        $('#fName').value = base;
      }
    } else if (!r.ok) toast('bad', '选择失败', r.msg);
  });
  $('#btnSave').addEventListener('click', saveEdit);
  $('#btnTest').addEventListener('click', () => {
    const it = collectForm();
    if (!it.path) return toast('bad', '请先填写路径');
    runItem(null, it);
  });

  // 弹窗关闭
  $$('[data-close]').forEach(b => b.addEventListener('click', () => {
    b.closest('.overlay').hidden = true;
    state.editing = null;
  }));
  $$('.overlay').forEach(o => o.addEventListener('mousedown', e => {
    if (e.target === o && o.id !== 'confirmOverlay') {
      o.hidden = true;
      state.editing = null;
    }
  }));

  // 全局快捷键
  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    const anyOpen = $$('.overlay').some(o => !o.hidden);

    if (e.key === '/' && !typing && !anyOpen) { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
    if (e.key === 'Escape') {
      if (anyOpen) {
        $$('.overlay').forEach(o => { o.hidden = true; });
        state.editing = null;
      } else if (state.q) {
        state.q = ''; $('#q').value = ''; render();
      }
      return;
    }
    if (e.key === 'n' && !typing && !anyOpen) {
      e.preventDefault();
      openEdit(null, (state.active === 'all' || state.active === 'recent') ? null : state.active);
    }
  });

  // 周期刷新连接状态
  setInterval(ping, 30000);
}

/* ------------------------------------------------------------ 启动 */

(async function init() {
  applyTheme(localStorage.getItem('ql-theme') || 'light');
  bind();
  await refresh();
  ping();
})();

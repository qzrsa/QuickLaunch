'use strict';
/**
 * 自更新的**编排层**：把「检查 → 下载 → 摊进暂存区 → 交接给退出后助手」串成一条状态机，
 * 并把状态摊成一份快照给界面。主进程只负责喂真实依赖（app / fs / spawn / 设置），
 * 于是整条状态机能在 smoke 里用注入依赖离线跑完 —— 不联网，也不碰真实程序目录。
 *
 * 分工（刻意分成四层，混了就会出现两份实现）：
 *   updater-core    纯判断：选方案 / 校验 / 算删除清单
 *   updater.js      执行：传输、落盘、摊暂存区
 *   updater-apply   生成"退出后"的助手脚本（纯字符串拼装）
 *   update-service  编排 + 状态机 + 面向界面的快照   ← 本文件
 *
 * ★★ 三条不可动摇的产品约束（用户拍板）：
 *   ① 默认开启自动检查，但**只在启动时检查一次** —— 不轮询、不常驻、不后台盯着。
 *   ② **下载与安装永远等用户点**。检查是全自动的，动手必须是人按的。
 *   ③ 便携版是单文件 exe，运行中无法替换自己 → 直接判"不支持"，并告诉用户去哪下。
 *
 * ★★ 为什么快照要连"为什么不能更新"一起给出：用户看到"更新不可用"时最需要的是原因
 *    （便携版？清单没发？超时？），而不是一个静默的灰按钮。
 */

const nodeFs = require('fs');
const nodePath = require('path');
const { spawn: nodeSpawn } = require('child_process');

const updater = require('./updater.js');
const applyLib = require('./updater-apply.js');

/* ------------------------------------------------------------------ 状态 */

const STATE = Object.freeze({
  UNSUPPORTED: 'unsupported',   // 便携版 / 开发模式
  IDLE: 'idle',                 // 还没查过
  CHECKING: 'checking',
  UPTODATE: 'uptodate',
  AVAILABLE: 'available',       // 有新版本，等用户点「下载」
  DOWNLOADING: 'downloading',
  STAGED: 'staged',             // 已摊进暂存区，等用户点「重启并更新」
  NOTHING: 'nothing',           // 下下来了，但本机逐字节已与目标一致 → 不必换
  FAILED: 'failed',
});

const STATE_TXT = Object.freeze({
  unsupported: '当前形态不支持自动更新',
  idle: '尚未检查',
  checking: '正在检查更新…',
  uptodate: '已是最新版本',
  available: '发现新版本',
  downloading: '正在下载…',
  staged: '已就绪，重启即可完成更新',
  nothing: '本机文件已是目标内容，无需替换',
  failed: '更新失败',
});

/** 清单请求最多等 30 秒。★ 传输层这条路径上没带超时（updater.check 不往下传 timeout），
 *  所以这里用 Promise.race 兜住 —— 否则网络卡住会永远停在「正在检查」。 */
const CHECK_TIMEOUT_MS = 30000;

/** 进度事件的推送间隔。一个 160 MB 的包会有上千次 chunk 回调，
 *  每次都跨进程推一次会把渲染层淹掉。 */
const PROGRESS_THROTTLE_MS = 150;

/* ------------------------------------------------------------------ 工具 */

function fmtBytes(n) {
  if (!(n >= 0)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
  return (n / 1048576).toFixed(2) + ' MiB';
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function blank() {
  return {
    status: STATE.IDLE, latest: '', reason: '', checkedAt: 0,
    manifest: null, plan: null, patch: null, stage: '',
    progress: null, notice: null,
  };
}

/**
 * @param {object} deps
 * @param {string} deps.version     app.getVersion()
 * @param {()=>string} deps.form    运行形态（dev/portable/installed/green）
 * @param {()=>string} deps.programDir
 * @param {()=>string} deps.exePath  更新完成后由助手把自己拉起来
 * @param {()=>({autoUpdate?:boolean, updateBase?:string, lastUpdateNotice?:string})} deps.getSettings
 * @param {(patch:object)=>void} [deps.setSettings]
 * @param {(channel:string, payload:any)=>void} deps.send  推给渲染进程
 * @param {()=>void} [deps.quit]     交接助手之后退出自己
 * @param {object}   [deps.fs]
 * @param {Function} [deps.getBuffer] 注入传输（离线测试用）
 * @param {Function} [deps.spawn]
 * @param {Function} [deps.now]
 */
function createUpdateService(deps) {
  const fs = deps.fs || nodeFs;
  const spawn = deps.spawn || nodeSpawn;
  const now = deps.now || (() => Date.now());

  const st = blank();
  let seq = 0;                 // 每次检查/下载自增；用来丢弃"超时之后才回来"的迟到结果
  let inflight = null;         // 正在跑的下载 Promise（防重复点）
  let booted = false;

  const can = () => updater.canSelfUpdate(deps.form());
  const settings = () => (deps.getSettings && deps.getSettings()) || {};

  /** 归一化后的更新源。设置里填了非法值就返回 {error}，绝不静默回落成默认源。 */
  function base() {
    try { return updater.normalizeBase(settings().updateBase); }
    catch (e) { return { error: e.message }; }
  }

  /** 状态/进度变了就推一份新快照。渲染层只认快照，不自己拼状态。 */
  function pushState() {
    try { deps.send('ql:update-state', snapshot()); } catch { /* 窗口没了也不能影响更新本身 */ }
  }

  function set(partial) {
    Object.assign(st, partial);
    pushState();
  }

  /* ---------------------------------------------------------- 界面快照 */

  function planInfo() {
    if (!st.manifest) return null;
    if (st.plan && st.plan.mode === 'delta' && st.patch) {
      const sz = Number(st.patch.size) || 0;
      return { mode: 'delta', size: sz, sizeText: fmtBytes(sz) };
    }
    const sz = Number(st.manifest.full && st.manifest.full.size) || 0;
    return { mode: 'full', size: sz, sizeText: fmtBytes(sz) };
  }

  function progressInfo() {
    const p = st.progress;
    if (!p) return null;
    const total = Number(p.total) || 0;
    const got = Number(p.got) || 0;
    const pct = total > 0 ? Math.min(100, Math.floor(got / total * 100)) : null;
    return {
      got, total, pct,
      text: total > 0 ? `${fmtBytes(got)} / ${fmtBytes(total)}（${pct}%）` : fmtBytes(got),
    };
  }

  /** 给界面的一份完整状态。关于窗口、设置面板、状态行都从这里取。 */
  function snapshot() {
    const s = settings();
    const c = can();
    const b = base();
    return {
      supported: !!c.ok,
      unsupportedReason: c.ok ? '' : c.reason,
      form: deps.form(),
      myVersion: deps.version(),
      autoUpdate: s.autoUpdate !== false,
      base: b.error ? '' : b,
      baseError: b.error || '',
      status: st.status,
      statusText: STATE_TXT[st.status] || st.status,
      latest: st.latest || '',
      reason: st.reason || '',
      plan: planInfo(),
      progress: progressInfo(),
      checkedAt: st.checkedAt,
      checkedAtText: fmtTime(st.checkedAt),
      // 更新目录（含日志与暂存区）。「关于」里给一个"打开它"的入口，
      // 更新失败时用户至少能看到 .update/apply-<版本>.log 里的原因。
      dir: nodePath.join(deps.programDir(), updater.STAGE_DIR),
      busy: st.status === STATE.CHECKING || st.status === STATE.DOWNLOADING,
      canCheck: c.ok && !(st.status === STATE.CHECKING || st.status === STATE.DOWNLOADING),
      canDownload: c.ok && st.status === STATE.AVAILABLE,
      canApply: c.ok && st.status === STATE.STAGED,
      // 只在本次会话里出现一次的结果提示（更新成功 / 上次更新失败），由渲染层弹 toast
      notice: st.notice,
    };
  }

  /* ---------------------------------------------------------- 检查 */

  /**
   * 查一次更新。
   * @param {{silent?:boolean, timeoutMs?:number}} [o]
   *   silent=true 时"已是最新/没清单"都不打扰用户（启动时用）；
   *   timeoutMs 可覆盖超时（自检用 —— 不然验一次超时要等 30 秒）。
   */
  async function check(o = {}) {
    const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : CHECK_TIMEOUT_MS;
    const c = can();
    if (!c.ok) {
      set({ status: STATE.UNSUPPORTED, latest: '', reason: c.reason, checkedAt: now() });
      return { ok: false, reason: c.reason, unsupported: true };
    }
    const b = base();
    if (b.error) {
      set({ status: STATE.FAILED, latest: '', reason: b.error, checkedAt: now() });
      return { ok: false, reason: b.error };
    }
    if (st.status === STATE.CHECKING || st.status === STATE.DOWNLOADING) {
      return { ok: false, reason: '正在忙，先等一下' };
    }

    const my = ++seq;
    set({ status: STATE.CHECKING, reason: '', notice: null });

    let timer = null;
    let r;
    try {
      r = await Promise.race([
        updater.check({
          myVersion: deps.version(), programDir: deps.programDir(), base: b,
          fs, getBuffer: deps.getBuffer,
        }),
        new Promise((_res, rej) => {
          const wait = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`;
          timer = setTimeout(() => rej(new Error(`检查超时（更新源 ${wait} 没响应）`)), timeoutMs);
        }),
      ]);
    } catch (e) {
      r = { ok: false, available: false, reason: e.message };
    } finally {
      if (timer) clearTimeout(timer);
    }

    // ★ 本次已经被后来的动作取代了 → 结果直接丢掉。否则迟到的响应会把界面拽回过期状态。
    if (my !== seq) return { ok: false, reason: '结果已过期（期间有更新的操作）' };

    if (!r.ok) {
      set({ status: STATE.FAILED, latest: '', reason: r.reason, checkedAt: now() });
      return { ok: false, reason: r.reason, silent: !!o.silent };
    }
    if (!r.available) {
      set({ status: STATE.UPTODATE, latest: '', reason: r.reason, manifest: r.manifest || null, checkedAt: now() });
      return { ok: true, available: false, reason: r.reason };
    }
    set({
      status: STATE.AVAILABLE,
      latest: r.manifest.version,
      reason: r.reason,
      manifest: r.manifest,
      plan: r.plan,
      patch: (r.plan && r.plan.mode === 'delta') ? r.plan.patch : null,
      checkedAt: now(),
    });
    return { ok: true, available: true, version: r.manifest.version, plan: r.plan };
  }

  /* ---------------------------------------------------------- 下载并暂存 */

  async function download() {
    if (inflight) return inflight;
    const c = can();
    if (!c.ok) return { ok: false, reason: c.reason };
    if (!st.manifest) return { ok: false, reason: '还没有可用清单，请先检查更新' };
    if (st.status === STATE.DOWNLOADING) return { ok: false, reason: '正在下载' };
    if (st.status !== STATE.AVAILABLE) return { ok: false, reason: '当前没有待下载的更新' };

    function finishFail(reason) {
      set({ status: STATE.FAILED, reason, progress: null });
      return { ok: false, reason };
    }

    function finishStage(r, m, mode) {
      if (!r.ok) return finishFail(r.reason);
      if (r.nothingToDo) {
        // 本机已经跟目标逐字节一致了 —— 不是失败，但也不必换文件
        set({
          status: STATE.NOTHING, latest: m.version, progress: null, stage: '',
          reason: `本机文件已与 v${m.version} 逐字节一致，无需替换`,
        });
        return { ok: true, nothingToDo: true };
      }
      set({
        status: STATE.STAGED, latest: m.version, progress: null, stage: r.stage || '',
        reason: `已下载并校验 v${m.version}（${mode === 'delta' ? '增量' : '全量'}），重启即完成`,
      });
      return { ok: true, staged: true, stage: r.stage, mode };
    }

    inflight = (async () => {
      const b = base();
      if (b.error) return finishFail(b.error);

      const my = ++seq;
      const m = st.manifest;
      const p = st.plan || { mode: 'full' };
      const isDelta = p.mode === 'delta' && !!p.patch;
      const size = Number(isDelta ? p.patch.size : (m.full && m.full.size)) || 0;

      set({ status: STATE.DOWNLOADING, reason: '', progress: size ? { got: 0, total: size } : null });

      let lastPush = 0;
      const onChunk = (got, total) => {
        st.progress = { got, total: Number(total) || size || 0 };
        const t = now();
        if (t - lastPush < PROGRESS_THROTTLE_MS) return;
        lastPush = t;
        pushState();
      };

      if (!isDelta) {
        // 全量：stageFull 自己把 zip 下到暂存区里，所以这里不能先下一遍
        const r = await updater.stageFull({
          manifest: m, base: b, programDir: deps.programDir(), version: m.version,
          myVersion: deps.version(), exePath: deps.exePath(), restart: true,
          fs, getBuffer: deps.getBuffer, onChunk,
        });
        if (my !== seq) return { ok: false, reason: '结果已过期（期间有更新的操作）' };
        return finishStage(r, m, 'full');
      }

      // 差量：先把补丁包下到暂存区（别放程序目录 —— 那会被当成程序文件）
      // ★★ 必须**先建目录**：全量路径里 stageFull 自己会 mkdir，差量这条路上没有它，
      //    漏了就是 ENOENT —— 而且报出来只是"下载失败"，看不出是目录没建。
      //    （这条是 smoke 里端到端跑差量时才暴露出来的，静读代码很难发现。）
      const stageRoot = updater.stageDirOf(deps.programDir(), m.version);
      try { fs.mkdirSync(stageRoot, { recursive: true }); }
      catch (e) { return finishFail('暂存区创建失败（磁盘或权限）：' + e.message); }

      const assetPath = nodePath.join(stageRoot, p.patch.asset);
      const dl = await updater.downloadAsset({
        base: b, asset: p.patch.asset, size: p.patch.size, sha256: p.patch.sha256,
        dest: assetPath, fs, getBuffer: deps.getBuffer, onChunk,
      });
      if (my !== seq) return { ok: false, reason: '结果已过期（期间有更新的操作）' };
      if (!dl.ok) return finishFail(dl.reason);

      let pack = null;
      try { pack = fs.readFileSync(assetPath); }
      catch (e) { return finishFail('读取补丁包失败：' + e.message); }

      let r;
      try {
        r = await updater.stage({
          manifest: m, patch: p.patch, pack, mode: 'delta', version: m.version,
          programDir: deps.programDir(), myVersion: deps.version(),
          exePath: deps.exePath(), restart: true, fs,
        });
      } catch (e) {
        r = { ok: false, reason: '摊暂存区失败：' + e.message };
      }
      if (my !== seq) return { ok: false, reason: '结果已过期（期间有更新的操作）' };
      return finishStage(r, m, 'delta');
    })().finally(() => { inflight = null; });

    return inflight;
  }

  /* ---------------------------------------------------------- 交接助手 */

  /** 打包后被 detached 拉起的进程未必继承到完整 PATH，所以显式给绝对路径。 */
  function powerShellExe() {
    const root = process.env.SystemRoot || 'C:\\Windows';
    const abs = nodePath.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try { if (fs.existsSync(abs)) return abs; } catch { /* noop */ }
    return 'powershell.exe';
  }

  /**
   * 把暂存的更新交给"退出后运行"的助手，然后退出自己。
   * ★ 顺序不能反：**先**把助手拉起来（detached + unref），**再**退出 ——
   *   反过来的话主进程一走，还没 spawn 的助手就再也没人起了。
   * ★ 助手会等这个 pid 真的退出后才动手（Windows 上运行中的 exe 不可覆盖）。
   */
  function applyAndRestart() {
    if (st.status !== STATE.STAGED) return { ok: false, reason: '还没有下载好的更新' };
    const stageDir = st.stage || updater.stageDirOf(deps.programDir(), st.latest);
    const planPath = nodePath.join(stageDir, 'apply.json');

    let plan;
    try { plan = JSON.parse(fs.readFileSync(planPath, 'utf8')); }
    catch (e) { return { ok: false, reason: '读不到更新计划（暂存区可能已被清理）：' + e.message }; }

    // 计划里的 restart 决定助手换完文件后要不要把新版拉起来 —— 我们总是要
    plan.restart = true;
    plan.exe = plan.exe || deps.exePath();

    const script = applyLib.buildApplyScript(plan, { pid: process.pid, waitSeconds: 120 });
    const args = applyLib.spawnArgs(script);

    let child;
    try {
      child = spawn(powerShellExe(), args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } catch (e) {
      return { ok: false, reason: '启动更新助手失败：' + e.message };
    }

    console.log('[update] 已交接更新助手 pid=' + (child.pid || '?') + '，本进程即将退出以完成替换');
    set({ reason: '正在退出并替换文件，稍后会自动重新打开…' });
    if (deps.quit) setTimeout(() => { try { deps.quit(); } catch { /* noop */ } }, 400);
    return { ok: true, helperPid: child.pid || 0 };
  }

  /* ---------------------------------------------------------- 启动时的收尾 */

  /** 只在"这件事还没报过"时把 notice 挂到快照上，并记下已报（跨重启也不会重复） */
  function notifyOnce(key, kind, title, text) {
    const s = settings();
    if (s.lastUpdateNotice === key) return false;
    st.notice = { kind, title, text, key };
    try { if (deps.setSettings) deps.setSettings({ lastUpdateNotice: key }); } catch { /* noop */ }
    return true;
  }

  /**
   * 读上一次更新的结果。四件事：
   *   ① `applied` → 报个喜（但只在"那个版本确实就是正在跑的版本"时，否则会瞎报）
   *   ② `failed`  → **必须**报：不报的话用户会以为更新成功了，却一直用着旧版
   *   ③ `staged`  → 上次下好了但没重启 → 恢复成"可重启更新"，别让它白下
   *   ④ 其余（针对更老版本的残留暂存）→ 清掉，别把上百 MB 白留在用户盘上
   */
  function restoreStaged() {
    const upd = nodePath.join(deps.programDir(), updater.STAGE_DIR);
    const stateFile = nodePath.join(upd, 'state.json');
    let s = null;
    try { s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* 没有就走人 */ }
    if (!s || !s.state) return { ok: true, none: true };

    const my = deps.version();
    const key = `${s.state}|${s.to || ''}|${s.at || ''}`;

    if (s.state === 'applied' && s.to === my) {
      notifyOnce(key, 'applied', `已更新到 v${s.to}`, '文件替换完成，当前运行的已经是新版本。');
      return { ok: true, applied: s.to };
    }
    if (s.state === 'failed') {
      notifyOnce(key, 'failed', '上次更新没有成功',
        `${s.note || '助手没能替换文件'}。程序仍在 v${my}，可以再试一次；`
        + `日志：${nodePath.join(upd, 'apply-' + (s.to || '') + '.log')}`);
      return { ok: true, failed: s.note || '' };
    }
    if (s.state === 'staged') {
      const dir = nodePath.join(upd, String(s.to || ''));
      if (updater.isNewer(s.to, my) && fs.existsSync(nodePath.join(dir, 'apply.json'))) {
        set({
          status: STATE.STAGED, latest: s.to, stage: dir,
          reason: `上次已下好 v${s.to}，重启即可完成更新`,
        });
        return { ok: true, resumed: s.to };
      }
      // 目标已经不比本机新了（或暂存区没了）→ 白占地方，清掉
      try { updater.dropStage(dir, fs); } catch { /* noop */ }
      try { fs.unlinkSync(stateFile); } catch { /* noop */ }
      return { ok: true, discarded: s.to };
    }
    return { ok: true, none: true };
  }

  /** 启动时调一次：判形态 + 恢复/收尾上次的更新结果。**不**发网络请求。 */
  function boot() {
    if (booted) return { ok: true, alreadyBooted: true };
    booted = true;
    const c = can();
    if (!c.ok) {
      set({ status: STATE.UNSUPPORTED, reason: c.reason });
      return { ok: false, reason: c.reason };
    }
    const r = restoreStaged();
    if (st.notice) pushState();
    return r;
  }

  /** 供 --update-probe 之类的自检直接看内部状态（正常流程用不到） */
  function _peek() { return st; }

  return {
    STATE, STATE_TXT, CHECK_TIMEOUT_MS, PROGRESS_THROTTLE_MS,
    check, download, applyAndRestart, boot, snapshot, restoreStaged, _peek,
    canSelfUpdate: can,
  };
}

module.exports = { createUpdateService, STATE, STATE_TXT, CHECK_TIMEOUT_MS, PROGRESS_THROTTLE_MS };

'use strict';
/**
 * 从 PE 文件（`.exe` / `.dll` / `.cpl`）里抠出**程序自带的图标** —— 自己解析资源表，不用 shell。
 *
 * 为什么非自己解不可（v1.4.5 的真事故）：
 *   之前全靠 Electron 的 `app.getFileIcon()`，而本机实测它对**大量正常程序**只回一张
 *   32×32 的通用图标（"窗口 + 蓝色方块"），例：
 *     notepad.exe / QuickLaunch.exe / clash-verge.exe  → 32×32 通用（哈希完全相同）
 *     python.exe / WeaselServer.exe                    → 48×48 真图标
 *   同一台机器、同一个 API、同一个 size='large'，结果一半对一半错 —— 没有任何可依赖的规律。
 *   于是界面上出现成片的"白板"，用户的原话是「修复了一部分 但有些好像还是不行」。
 *   自己读 PE 资源则稳定：本机实测 QuickLaunch.exe / clash-verge.exe / python.exe /
 *   WeaselServer.exe / cmd.exe 全部拿到 256×256 的真图标，哈希各不相同。
 *
 * `notepad.exe` 这种**资源表里真的没有图标**的（Win10 的 notepad 是个转发壳，图标由
 * AppX / imageres.dll 提供）会返回 null，上层保持 emoji 回退 —— 不猜、不编。
 *
 * 设计：读盘与解析分开，解析只认一个 `reader`（`{size, u16, u32, slice}`），
 * 所以单测可以直接喂 `bufferReader(fs.readFileSync(某个真 exe))`，不需要假 fs。
 */

const fs = require('fs');

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const MAX_ICO_BYTES = 1024 * 1024;   // 拼出来的 .ico 上限，防止个别巨型资源把内存吃光
const MAX_DEPTH = 4;

/**
 * 图标"搬家"后的位置：Win10/11 把很多系统文件（`notepad.exe` / `shell32.dll` /
 * `imageres.dll`…）的图标搬进了 MUI 资源文件 `%SystemRoot%\SystemResources\<名字>.mun`，
 * 原文件里**一张图标都不剩**。
 *
 * 本机实测（一张图标都没有的文件）：
 *   notepad.exe  大小 200704，资源根只有 RT_VERSION / RT_MANIFEST
 *   notepad.exe.mun 105984 → 抠出 101966B 的 ICO（就是记事本那个蓝本子）
 *   mspaint / mstsc / magnify / dfrgui / iscsicpl / shell32 / imageres 全部同理。
 * 不接这条路，Win10 上"记事本 / 画图 / 远程桌面"这一大片就永远是通用图。
 *
 * @returns {string} .mun 路径；不存在返回 ''
 */
function munFor(filePath, fsi) {
  const path = require('path');
  const p = String(filePath || '');
  if (!p || /\.mun$/i.test(p)) return '';
  const base = path.basename(p);
  if (!base) return '';
  const tries = [
    path.join(path.dirname(path.dirname(p)), 'SystemResources', base + '.mun'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'SystemResources', base + '.mun'),
  ];
  for (const t of tries) {
    try {
      if (typeof fsi.existsSync === 'function' ? fsi.existsSync(t) : (fsi.statSync(t), true)) return t;
    } catch { /* 权限/路径怪就别管 */ }
  }
  return '';
}

/** 内存里的 reader（单测用）：整块 buffer 当成一个"文件" */
function bufferReader(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.alloc(0);
  const need = (o, n) => o >= 0 && n >= 0 && o + n <= b.length;
  return {
    size: b.length,
    u8: o => (need(o, 1) ? b.readUInt8(o) : -1),
    u16: o => (need(o, 2) ? b.readUInt16LE(o) : -1),
    u32: o => (need(o, 4) ? b.readUInt32LE(o) : -1),
    slice: (o, n) => (need(o, n) ? b.subarray(o, o + n) : Buffer.alloc(0)),
    close: () => {},
  };
}

/** 真文件的 reader：按需读，不把几十 MB 的 exe 整个读进内存 */
function fileReader(filePath, deps = {}) {
  const fsi = deps.fs || fs;
  const fd = fsi.openSync(filePath, 'r');
  const size = fsi.fstatSync(fd).size;
  const read = (o, n) => {
    if (o < 0 || n <= 0 || o >= size) return Buffer.alloc(0);
    const len = Math.min(n, size - o);
    const out = Buffer.allocUnsafe(len);
    const got = fsi.readSync(fd, out, 0, len, o);
    return got === len ? out : out.subarray(0, got);
  };
  const pick = (o, n, fn) => { const s = read(o, n); return s.length >= n ? fn(s, o) : -1; };
  return {
    size,
    u8: o => pick(o, 1, s => s.readUInt8(0)),
    u16: o => pick(o, 2, s => s.readUInt16LE(0)),
    u32: o => pick(o, 4, s => s.readUInt32LE(0)),
    slice: read,
    close: () => { try { fsi.closeSync(fd); } catch { /* noop */ } },
  };
}

/**
 * 解析 PE → 图标（ICO 字节）。没有图标资源返回 null。
 * @param {{size:number,u8:Function,u16:Function,u32:Function,slice:Function}} r
 * @param {{group?:number,id?:number}} [opts]
 *        group = 取第几组图标（0 基，按资源 ID 升序 —— 就是快捷方式里 `IconIndex` 正数的含义）；
 *        id    = 按资源 ID 精确取一组（`IconIndex` 为负数时，Windows 规定资源 ID = -IconIndex）；
 *        都不给就挑"像素最多"的那一组（多数程序第一组就是主图标，但也有例外）
 */
function parseIcon(r, opts = {}) {
  try {
    if (r.u16(0) !== 0x5a4d) return null;                       // 'MZ'
    const pe = r.u32(0x3c);
    if (pe <= 0 || r.u32(pe) !== 0x00004550) return null;        // 'PE\0\0'
    const numSections = r.u16(pe + 6);
    const optSize = r.u16(pe + 20);
    const opt = pe + 24;
    const magic = r.u16(opt);
    if (magic !== 0x10b && magic !== 0x20b) return null;         // PE32 / PE32+
    const ddBase = opt + (magic === 0x20b ? 112 : 96);
    const resRva = r.u32(ddBase + 16);                            // DataDirectory[2].VirtualAddress
    if (resRva <= 0) return null;

    const secBase = opt + optSize;
    if (numSections <= 0 || numSections > 96) return null;
    const sections = [];
    for (let i = 0; i < numSections; i++) {
      const o = secBase + i * 40;
      const vsize = r.u32(o + 8);
      const va = r.u32(o + 12);
      const raw = r.u32(o + 20);
      if (va < 0 || raw < 0) continue;
      sections.push({ va, vsize, raw });
    }
    const toOff = rva => {
      for (const s of sections) {
        const span = Math.max(s.vsize, 1);
        if (rva >= s.va && rva < s.va + span) return s.raw + (rva - s.va);
      }
      return -1;
    };
    const resOff = toOff(resRva);
    if (resOff < 0) return null;

    /** 资源目录的一个节点 */
    const entries = off => {
      const base = resOff + off;
      const named = r.u16(base + 12);
      const ids = r.u16(base + 14);
      if (named < 0 || ids < 0 || named + ids > 4096) return [];
      const out = [];
      for (let i = 0; i < named + ids; i++) {
        const e = base + 16 + i * 8;
        const name = r.u32(e);
        const data = r.u32(e + 4);
        if (name < 0 || data < 0) continue;
        out.push({ id: name, off: data & 0x7fffffff, isDir: !!(data & 0x80000000) });
      }
      return out;
    };
    const leaf = off => ({ rva: r.u32(resOff + off), size: r.u32(resOff + off + 4) });

    const root = entries(0);
    const typeDir = id => root.find(x => x.id === id && x.isDir);
    const grpType = typeDir(RT_GROUP_ICON);
    const icoType = typeDir(RT_ICON);
    if (!grpType || !icoType) return null;

    // RT_ICON：id → 字节
    const icoById = new Map();
    for (const t of entries(icoType.off)) {
      if (!t.isDir) continue;
      const langs = entries(t.off);
      if (!langs.length) continue;
      const l = leaf(langs[0].off);
      const off = toOff(l.rva);
      if (off < 0 || l.size <= 0 || l.size > MAX_ICO_BYTES) continue;
      icoById.set(t.id, r.slice(off, l.size));
    }
    if (!icoById.size) return null;

    // 每个组都读一遍，挑"最大的一张"那一组（有些 exe 第一组是文档图标，不是主图标）。
    // 指定了 group（`.url` 的 IconIndex）就只认那一组 —— 序号对不上就返回 null，别乱猜。
    const groups = entries(grpType.off).filter(g => g.isDir);
    // ★ 指定了 group / id 就**只**认那一组：对不上返回 null。
    //   （别写成「找不到就退回挑最大的一组」—— 那等于把别的图标图像安到用户指定的位置上，
    //     看起来"修好了"，其实图标是错的，比留空还难查。）
    let scan = groups;
    if (Number.isFinite(opts.id)) scan = groups.filter(g => g.id === opts.id);
    else if (Number.isFinite(opts.group)) scan = [groups[opts.group]].filter(Boolean);
    if (!scan.length) return null;

    let best = null;
    for (const g of scan) {
      if (!g.isDir) continue;
      const langs = entries(g.off);
      if (!langs.length) continue;
      const l = leaf(langs[0].off);
      const off = toOff(l.rva);
      if (off < 0 || l.size < 6) continue;
      const grp = r.slice(off, Math.min(l.size, 8192));
      if (grp.length < 6) continue;
      if (grp.readUInt16LE(2) !== 1) continue;             // ICONDIR.type 必须是 1（图标）
      const count = grp.readUInt16LE(4);
      if (count <= 0 || count > 256) continue;
      const list = [];
      for (let i = 0; i < count; i++) {
        const o = 6 + i * 14;
        if (o + 14 > grp.length) break;
        const w = grp.readUInt8(o);
        const hh = grp.readUInt8(o + 1);
        const data = icoById.get(grp.readUInt16LE(o + 12));
        if (!data || !data.length) continue;
        list.push({
          w, h: hh, colorCount: grp.readUInt8(o + 2),
          planes: grp.readUInt16LE(o + 4), bitCount: grp.readUInt16LE(o + 6),
          bytes: data.length, data,
        });
      }
      if (!list.length) continue;
      const area = list.reduce((m, x) => Math.max(m, (x.w || 256) * (x.h || 256)), 0);
      if (!best || area > best.area) best = { area, list };
    }
    if (!best) return null;

    // 大的排前面（有的解码器只认第一帧），再按总量截断
    const picked = [];
    let total = 0;
    for (const x of best.list.slice().sort((a, b) => b.bytes - a.bytes)) {
      if (total + x.bytes > MAX_ICO_BYTES) continue;
      picked.push(x);
      total += x.bytes;
    }
    if (!picked.length) return null;

    const head = Buffer.alloc(6 + 16 * picked.length);
    head.writeUInt16LE(0, 0);                 // reserved
    head.writeUInt16LE(1, 2);                 // type = icon
    head.writeUInt16LE(picked.length, 4);
    let offset = head.length;
    picked.forEach((x, i) => {
      const o = 6 + i * 16;
      head.writeUInt8(x.w > 255 ? 0 : x.w, o);       // 0 表示 256
      head.writeUInt8(x.h > 255 ? 0 : x.h, o + 1);
      head.writeUInt8(x.colorCount, o + 2);
      head.writeUInt8(0, o + 3);
      head.writeUInt16LE(x.planes || 1, o + 4);
      head.writeUInt16LE(x.bitCount, o + 6);
      head.writeUInt32LE(x.bytes, o + 8);
      head.writeUInt32LE(offset, o + 12);
      offset += x.bytes;
    });
    return Buffer.concat([head, ...picked.map(x => x.data)]);
  } catch {
    return null;
  }
}

/* 同一个文件反复问（自愈 + 导入）不重复读盘；键里带 mtime/size，程序升级后自动失效 */
const cache = new Map();
const CACHE_MAX = 400;

/**
 * 读取某个 PE 文件的图标 → ICO 字节；没有/读不了返回 null。
 * @param {string} filePath .exe / .dll / .cpl …
 * @param {{fs?:object, group?:number, id?:number}} [deps] group/id 见 parseIcon
 * @returns {Buffer|null}
 */
function readIconResource(filePath, deps = {}) {
  if (!filePath) return null;
  const fsi = deps.fs || fs;
  const group = Number.isFinite(deps.group) ? deps.group : undefined;
  const id = Number.isFinite(deps.id) ? deps.id : undefined;
  const opts = group === undefined && id === undefined
    ? {}
    : (id === undefined ? { group } : { id });
  let key = String(filePath).toLowerCase();
  if (group !== undefined) key += '#' + group;
  if (id !== undefined) key += '@' + id;
  try {
    const st = fsi.statSync(filePath);
    key += `|${st.size}|${st.mtimeMs}`;
  } catch {
    return null;   // 不存在就别开文件了
  }
  if (cache.has(key)) return cache.get(key);

  let out = extract(filePath, opts, fsi);
  // ★ 文件里一张图标都没有 → 去 MUI 资源文件 `.mun` 里找（Win10/11 的图标搬家，见 munFor）
  if (!out && deps.mun !== false) {
    const mun = munFor(filePath, fsi);
    if (mun) out = extract(mun, opts, fsi);
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, out);
  return out;
}

/** 单个文件 → ICO（不含 .mun 回退），失败 null */
function extract(filePath, opts, fsi) {
  let reader = null;
  try {
    reader = fileReader(filePath, { fs: fsi });
    return parseIcon(reader, opts);
  } catch {
    return null;
  } finally {
    if (reader) reader.close();
  }
}

function clearCache() { cache.clear(); }

module.exports = {
  parseIcon, readIconResource, munFor, bufferReader, fileReader, clearCache, MAX_ICO_BYTES,
};

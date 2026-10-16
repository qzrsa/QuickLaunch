'use strict';
/**
 * 纯 Node 的 ZIP **读**取器（只依赖 zlib，零第三方）。
 *
 * 为什么要有它：
 *   1. 自更新的**全量回退**必须能解开绿色版 zip —— 差量不可用（跨版本升级、本地文件被动过）
 *      时要自动退回全量，而不是把用户丢到浏览器里去手动下载；
 *   2. CI 要拉**上一个 Release 的绿色版 zip** 当差量基准，也需要能解包。
 * 写的那一半在 `scripts/pack-green.mjs`（同样手写）—— 读写的 CRC32 **共用这里这一份**，
 * 免得两边各算一套、哪天对不上还查不出是谁的错。
 *
 * 只支持我们自己产出的那种 zip：不压缩（method 0）或 deflate（method 8）、无 ZIP64、
 * 无加密。碰到不认识的形状**直接抛**，绝不"尽力而为"地解出一堆半残文件 ——
 * 更新链路上"悄悄少解了一个文件"就是装出一个半残程序。
 * ★ 一律**以中央目录为准**（不信本地头）：写 zip 时若用了 data descriptor，本地头里的
 *   大小会是 0，只有中央目录才有真值。
 */

const zlib = require('zlib');
const { withoutAsar } = require('./asar-safe.js');

/* ------------------------------------------------------------------ CRC32 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ------------------------------------------------------------------ 中央目录 */
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** 从尾部往回找 EOCD（zip 注释会让它不在最后 22 字节处，所以必须扫） */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let p = buf.length - 22; p >= min; p--) {
    if (buf.readUInt32LE(p) === EOCD_SIG) return p;
  }
  throw new Error('不是 zip：找不到中央目录结束标记（EOCD）');
}

/**
 * 列出条目（以中央目录为准）。
 * @returns {{name:string, method:number, crc:number, compSize:number, size:number,
 *            localOffset:number, flags:number}[]}
 */
function listZip(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {
    throw new Error('不支持 ZIP64 的 zip');
  }
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new Error(`中央目录第 ${i} 条读不下去（偏移 ${p}）`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (method !== 0 && method !== 8) {
      throw new Error(`不支持的压缩方式 ${method}（条目 ${p}）`);
    }
    if (flags & 0x0001) throw new Error('不支持加密的 zip');
    out.push({
      name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
      method, crc, compSize, size, localOffset, flags,
    });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  void cdSize;
  return out;
}

/** 取单个条目的原始字节（解压 + CRC 校验） */
function extractEntry(buf, e) {
  const lo = e.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) {
    throw new Error(`本地头不对: ${e.name}`);
  }
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);
  if (raw.length !== e.compSize) throw new Error(`数据被截断: ${e.name}`);

  let data;
  if (e.method === 0) {
    data = Buffer.from(raw);
  } else {
    try { data = zlib.inflateRawSync(raw); }
    catch (err) { throw new Error(`解压失败 ${e.name}: ${err.message}`); }
  }
  // ★ 逐条验 CRC：解压出来是坏的不该悄悄写进程序目录
  if (data.length !== e.size) throw new Error(`解压后大小不符: ${e.name}（${data.length} != ${e.size}）`);
  if (crc32(data) !== e.crc) throw new Error(`CRC 校验失败: ${e.name}`);
  return data;
}

/** 条目名安全校验：绝对路径 / `..` / 反斜杠一律拒（zip slip） */
function assertSafeName(name, isProtected) {
  if (!name || name.endsWith('/')) return 'dir';
  if (name.includes('\\')) throw new Error(`条目名带反斜杠，拒绝: ${name}`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error(`条目名是绝对路径，拒绝: ${name}`);
  const parts = name.split('/');
  if (parts.some(p => p === '..' || p === '')) throw new Error(`条目名含 ..，拒绝: ${name}`);
  if (isProtected && isProtected(name)) throw new Error(`条目落在受保护目录，拒绝: ${name}`);
  return 'file';
}

/**
 * 解出全部文件到内存。
 * @param {Buffer} buf
 * @param {{filter?:(rel:string)=>boolean, isProtected?:(rel:string)=>boolean}} [o]
 * @returns {{name:string,data:Buffer}[]}
 */
function extractAll(buf, o = {}) {
  const out = [];
  for (const e of listZip(buf)) {
    const kind = assertSafeName(e.name, o.isProtected);
    if (kind === 'dir') continue;
    if (o.filter && !o.filter(e.name)) continue;
    out.push({ name: e.name, data: extractEntry(buf, e) });
  }
  return out;
}

/**
 * 解包到目录（调用方负责目标目录可写）。
 * ★ 整趟写入都在"关掉 asar 补丁"的状态下做：绿色版 zip 里的 `resources/app.asar` 会被
 *   Electron 当存档拦下（写 Buffer 直接抛），而那是**必须解出来**的主载荷。见 asar-safe.js。
 * @returns {{path:string,size:number}[]} 实际写出的文件
 */
function extractToDir(buf, dir, o = {}) {
  const fs = o.fs || require('fs');
  const nodePath = require('path');
  const written = [];
  withoutAsar(() => {
    for (const e of listZip(buf)) {
      const kind = assertSafeName(e.name, o.isProtected);
      if (kind === 'dir') continue;
      if (o.filter && !o.filter(e.name)) continue;
      const data = extractEntry(buf, e);
      const abs = nodePath.join(dir, ...e.name.split('/'));
      fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
      written.push({ path: e.name, size: data.length });
      if (o.onFile) o.onFile(e.name, written.length);
    }
  });
  return written;
}

module.exports = { crc32, findEocd, listZip, extractEntry, extractAll, extractToDir, assertSafeName };

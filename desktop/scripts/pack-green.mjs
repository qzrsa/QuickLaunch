#!/usr/bin/env node
/**
 * 把 electron-builder 的 dir 产物（win-unpacked）压成「绿色版」zip。
 *
 * 为什么不用现成工具：
 *   - Compress-Archive：遇到读不了的文件**静默跳过**，仍然产出 zip 并报成功 → 少文件你不知道；
 *     且 `-Path 'Dir\*'` 产出扁平结构、条目数与实际对不上。
 *   - .NET ZipFile：要在 PowerShell 里 Add-Type，脚本还得是纯 ASCII，多一层转义。
 *   - Python zipfile：CI 依赖 runner 自带的 Python。
 *
 * 所以这里用纯 Node 手写 ZIP（本地和 CI 都一定有 node），只有一个外部依赖都没有的好处：
 *   1. 条目路径一律相对 + 正斜杠，exe 就在 zip 根层（解压即用）；
 *   2. 任何 I/O 错误直接 throw + 非零退出，绝不静默丢文件；
 *   3. 压完**回读 zip 校验必需条目**，缺一个就报错。
 *
 * 用法：
 *   node scripts/pack-green.mjs --src ../dist/win-unpacked \
 *        --out ../dist/QuickLaunch-Green-<版本>.zip \
 *        --need QuickLaunch.exe,resources/app.asar,resources/icon.ico
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/* ------------------------------------------------------------------ 参数 */
const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const SRC = arg('--src');
const NEED = (arg('--need', '') || '').split(',').map(s => s.trim()).filter(Boolean);

/**
 * 运行时目录，绝不允许进发布包。
 * win-unpacked 是「程序目录」，一旦有人在本机原地跑过一次绿色版，
 * 用户的 config.json（可能含路径、备注等私人信息）就会躺在 <程序目录>/data/ 里；
 * 此时再打包就会把私人配置随 Release 发出去。同样的问题也出在探针截图目录上。
 * 所以这里按顶层目录名整棵剪掉，并且事后做一次硬校验。
 */
const SKIP_TOP = new Set(['data', '.probe-shot', '.tmpdata']);

if (!SRC) {
  console.error('用法: node scripts/pack-green.mjs --src <目录> [--out <zip>] [--need a,b,c]');
  process.exit(2);
}
if (!fs.existsSync(SRC) || !fs.statSync(SRC).isDirectory()) {
  console.error(`[绿色版] 源目录不存在: ${SRC}`);
  process.exit(1);
}

// --out 省略时按 package.json 的版本号自动命名，避免手写版本号写歪了
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const OUT = arg('--out') || path.join(SRC, '..', `QuickLaunch-Green-${pkg.version}.zip`);

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

/* ---------------------------------------------------- DOS 时间 / 日期编码 */
function dosDateTime(d) {
  const year = d.getFullYear();
  if (year < 1980) return { time: 0, date: 0x0021 }; // 1980-01-01
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/* ------------------------------------------------------------ 递归收集文件 */
function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;   // zip 里一律正斜杠
    if (!base && SKIP_TOP.has(e.name)) {
      console.warn(`[绿色版] ⚠ 已排除运行时目录: ${rel}/ （不进发布包，避免带上本机数据）`);
      continue;
    }
    if (e.isDirectory()) out.push(...walk(abs, rel));
    else if (e.isFile()) out.push({ abs, rel });
    else console.warn(`[绿色版] 跳过非普通文件: ${rel}`);
  }
  return out;
}

/* ------------------------------------------------------------------ 主流程 */
const files = walk(SRC);
if (files.length === 0) {
  console.error(`[绿色版] 源目录是空的: ${SRC}`);
  process.exit(1);
}

const chunks = [];        // 所有输出分片，最后一次性写出
const central = [];       // 中央目录条目
let offset = 0;

// 统一时间戳：用源目录 mtime，保证同一份产物多次打包结果一致（可复现构建）
// DOS 时间只有 2 秒精度，所有条目共用同一个值。
const dt = dosDateTime(fs.statSync(SRC).mtime);

for (const f of files) {
  const raw = fs.readFileSync(f.abs);
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  // 只有真的更小才用 deflate，否则 store（和 Info-ZIP 的策略一致）
  const useDeflate = deflated.length < raw.length;
  const data = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(raw);
  const nameBuf = Buffer.from(f.rel, 'utf8');

  // bit 11（0x0800）= 文件名是 UTF-8
  const flags = 0x0800;
  const { time, date } = dt;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);            // version needed
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);            // extra len

  chunks.push(local, nameBuf, data);

  // 外部属性：解压到 Linux/WSL 时 exe/dll 仍带可执行位（高位是 unix mode）
  const exec = /\.(exe|dll|node)$/i.test(f.rel);
  const unixMode = (exec ? 0o100755 : 0o100644) << 16;
  const madeBy = (3 << 8) | 20;          // 3 = unix

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(madeBy, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(flags, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(time, 12);
  cd.writeUInt16LE(date, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(raw.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);               // extra
  cd.writeUInt16LE(0, 32);               // comment
  cd.writeUInt16LE(0, 34);               // disk
  cd.writeUInt16LE(0, 36);               // internal attr
  cd.writeUInt32LE(unixMode >>> 0, 38);
  cd.writeUInt32LE(offset, 42);
  central.push(cd, nameBuf);

  offset += local.length + nameBuf.length + data.length;
}

const cdBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([...chunks, cdBuf, eocd]));

/* ------------------------------------------------------------ 回读校验 */
const ver = fs.readFileSync(OUT);
if (ver.readUInt32LE(0) !== 0x04034b50) throw new Error('zip 头校验失败');
const n = ver.readUInt16LE(ver.length - 22 + 10);
if (n !== files.length) throw new Error(`条目数不符：写 ${files.length}，头里 ${n}`);

// 中央目录里把所有文件名捞出来比（不重新解压，够用且快）
const names = [];
{
  let p = 0;
  while (p + 4 <= cdBuf.length && cdBuf.readUInt32LE(p) === 0x02014b50) {
    const nameLen = cdBuf.readUInt16LE(p + 28);
    const extraLen = cdBuf.readUInt16LE(p + 30);
    const cmtLen = cdBuf.readUInt16LE(p + 32);
    names.push(cdBuf.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + cmtLen;
  }
}
const missing = NEED.filter(x => !names.includes(x));
if (missing.length) throw new Error(`zip 缺少必需条目: ${missing.join(', ')}`);

// 硬校验：独立数一遍源目录里确实存在的运行时目录，断言它们一个都没进 zip。
// 不从 `files` 反推 —— 那样只能证明 walk 按预期过滤，证不了"磁盘上真有东西且没漏"。
const onDisk = [];
for (const top of SKIP_TOP) {
  const d = path.join(SRC, top);
  if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
    for (const f of walk(d, top)) onDisk.push(f.rel);   // top 非空 → 不过滤
  }
}
const leaked = onDisk.filter(n => names.includes(n));
if (leaked.length) {
  throw new Error(`zip 混入了运行时数据，已中止: ${leaked.slice(0, 5).join(', ')}${leaked.length > 5 ? ` …共 ${leaked.length} 条` : ''}`);
}
if (onDisk.length) {
  console.log(`          已排除 ${onDisk.length} 个运行时文件（data/ 等，未进包）`);
}

const mb = (ver.length / 1048576).toFixed(1);
console.log(`[绿色版] ${OUT}`);
console.log(`          条目 ${names.length} 个 / ${mb} MB（未压缩合计 ${(files.reduce((s, f) => s + fs.statSync(f.abs).size, 0) / 1048576).toFixed(1)} MB）`);
if (NEED.length) console.log(`          必需条目全部命中: ${NEED.join(', ')}`);

'use strict';
/**
 * 差量引擎（纯函数，**不碰 fs**，所以能离线测）。
 *
 * 为什么必须是**块级**而不是文件级 —— 实测数据（Green 1.0.2 → 1.1.0）：
 *   76 个条目里 74 个逐字节相同，变的只有 app.asar(253KB) 和 QuickLaunch.exe(245.6MB)。
 *   ★ 而那个 exe 两版**长度一模一样**，按 32 KiB 分块比只有 2/7496 块不同 = 64 KiB
 *     （差的就是 VERSIONINFO 里几个版本号字节）。
 *   → 「文件级」会把整份 245 MB 算进差量（合计 103.72 MiB，占全量 67.5%，等于白搭）；
 *     「块级」只下 64 KiB。**数量级的差别就在这儿。**
 *
 * 分块用内容定义（CDC，Gear 滚动哈希），不用固定长度：
 * 固定长度分块遇到「中间插入几个字节」会让后面**全部错位**，复用率瞬间归零 ——
 * 实测过：1 KiB 网格采样碰上 43 KB 的插入，244/244 个窗口全 miss（报出 394.9% 的假数据）。
 *
 * 补丁 = 一串**统一 4 元组**指令 `[type, a, b, len]`（len **恒在 index 3**）：
 *   [0, oldIdx, start, len]  从「旧文件列表」的第 oldIdx 个文件的 start 处拷 len 字节
 *   [1, packOffset, 0, len]  从补丁包（pack）的 packOffset 处取 len 字节（b 位不用）
 * ★ 一定要统一：一开始 COPY 写 4 元组、DATA 写 3 元组，长度落在不同下标上，
 *   合并与还原各读各的 → 还原时算出 `NaN != 245604864` 直接炸。**长度只用 index 3 表达。**
 * 相邻的同类指令会**合并**，所以一个只改了几处的 245 MB 文件只有寥寥几条指令
 * （否则光指令表就能塞爆 manifest）。
 */

const crypto = require('crypto');

// ---- 分块参数：平均 8 KiB、最小 2 KiB、最大 32 KiB（与 electron-builder blockmap 的 32 KiB 上限对齐）----
const MIN_CHUNK = 2048;
const MAX_CHUNK = 32768;
/**
 * 切割条件用的掩码 —— **必须取哈希的高位，不能取低位**。
 * Gear 的递推是 `h = (h<<1) + GEAR[byte]`，左移意味着 h 的**最低位只由最后一个字节决定**
 * （bit0 == GEAR[last]&1），低位根本没被混匀。
 * 实测（目标都是平均 8192 字节切一次）：
 *   mask = 0x1FFF   (bit0-12) → asar 每 41994 字节才切一次，随机数据 7654 —— 对真实数据偏差 5 倍
 *   mask = 0x1FFF0000(bit16-28) → asar 9999，随机 7884 —— 两种数据都贴着期望值
 * ★ 切得比预期稀疏的后果很直接：块变得又大又粗，里面随便改一个字节整块作废。
 *   app.asar 只有 253 KB，用低位掩码时只切出 11 块（平均 23 KB），**复用率 0/11**——
 *   等于差量对这个文件完全失效。换成高位掩码后复用才正常。
 */
const MASK = 0x1FFF0000;             // 期望块长 = MIN_CHUNK + 2^13 ≈ 10 KiB

/** Gear 表：用固定种子现场生成，保证**跨机器、跨版本可复现**
 *  （★ 不能写成随机值 —— 否则 CI 与本地算出的分块边界不同，补丁互相不认）。 */
const GEAR = (() => {
  const t = new Uint32Array(256);
  let h = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    h = (h ^ (h << 13)) >>> 0;
    h = (h ^ (h >>> 17)) >>> 0;
    h = (h ^ (h << 5)) >>> 0;
    t[i] = h >>> 0;
  }
  return t;
})();

const sha1hex = (buf, s, e) => crypto.createHash('sha1').update(buf.subarray(s, e)).digest('hex');
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * 入口先校验形状。不校验的话，传错形状（比如把裸 Buffer 当成 `{path,data}` 塞进来）
 * 会在很深的 crypto 里炸出一句 `Received undefined`，根本看不出是谁传错了。
 */
function checkFiles(list, who) {
  if (!Array.isArray(list)) throw new TypeError(who + ' 必须是数组');
  list.forEach((f, i) => {
    if (!f || typeof f.path !== 'string' || !f.path) {
      throw new TypeError(`${who}[${i}] 缺少 path（每一项都要是 {path, data}）`);
    }
    if (!Buffer.isBuffer(f.data)) {
      throw new TypeError(`${who}[${i}]="${f.path}" 的 data 不是 Buffer（每一项都要是 {path, data}）`);
    }
  });
  return list;
}

/** 逐字节比两段区间是否相同（用于确认块匹配，顺带把哈希碰撞的可能性彻底消掉） */
function regionEqual(a, aStart, b, bStart, len) {
  if (aStart + len > a.length || bStart + len > b.length) return false;
  for (let i = 0; i < len; i++) if (a[aStart + i] !== b[bStart + i]) return false;
  return true;
}

/**
 * 内容定义分块。
 * @returns {{start:number,len:number,h:string}[]}
 */
function chunkify(buf) {
  const out = [];
  let start = 0;
  while (start < buf.length) {
    const hardEnd = Math.min(start + MAX_CHUNK, buf.length);
    let h = 0, cut = -1;
    for (let i = start; i < hardEnd; i++) {
      h = (((h << 1) >>> 0) + GEAR[buf[i]]) >>> 0;
      if (i - start + 1 >= MIN_CHUNK && (h & MASK) === 0) { cut = i + 1; break; }
    }
    const stop = cut === -1 ? hardEnd : cut;
    out.push({ start, len: stop - start, h: sha1hex(buf, start, stop) });
    start = stop;
  }
  return out;
}

/**
 * 给「旧文件列表」建块索引：块哈希 -> 候选位置。
 * @param {{path:string,data:Buffer}[]} oldFiles
 */
function buildIndex(oldFiles, { maxCandidates = 64 } = {}) {
  const idx = new Map();
  checkFiles(oldFiles, 'oldFiles').forEach((f, key) => {
    for (const c of chunkify(f.data)) {
      let arr = idx.get(c.h);
      if (!arr) { arr = []; idx.set(c.h, arr); }
      // 同一段内容在旧版本里出现很多次时（比如一堆 0 字节区），候选封顶，
      // 否则每个块的确认比对会退化成 O(n²)。
      if (arr.length < maxCandidates) arr.push({ key, start: c.start, len: c.len });
    }
  });
  return idx;
}

/**
 * 生成「整个目录」的差量：一个 manifest（进 update.json）+ 一个 pack（二进制数据段）。
 * @param {{path:string,data:Buffer}[]} oldFiles 基准版本的文件（客户端本地的样子）
 * @param {{path:string,data:Buffer}[]} newFiles 目标版本的文件
 * @param {(s:string)=>boolean} [dropFile] 返回 true 表示这个路径要整体跳过（运行时目录等）
 */
function makeDirPatch(oldFiles, newFiles, opts = {}) {
  const drop = opts.dropFile || (() => false);
  const olds = checkFiles(oldFiles, 'oldFiles').filter(f => !drop(f.path));
  const news = checkFiles(newFiles, 'newFiles').filter(f => !drop(f.path));

  const oldByPath = new Map();
  olds.forEach((f, i) => oldByPath.set(f.path, { i, data: f.data, hash: sha256hex(f.data) }));
  const idx = buildIndex(olds);

  const dataSegs = [];        // pack 的内容
  let packSize = 0;
  const pushData = (buf, s, e) => {
    const seg = Buffer.from(buf.subarray(s, e));
    dataSegs.push(seg);
    const off = packSize;
    packSize += seg.length;
    return off;
  };

  const files = [];
  let copyBytes = 0, dataBytes = 0;

  for (const nf of news) {
    const prev = oldByPath.get(nf.path);
    const nh = sha256hex(nf.data);
    if (prev && prev.data.length === nf.data.length && prev.hash === nh) {
      files.push({ path: nf.path, size: nf.data.length, sha256: nh, action: 'same' });
      continue;
    }

    const ops = [];
    // 只在「紧邻的同类型指令」上合并；注意 COPY 必须**同源同连续**才能并，
    // 否则会把两段不相邻的旧数据缝在一起，还原出来是错的。
    const pushOp = (op) => {
      const last = ops[ops.length - 1];
      if (last && last[0] === op[0]) {
        if (op[0] === 0 && last[1] === op[1] && last[2] + last[3] === op[2]) { last[3] += op[3]; return; }
        if (op[0] === 1 && last[1] + last[3] === op[1]) { last[3] += op[3]; return; }
      }
      ops.push(op);
    };

    for (const c of chunkify(nf.data)) {
      let hit = null;
      const cands = idx.get(c.h);
      if (cands) {
        for (const cd of cands) {
          if (cd.len !== c.len) continue;
          const src = olds[cd.key].data;
          if (regionEqual(src, cd.start, nf.data, c.start, c.len)) { hit = cd; break; }
        }
      }
      if (hit) { pushOp([0, hit.key, hit.start, c.len]); copyBytes += c.len; }
      else { pushOp([1, pushData(nf.data, c.start, c.start + c.len), 0, c.len]); dataBytes += c.len; }
    }

    files.push({ path: nf.path, size: nf.data.length, sha256: nh, action: 'patch', ops });
  }

  const newPaths = new Set(news.map(f => f.path));
  const removed = olds.map(f => f.path).filter(p => !newPaths.has(p));
  const pack = Buffer.concat(dataSegs);

  return {
    manifest: {
      version: 1,
      olds: olds.map(f => ({ path: f.path, size: f.data.length, sha256: oldByPath.get(f.path).hash })),
      files,
      removed,
      pack: { size: pack.length, sha256: sha256hex(pack) },
    },
    pack,
    stats: { oldFiles: olds.length, newFiles: news.length, copyBytes, dataBytes },
  };
}

/**
 * 应用差量补丁。
 * @param {Map<string,Buffer>} localByPath 客户端本地的文件（按 manifest.olds 的 path 取）
 * @param {object} manifest makeDirPatch 产出的 manifest
 * @param {Buffer} pack
 * @returns {{path:string,data:Buffer}[]} 需要写盘的文件（action==='same' 的不在结果里）
 */
function applyDirPatch(localByPath, manifest, pack) {
  if (manifest.version !== 1) throw new Error('差量清单版本不支持: ' + manifest.version);
  if (!Buffer.isBuffer(pack)) throw new TypeError('pack 必须是 Buffer');
  const got = sha256hex(pack);
  if (manifest.pack && manifest.pack.sha256 !== got) {
    throw new Error('补丁包校验失败：期望 ' + manifest.pack.sha256 + '，实际 ' + got);
  }

  // 基准文件必须先验哈希：本地文件被动过 / 版本对不上，这个补丁就打不上，
  // 必须在这里就抛错让上层**退回全量下载**，绝不能硬打出一个半残的程序。
  manifest.olds.forEach((o, i) => {
    const buf = localByPath.get(o.path);
    if (!buf) throw new Error('缺少基准文件: ' + o.path);
    if (buf.length !== o.size) throw new Error('基准文件大小不符: ' + o.path);
    const h = sha256hex(buf);
    if (h !== o.sha256) throw new Error('基准文件已被改动: ' + o.path);
    void i;
  });

  const out = [];
  for (const f of manifest.files) {
    if (f.action !== 'patch') continue;
    const buf = Buffer.allocUnsafe(f.size);
    let pos = 0;
    for (const op of f.ops) {
      if (op.length !== 4) throw new Error('指令格式错误（应为 4 元组）: ' + f.path);
      if (op[0] === 0) {
        const src = localByPath.get(manifest.olds[op[1]].path);
        if (!src) throw new Error('缺少 COPY 源文件: ' + manifest.olds[op[1]].path);
        src.copy(buf, pos, op[2], op[2] + op[3]);
      } else if (op[0] === 1) {
        if (op[1] + op[3] > pack.length) throw new Error('补丁包越界: ' + f.path);
        pack.copy(buf, pos, op[1], op[1] + op[3]);
      } else {
        throw new Error('未知指令类型 ' + op[0] + ': ' + f.path);
      }
      pos += op[3];
    }
    if (pos !== f.size) throw new Error('指令流长度不符: ' + f.path + ' (' + pos + ' != ' + f.size + ')');
    const h = sha256hex(buf);
    if (h !== f.sha256) throw new Error('还原结果校验失败: ' + f.path);
    out.push({ path: f.path, data: buf });
  }
  return out;
}

/** 判定「值不值得走增量」：差量包占全量比例超过阈值就老实下全量。
 *  ★ 判据是**占比**而不是「文件大不大」—— 我们的实测里 245 MB 的文件只差 64 KiB。 */
function shouldUseDelta(packSize, fullSize, limit = 0.6) {
  if (!(fullSize > 0) || !(packSize >= 0)) return false;
  return packSize / fullSize <= limit;
}

module.exports = {
  MIN_CHUNK, MAX_CHUNK, MASK,
  checkFiles, chunkify, buildIndex, makeDirPatch, applyDirPatch, shouldUseDelta,
  sha256hex, regionEqual,
};

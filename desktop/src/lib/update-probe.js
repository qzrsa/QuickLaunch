'use strict';
/**
 * **仅供 `--update-probe` 使用**的离线更新源夹具。
 *
 * 为什么需要它：自更新的界面（发现新版本 → 下载 → 已就绪 → 重启并更新）
 * 如果只能靠"真去 GitHub 拉一次"来验证，那探针就变成看运气了 —— 没网、
 * 恰好没发过清单、或者 GitHub 被墙，都会让探针结果毫无意义。所以这里造一套
 * 完全本地的假更新源：一个"新版本"目录 + 一个绿色版 zip + 一份 update.json，
 * 通过注入的传输层喂给 update-service。
 *
 * ★ 只在 `!app.isPackaged` 下启用（同 --shot），且**从不**调用 applyAndRestart ——
 *   它只把流程推到"已就绪"就停下，真正的换文件由 scripts/verify-apply.mjs 去验。
 * ★ 夹具里的程序目录落在 `.tmpdata/update-probe/prog`，**不是**真实程序目录。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { crc32 } = require('./unzip.js');
const { withoutAsar } = require('./asar-safe.js');

const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * 极简 **store-only** ZIP 写器（不压缩）。
 * ★ 只服务夹具，不追求通用 —— 项目里真正的写器是 `scripts/pack-green.mjs`
 *   （它会挑 store/deflate、排除运行时目录、统一时间戳）。这里刻意不引它：
 *   那是个 ESM 脚本，主进程里要用它就得起子进程，而打包后 `process.execPath`
 *   是 Electron 而不是 node，起不起来得看运气。读回来仍由 `unzip.js` 校验 CRC。
 */
function zipStore(entries) {
  const parts = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0x0800, 6);      // bit 11：文件名是 UTF-8
    lh.writeUInt16LE(0, 8);           // method 0 = store
    lh.writeUInt16LE(0, 10);          // time
    lh.writeUInt16LE(0x21, 12);       // date = 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(0, 38);          // 外部属性
    ch.writeUInt32LE(offset, 42);     // 本地头偏移
    centrals.push(ch, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

/** 1.1.1 → 1.2.0；解析不出来就退到 9.9.9（探针也要能跑） */
function bumpMinor(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${+m[2] + 1}.0` : '9.9.9';
}

/**
 * 造夹具。
 * @param {string} root     夹具根目录（`.tmpdata/update-probe`）
 * @param {string} version  目标版本号（比本机新）
 * @returns {{root,progDir,newDir,zipName,zipBuf,manifest,served}}
 */
function makeFixture(root, version) {
  fs.rmSync(root, { recursive: true, force: true });
  const newDir = path.join(root, 'newver');
  const progDir = path.join(root, 'prog');
  const zipName = `QuickLaunch-Green-${version}.zip`;

  const put = (base, rel, data) => {
    const p = path.join(base, ...rel.split('/'));
    // ★ 造夹具这一步也得关掉 asar 补丁：夹具里就有 `resources/app.asar`，而
    //   **在真 Electron 里往 *.asar 写 Buffer 会被补丁拦下**（写字符串反而侥幸通过）。
    //   这一条就是这么被发现的 —— 夹具本身是从 Electron 主进程里跑起来的。见 asar-safe.js。
    withoutAsar(() => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
    });
  };

  // 目标版本的内容：一个"二进制"（zip 是 store-only，所以它的体积就是包的大头 ——
  // 这样传输层会切出多个 chunk，进度与节流两条路径都能真的被走到）、
  // 一个 asar、一个语言包
  const exeData = Buffer.alloc(300000);
  for (let i = 0; i < exeData.length; i++) exeData[i] = (i * 37 + 11) & 0xff;
  const entries = [
    { name: 'QuickLaunch.exe', data: exeData },
    { name: 'resources/app.asar', data: Buffer.from(`ASAR v${version}\n`.repeat(600)) },
    { name: 'locales/zh-CN.pak', data: Buffer.from('快速启动 语言包\n'.repeat(300)) },
  ];
  for (const e of entries) put(newDir, e.name, e.data);

  // 本机（"旧版本"）：asar 与语言包都不一样 → 这两条会被摊进暂存区；
  // 再加一个只属于旧版的文件 → 全量路径的 deletes 必须是空的（看不懂的东西绝不删）
  put(progDir, 'QuickLaunch.exe', exeData);                       // 与目标一致 → 不该被重复写
  put(progDir, 'resources/app.asar', Buffer.from('ASAR v1.0.0 OLD\n'));
  put(progDir, 'old-extra.dll', Buffer.from('只有旧版才有的文件'));
  put(progDir, 'data/config.json', '{"private":"用户数据，更新器绝不能碰"}');

  const zipBuf = zipStore(entries);
  const manifest = {
    schema: 1,
    app: 'QuickLaunch',
    channel: 'green',
    version,
    full: { asset: zipName, size: zipBuf.length, sha256: sha256hex(zipBuf) },
    files: entries.map(e => ({ path: e.name, size: e.data.length, sha256: sha256hex(e.data) })),
    patches: [],
  };

  const served = [
    { name: 'update.json', body: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: zipName, body: zipBuf },
  ];

  return { root, progDir, newDir, zipName, zipBuf, manifest, served };
}

/** 按真实传输层的约定写盘并调用 onChunk（真实现是"边收边写"） */
function transport(fx, opts = {}) {
  const sleep = () => new Promise(r => setTimeout(r, 0));
  const SLICE = 64 * 1024;

  return async (url, o = {}) => {
    const u = String(url);
    const hit = fx.served.find(s => u.endsWith('/' + s.name) || u.endsWith(s.name));
    if (!hit) {
      const e = new Error('夹具里没有这个地址：' + u);
      e.status = 404;
      throw e;
    }
    const body = hit.body;
    // ★ 不要先来一次 onChunk(0, len)：真实传输层是"收到多少报多少"，
    //   提前报个 0 会让"进度里有真实字节数"这条断言永远绿在一个假值上。
    //   （进度条的 0/total 由编排层在进入 downloading 时自己给。）
    if (o.destPath) {
      const fd = (o.fs || fs).openSync(o.destPath, 'w');
      try {
        for (let off = 0; off < body.length; off += SLICE) {
          const part = body.subarray(off, Math.min(off + SLICE, body.length));
          (o.fs || fs).writeSync(fd, part);
          o.onChunk && o.onChunk(Math.min(off + SLICE, body.length), body.length);
          if (opts.slow) await sleep();
        }
      } finally {
        (o.fs || fs).closeSync(fd);
      }
      return { path: o.destPath, size: body.length, total: body.length };
    }
    return body;
  };
}

module.exports = { makeFixture, zipStore, bumpMinor, transport, sha256hex };

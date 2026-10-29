'use strict';
/**
 * 图标提取：把「程序自带的默认 ICO / 用户自定义图片」转成 dataURL 存进 item.icon。
 *
 * 约定：item.icon 有两种形态
 *  - emoji 字符串（原有，用户从 emoji 选择器挑的）
 *  - `data:image/...;base64,...`（程序自带 ICO / 自定义图片）
 * 渲染层遇到 data: 开头就当 <img> 显示，其他一律当 emoji 文本。
 *
 * 为什么要存 dataURL 而不是存文件路径：
 *  - 数据随程序走（绿色版/便携版整个目录搬走即迁移），内嵌到 config.json 里最省心，
 *    不依赖原 exe 还在不在、渲染层能不能读任意绝对路径（安全上也不该让它随便读盘）。
 *  - 尺寸做上限：默认 ICO 缩到 ~64px、自定义图片缩到 ~192px，避免 config.json 被撑大。
 *
 * 纯 Node 下没有 Electron 的 app/nativeImage —— 本模块只被主进程 require，
 * 用注入而非直接 require，方便单测（smoke 已用注入 fs 的先例）。
 */

const MAX_NATIVE = 2048; // 输入图片超过这个边就拒绝，防止巨图把配置撑爆

const urlsc = require('./urlshortcut');
const exeicon = require('./exeicon');

/**
 * 把一个 Electron NativeImage / 磁盘图片路径 → 按最长边缩放到 size 的数据URL。
 * 返回 '' 表示失败/不可用。
 * @param {import('electron').nativeImage} image 已就绪的 image（.isEmpty() 视为失败）
 * @param {number} size 最长边像素
 */
function imageToDataUrl(image, size = 128) {
  try {
    if (!image || image.isEmpty()) return '';
    let img = image;
    const s = img.getSize();
    if (s && s.width > MAX_NATIVE && s.height > MAX_NATIVE) return '';
    if (s && (s.width > size || s.height > size)) {
      img = image.resize({ width: size, quality: 'good' });
    }
    return img.toDataURL();
  } catch { return ''; }
}

/** 把本地图片/ICO文件 → 缩放到 size 的 dataURL。返回 '' 表示失败。 */
function imageFileToDataUrl(filePath, size = 192) {
  try {
    const { nativeImage } = require('electron');
    if (!nativeImage) return '';
    const img = nativeImage.createFromPath(filePath);
    return imageToDataUrl(img, size);
  } catch { return ''; }
}

/** 展开 %ENV% 与 ~（编辑弹窗里手填的路径可能带环境变量） */
function expandEnv(p) {
  let s = String(p || '');
  if (!s) return '';
  try {
    const os = require('os');
    if (s.startsWith('~')) s = require('path').join(os.homedir(), s.slice(1));
  } catch { /* 拿不到 home 就原样 */ }
  return s.replace(/%([^%]+)%/g, (m, name) => {
    const v = process.env[name] || process.env[name.toUpperCase()];
    return v === undefined ? m : v;
  });
}

/**
 * 解析 `.lnk`，给出「该从哪取图标」的唯一来源。返回 `{path, group?, id?}` 或 null。
 *
 *  - `path` 是 `.ico` / `.dll` / `.exe` / 目标文件
 *  - `group` / `id` 只对 `.dll` / `.exe` 有意义（来自快捷方式的 `iconIndex`，见下）
 *
 * ★★ 为什么必须自己解析：`app.getFileIcon()` 对 `.lnk` **不追目标**，一律返回
 *   一张 32×32 的通用「应用」图标（实测本机 173 个开始菜单快捷方式拿到**同一个**
 *   32×32 图，哈希一模一样）。用户看到的就是"图标一片空白/全一样"，而桌面上一切正常。
 * ★ `icon` 字段的两种取值（本机实测）：
 *   ① `.ico` → 直接读图（最准，优先）
 *   ② `.exe`/`.dll` + `iconIndex` → 去那个 PE 里取"第 N 组"。`iconIndex` 的规矩是
 *      「非负数 = 第 N 组（0 基，按资源 ID 升序）；负数 = 资源 ID 就是 -N」，v1.4.5 实现。
 *      本机例子：`iSCSI Initiator.lnk` 的 icon 指向 `iscsicpl.dll` + iconIndex=-1，
 *      而它的 target `iscsicpl.exe` 自己**一张图标都没有** —— 以前直接忽略 `.dll`，
 *      于是这类"图标转发壳"程序只能退回通用图。
 * ★ 顺序：先认 `icon`（安装包特意指定的那张），再退回 target。反了就永远拿不到自定义图标
 *   （例：小狼毫那几个快捷方式各自指向同一个 dll 里的**不同**图标）。
 */
function shortcutSource(lnkPath) {
  try {
    const { shell } = require('electron');
    if (!shell || typeof shell.readShortcutLink !== 'function') return null;
    const fs = require('fs');
    const info = shell.readShortcutLink(lnkPath);
    if (!info) return null;

    const ic = expandEnv(info.icon || '');
    if (ic && fs.existsSync(ic)) {
      if (/\.ico$/i.test(ic)) return { path: ic };
      if (/\.(dll|exe|cpl|ocx|scr)$/i.test(ic)) {
        const n = Math.trunc(Number(info.iconIndex) || 0);
        return n < 0 ? { path: ic, id: -n } : { path: ic, group: n };
      }
    }
    const t = expandEnv(info.target || '');
    if (t && fs.existsSync(t)) return { path: t };
    return null;
  } catch { return null; }
}

/** 解析 `.lnk` 的图标来源路径；解析不出来返回 ''。（旧接口，只回路径） */
function shortcutTarget(lnkPath) {
  const src = shortcutSource(lnkPath);
  return src ? src.path : '';
}

/**
 * 把程序路径（exe/lnk/url/ico/任何有默认图标的文件）→ 提取自带图标转 dataURL。'' 表示取不到。
 *
 * 取图的顺序（每一步都踩过坑，别随手调换）：
 *  ① `.lnk` → `shortcutSource()` 算出来源：`.ico` / 「某个 dll·exe 的第 N 组」/ 目标文件
 *  ② `.ico` → `nativeImage.createFromPath` 直读
 *  ③ `.url` → 读它自己的 `IconFile=`（见 lib/urlshortcut.js）
 *  ④ `.exe/.dll/.cpl` → **自己解 PE 资源**（lib/exeicon.js）
 *  ⑤ 其余（文件夹 / `.msc` / 无资源的文件）→ 才轮到 `app.getFileIcon`
 *
 * ★★ 为什么 ④ 必须自己解：本机实测 `app.getFileIcon(..., {size:'large'})` 对**大量正常程序**
 *    只回一张 32×32 的通用图标（notepad.exe / QuickLaunch.exe / clash-verge.exe 三者哈希完全相同），
 *    而 python.exe / WeaselServer.exe 却又能拿到 48×48 真图标 —— 同一台机、同一个 API，
 *    一半对一半错，没有任何规律。用户看到的成片"白板"就是这么来的。
 * ★★ 存在性必须先查：`app.getFileIcon` 对不存在的路径不报错也不返回空，而是回一张"白板"。
 * ★ `.exe` 的 PE 里**真的没有图标资源**时（例如 Win10 的 notepad.exe 只是个转发壳）
 *    返回 ''，让上层保持 emoji —— 不拿通用图标去糊，也不猜别的 dll。
 */
async function fileDefaultIconToDataUrl(filePath, size = 128) {
  try {
    const { app, nativeImage } = require('electron');
    if (!app || !nativeImage || !filePath) return '';
    const fs = require('fs');
    const p = expandEnv(filePath);
    let exists = false;
    try { exists = fs.existsSync(p); } catch { exists = false; }
    if (!exists) return '';

    // ① .lnk 先算出来源（可能是"某个 dll/exe 的第 N 组"）
    let src = { path: p };
    if (/\.lnk$/i.test(p)) src = shortcutSource(p) || { path: p };
    const pick = src.path;

    // ② 直接是 .ico
    if (/\.ico$/i.test(pick)) return imageFileToDataUrl(pick, size);

    // ③ .url：读 IconFile；取不到就返回空（保持 emoji，别用通用"地球"图盖掉）
    if (/\.url$/i.test(pick)) {
      const sc = urlsc.readUrlShortcut(pick, { fs });
      return sc && sc.iconFile ? urlIconFileToDataUrl(sc.iconFile, size, sc.iconIndex) : '';
    }

    // ④ 可执行文件：自己解 PE 资源。快捷方式指定了 group/id 就只认那一组
    //    （那一组取不到就返回空 —— **不能**退回"随便挑一组"或 getFileIcon，
    //     那会挂上一张看起来像、其实不是的图，用户更难发现）。
    if (/\.(exe|dll|cpl|scr|ocx)$/i.test(pick)) {
      return exeFileIconToDataUrl(pick, size, src.group, src.id);
    }

    // ⑤ 兜底：文件夹、.msc、关联图标等
    const img = await app.getFileIcon(pick, { size: 'large' });
    return imageToDataUrl(img, size);
  } catch { return ''; }
}

/**
 * 构造好的 ICO 字节 → dataURL。'' 表示失败。
 *
 * ★★ `nativeImage.createFromBuffer(ico)` 是**不支持** ICO 的（实测返回空图），
 *    只有 `createFromPath` 认 —— 所以必须落一个临时文件再读。
 *    好消息：`createFromPath` 是**立刻解码**进内存的（实测删掉文件后 `toPNG()` 依旧正常），
 *    所以读完就删，不留垃圾。文件名用内容哈希，重复的图标不会互相覆盖。
 */
function icoToDataUrl(icoBuf, size = 128) {
  try {
    const { app, nativeImage } = require('electron');
    if (!app || !nativeImage || !icoBuf || !icoBuf.length) return '';
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');
    const dir = path.join(app.getPath('temp'), 'quicklaunch-icon');
    fs.mkdirSync(dir, { recursive: true });
    const name = crypto.createHash('md5').update(icoBuf).digest('hex').slice(0, 20) + '.ico';
    const file = path.join(dir, name);
    fs.writeFileSync(file, icoBuf);
    const img = nativeImage.createFromPath(file);
    const url = imageToDataUrl(img, size);
    try { fs.unlinkSync(file); } catch { /* 删不掉就留着，下次覆盖写 */ }
    return url;
  } catch { return ''; }
}

/**
 * 可执行文件 → 它自己的图标 dataURL（解 PE 资源，不碰 shell）。'' 表示这个文件没有图标资源。
 * @param {string} filePath .exe / .dll / .cpl …
 * @param {number} [size] 最长边
 * @param {number} [group] 取第几组（0 基）
 * @param {number} [id] 按资源 ID 取一组（与 group 互斥，优先 id）
 */
function exeFileIconToDataUrl(filePath, size = 128, group, id) {
  const deps = id !== undefined && Number.isFinite(id) ? { id }
    : (group !== undefined && Number.isFinite(group) ? { group } : undefined);
  const ico = exeicon.readIconResource(filePath, deps);
  return ico ? icoToDataUrl(ico, size) : '';
}

/**
 * `.url`（Internet 快捷方式）里 `IconFile=` 指的图标文件 → dataURL。取不到返回 ''。
 *
 * ★★ `.ico` 只能用 nativeImage 直读，**千万别**换成 `app.getFileIcon`：本机实测多个
 *    不同的 `.ico` 走 getFileIcon **全回同一张 32×32 通用图标**（哈希一模一样）；
 *    走 nativeImage 是 256×256 且各不相同。同一类坑还有 `.lnk`（不追目标）、`.url` 本体、
 *    以及 `.exe` 本体（见 fileDefaultIconToDataUrl 的注释）。
 * ★ `IconFile` 指向 `.dll` / `.exe` 时按 `IconIndex` 去 PE 资源里取那一组（v1.4.5 起），
 *    取不到就返回空 —— 别硬凑一张假图。
 */
function urlIconFileToDataUrl(filePath, size = 128, iconIndex = 0) {
  const p = expandEnv(filePath);
  if (!p) return '';
  try {
    if (!require('fs').existsSync(p)) return '';
  } catch { return ''; }
  if (/\.(dll|exe|cpl)$/i.test(p)) {
    // 与 .lnk 的 iconIndex 同一套规矩：非负 = 第 N 组，负数 = 资源 ID 为 -N
    const n = Math.trunc(Number(iconIndex) || 0);
    return n < 0 ? exeFileIconToDataUrl(p, size, undefined, -n) : exeFileIconToDataUrl(p, size, n);
  }
  return imageFileToDataUrl(p, size);
}

/** 任意图片字节（PNG / ICO / …）→ dataURL。'' 表示失败。
 *  用于联网抓回来的 favicon：先试 createFromBuffer（认 PNG），再退 ICO 处理（落临时文件）。 */
function bufferToIconDataUrl(buf, size = 64) {
  try {
    if (!buf || !buf.length) return '';
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBuffer(buf);
    if (img && !img.isEmpty()) return imageToDataUrl(img, size);
    return icoToDataUrl(buf, size);
  } catch { return ''; }
}

/** 判断一个 icon 值是否为「图片型」dataURL（渲染层据此决定渲染 <img>） */
function isImageIcon(icon) {
  return typeof icon === 'string' && /^data:image\//i.test(icon);
}

module.exports = {
  imageToDataUrl, imageFileToDataUrl, fileDefaultIconToDataUrl, urlIconFileToDataUrl,
  icoToDataUrl, exeFileIconToDataUrl, bufferToIconDataUrl,
  isImageIcon, shortcutSource, shortcutTarget, expandEnv, MAX_NATIVE,
};

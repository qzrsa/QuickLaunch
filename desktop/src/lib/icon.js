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
 * 解析 `.lnk` 的真实目标文件；解析不出来返回 ''。
 *
 * ★★ 为什么必须自己解析：`app.getFileIcon()` 对 `.lnk` **不追目标**，一律返回
 *   一张 32×32 的通用「应用」图标（实测本机 173 个开始菜单快捷方式拿到**同一个**
 *   32×32 图，哈希一模一样）。用户看到的就是"图标一片空白/全一样"，而桌面上一切正常。
 *   改成先 `shell.readShortcutLink()` 拿到 target，再对 target 取图标 —— 实测 4/4 都拿到了
 *   各自不同的 48×48 真图标。
 * ★ 自定义图标只认 `.ico`：`.dll`/`.exe` 的 `icon` 字段还带着 `iconIndex`，而 `getFileIcon`
 *   只能取"文件自己的默认图标"，取不到那一张 —— 这时候不如退回目标程序的默认图标。
 */
function shortcutTarget(lnkPath) {
  try {
    const { shell } = require('electron');
    if (!shell || typeof shell.readShortcutLink !== 'function') return '';
    const fs = require('fs');
    const info = shell.readShortcutLink(lnkPath);
    if (!info) return '';
    const ic = expandEnv(info.icon || '');
    if (ic && /\.ico$/i.test(ic) && fs.existsSync(ic)) return ic;
    const t = expandEnv(info.target || '');
    if (t && fs.existsSync(t)) return t;
    return '';
  } catch { return ''; }
}

/**
 * 把程序路径（exe/lnk/任何有默认图标的文件）→ 提取自带 ICO 转 dataURL。返回 '' 表示失败。
 *
 * ★ 必须先确认路径**真实存在**：实测 `app.getFileIcon` 对不存在的路径不报错、也不返回空，
 *   而是回一个通用的"白板"图标 —— 直接采信就会给"稍后才接入的盘"挂上一个假图标。
 *   不存在时返回 ''，上层保持 emoji 回退。裸命令名（如 notepad.exe）同理按不存在处理。
 * ★ `.lnk` 先解析目标（见 shortcutTarget），否则拿到的是通用图标。
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
    const pick = /\.lnk$/i.test(p) ? (shortcutTarget(p) || p) : p;
    const img = await app.getFileIcon(pick, { size: 'large' });
    return imageToDataUrl(img, size);
  } catch { return ''; }
}

/**
 * `.url`（Internet 快捷方式）里 `IconFile=` 指的图标文件 → dataURL。取不到返回 ''。
 *
 * ★★ 只能用 nativeImage 直读，**千万别**换成 `app.getFileIcon`：本机实测 3 个不同的
 *    `.ico`（Steam 游戏图标 / FeverGames 图标）走 getFileIcon **全回同一张 32×32
 *    通用图标**（哈希一模一样）；走 nativeImage 是 256×256 且三张各不相同。
 *    同一类坑还有 `.lnk`（不追目标）、`.url` 本体（getFileIcon 也是通用图）。
 * ★ `IconFile` 指向 `.dll` / `.exe` 时这里必然失败（多图标容器要靠 `IconIndex`），
 *    返回 '' 让上层保持 emoji 回退 —— 别硬凑一张假图。
 */
function urlIconFileToDataUrl(filePath, size = 128) {
  const p = expandEnv(filePath);
  if (!p) return '';
  try {
    if (!require('fs').existsSync(p)) return '';
  } catch { return ''; }
  if (/\.(dll|exe)$/i.test(p)) return '';
  return imageFileToDataUrl(p, size);
}

/** 判断一个 icon 值是否为「图片型」dataURL（渲染层据此决定渲染 <img>） */
function isImageIcon(icon) {
  return typeof icon === 'string' && /^data:image\//i.test(icon);
}

module.exports = {
  imageToDataUrl, imageFileToDataUrl, fileDefaultIconToDataUrl, urlIconFileToDataUrl,
  isImageIcon, shortcutTarget, MAX_NATIVE,
};

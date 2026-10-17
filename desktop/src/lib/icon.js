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
 * 把程序路径（exe/lnk/任何有默认图标的文件）→ 提取自带 ICO 转 dataURL。返回 '' 表示失败。
 *
 * ★ 必须先确认路径**真实存在**：实测 `app.getFileIcon` 对不存在的路径不报错、也不返回空，
 *   而是回一个通用的"白板"图标 —— 直接采信就会给"稍后才接入的盘"挂上一个假图标。
 *   不存在时返回 ''，上层保持 emoji 回退。裸命令名（如 notepad.exe）同理按不存在处理。
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
    const img = await app.getFileIcon(p, { size: 'large' });
    return imageToDataUrl(img, size);
  } catch { return ''; }
}

/** 判断一个 icon 值是否为「图片型」dataURL（渲染层据此决定渲染 <img>） */
function isImageIcon(icon) {
  return typeof icon === 'string' && /^data:image\//i.test(icon);
}

module.exports = { imageToDataUrl, imageFileToDataUrl, fileDefaultIconToDataUrl, isImageIcon, MAX_NATIVE };

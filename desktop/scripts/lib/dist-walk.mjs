/**
 * 「程序目录扫描 + 运行时数据防泄漏」的唯一实现。
 *
 * ⚠️ 为什么要单独抽一个模块：`win-unpacked`（绿意版的程序目录）里，只要有人在本机
 * 原地跑过一次，`data/config.json` 就在里面 —— 那可能是用户的私人配置（路径、备注等）。
 * 打包/生成更新清单时**不排除就会随 Release 发出去**。
 * 这条守卫属于"最坏可造成数据外泄"的级别，所以：
 *   1. 只有**一份**实现，不许各脚本各写一份（写了就会漂移）；
 *   2. 排除之后还要**独立再数一遍**磁盘上真实存在的运行时文件，断言它们一个都没进产物 ——
 *      绝不能"从过滤后的列表反推"，那种断言永远为空、等于没写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// ★ 受保护的运行时目录名**只有一份定义**，就在 src/lib/datadir.js 里：
//   打包、生成更新清单、自更新落盘三处都要用同一个列表，各写一份必然漂移，
//   而漏一处的后果是把用户私人配置发出去、或者被更新器删掉。
const require = createRequire(import.meta.url);
const { PROTECTED_TOP } = require('../../src/lib/datadir.js');

/** 顶层运行时目录：整棵剪掉，不进任何发布产物 */
export const SKIP_TOP = new Set(PROTECTED_TOP);

/**
 * 递归收集 srcDir 下的普通文件。
 * @param {string} dir
 * @param {string} base 相对前缀；**非空时不再过滤 SKIP_TOP**（用于主动遍历运行时目录本身）
 * @param {(kind:'dir'|'file', rel:string)=>void} [onWarn]
 * @returns {{abs:string, rel:string}[]} rel 一律正斜杠
 */
export function walkDist(dir, base = '', onWarn = null) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (!base && SKIP_TOP.has(e.name)) {
      if (onWarn) onWarn('dir', rel);
      continue;
    }
    if (e.isDirectory()) out.push(...walkDist(abs, rel, onWarn));
    else if (e.isFile()) out.push({ abs, rel });
    else if (onWarn) onWarn('file', rel);
  }
  return out;
}

/** 独立地"再数一遍"：磁盘上此刻真实存在的运行时文件有哪些 */
export function runtimeFilesOnDisk(srcDir) {
  const out = [];
  for (const top of SKIP_TOP) {
    const d = path.join(srcDir, top);
    if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
      for (const f of walkDist(d, top)) out.push(f.rel);
    }
  }
  return out;
}

/**
 * 硬校验：产物里**一个运行时文件都不许有**。
 * @param {string} srcDir 程序目录
 * @param {string[]} names 产物已包含的条目路径
 * @param {string} label 报错文案里的产物名
 * @returns {number} 磁盘上的运行时文件数量（0 表示本机没跑过，也就没什么可漏）
 */
export function assertNoRuntimeLeak(srcDir, names, label = '产物') {
  const onDisk = runtimeFilesOnDisk(srcDir);
  const leaked = onDisk.filter(n => names.includes(n));
  if (leaked.length) {
    throw new Error(`${label} 混入了运行时数据，已中止: ${leaked.slice(0, 5).join(', ')}`
      + `${leaked.length > 5 ? ` …共 ${leaked.length} 条` : ''}`);
  }
  return onDisk.length;
}

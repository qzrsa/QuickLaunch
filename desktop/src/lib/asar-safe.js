'use strict';
/**
 * **只在 Electron 里才会踩到**的一个坑：asar 补丁会把"以 `.asar` 结尾的路径"当存档。
 *
 * 事实（2025-10 用 Electron 44.7.2 实测，见 `.workbuddy/memory/探针手册.md`）：
 *   - Electron 用**路径后缀**判定 asar（大小写不敏感）。`…\resources\app.asar` 这种
 *     "存档文件本身"会被解析成「存档根 + 空内部路径」，于是：
 *       · `readFileSync` / `openSync` → `Invalid package …app.asar` 或 `ENOENT, not found in …`
 *       · `statSync(...).size` → 谎报 **0**（不抛错，静默给错值 —— 更坏）
 *       · `writeFileSync(Buffer)` → 抛；`writeFileSync(string)` → 走 Node 的 C++ 快路径侥幸写进去
 *     `resources/app.asar.new`、`resources/app.asar.txt`、`locales/zh-CN.pak` 都正常，
 *     `data/foo.asar`（换个目录但后缀一样）照样中招 —— **判据只有后缀**。
 *   - `process.noAsar = true` 能彻底关掉它，之后读写都正常；改回来也没有副作用。
 *
 * 为什么必须要它：更新器得把 `<程序目录>\resources\app.asar` 当**普通文件**看待
 * （算 sha256 做差量比对、把它摊进暂存区、从 zip 解出来），而每个真机上都有这个文件。
 * 不关补丁，scanProgramDir / stage / stageFull 在打包后的程序里**必然**失败；
 * 而单测跑在纯 Node 下（没有补丁），所以全绿也照样漏掉 —— 这类坑只有真跑一遍才现形。
 *
 * ★ 只许包**同步**代码：`noAsar` 是进程级全局开关，包着 `await` 就等于"顺手把别人的
 *   asar 支持也关了"（打包后程序自己的代码就在 app.asar 里，`require` 会当场断）。
 * ★ 用 `try/finally` 恢复：里面抛错也不能把开关留在关闭状态。
 * ★ 允许嵌套：按 `prev` 逐层还原，内层不会把外层的状态踢掉。
 *
 * @template T
 * @param {() => T} fn 一段**同步**代码
 * @returns {T}
 */
function withoutAsar(fn) {
  const prev = process.noAsar;
  process.noAsar = true;
  try {
    return fn();
  } finally {
    process.noAsar = prev;
  }
}

module.exports = { withoutAsar };

'use strict';
/**
 * 生成"退出之后才运行"的那段助手脚本（纯字符串拼装，不碰 fs、不起进程 → 可在 smoke 里逐条断言）。
 *
 * ★★ 为什么要一个"退出后"的助手：Windows 上**正在运行的 exe 是不可覆盖的**，
 *    连 `resources/*.dll` 也被映射着。所以只能自己先退出，让另一个进程去换文件。
 *
 * ★★ 为什么用 PowerShell 的 `-EncodedCommand`，而不是写一个 .cmd/.ps1 文件：
 *    - `.cmd` 的文件名与内容都要过控制台代码页，而**用户自己的程序目录里就有中文**
 *      （`D:\WorkBuddy\快速启动\...`）→ 一旦按 GBK/UTF-8 猜错，路径就废了；
 *    - `-EncodedCommand` 收的是 **UTF-16LE 的 base64**，编码是明文规定的，不存在"猜代码页"；
 *    - 而且**一个字节都不落盘**，不用管临时文件的权限与清理。
 *
 * ★★ 助手**不信任** apply.json：它拿到的 protectedTop 名单是主进程从 `datadir.PROTECTED_TOP`
 *    注入进来的（不是在这里另抄一份），并且对每一条路径**再挡一次**
 *    （`..`、绝对路径、受保护顶层目录）。纵深防御 —— 更新器最要命的失败是删掉用户的 data/。
 *
 * ★★ 换文件用的是"先落 `.ql-new`，再逐个 `Move-Item -Force`"：
 *    同卷内的 Move 是原子替换，所以中途断电/被杀也**不会留下半截的 exe**。
 *    顺序上把 `*.exe` 放到最后 —— 真正的程序代码在 `resources/app.asar` 里，
 *    它先到位，万一后面失败，旧 exe + 新 asar 仍然跑得起来。
 */

/** PowerShell 单引号字符串：单引号自己要用两个单引号转义（这样 `$` `\` `中文` 全是字面量）。 */
function psQuote(s) {
  return "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
}

/**
 * 生成助手脚本。
 * @param {object} apply  stage() 写下的 apply.json 内容
 * @param {{pid:number, waitSeconds?:number, logPath?:string}} o
 * @returns {string} PowerShell 脚本正文
 */
function buildApplyScript(apply, o) {
  const pid = Number(o.pid) || 0;
  const wait = Number(o.waitSeconds) || 60;
  const stage = apply.stageDir;
  const prog = apply.programDir;
  const log = o.logPath || (stage + '\\apply.log');

  // 名单来自 datadir.PROTECTED_TOP（注入），不是这里硬编码
  const protectedList = (apply.protectedTop || []).map(psQuote).join(', ');
  const exe = apply.exe || '';

  return `$ErrorActionPreference = 'Stop'
$pid0    = ${pid}
$stage   = ${psQuote(stage)}
$prog    = ${psQuote(prog)}
$logFile = ${psQuote(log)}
$restart = $${apply.restart ? 'true' : 'false'}
$appExe  = ${psQuote(exe)}
$protected = @(${protectedList})

# ★ 一律走 .NET 的 UTF-8（**不带 BOM**）读写：
#   Windows PowerShell 5.1 的 \`-Encoding utf8\` 写文件会**加上 BOM**，而 Node 侧
#   JSON.parse 碰到开头的 \\uFEFF 会直接抛 —— 一个 BOM 就能把"更新成功"写成"更新失败"。
$utf8 = New-Object System.Text.UTF8Encoding $false
function ReadText([string]$p) { return [IO.File]::ReadAllText($p, $utf8) }
function WriteText([string]$p, [string]$t) { [IO.File]::WriteAllText($p, $t, $utf8) }

function Log([string]$m) {
  try { [IO.File]::AppendAllText($logFile, "$([DateTime]::Now.ToString('MM-dd HH:mm:ss')) $m\`r\`n", $utf8) } catch { }
}
function SaveState([string]$s, [string]$note) {
  try {
    WriteText (Join-Path (Split-Path -Parent $stage) 'state.json') (
      @{ state = $s; to = $plan.to; from = $plan.from; at = [DateTime]::Now.ToString('o'); note = $note } |
      ConvertTo-Json)
  } catch { }
}

Log "助手启动 pid0=$pid0 stage=$stage"

# ---- 1. 等主进程退出 ----
#     ★ 正在运行的 exe 在 Windows 上不可覆盖，所以这一步不是"礼貌"，是必需。
$deadline = (Get-Date).AddSeconds(${wait})
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id $pid0 -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
}
if (Get-Process -Id $pid0 -ErrorAction SilentlyContinue) {
  Log "主进程 ${wait} 秒内没有退出，放弃（本机文件一个都没动）"
  exit 3
}
Log '主进程已退出，开始应用'

# ---- 2. 读计划（助手自己的 try 块从这里开始：后面任何一步失败都要写回 failed）----
$plan = $null
try {
  $plan = (ReadText (Join-Path $stage 'apply.json')) | ConvertFrom-Json
  if ($null -eq $plan) { throw 'apply.json 是空的' }

  function Assert-Safe([string]$rel, [string]$what) {
    if ([string]::IsNullOrWhiteSpace($rel)) { throw "$what 里有空路径" }
    if ($rel.Contains('..')) { throw "$what 路径含 ..：$rel" }
    if ([IO.Path]::IsPathRooted($rel)) { throw "$what 路径是绝对路径：$rel" }
    $top = ($rel -replace '\\\\', '/').Split('/')[0]
    if ($protected -contains $top) { throw "$what 命中受保护路径（运行时数据，绝不碰）：$rel" }
  }

  # ---- 3. 先全部落成 .ql-new（此时**原文件一个都没动**）----
  $pending = @()
  $filesRoot = Join-Path $stage 'files'
  foreach ($w in @($plan.writes)) {
    Assert-Safe $w.path '写入清单'
    $src = Join-Path $filesRoot ($w.path -replace '/', '\\')
    $dst = Join-Path $prog ($w.path -replace '/', '\\')
    if (-not (Test-Path -LiteralPath $src)) { throw "暂存文件不存在：$($w.path)" }
    $h = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $w.sha256) { throw "暂存文件校验失败：$($w.path)" }
    $tmp = "$dst.ql-new"
    $parent = Split-Path -Parent $tmp
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item -LiteralPath $src -Destination $tmp -Force
    $pending += [pscustomobject]@{ Tmp = $tmp; Dst = $dst; Rel = $w.path; Size = [int64]$w.size; Exe = ($w.path -match '\\.exe$') }
  }

  # ---- 4. 原子替换：非 exe 先（按体积从小到大），exe 最后 ----
  $order = @($pending | Where-Object { -not $_.Exe } | Sort-Object Size) +
           @($pending | Where-Object { $_.Exe }     | Sort-Object Size)
  foreach ($p in $order) {
    Move-Item -LiteralPath $p.Tmp -Destination $p.Dst -Force
    Log "已替换 $($p.Rel)"
  }

  # ---- 5. 删掉新版本已经没有的文件（受保护路径在 Assert-Safe 里一律拒绝）----
  foreach ($d in @($plan.deletes)) {
    Assert-Safe $d '删除清单'
    $abs = Join-Path $prog ($d -replace '/', '\\')
    if (Test-Path -LiteralPath $abs) { Remove-Item -LiteralPath $abs -Force; Log "已删除 $d" }
  }

  # ---- 6. 收尾自检：写进去的东西必须和计划里的哈希对得上 ----
  $bad = 0
  foreach ($p in $pending) {
    if (-not (Test-Path -LiteralPath $p.Dst)) { $bad++; Log "收尾自检：$($p.Rel) 不见了"; continue }
    $h = (Get-FileHash -LiteralPath $p.Dst -Algorithm SHA256).Hash.ToLower()
    $want = ($plan.writes | Where-Object { $_.path -eq $p.Rel }).sha256
    if ($h -ne $want) { $bad++; Log "收尾自检：$($p.Rel) 哈希不符" }
  }
  if ($bad -gt 0) { throw "收尾自检有 $bad 个文件不符" }

  SaveState 'applied' ''
  Log "更新完成：$($plan.from) -> $($plan.to)"
  # 日志留一份到 .update/ 下面（stage 目录整个删掉也不丢线索）
  try {
    Copy-Item -LiteralPath $logFile -Destination (Join-Path (Split-Path -Parent $stage) ('apply-' + $plan.to + '.log')) -Force
  } catch { }
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue

  # ---- 7. 需要的话把新版拉起来 ----
  if ($restart -and $appExe -and (Test-Path -LiteralPath $appExe)) {
    Log '重新启动'
    Start-Process -FilePath $appExe
  }
  exit 0
} catch {
  $msg = $_.Exception.Message
  Log "失败：$msg"
  if ($null -ne $plan) { SaveState 'failed' $msg } else { SaveState 'failed' 'plan' }
  # 收尾：把没来得及换上去的 .ql-new 清掉，免得留下垃圾让用户以为更新成功了
  try { Get-ChildItem -LiteralPath $prog -Recurse -Filter '*.ql-new' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue } catch { }
  exit 4
}
`;
}

/** `-EncodedCommand` 要的是 UTF-16LE 的 base64 —— 这是明文规定的编码，不看控制台代码页。 */
function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/** 组装 spawn 参数（纯函数，便于断言"没走写脚本文件那条路"）。 */
function spawnArgs(script) {
  return [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodeCommand(script),
  ];
}

module.exports = { buildApplyScript, encodeCommand, spawnArgs, psQuote };

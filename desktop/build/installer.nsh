; ============================================================
; QuickLaunch 数据保护（覆盖安装保留 data，手动卸载才删 data）
; ============================================================
; 背景：本项目「数据随程序走」，用户数据（含一键整理快照）都在
; <安装目录>\data\ 里（快照在 data\backup\，随 data 一起保护）。
; electron-builder 的 NSIS 覆盖安装会先卸载旧版，旧卸载器执行
;   RMDir /r $INSTDIR
; 把整个安装目录（连同 data\）一起删掉。deleteAppDataOnUninstall
; 只保护 %APPDATA%，对程序目录里的 data\ 完全无效 → 数据永久丢失。
;
; 目标（用户原话「覆盖安装不要动，只有删除软件才删」）：
;   - 覆盖安装（升级）：data\ 原地保留，绝不丢。
;   - 手动卸载（真删软件）：data\ 连同程序一起删掉。
;
; 区分两者靠 electron-builder 的运行时标志 ${isUpdated}：
;   - 覆盖安装时，安装器把「旧卸载器」以 --updated 参数调起 → ${isUpdated}=true；
;   - 手动卸载时，卸载器不带 --updated → ${isUpdated}=false。
;   （${isUpdated} 由 StdUtils.TestParameter "updated" 在运行时判命令行，见
;   templates/nsis/include/installUtil.nsh 与生成的 builder-debug.yml。）
;
; 实现「覆盖安装保留 data」用的是「先挪走 → 删其余 → 再挪回」：
;   为什么不「直接跳过 data 不删」？NSIS 删除目录只有 RMDir /r（整目录递归删），
;   无法"排除"某个子目录；要真跳过只能手写 FindFirst/FindNext 逐个枚举删除，
;   代码长、边界多（隐藏/只读/文件占用/深层路径），漏删会留垃圾、删错更危险。
;   而「挪走再挪回」两次 Rename 是原子、同盘、毫秒级，最终 data 还在原位，
;   效果与「跳过不删」完全一致，却复用 electron-builder 成熟的删除逻辑，最稳。
;   唯一的极小窗口：若安装在「挪走之后、挪回之前」崩溃，data 会停在同级
;   QuickLaunch.data.bak —— 下次 customInit 会先把它挪到 .bak.prev 保全、
;   再继续，绝不丢弃（见 qlPreserveData）。
;
; 三个钩子（electron-builder 原生支持，见 templates/nsis/*.nsh）：
;   customInit      —— 安装器 onInit、卸载旧版之前跑：只要 data\ 存在就挪到
;                      QuickLaunch.data.bak 保护。★ 这是保住「旧版卸载器还没有
;                      保护逻辑」这一最危险过渡期（v2.0.9 及更早 → v2.0.10+）
;                      的关键：旧卸载器无法修改，只能靠新安装器在它运行前先抢救。
;   customUnInstall —— 卸载器删文件之前跑：★ 仅覆盖安装（${isUpdated}）才挪走
;                      保护；手动卸载时不动 data\，让它随 RMDir /r 一起删掉。
;   customInstall   —— 新版装完后跑：把 .bak 挪回 <安装目录>\data\。
; ============================================================

!macro qlPreserveData
  ; 只有真的存在 data\ 才动手（全新安装没有，直接跳过）
  IfFileExists "$INSTDIR\data\*.*" 0 qlPreserveDone
    ; 极端情况：上一次覆盖安装中断，同级已残留 .bak（里面是用户上次的数据）
    ; → 先挪到 .bak.prev 保全，绝不用 RMDir 直接删掉它
    IfFileExists "$INSTDIR\..\QuickLaunch.data.bak\*.*" 0 qlDoRename
      RMDir /r "$INSTDIR\..\QuickLaunch.data.bak.prev"
      Rename "$INSTDIR\..\QuickLaunch.data.bak" "$INSTDIR\..\QuickLaunch.data.bak.prev"
    qlDoRename:
    Rename "$INSTDIR\data" "$INSTDIR\..\QuickLaunch.data.bak"
  qlPreserveDone:
!macroend

!macro qlRestoreData
  ; 卸载阶段保护过 data\，装完新版后挪回原位
  IfFileExists "$INSTDIR\..\QuickLaunch.data.bak\*.*" 0 qlRestoreDone
    RMDir /r "$INSTDIR\data"
    Rename "$INSTDIR\..\QuickLaunch.data.bak" "$INSTDIR\data"
  qlRestoreDone:
!macroend

!macro customInit
  !insertmacro qlPreserveData
!macroend

!macro customUnInstall
  ; ★ 覆盖安装（卸载器带 --updated）才保护 data；手动卸载不保护，
  ;   让 data 随默认 RMDir /r $INSTDIR 一起删掉（=「删除软件才删 data」）
  ${if} ${isUpdated}
    !insertmacro qlPreserveData
  ${endif}
!macroend

!macro customInstall
  !insertmacro qlRestoreData
!macroend

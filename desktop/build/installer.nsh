; ============================================================
; QuickLaunch 数据保护（覆盖安装 / 卸载都不丢 data）
; ============================================================
; 背景：本项目「数据随程序走」，用户数据放在 <安装目录>\data\。
; electron-builder 的 NSIS 覆盖安装会先卸载旧版，旧卸载器执行
;   RMDir /r $INSTDIR
; 把整个安装目录（连同 data\）一起删掉。deleteAppDataOnUninstall
; 只保护 %APPDATA%，对程序目录里的 data\ 完全无效 → 用户数据永久丢失。
;
; 三个钩子（electron-builder 原生支持，见 templates/nsis/*.nsh）：
;   customInit      —— 安装器 onInit 里、卸载旧版之前跑：先把 data\
;                      挪到安装目录同级 QuickLaunch.data.bak。
;                      ★ 这是保住「旧版卸载器还没有保护逻辑」这一最危险
;                      过渡期（v2.0.9 及更早 → v2.0.10+）的关键：旧卸载器
;                      由我们无法修改，只能靠新安装器在它运行前先把数据挪走。
;   customUnInstall —— 卸载器删文件之前跑：同样挪 data\（覆盖手动卸载、
;                      以及以后「我方卸载器」被调用时的场景）。
;   customInstall   —— 新版装完后跑：把 .bak 挪回 <安装目录>\data\。
;
; 语义保证：任何时候都不删除用户数据，只「挪位置」；最坏情况数据停在
; QuickLaunch.data.bak（或 .bak.prev），可手动找回。
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
  !insertmacro qlPreserveData
!macroend

!macro customInstall
  !insertmacro qlRestoreData
!macroend

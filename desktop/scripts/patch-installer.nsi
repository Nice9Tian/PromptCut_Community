; PromptCut 更新补丁的自解压外壳。
;
; 用户拿到的是一个 exe，双击就装。这里不重复实现更新逻辑 —— 逻辑都在
; apply-patch.ps1 里（那份已经在真实安装目录的副本上验证过）。本脚本只做两件事：
; 把补丁内容解到临时目录，然后把 apply-patch.ps1 跑起来并等它结束。
;
; 用 $PLUGINSDIR 存放解出来的内容：NSIS 在进程退出时（含中途被杀）自动清掉它，
; 不会在用户的 %TEMP% 里留下几百 MB 的残骸。
;
; 由 make-patch.mjs 调用：
;   makensis -DVERSION=0.2.3 -DSRCDIR=<补丁目录> -DOUTFILE=<输出exe> -DICON=<ico> patch-installer.nsi

Unicode true
Name "PromptCut 更新补丁 ${VERSION}"
OutFile "${OUTFILE}"
Icon "${ICON}"

; 更新写的是 %LOCALAPPDATA%，要管理员权限反而会让 UAC 白弹一次，
; 而且提权后 $LOCALAPPDATA 会指向管理员账户，找不到用户装的那一份。
RequestExecutionLevel user

; 没有向导页：这个 exe 的界面就是 apply-patch.ps1 的控制台窗口，
; 免得用户先点三下「下一步」再看一遍同样的进度。
SilentInstall silent

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "PromptCut 更新补丁"
VIAddVersionKey "FileDescription" "PromptCut ${VERSION} 更新补丁"
VIAddVersionKey "FileVersion" "${VERSION}.0"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "PromptCut"

!include "FileFunc.nsh"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\patch"
  File /r "${SRCDIR}\*.*"

  ; exe 自己的命令行原样转给脚本，这样装在非默认位置的用户仍然可以
  ;   PromptCut-patch-x.y.z.exe -InstallDir "D:\PromptCut"
  ; 也方便先 -WhatIf 只检查不写入。
  ${GetParameters} $R0

  ; 传 -Force：双击进来的用户没有别的途径确认「可以关掉正在运行的 PromptCut」，
  ; 在这里再弹一个窗口问反而啰嗦。apply-patch.ps1 只会关掉可执行文件在目标
  ; 安装目录下的那些进程，不会误伤别处装的或开发中跑的。
  ; 非交互验证沿用脚本已有的环境开关，整条命令链不弹控制台。
  ReadEnvStr $R1 "PROMPTCUT_PATCH_NONINTERACTIVE"
  StrCmp $R1 "" interactive
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\patch\apply-patch.ps1" -Force $R0'
    Pop $0
    Pop $R1
    StrCmp $0 "error" failed
    StrCmp $0 "timeout" failed
    Goto finished
  interactive:
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\patch\apply-patch.ps1" -Force $R0' $0
    Goto finished
  failed:
    StrCpy $0 1
  finished:
  SetErrorLevel $0
SectionEnd

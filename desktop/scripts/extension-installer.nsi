; PromptCut 拓展库包的自解压外壳。
;
; 和补丁那个壳同一套路：解到 $PLUGINSDIR（NSIS 退出时自动清掉，不会在 %TEMP%
; 留下几百 MB 的 wheel），然后跑 apply-extension.ps1。
;
; 装的是可选能力，落点是用户自己的 %LOCALAPPDATA% 和 %APPDATA%，不需要管理员；
; 提权反而会让这两个路径指向管理员账户，装了也白装。
;
; 由 make-extension.mjs 调用：
;   makensis -DVERSION=1.0.0 -DLABEL=镜头识别 -DSRCDIR=<目录> -DOUTFILE=<exe> -DICON=<ico>

Unicode true
Name "PromptCut ${LABEL} 拓展 ${VERSION}"
OutFile "${OUTFILE}"
Icon "${ICON}"
RequestExecutionLevel user

; 没有向导页：界面就是 apply-extension.ps1 的控制台窗口
SilentInstall silent

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "PromptCut ${LABEL} 拓展"
VIAddVersionKey "FileDescription" "PromptCut ${LABEL} 拓展库 ${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}.0"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "PromptCut"

!include "FileFunc.nsh"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\ext"
  File /r "${SRCDIR}\*.*"

  ; exe 的命令行原样转给脚本：装在非默认位置的用户可以 -InstallDir，
  ; 想先看看会做什么可以 -WhatIf。
  ${GetParameters} $R0

  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\ext\apply-extension.ps1" $R0' $0
  SetErrorLevel $0
SectionEnd

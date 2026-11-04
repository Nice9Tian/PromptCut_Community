; Self-extracting shell of the PromptCut extension pack.
;
; Same approach as the patch shell: extract to $PLUGINSDIR (NSIS cleans it up automatically on exit, so it will not leave
; hundreds of MB of wheels in %TEMP%), then run apply-extension.ps1.
;
; What gets installed is an optional capability whose destination is the user's own %LOCALAPPDATA% and %APPDATA%, so administrator rights are not needed;
; elevating would instead make these two paths point to the administrator account, and the install would be for nothing.
;
; Invoked by make-extension.mjs:
;   makensis -DVERSION=1.0.0 -DLABEL="Shot detection" -DSRCDIR=<dir> -DOUTFILE=<exe> -DICON=<ico>

Unicode true
Name "PromptCut ${LABEL} extension ${VERSION}"
OutFile "${OUTFILE}"
Icon "${ICON}"
RequestExecutionLevel user

; No wizard pages: the UI is the console window of apply-extension.ps1
SilentInstall silent

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "PromptCut ${LABEL} extension"
VIAddVersionKey "FileDescription" "PromptCut ${LABEL} extension library ${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}.0"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "PromptCut"

!include "FileFunc.nsh"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\ext"
  File /r "${SRCDIR}\*.*"

  ; The exe's command line is passed to the script as is: users who installed in a non-default location can use -InstallDir,
  ; and those who want to see first what it would do can use -WhatIf.
  ${GetParameters} $R0

  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\ext\apply-extension.ps1" $R0' $0
  SetErrorLevel $0
SectionEnd

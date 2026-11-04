; Self-extracting shell of the PromptCut update patch.
;
; What the user gets is a single exe; double-click to install. The update logic is not re-implemented here: it all lives in
; apply-patch.ps1 (that copy has already been verified on a copy of a real install directory). This script does only two things:
; extract the patch contents to a temporary directory, then run apply-patch.ps1 and wait for it to finish.
;
; Use $PLUGINSDIR to hold the extracted contents: NSIS cleans it up automatically when the process exits (including when killed midway),
; so no hundreds of MB of debris are left in the user's %TEMP%.
;
; Invoked by make-patch.mjs:
;   makensis -DVERSION=0.2.3 -DSRCDIR=<patch-dir> -DOUTFILE=<output-exe> -DICON=<ico> patch-installer.nsi

Unicode true
Name "PromptCut update patch ${VERSION}"
OutFile "${OUTFILE}"
Icon "${ICON}"

; The update writes to %LOCALAPPDATA%, so requiring administrator rights would only make UAC pop up for nothing,
; and after elevation $LOCALAPPDATA would point to the administrator account and could not find the copy the user installed.
RequestExecutionLevel user

; No wizard pages: the UI of this exe is the console window of apply-patch.ps1,
; so users do not have to click "Next" three times and then watch the same progress again.
SilentInstall silent

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "PromptCut update patch"
VIAddVersionKey "FileDescription" "PromptCut ${VERSION} update patch"
VIAddVersionKey "FileVersion" "${VERSION}.0"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "PromptCut"

!include "FileFunc.nsh"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\patch"
  File /r "${SRCDIR}\*.*"

  ; The exe's own command line is passed to the script as is, so users who installed in a non-default location can still
  ;   PromptCut-patch-x.y.z.exe -InstallDir "D:\PromptCut"
  ; and it is also convenient to run -WhatIf first, which only checks and writes nothing.
  ${GetParameters} $R0

  ; Pass -Force: a user who arrives by double-clicking has no other way to confirm "it is OK to close the running PromptCut",
  ; and popping up yet another dialog here would just be wordy. apply-patch.ps1 only closes the processes whose executable is under the target
  ; install directory, so it will not hit copies installed elsewhere or running in development by mistake.
  ; Non-interactive verification reuses the script's existing environment switch, so the whole command chain opens no console.
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

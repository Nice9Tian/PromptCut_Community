; NSIS install/uninstall hooks for PromptCut
;
; ── Why processes are killed first at install time ────────────────────────────────────────────────
;
; The error looks like this: "Extract: error writing to file runtime\ffmpeg\ffmpeg.exe", and uninstalling and reinstalling does not help either.
; The cause is a path that is **inevitably** taken, not an occasional fluke:
;
;   1. Tauri's template only recognizes the main program, `CheckIfAppIsRunning "PromptCut.exe"`; if it finds it running, it
;      shows a dialog and then force-kills it with `KillProcessCurrentUser`;
;   2. The force kill goes through TerminateProcess, so the process never gets a chance to run cleanup code. And the shell's cleanup of the Node sidecar
;      and the chain of ffmpeg / chrome underneath it happens only on the **normal exit** path
;      (RunEvent::ExitRequested | Exit → kill_sidecar_tree in lib.rs);
;   3. So the main program is gone, but the sidecar and ffmpeg all become orphans: still alive, still holding on to
;      the file handle of `runtime\ffmpeg\ffmpeg.exe` (on Windows a process locks its own image file);
;   4. The installer is denied when it writes to that file → that is the error above.
;
; Why uninstalling and reinstalling does not help: the uninstaller uses the same `CheckIfAppIsRunning` and likewise ignores orphans;
; files that cannot be deleted during uninstall are marked `/REBOOTOK` and left until the next reboot. So those orphans were never killed at any point,
; and reinstalling runs into exactly the same problem again. Only a reboot (or killing them manually) can undo it.
;
; ── Why kill by path, not by process name ─────────────────────────────────────────────
;
; `taskkill /IM ffmpeg.exe` and the like would also kill the ffmpeg the user is running themselves, and node.exe and
; chrome.exe must not be touched at all: dev machines are full of them. So we kill only the ones **installed in this install directory**:
; the sidecar `node.exe` in the root, and everything under `runtime\` (ffmpeg, ffprobe, the bundled Chrome).
;
; Deliberately **do not touch** `$INSTDIR\cli\`: CLI hosting installs Claude Code / Codex / agy there
; (setupRoot in server/runners/cli-runtime.mjs), and the user may have an agent session open.
; Also **do not touch** `promptcut.exe`; that is left to Tauri's own prompt dialog, so the decision "whether to close the software in use"
; is not taken away from the user.
;
; The cost, stated plainly: if the user launches the installer with the software open and then clicks cancel on the prompt dialog, the window they left open will, because
; the sidecar has already been killed, become an empty shell and must be reopened once. Compared with "cannot install, and never can without a reboot", this trade is worth it.

; A file that cannot be written must make the whole install fail, not be skipped.
;
; NSIS defaults to AllowSkipFiles on: in UI mode it shows an "error writing to file" box, and in silent mode (/S) it
; **silently skips the file and keeps installing**, and finally still reports exit code 0. Tested: with an orphan ffmpeg locking
; runtime\ffmpeg\ffmpeg.exe, the silent install finished with exit code 0, yet the modification time of that file was still the previous version's:
; what gets installed is an app that "looks installed but is actually missing a few files", which is harder to diagnose than a failed install.
; With it turned off the two paths are unified: a file that cannot be written aborts the install, so .onInstFailed takes over and produces the diagnostic report.
AllowSkipFiles off

; Write the process-killing work as a temporary ps1 and run that, rather than cramming PowerShell code into the nsExec command line:
; the quotes on the two sides would clash, and this script is full of $ and quotes.
;
; **The process list must go through WMI (Get-CimInstance Win32_Process), not Get-Process.**
; NSIS is a 32-bit program, and the PowerShell it starts is 32-bit too; a 32-bit process **cannot read the
; Process.Path of a 64-bit process**: that property is backed by MainModule, enumerating modules across bitness fails, and together with
; SilentlyContinue it silently returns $null, so every process is skipped as "path unknown",
; none gets killed, and the script still exits with code 0.
; This pitfall is only visible when you actually run the installer: tested by hand with 64-bit PowerShell, it works fine.
; The WMI route is provided by the kernel and is not affected by WOW64.
!macro PC_WRITE_KILLER
  InitPluginsDir
  FileOpen $9 "$PLUGINSDIR\pc-kill-leftovers.ps1" w
  FileWrite $9 "param([string]$$Dir)$\r$\n"
  FileWrite $9 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $9 "if (-not $$Dir) { exit 0 }$\r$\n"
  ; everything under runtime\ + the sidecar node.exe in the root
  FileWrite $9 "$$runtime = [System.IO.Path]::Combine($$Dir, 'runtime') + [System.IO.Path]::DirectorySeparatorChar$\r$\n"
  FileWrite $9 "$$sidecar = [System.IO.Path]::Combine($$Dir, 'node.exe')$\r$\n"
  FileWrite $9 "$$cmp = [System.StringComparison]::OrdinalIgnoreCase$\r$\n"
  FileWrite $9 "foreach ($$proc in Get-CimInstance Win32_Process) {$\r$\n"
  FileWrite $9 "  $$path = $$proc.ExecutablePath$\r$\n"
  FileWrite $9 "  if (-not $$path) { continue }$\r$\n"
  FileWrite $9 "  if ($$path.Equals($$sidecar, $$cmp) -or $$path.StartsWith($$runtime, $$cmp)) {$\r$\n"
  FileWrite $9 "    Write-Output ('kill ' + $$proc.ProcessId + ' ' + $$path)$\r$\n"
  FileWrite $9 "    Stop-Process -Id $$proc.ProcessId -Force$\r$\n"
  FileWrite $9 "  }$\r$\n"
  FileWrite $9 "}$\r$\n"
  FileClose $9
!macroend

; Our own lines follow the installer's language, which NSIS picks from the system
; (tauri.conf.json bundle.windows.nsis.languages): 2052 Simplified Chinese, 1041 Japanese, otherwise English.
!macro PC_PICK out en zh ja
  StrCpy ${out} "${en}"
  StrCmp $LANGUAGE 2052 0 +2
  StrCpy ${out} "${zh}"
  StrCmp $LANGUAGE 1041 0 +2
  StrCpy ${out} "${ja}"
!macroend

!macro PC_KILL_LEFTOVERS
  !insertmacro PC_WRITE_KILLER
  !insertmacro PC_PICK $R9 "Cleaning up processes left over from the last run…" "清理上一次运行残留的进程…" "前回の実行で残ったプロセスを片付けています…"
  DetailPrint "$R9"
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\pc-kill-leftovers.ps1" -Dir "$INSTDIR"'
  Pop $0
  ; After killing, give the kernel a moment to reclaim the file handles, otherwise the write that follows is still denied
  Sleep 800
!macroend

; ── Self-service check after a failed install ──────────────────────────────────────────────────────
;
; The message NSIS reports, "Extract: error writing to file xxx", cannot tell the cause: it may be an orphan process left over from the last run
; holding the file, antivirus software may have blocked ffmpeg (a common false-positive target), or it may be a full disk or permissions.
; The three have completely different fixes, and asking the user cannot reveal which. So on failure ask once and let the machine look for itself,
; capturing the state as a text file saved to the desktop.
;
; The report script lives separately in report.ps1 (not stuffed in here line by line via FileWrite), so it can be run and verified on its own.
; `${__FILEDIR__}` is the directory of this file: the generated installer.nsi is under target,
; so a relative path would look in the wrong place.
!macro PC_DIAG_REPORT phase
  ; A silent install (/S) shows no dialog and writes the report directly: nobody on that path can click "Yes", and unattended runs are exactly where
  ; it matters most to leave the evidence behind. Only ask when someone is watching; do not put files on people's desktops uninvited.
  IfSilent pc_diag_go_${phase} 0
  !insertmacro PC_PICK $R9 "PromptCut could not finish installing this time.$\r$\n$\r$\nCheck the cause now and save a diagnostic report to the desktop?$\r$\nThe report contains information such as process locks, antivirus blocks and disk space, and no keys of any kind." "PromptCut 这次没能装完。$\r$\n$\r$\n要现在检查一下原因、把诊断报告存到桌面吗?$\r$\n报告里是进程占用、杀毒拦截、磁盘空间这些信息,不含任何密钥。" "PromptCut のインストールを完了できませんでした。$\r$\n$\r$\n今すぐ原因を調べて、診断レポートをデスクトップに保存しますか？$\r$\nレポートにはプロセスのロック、ウイルス対策ソフトによるブロック、ディスクの空き容量などの情報が入り、鍵の類は一切含まれません。"
  MessageBox MB_YESNO|MB_ICONQUESTION "$R9" IDNO pc_diag_skip_${phase}
  pc_diag_go_${phase}:
    InitPluginsDir
    File "/oname=$PLUGINSDIR\pc-report.ps1" "${__FILEDIR__}\report.ps1"
    StrCpy $8 "$DESKTOP\PromptCut-install-diagnostics.txt"
    !insertmacro PC_PICK $R9 "Checking…" "正在检查…" "確認しています…"
    DetailPrint "$R9"
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\pc-report.ps1" -Dir "$INSTDIR" -Out "$8" -Phase "${phase}"'
    Pop $0
    !insertmacro PC_PICK $R9 "Diagnostic report: $8 (exit code $0)" "诊断报告: $8 (退出码 $0)" "診断レポート: $8（終了コード $0）"
    DetailPrint "$R9"
    IfSilent pc_diag_skip_${phase} 0
    ${If} $0 == 0
      !insertmacro PC_PICK $R9 "Report saved to the desktop:$\r$\n$8$\r$\n$\r$\nClick OK to open it. Send this file to the developers and they can pinpoint the problem." "报告已存到桌面:$\r$\n$8$\r$\n$\r$\n点确定会打开它。把这个文件发给开发者就能定位问题。" "レポートをデスクトップに保存しました:$\r$\n$8$\r$\n$\r$\nOK を押すと開きます。このファイルを開発者に送ると原因を特定できます。"
      MessageBox MB_OK|MB_ICONINFORMATION "$R9"
      ExecShell "open" "$8"
    ${Else}
      !insertmacro PC_PICK $R9 "The check could not run (PowerShell exit code $0).$\r$\nYou can send the developers a screenshot of the content under 'Show details' in the installer window." "检查没能跑起来(PowerShell 退出码 $0)。$\r$\n可以把安装界面里「显示详细信息」的内容截图发给开发者。" "確認を実行できませんでした（PowerShell 終了コード $0）。$\r$\nインストーラー画面の「詳細を表示」の内容をスクリーンショットにして開発者に送ってください。"
      MessageBox MB_OK|MB_ICONEXCLAMATION "$R9"
    ${EndIf}
  pc_diag_skip_${phase}:
!macroend

; SetErrorLevel 2: NSIS exits with 0 by default whether it succeeds or fails. A silent install (/S) is driven by scripts,
; and the exit code is the only result they get: reporting 0 on failure would make batch deployment think the install worked.
; 2 is the NSIS convention for "install failed".
Function .onInstFailed
  SetErrorLevel 2
  !insertmacro PC_DIAG_REPORT "install"
FunctionEnd

Function un.onUninstFailed
  SetErrorLevel 2
  !insertmacro PC_DIAG_REPORT "uninstall"
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  !insertmacro PC_KILL_LEFTOVERS
!macroend

; The same goes for uninstall: if these are not killed first, the locked files in `runtime\` cannot be deleted and can only be marked /REBOOTOK and left until reboot,
; so when the user "uninstalls and then installs again" they run into the very same batch of orphans.
;
; The lines below delete only build-time caches (generated by vite/rolldown at runtime); do not delete the whole runtime/ tree:
; the user may have put their own things in it. Also do not touch pylibs / models under %APPDATA%,
; those are the engines and models the user downloaded, and only the menu's "Reset Python libraries" should clear them.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro PC_KILL_LEFTOVERS
  RMDir /r "$INSTDIR\runtime\app\node_modules\.vite"
  RMDir /r "$INSTDIR\runtime\app\node_modules\.vite-temp"
  RMDir /r "$INSTDIR\runtime\app\dist"
  RMDir /r "$INSTDIR\runtime\app\out"
!macroend

; NSIS install/uninstall hooks for PromptCut
;
; ── 装的时候为什么要先杀进程 ────────────────────────────────────────────────
;
; 报错长这样:「抽取: 无法写入文件 runtime\ffmpeg\ffmpeg.exe」,而且卸载重装也不好使。
; 原因是一条**必然**会走到的路,不是偶发:
;
;   1. Tauri 的模板只认主程序 —— `CheckIfAppIsRunning "PromptCut.exe"`,发现它在跑就
;      弹框、然后 `KillProcessCurrentUser` 强杀;
;   2. 强杀走的是 TerminateProcess,进程根本没有机会跑收尾代码。而外壳清理 Node sidecar
;      和它底下那串 ffmpeg / chrome,只发生在**正常退出**那条路上
;      (lib.rs 的 RunEvent::ExitRequested | Exit → kill_sidecar_tree);
;   3. 于是主程序没了,sidecar 和 ffmpeg 全成了孤儿,还活着,还攥着
;      `runtime\ffmpeg\ffmpeg.exe` 这个文件句柄 —— Windows 上一个进程会锁住自己的映像文件;
;   4. 安装器写到那个文件时被拒 → 就是上面那句报错。
;
; 卸载重装为什么没用:卸载器用的是同一个 `CheckIfAppIsRunning`,一样不管孤儿;
; 卸载时删不掉的文件会挂 `/REBOOTOK` 留到下次重启。所以那些孤儿从头到尾没死过,
; 重装再撞一次,一模一样。只有重启(或者手动杀掉)才解得开。
;
; ── 为什么按路径杀,不按进程名杀 ─────────────────────────────────────────────
;
; `taskkill /IM ffmpeg.exe` 之类会连用户自己在跑的 ffmpeg 一起杀掉,node.exe 和
; chrome.exe 更是不能碰 —— 开发机上遍地都是。所以只杀**装在这个安装目录里**的那几个:
; 根目录的 sidecar `node.exe`,以及 `runtime\` 底下的一切(ffmpeg、ffprobe、随包的 Chrome)。
;
; 特意**不碰** `$INSTDIR\cli\` —— CLI 托管把 Claude Code / Codex / agy 装在那儿
; (server/runners/cli-runtime.mjs 的 setupRoot),用户可能正开着一个 agent 会话。
; 也**不碰** `promptcut.exe`,那个留给 Tauri 自己那道询问框,别把「要不要关掉正在用的软件」
; 这个决定从用户手里抢走。
;
; 代价说清楚:如果用户开着软件启动安装器、又在询问框上点了取消,他那个还开着的窗口会因为
; sidecar 已经被杀而变成空壳,得重开一次。相比「装不上,而且不重启就永远装不上」,这个换得值。

; 写不进去的文件必须让整个安装失败,不许跳过。
;
; NSIS 默认 AllowSkipFiles on:界面模式下弹一个「无法写入文件」的框,静默模式(/S)则
; **一声不吭跳过这个文件继续装**,最后还报退出码 0。实测过:拿一个孤儿 ffmpeg 锁住
; runtime\ffmpeg\ffmpeg.exe,静默装完退出码是 0,而那个文件的修改时间还是上一版的 ——
; 装出来的是一个「看起来装好了、其实少了几个文件」的应用,比装不上更难查。
; 关掉之后两条路统一:写不进去就中止,于是 .onInstFailed 接管、出诊断报告。
AllowSkipFiles off

; 把杀进程的活写成一个临时 ps1 再跑,而不是把 PowerShell 代码塞进 nsExec 的命令行 ——
; 那样两边的引号会打架,而这段脚本里全是 $ 和引号。
;
; **进程列表必须走 WMI(Get-CimInstance Win32_Process),不能用 Get-Process。**
; NSIS 是 32 位程序,它起的 PowerShell 也是 32 位;而 32 位进程**读不到 64 位进程的
; Process.Path** —— 那个属性底下是 MainModule,跨位数枚举模块会失败,配上
; SilentlyContinue 就静悄悄返回 $null,于是每个进程都被当成「路径不明」跳过,
; 一个都杀不掉,脚本还照样退出码 0。
; 这个坑只有把安装包真的装一遍才看得见:手动用 64 位 PowerShell 测,它是好的。
; WMI 那条路由内核提供,不受 WOW64 影响。
!macro PC_WRITE_KILLER
  InitPluginsDir
  FileOpen $9 "$PLUGINSDIR\pc-kill-leftovers.ps1" w
  FileWrite $9 "param([string]$$Dir)$\r$\n"
  FileWrite $9 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $9 "if (-not $$Dir) { exit 0 }$\r$\n"
  ; runtime\ 底下的一切 + 根目录那个 sidecar node.exe
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

!macro PC_KILL_LEFTOVERS
  !insertmacro PC_WRITE_KILLER
  DetailPrint "清理上一次运行残留的进程…"
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\pc-kill-leftovers.ps1" -Dir "$INSTDIR"'
  Pop $0
  ; 杀完给内核一点时间把文件句柄收走,不然紧接着的写入还是会被拒
  Sleep 800
!macroend

; ── 装失败之后的自助检查 ──────────────────────────────────────────────────
;
; NSIS 报出来的那句「抽取: 无法写入文件 xxx」分不出原因 —— 可能是上次运行留下的孤儿进程
; 锁着文件,可能是杀毒软件把 ffmpeg 拦了(它是常见误报对象),也可能是磁盘满或者权限。
; 三种的解法完全不同,而这些靠问用户是问不出来的。所以失败时问一句、让机器自己去看,
; 把现场抓成一个文本文件存到桌面。
;
; 报告脚本单独放在 report.ps1(不塞进这里逐行 FileWrite),这样它能被单独运行、单独验证。
; `${__FILEDIR__}` 是本文件所在目录 —— 生成出来的 installer.nsi 在 target 底下,
; 用相对路径会找错地方。
!macro PC_DIAG_REPORT phase
  ; 静默安装(/S)不弹框,直接出报告 —— 那条路上没人能点「是」,而恰恰是无人值守的场合
  ; 更需要留下现场。有人看着的时候才问一句,别擅自往人家桌面上放文件。
  IfSilent pc_diag_go_${phase} 0
  MessageBox MB_YESNO|MB_ICONQUESTION "PromptCut 这次没能装完。$\r$\n$\r$\n要现在检查一下原因、把诊断报告存到桌面吗?$\r$\n报告里是进程占用、杀毒拦截、磁盘空间这些信息,不含任何密钥。" IDNO pc_diag_skip_${phase}
  pc_diag_go_${phase}:
    InitPluginsDir
    File "/oname=$PLUGINSDIR\pc-report.ps1" "${__FILEDIR__}\report.ps1"
    StrCpy $8 "$DESKTOP\PromptCut-安装诊断.txt"
    DetailPrint "正在检查…"
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\pc-report.ps1" -Dir "$INSTDIR" -Out "$8" -Phase "${phase}"'
    Pop $0
    DetailPrint "诊断报告: $8 (退出码 $0)"
    IfSilent pc_diag_skip_${phase} 0
    ${If} $0 == 0
      MessageBox MB_OK|MB_ICONINFORMATION "报告已存到桌面:$\r$\n$8$\r$\n$\r$\n点确定会打开它。把这个文件发给开发者就能定位问题。"
      ExecShell "open" "$8"
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "检查没能跑起来(PowerShell 退出码 $0)。$\r$\n可以把安装界面里「显示详细信息」的内容截图发给开发者。"
    ${EndIf}
  pc_diag_skip_${phase}:
!macroend

; SetErrorLevel 2:NSIS 默认无论成败都退出 0。静默安装(/S)是脚本在调,
; 退出码是它唯一能拿到的结果 —— 失败了还报 0,批量部署那边会以为装好了。
; 2 是 NSIS 约定的「安装失败」。
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

; 卸载同理:不先杀掉这些,`runtime\` 里锁着的文件删不掉,只能挂 /REBOOTOK 留到重启,
; 于是用户「卸载完再装一次」时撞见的还是同一批孤儿。
;
; 下面几条只删构建期缓存(vite/rolldown 运行时生成的),不要整棵删 runtime/ ——
; 用户可能往里放过自己的东西。也不要碰 %APPDATA% 下的 pylibs / models,
; 那是用户下载的引擎和模型,只有菜单里的「重置 Python 库」才该清。
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro PC_KILL_LEFTOVERS
  RMDir /r "$INSTDIR\runtime\app\node_modules\.vite"
  RMDir /r "$INSTDIR\runtime\app\node_modules\.vite-temp"
  RMDir /r "$INSTDIR\runtime\app\dist"
  RMDir /r "$INSTDIR\runtime\app\out"
!macroend

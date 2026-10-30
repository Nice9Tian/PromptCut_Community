# PromptCut 安装诊断报告
#
# 安装/卸载失败之后由安装器调起(见 hooks.nsh 的 .onInstFailed),把「为什么写不进去」
# 这件事需要的现场一次性抓齐,存成一个文本文件让用户发回来。
#
# 为什么要有这个:最典型的失败是「抽取: 无法写入文件 runtime\ffmpeg\ffmpeg.exe」,
# 而这句话本身分不出是哪种原因 —— 可能是上一次运行留下的孤儿进程锁着文件,
# 可能是杀毒软件把 ffmpeg 拦了(它是常见误报对象),也可能是磁盘满或者权限。
# 这三种的解法完全不同,靠用户口述问不出来,所以让机器自己去看。
#
# 报告里不放任何密钥:只列进程路径、文件大小、系统版本这类信息,
# 日志只取尾部若干行并且提示用户发之前可以自己看一眼。

param(
  [string]$Dir,       # 安装目录
  [string]$Out,       # 报告写到哪
  [string]$Phase = 'install'
)

$ErrorActionPreference = 'SilentlyContinue'
$lines = New-Object System.Collections.Generic.List[string]
function Add-Line { param([string]$s) $lines.Add($s) }
function Add-Section { param([string]$s) $lines.Add(''); $lines.Add('== ' + $s + ' =='); }

Add-Line 'PromptCut 安装诊断报告'
Add-Line ('生成时间: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Add-Line ('阶段: ' + $Phase)
# 装着的是哪一版。安装器自己的版本号在 NSIS 那边取不到 —— hooks.nsh 的 include
# 排在 `!define VERSION` 前面,那时候它还不存在。而「原地装着的旧版本」对判断问题
# 其实更有用:能看出是全新安装还是覆盖升级、从哪一版升上来的。
$installedPkg = Join-Path $Dir 'runtime\app\package.json'
if (Test-Path $installedPkg) {
  try { Add-Line ('已装版本: ' + ((Get-Content $installedPkg -Raw | ConvertFrom-Json).version)) }
  catch { Add-Line '已装版本: package.json 解不开' }
} else {
  Add-Line '已装版本: 没有(全新安装,或者上一版已经被删干净了)'
}

# ── 系统 ────────────────────────────────────────────────────────────────
Add-Section '系统'
try {
  $os = Get-CimInstance Win32_OperatingSystem
  Add-Line ('Windows: ' + $os.Caption + ' (' + $os.Version + ', build ' + $os.BuildNumber + ')')
} catch { Add-Line 'Windows: 读不到' }
# 不能用 $env:PROCESSOR_ARCHITECTURE:NSIS 是 32 位的,它起的 PowerShell 也是 32 位,
# 这个变量会报 x86,把 64 位系统写成 32 位 —— 诊断报告里给错的事实比不给更糟。
# 真实架构看 OSArchitecture,取不到再退回 ARCHITEW6432(WOW64 下才有)。
try { Add-Line ('架构: ' + (Get-CimInstance Win32_OperatingSystem).OSArchitecture) }
catch {
  $a = $env:PROCESSOR_ARCHITEW6432
  if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }
  Add-Line ('架构: ' + $a)
}
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Add-Line ('以管理员身份运行: ' + $admin)

# ── 安装目录 ────────────────────────────────────────────────────────────
Add-Section '安装目录'
Add-Line ('路径: ' + $Dir)
$dirExists = Test-Path $Dir
Add-Line ('存在: ' + $dirExists)
if ($Dir) {
  try {
    $qualifier = (Split-Path -Qualifier $Dir)
    $drive = Get-PSDrive -Name $qualifier.TrimEnd(':')
    Add-Line ('所在盘剩余空间: ' + [math]::Round($drive.Free / 1GB, 2) + ' GB')
  } catch { Add-Line '剩余空间: 读不到' }
}

# ── 占着安装目录里文件的进程(最常见的元凶)────────────────────────────
Add-Section '占用安装目录的进程'
Add-Line '(上一次运行留下的孤儿会锁住自己的 exe,安装器就写不进去)'
# 走 WMI 而不是 Get-Process:安装器是 32 位的,它起的 PowerShell 也是,
# 而 32 位进程读不到 64 位进程的 Process.Path(MainModule 跨位数会失败,返回 $null)。
# 用 Get-Process 的话这一节会永远报「没有占用进程」—— 一个假阴性,
# 而且恰好把最常见的原因排除掉了,比不报还糟。
$found = $false
if ($dirExists) {
  $prefix = $Dir.TrimEnd('\') + '\'
  $cmp = [System.StringComparison]::OrdinalIgnoreCase
  foreach ($proc in Get-CimInstance Win32_Process) {
    $path = $proc.ExecutablePath
    if (-not $path) { continue }
    if ($path.StartsWith($prefix, $cmp)) {
      $found = $true
      $started = ''
      try { $started = ' 启动于 ' + $proc.CreationDate.ToString('HH:mm:ss') } catch {}
      Add-Line ('  PID ' + $proc.ProcessId + '  ' + $path + $started)
    }
  }
}
if (-not $found) { Add-Line '  (没有。说明不是进程占用,往下看杀毒软件那一节)' }

# ── 关键文件能不能写 ────────────────────────────────────────────────────
Add-Section '关键文件'
$targets = @(
  (Join-Path $Dir 'runtime\ffmpeg\ffmpeg.exe'),
  (Join-Path $Dir 'runtime\ffmpeg\ffprobe.exe'),
  (Join-Path $Dir 'node.exe'),
  (Join-Path $Dir 'promptcut.exe')
)
$locked = New-Object System.Collections.Generic.List[string]
foreach ($f in $targets) {
  if (-not (Test-Path $f)) { Add-Line ('  缺失: ' + $f); continue }
  $size = (Get-Item $f).Length
  $writable = $false
  try {
    $fs = [System.IO.File]::Open($f, 'Open', 'Write', 'None')
    $fs.Close(); $writable = $true
  } catch { $writable = $false }
  Add-Line ('  ' + $f + '  ' + $size + ' 字节  可独占写入=' + $writable)
  if (-not $writable) { $locked.Add($f) }
}

# ── 到底是谁锁着 ────────────────────────────────────────────────────────
# 上面那一节只说得出「写不进去」,说不出「被谁占着」。而占用者未必在安装目录里
# (杀毒软件的扫描线程、索引服务、用户自己开着的播放器都可能),所以按路径找进程那一节
# 会如实报「没有」—— 对,但不解决问题。
#
# Restart Manager 就是干这个的:Windows 安装程序用它来问「要更新这个文件,得先请谁让开」。
# 它不受路径和位数限制,能直接把持有句柄的进程报出来。
if ($locked.Count -gt 0) {
  Add-Section '锁住这些文件的是谁'
  try {
    if (-not ('PcRm' -as [type])) {
      Add-Type -Namespace '' -Name 'PcRm' -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint dwLowDateTime; public uint dwHighDateTime; }
[StructLayout(LayoutKind.Sequential)] public struct RM_UNIQUE_PROCESS { public int dwProcessId; public FILETIME ProcessStartTime; }
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct RM_PROCESS_INFO {
  public RM_UNIQUE_PROCESS Process;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
  public int ApplicationType; public uint AppStatus; public uint TSSessionId;
  [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
}
[DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
[DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint pSessionHandle);
[DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, IntPtr rgApplications, uint nServices, string[] rgsServiceNames);
[DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
'@ -ErrorAction Stop
    }
    $session = 0
    $key = [guid]::NewGuid().ToString()
    if ([PcRm]::RmStartSession([ref]$session, 0, $key) -eq 0) {
      try {
        [void][PcRm]::RmRegisterResources($session, [uint32]$locked.Count, $locked.ToArray(), 0, [IntPtr]::Zero, 0, $null)
        $needed = 0; $count = 0; $reason = 0
        [void][PcRm]::RmGetList($session, [ref]$needed, [ref]$count, $null, [ref]$reason)
        if ($needed -gt 0) {
          $count = $needed
          $arr = New-Object 'PcRm+RM_PROCESS_INFO[]' $needed
          if ([PcRm]::RmGetList($session, [ref]$needed, [ref]$count, $arr, [ref]$reason) -eq 0) {
            for ($i = 0; $i -lt $count; $i++) {
              $pi = $arr[$i]
              $exe = ''
              try { $exe = ' -> ' + (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $pi.Process.dwProcessId)).ExecutablePath } catch {}
              Add-Line ('  PID ' + $pi.Process.dwProcessId + '  ' + $pi.strAppName + $exe)
            }
          }
        } else {
          Add-Line '  Restart Manager 说没有进程持有这些文件 —— 那多半是杀毒软件在内核层拦截,或者权限问题'
        }
      } finally { [void][PcRm]::RmEndSession($session) }
    } else {
      Add-Line '  Restart Manager 会话开不起来,查不到持有者'
    }
  } catch {
    Add-Line ('  查持有者失败: ' + $_.Exception.Message)
  }
}

# ── 杀毒 ────────────────────────────────────────────────────────────────
Add-Section '杀毒软件'
Add-Line '(ffmpeg.exe 是常见误报对象;被隔离时表现和进程占用一样,都是写不进去)'
try {
  $mp = Get-MpComputerStatus
  Add-Line ('Defender 实时保护: ' + $mp.RealTimeProtectionEnabled)
} catch { Add-Line 'Defender 状态: 读不到(可能装了第三方杀毒)' }
try {
  $av = Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName AntiVirusProduct
  foreach ($a in $av) { Add-Line ('已注册的杀毒: ' + $a.displayName) }
} catch { Add-Line '已注册的杀毒: 读不到' }
$hits = $false
try {
  foreach ($d in (Get-MpThreatDetection | Sort-Object InitialDetectionTime -Descending | Select-Object -First 40)) {
    $res = ($d.Resources -join ' ')
    if ($res -match 'PromptCut|ffmpeg|ffprobe') {
      $hits = $true
      Add-Line ('  ' + $d.InitialDetectionTime + '  ' + $d.ThreatID + '  ' + $res)
    }
  }
} catch {}
if (-not $hits) { Add-Line '  最近的 Defender 检测记录里没有跟 PromptCut / ffmpeg 相关的' }

# ── 应用日志尾部 ────────────────────────────────────────────────────────
Add-Section '上一次运行的日志(尾部 60 行)'
$log = Join-Path $env:LOCALAPPDATA 'com.promptcut.desktop\logs\sidecar.log'
if (Test-Path $log) {
  Add-Line ('来源: ' + $log)
  foreach ($l in (Get-Content $log -Tail 60)) { Add-Line ('  ' + $l) }
} else {
  Add-Line ('没有日志文件(' + $log + ')')
}

Add-Line ''
Add-Line '— 报告结束。发之前可以自己看一遍,里面不含密钥,但有本机路径和用户名。'

$dirOut = Split-Path -Parent $Out
if ($dirOut -and -not (Test-Path $dirOut)) { New-Item -ItemType Directory -Force -Path $dirOut | Out-Null }
Set-Content -Path $Out -Value $lines -Encoding UTF8
Write-Output ('报告已保存: ' + $Out)

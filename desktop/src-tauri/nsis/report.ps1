# PromptCut install diagnostic report
#
# Invoked by the installer after an install/uninstall failure (see .onInstFailed in hooks.nsh); it gathers the evidence needed to answer "why can't it write"
# in one go and saves it as a text file for the user to send back.
#
# Why this exists: the most typical failure is "Extract: error writing to file runtime\ffmpeg\ffmpeg.exe",
# and that message alone cannot tell which cause it is: an orphan process left over from the last run may be locking the file,
# antivirus software may have blocked ffmpeg (a common false-positive target), or it may be a full disk or permissions.
# These three have completely different fixes, and asking the user to describe it will not reveal which, so let the machine look for itself.
#
# The report contains no keys: it lists only things like process paths, file sizes and system versions,
# and for logs it takes only the last several lines and reminds the user they can take a look before sending.

param(
  [string]$Dir,       # install directory
  [string]$Out,       # where to write the report
  [string]$Phase = 'install'
)

$ErrorActionPreference = 'SilentlyContinue'
$lines = New-Object System.Collections.Generic.List[string]
function Add-Line { param([string]$s) $lines.Add($s) }
function Add-Section { param([string]$s) $lines.Add(''); $lines.Add('== ' + $s + ' =='); }

Add-Line 'PromptCut install diagnostic report'
Add-Line ('Generated at: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Add-Line ('Phase: ' + $Phase)
# Which version is installed. The installer's own version number is not available on the NSIS side: the include of hooks.nsh
# comes before `!define VERSION`, when it does not exist yet. And "the old version installed in place" is, for diagnosing the problem,
# actually more useful: it shows whether this is a fresh install or an upgrade over an existing one, and which version it upgraded from.
$installedPkg = Join-Path $Dir 'runtime\app\package.json'
if (Test-Path $installedPkg) {
  try { Add-Line ('Installed version: ' + ((Get-Content $installedPkg -Raw | ConvertFrom-Json).version)) }
  catch { Add-Line 'Installed version: package.json cannot be parsed' }
} else {
  Add-Line 'Installed version: none (fresh install, or the previous version has been fully deleted)'
}

# ── System ────────────────────────────────────────────────────────────────────
Add-Section 'System'
try {
  $os = Get-CimInstance Win32_OperatingSystem
  Add-Line ('Windows: ' + $os.Caption + ' (' + $os.Version + ', build ' + $os.BuildNumber + ')')
} catch { Add-Line 'Windows: unreadable' }
# Do not use $env:PROCESSOR_ARCHITECTURE: NSIS is 32-bit and the PowerShell it starts is 32-bit too,
# so that variable reports x86 and records a 64-bit system as 32-bit; a wrong fact in a diagnostic report is worse than none.
# Take the real architecture from OSArchitecture, and fall back to ARCHITEW6432 (only present under WOW64) if it cannot be read.
try { Add-Line ('Architecture: ' + (Get-CimInstance Win32_OperatingSystem).OSArchitecture) }
catch {
  $a = $env:PROCESSOR_ARCHITEW6432
  if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }
  Add-Line ('Architecture: ' + $a)
}
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Add-Line ('Running as administrator: ' + $admin)

# ── Install directory ────────────────────────────────────────────────────────────────
Add-Section 'Install directory'
Add-Line ('Path: ' + $Dir)
$dirExists = Test-Path $Dir
Add-Line ('Exists: ' + $dirExists)
if ($Dir) {
  try {
    $qualifier = (Split-Path -Qualifier $Dir)
    $drive = Get-PSDrive -Name $qualifier.TrimEnd(':')
    Add-Line ('Free space on the drive: ' + [math]::Round($drive.Free / 1GB, 2) + ' GB')
  } catch { Add-Line 'Free space: unreadable' }
}

# ── Processes holding files in the install directory (the most common culprit)───────────────────────────────────
Add-Section 'Processes locking the install directory'
Add-Line '(an orphan left over from the last run locks its own exe, so the installer cannot write to it)'
# Go through WMI rather than Get-Process: the installer is 32-bit, and so is the PowerShell it starts,
# and a 32-bit process cannot read the Process.Path of a 64-bit process (MainModule fails across bitness and returns $null).
# With Get-Process this section would always report "no process holding it": a false negative,
# and one that happens to rule out the most common cause, which is worse than reporting nothing.
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
      try { $started = ' started at ' + $proc.CreationDate.ToString('HH:mm:ss') } catch {}
      Add-Line ('  PID ' + $proc.ProcessId + '  ' + $path + $started)
    }
  }
}
if (-not $found) { Add-Line '  (None. So it is not a process lock; see the antivirus section below)' }

# ── Whether key files can be written ──────────────────────────────────────────────────
Add-Section 'Key files'
$targets = @(
  (Join-Path $Dir 'runtime\ffmpeg\ffmpeg.exe'),
  (Join-Path $Dir 'runtime\ffmpeg\ffprobe.exe'),
  (Join-Path $Dir 'node.exe'),
  (Join-Path $Dir 'promptcut.exe')
)
$locked = New-Object System.Collections.Generic.List[string]
foreach ($f in $targets) {
  if (-not (Test-Path $f)) { Add-Line ('  Missing: ' + $f); continue }
  $size = (Get-Item $f).Length
  $writable = $false
  try {
    $fs = [System.IO.File]::Open($f, 'Open', 'Write', 'None')
    $fs.Close(); $writable = $true
  } catch { $writable = $false }
  Add-Line ('  ' + $f + '  ' + $size + ' bytes  exclusively writable=' + $writable)
  if (-not $writable) { $locked.Add($f) }
}

# ── Who is actually holding the lock ────────────────────────────────────────────────────────
# The section above can only say "cannot write", not "who is holding it". And the holder is not necessarily inside the install directory
# (an antivirus scanning thread, the indexing service, a player the user left open: any of them could be), so the section that looks for processes by path
# will honestly report "none": correct, but it does not solve the problem.
#
# Restart Manager exists for exactly this: Windows installers use it to ask "to update this file, who has to be asked to step aside first".
# It is not limited by path or bitness and can directly report the processes that hold handles.
if ($locked.Count -gt 0) {
  Add-Section 'Who is locking these files'
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
          Add-Line '  Restart Manager says no process holds these files: most likely an antivirus is blocking them at the kernel level, or it is a permissions issue'
        }
      } finally { [void][PcRm]::RmEndSession($session) }
    } else {
      Add-Line '  Restart Manager session could not be started, so the holder cannot be determined'
    }
  } catch {
    Add-Line ('  Failed to look up the holder: ' + $_.Exception.Message)
  }
}

# ── Antivirus ────────────────────────────────────────────────────────────────
Add-Section 'Antivirus software'
Add-Line '(ffmpeg.exe is a common false-positive target; when quarantined it looks the same as a process lock: the file cannot be written)'
try {
  $mp = Get-MpComputerStatus
  Add-Line ('Defender real-time protection: ' + $mp.RealTimeProtectionEnabled)
} catch { Add-Line 'Defender status: unreadable (a third-party antivirus may be installed)' }
try {
  $av = Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName AntiVirusProduct
  foreach ($a in $av) { Add-Line ('Registered antivirus: ' + $a.displayName) }
} catch { Add-Line 'Registered antivirus: unreadable' }
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
if (-not $hits) { Add-Line '  No recent Defender detection records relate to PromptCut / ffmpeg' }

# ── App log tail ────────────────────────────────────────────────────────
Add-Section 'Log of the previous run (last 60 lines)'
$log = Join-Path $env:LOCALAPPDATA 'com.promptcut.desktop\logs\sidecar.log'
if (Test-Path $log) {
  Add-Line ('Source: ' + $log)
  foreach ($l in (Get-Content $log -Tail 60)) { Add-Line ('  ' + $l) }
} else {
  Add-Line ('No log file (' + $log + ')')
}

Add-Line ''
Add-Line '— End of report. Review it before sending: it contains no keys, but it does include local paths and the user name.'

$dirOut = Split-Path -Parent $Out
if ($dirOut -and -not (Test-Path $dirOut)) { New-Item -ItemType Directory -Force -Path $dirOut | Out-Null }
Set-Content -Path $Out -Value $lines -Encoding UTF8
Write-Output ('Report saved: ' + $Out)

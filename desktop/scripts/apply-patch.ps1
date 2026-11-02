<#
    PromptCut update patch installer.

    Ships with the patch pack and runs on the user's machine (it is not a build script). It overlays the patch's
    payload onto the installed runtime\app, touching build artifacts only and never user data.

    If any step fails, it rolls back to the backup: a failed update is acceptable, a half-installed program is not.

    Usage:
      .\apply-patch.ps1                     # install to the default location
      .\apply-patch.ps1 -InstallDir <path>  # install to a specific location
      .\apply-patch.ps1 -Force              # do not ask, terminate the running PromptCut directly
      .\apply-patch.ps1 -WhatIf             # check only, write nothing
#>
[CmdletBinding()]
param(
    [string] $InstallDir,
    [switch] $Force,
    [switch] $WhatIf
)

$ErrorActionPreference = 'Stop'
$PatchRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step { param([string] $Text) Write-Host "  $Text" }
function Write-Ok   { param([string] $Text) Write-Host "  $Text" -ForegroundColor Green }
function Write-Warn { param([string] $Text) Write-Host "  $Text" -ForegroundColor Yellow }

function Fail {
    param([string] $Text)
    Write-Host ""
    Write-Host "  Update not completed: $Text" -ForegroundColor Red
    Write-Host "  The program is still the original version and opens normally." -ForegroundColor Red
    Write-Host "  If needed, installing over it with the full installer achieves the same result." -ForegroundColor Red
    Write-Host ""
    if (-not $env:PROMPTCUT_PATCH_NONINTERACTIVE) { Read-Host "Press Enter to close" }
    exit 1
}

# Compare version numbers like "0.2.10" numerically; string comparison would sort it before "0.2.9".
function Compare-Version {
    param([string] $Left, [string] $Right)
    $l = @($Left  -split '[.\-+]' | ForEach-Object { [int]($_ -replace '\D', '0') })
    $r = @($Right -split '[.\-+]' | ForEach-Object { [int]($_ -replace '\D', '0') })
    for ($i = 0; $i -lt [Math]::Max($l.Count, $r.Count); $i++) {
        $a = if ($i -lt $l.Count) { $l[$i] } else { 0 }
        $b = if ($i -lt $r.Count) { $r[$i] } else { 0 }
        if ($a -ne $b) { return $a - $b }
    }
    return 0
}

Write-Host ""
Write-Host "PromptCut update" -ForegroundColor Cyan
Write-Host ""

# ── 1. Read the patch manifest ─────────────────────────────────────────────────────
$manifestPath = Join-Path $PatchRoot 'patch.json'
if (-not (Test-Path $manifestPath)) { Fail "The patch pack is incomplete: patch.json not found. Please download it again." }
$patch = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
if ($patch.format -ne 'promptcut-patch/1') { Fail "Unrecognized patch format ($($patch.format)). Please download a patch that matches this program." }

$payloadDir = Join-Path $PatchRoot 'payload'
if (-not (Test-Path $payloadDir)) { Fail "The patch pack is incomplete: payload directory not found. Please download it again." }

Write-Step "Patch version: $($patch.appVersion)"

# ── 2. Locate the install location ───────────────────────────────────────────────────
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'PromptCut' }
$runtimeDir  = Join-Path $InstallDir 'runtime'
$appDir      = Join-Path $runtimeDir 'app'
$versionsPath = Join-Path $runtimeDir 'VERSIONS.json'

if (-not (Test-Path $appDir)) {
    Fail "No installed PromptCut found in $InstallDir. If it is installed elsewhere, specify it with -InstallDir, or just use the full installer."
}
Write-Step "Install location: $InstallDir"

# ── 3. Version check ───────────────────────────────────────────────────────
$installed = $null
if (Test-Path $versionsPath) { $installed = Get-Content -Raw -Encoding UTF8 -LiteralPath $versionsPath | ConvertFrom-Json }

# Core generation = the first two segments of the shell version (the 0.2 in 0.2.x). When the core (Rust shell, Chrome,
# ffmpeg, bundled Python) changes, the middle digit is bumped, so "a different middle digit = you must use the
# full installer", and users can tell at a glance whether a patch applies. Minor shell fixes within the same generation
# only bump the last digit; the patch still installs, but cannot be installed on a shell older than the patch.
function Get-Generation { param([string] $Version) ($Version -split '[.\-+]')[0..1] -join '.' }

$shellExe = Join-Path $InstallDir 'promptcut.exe'
if (Test-Path $shellExe) {
    $shellVersion = (Get-Item -LiteralPath $shellExe).VersionInfo.ProductVersion
    if ($shellVersion) {
        $mine = Get-Generation $shellVersion
        if ($patch.shellGeneration -and $mine -ne $patch.shellGeneration) {
            Fail "Core generation mismatch: this machine is on $mine.x, while this patch targets $($patch.shellGeneration).x. The core (shell, Chrome, ffmpeg, bundled Python) has moved to a new generation, which a patch cannot change, so please use the full installer."
        }
        if ((Compare-Version $shellVersion $patch.minShellVersion) -lt 0) {
            Fail "The PromptCut shell on this machine is $shellVersion; this patch requires $($patch.minShellVersion) or newer. Please upgrade to that version with the full installer first."
        }
    }
}

if ($installed) {
    Write-Step "Current version: $($installed.app)"
    if ($installed.app -eq $patch.appVersion) {
        Write-Warn "Already on $($patch.appVersion). Continuing will overwrite it again."
        if (-not $Force -and -not $env:PROMPTCUT_PATCH_NONINTERACTIVE) {
            if ((Read-Host "  Continue? (y/N)") -notmatch '^[yY]') { Write-Host "  Cancelled."; exit 0 }
        }
    }
}

# When the patch does not carry dependencies, the installed dependencies must be the same set the patch was compiled against,
# otherwise the new code will import a package that is not installed at all.
if (-not $patch.includesDeps) {
    $lockPath = Join-Path $appDir 'package-lock.json'
    if (-not (Test-Path $lockPath)) { Fail "Cannot find $lockPath, so we cannot confirm whether the dependencies match. Please use the full installer." }
    $lockHash = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLower()
    # Also accept the lock file of the patch's base version: make-patch only emits a patch without dependencies when "the dependency section is identical to the base",
    # while the hash of the whole file gets thrown off by the version field in the lock file (0.5.2 bumped the version number and so touched it, with not a single dependency changed,
    # yet installing it on 0.5.1 was rejected here). The lock file itself is in the payload and is replaced with the new one after installation.
    if ($lockHash -ne $patch.lockHash -and -not ($patch.baseLockHash -and $lockHash -eq $patch.baseLockHash)) {
        Fail "The dependencies on this machine do not match the patch (this patch does not include dependencies). Please use the full installer, or download a patch that includes dependencies."
    }
    Write-Step "Dependencies: match the patch, no update needed"
} else {
    Write-Step "Dependencies: this patch will update them too"
}

if ($WhatIf) {
    Write-Host ""
    Write-Ok "All checks passed. -WhatIf was given, so only checks ran and no files were written."
    Write-Host ""
    exit 0
}

# ── 4. Ask the user to close the running program ───────────────────────────────────────
# Only recognize processes whose executable lives under the directory being updated. Killing by process name across the board would also take out any PromptCut
# installed elsewhere or running in development, which have nothing to do with this update.
#
# **Both kinds of process must be recognized.** The shell (promptcut.exe) is just a window; what really serves the pages, runs the AI
# loop and holds every file under runtime\app is the node child process it starts. Originally only
# promptcut.exe was used to judge "closed cleanly or not", and node still being alive counted as a pass anyway: so the patch, under a
# dev server that was still serving, swapped out the whole runtime\app. In that case node **does not crash,
# it just goes mute**: its own loop keeps running and its requests to the model keep going out, but every HTTP request from the page
# hangs until the service restarts. The user sees a string of inexplicable tool timeouts with no traceable cause.
function Get-TargetProcesses {
    $hits = New-Object System.Collections.Generic.List[object]

    foreach ($p in @(Get-Process -Name 'promptcut' -ErrorAction SilentlyContinue)) {
        $path = $null
        try { $path = $p.Path } catch { }
        # When the path cannot be obtained (insufficient permissions), conservatively count the process as a target, otherwise a locked file would leave the update half done.
        if ((-not $path) -or $path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)) {
            $hits.Add([pscustomobject]@{ Id = $p.Id; Name = $p.ProcessName; Proc = $p })
        }
    }

    # node child process: the executable is under the install directory (the node bundled with the shell), or its command line
    # points at the install directory (one started with the system node during development counts too). A hit on either rule counts.
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop
    } catch {
        $procs = @()
    }
    foreach ($q in $procs) {
        $exe = [string]$q.ExecutablePath
        $cmd = [string]$q.CommandLine
        $inDir = ($exe -and $exe.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)) -or
                 ($cmd -and $cmd.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0)
        if ($inDir) {
            $obj = $null
            try { $obj = Get-Process -Id $q.ProcessId -ErrorAction Stop } catch { }
            if ($obj) { $hits.Add([pscustomobject]@{ Id = $q.ProcessId; Name = 'node'; Proc = $obj }) }
        }
    }

    # Use ToArray() rather than @($hits): in Windows PowerShell 5.1, `@(...)` expanding a
    # generic List that holds "PSCustomObjects wrapping Process objects" throws
    # "Argument types do not match". ToArray() does not have this problem.
    $hits.ToArray()
}

function Restore-LegacyPatchWindow {
    param([object[]] $Processes)
    # Old shells do not recognize --quit; their single-instance callback may not be able to restore a minimized window.
    # Only fill in the bring-back behavior that old versions already settled on; do not touch the background-exit path of 0.2.7.
    try {
        if (-not ('PromptCutPatchWindow' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PromptCutPatchWindow {
    private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    public static void Restore(uint process) {
        EnumWindows((window, parameter) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != process) return true;
            var name = new StringBuilder(256);
            GetClassName(window, name, name.Capacity);
            // MainWindowHandle may pick the helper window of the single-instance plugin, so it cannot be used to restore.
            if (name.ToString() != "Tauri Window") return true;
            ShowWindowAsync(window, 9); // SW_RESTORE
            SetForegroundWindow(window);
            return true;
        }, IntPtr.Zero);
    }
}
'@
        }
        foreach ($p in $Processes) {
            if ($p.Name -ne 'promptcut') { continue }
            [PromptCutPatchWindow]::Restore([uint32]$p.Id)
        }
    } catch {
        # When bring-back is unavailable, the 10-second wait and the fallback close below run as usual.
        Write-Warn "Cannot restore the old version's window; continuing to close and update."
    }
}

# Ask the running instance how many chat rounds are in progress right now.
# If it cannot be obtained, return $null (the program is not open, the port is wrong, an old version lacks this field); in that case do not block.
function Get-ActiveAiRuns {
    $port = $env:PROMPTCUT_PORT
    if (-not $port) { $port = '5210' }
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/api/mcp/status")
        # Local loopback must not go through the system proxy: if it does, the connection fails and is then misjudged as "not running"
        $req.Proxy = $null
        $req.Timeout = 3000
        $req.ReadWriteTimeout = 3000
        $resp = $req.GetResponse()
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $reader.ReadToEnd()
        $reader.Close(); $resp.Close()
        $json = $body | ConvertFrom-Json
        if ($null -eq $json.activeRuns) { return $null }
        return [int]$json.activeRuns
    } catch {
        return $null
    }
}

$running = @(Get-TargetProcesses)
if ($running.Count -gt 0) {
    <#
        First ask "is any chat running".

        The patch overwrites the entire runtime\app tree, while an AI chat round may already have edited half a timeline,
        created a few cards, and be waiting on some background job. Close it at that point and what the user loses is not "one update",
        but half-finished work. Updating a few minutes later makes no difference, so the default is to yield.
    #>
    $active = Get-ActiveAiRuns
    if ($active -gt 0) {
        Write-Warn "PromptCut still has $active AI chat rounds running."
        Write-Warn "Updating now will cut them off midway, and half-finished changes may be lost."
        if ($Force) {
            Write-Warn "-Force was specified; continuing anyway."
        } elseif ($env:PROMPTCUT_PATCH_NONINTERACTIVE) {
            Fail "A chat is running, so we stopped. Wait for it to finish and then update, or use -Force to continue anyway."
        } else {
            Write-Host "  We recommend waiting for the chat to finish before updating."
            if ((Read-Host "  Update now anyway? (y/N)") -notmatch '^[yY]') { Write-Host "  Cancelled."; exit 0 }
        }
    }

    if (-not $Force -and -not $env:PROMPTCUT_PATCH_NONINTERACTIVE) {
        Write-Warn "PromptCut is running and must be closed before it can be updated."
        if ((Read-Host "  Close it now? (y/N)") -notmatch '^[yY]') { Write-Host "  Cancelled."; exit 0 }
    }
    Write-Step "Closing PromptCut…"
    <#
        First ask it to exit cleanly: send the shell exe in the install directory a `--quit` once. The instance that is already running, through the single-instance
        plugin, receives the argument and takes the same path as the tray "Close" (the whole sidecar tree is cleaned up, the .proc lock is released, a main window tucked
        away in the background is first moved back on screen before its position is recorded); the process that sent the argument exits right away.

        The shell only recognizes `--quit` from 0.2.7 on. Shells 0.2.6 and earlier treat it as an ordinary second launch: it only brings the editor
        to the front without exiting; then after waiting the full 10 seconds it still goes through the CloseMainWindow + force kill below, same as before,
        so it is no worse.

        On shells from 0.2.7 on, CloseMainWindow only tucks the editor into the background (closing the window does not exit); the real fallback is
        the Stop-Process -Force that follows (the sidecar is in a kill-on-close job and goes with the shell when it dies;
        the kernel lock of .proc is reclaimed along with the process, and the Node layer falls back to the pid).
    #>
    if (Test-Path -LiteralPath $shellExe) {
        try {
            $null = Start-Process -FilePath $shellExe -ArgumentList '--quit' -PassThru -ErrorAction Stop
            if ($shellVersion -and (Compare-Version $shellVersion '0.2.7') -lt 0) {
                Restore-LegacyPatchWindow -Processes $running
            }
        } catch {
            Write-Warn "Could not send the exit request ($($_.Exception.Message)); falling back to closing the window + forced termination."
        }
        $deadline = (Get-Date).AddSeconds(10)
        while (@(Get-TargetProcesses).Count -gt 0 -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 500
        }
    }
    foreach ($p in Get-TargetProcesses) {
        try { $null = $p.Proc.CloseMainWindow() } catch { }
    }
    if (@(Get-TargetProcesses).Count -gt 0) { Start-Sleep -Seconds 2 }
    foreach ($p in Get-TargetProcesses) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
    }
    # The node child process does not necessarily exit with the shell, and it is the one holding runtime\app.
    Start-Sleep -Seconds 2
    $left = @(Get-TargetProcesses)
    if ($left.Count -gt 0) {
        $names = ($left | ForEach-Object { "$($_.Name)($($_.Id))" }) -join ', '
        Fail "PromptCut could not be closed (still running: $names). Please quit it manually and then run this update again."
    }
    Write-Ok "Closed"
}

# ── 5. Backup ───────────────────────────────────────────────────────────
# Back up only the build artifacts (the ones the patch overwrites), not node_modules / exports /
# .pc-chats: those are hundreds of MB of dependencies and the user's own data, and the patch does not touch them either.
$backupDir = Join-Path $runtimeDir ("app.backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-Step "Backing up the current version…"
$backedUp = New-Object System.Collections.Generic.List[string]
try {
    foreach ($rel in $patch.files.PSObject.Properties.Name) {
        $src = Join-Path $appDir $rel
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { continue }
        $dest = Join-Path $backupDir $rel
        $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest)
        Copy-Item -LiteralPath $src -Destination $dest -Force
        $backedUp.Add($rel)
    }
    foreach ($rel in @($patch.removed)) {
        $src = Join-Path $appDir $rel
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { continue }
        $dest = Join-Path $backupDir $rel
        $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest)
        Copy-Item -LiteralPath $src -Destination $dest -Force
        $backedUp.Add($rel)
    }
    if (Test-Path $versionsPath) {
        Copy-Item -LiteralPath $versionsPath -Destination (Join-Path $backupDir 'VERSIONS.json') -Force
    }
} catch {
    Fail "Backup failed: $($_.Exception.Message)"
}
Write-Ok "Backed up $($backedUp.Count) files to $(Split-Path -Leaf $backupDir)"

# ── 6. Overwrite ───────────────────────────────────────────────────────────
function Restore-Backup {
    Write-Warn "Rolling back…"
    try {
        foreach ($rel in $backedUp) {
            $src = Join-Path $backupDir $rel
            if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { continue }
            $dest = Join-Path $appDir $rel
            $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest)
            Copy-Item -LiteralPath $src -Destination $dest -Force
        }
        $bv = Join-Path $backupDir 'VERSIONS.json'
        if (Test-Path $bv) { Copy-Item -LiteralPath $bv -Destination $versionsPath -Force }
        Write-Warn "Rolled back to the version before the update."
    } catch {
        Write-Host "  The rollback failed too: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "  The backup is still in $backupDir; you can also install over it with the full installer." -ForegroundColor Red
    }
}

Write-Step "Updating…"
try {
    # Replace dist wholesale: it is produced entirely by the build, and leaving fragments of the previous version would make the page load old resources.
    $distSrc = Join-Path $payloadDir 'dist'
    $distDest = Join-Path $appDir 'dist'
    if ((Test-Path $distSrc) -and (Test-Path $distDest)) {
        Remove-Item -LiteralPath $distDest -Recurse -Force
    }

    $copied = 0
    foreach ($rel in $patch.files.PSObject.Properties.Name) {
        $src = Join-Path $payloadDir $rel
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw "The patch pack is missing a file: $rel" }
        $dest = Join-Path $appDir $rel
        $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest)
        Copy-Item -LiteralPath $src -Destination $dest -Force
        $copied++
    }

    foreach ($rel in @($patch.removed)) {
        $dest = Join-Path $appDir $rel
        if (Test-Path -LiteralPath $dest -PathType Leaf) { Remove-Item -LiteralPath $dest -Force }
    }

    if ($patch.includesDeps) {
        Write-Step "Updating dependencies (many files, please be patient)…"
        $depSrc = Join-Path $payloadDir 'node_modules'
        if (-not (Test-Path $depSrc)) { throw "The patch declares that it includes dependencies, but payload\node_modules does not exist" }
        $depDest = Join-Path $appDir 'node_modules'
        $depOld = "$depDest.old"
        if (Test-Path $depOld) { Remove-Item -LiteralPath $depOld -Recurse -Force }
        # Move aside first, then copy: overwriting in place would leave behind packages the previous version removed, mixing them into a dependency tree nobody has tested.
        if (Test-Path $depDest) { Move-Item -LiteralPath $depDest -Destination $depOld -Force }
        try {
            # Use robocopy rather than Copy-Item: tens of thousands of small files copy much faster, and deeply nested
            # node_modules paths do not hit the 260-character limit.
            $rc = Start-Process -FilePath 'robocopy.exe' -Wait -NoNewWindow -PassThru `
                -ArgumentList @($depSrc, $depDest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
            if ($rc.ExitCode -ge 8) { throw "robocopy failed to copy dependencies (code $($rc.ExitCode))" }
        } catch {
            if (Test-Path $depDest) { Remove-Item -LiteralPath $depDest -Recurse -Force }
            if (Test-Path $depOld) { Move-Item -LiteralPath $depOld -Destination $depDest -Force }
            throw
        }
        if (Test-Path $depOld) { Remove-Item -LiteralPath $depOld -Recurse -Force }
    }

    # Version info: change only the Node half; Chrome/ffmpeg/Python keep the values written at install time.
    # appSrcHash is computed on the build machine (source size+mtime) and can never match once a patch is installed,
    # so just drop it rather than leave a hash that looks real but means nothing.
    if ($installed) {
        $installed.app = $patch.appVersion
        $installed.PSObject.Properties.Remove('appSrcHash')
        $installed | Add-Member -NotePropertyName 'patchedAt' -NotePropertyValue $patch.builtAt -Force
        $installed | Add-Member -NotePropertyName 'patchLockHash' -NotePropertyValue $patch.lockHash -Force
        $installed | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $versionsPath -Encoding UTF8
    }

    Write-Ok "Updated $copied files"
} catch {
    Write-Host "  Error during the update: $($_.Exception.Message)" -ForegroundColor Red
    Restore-Backup
    Fail $_.Exception.Message
}

# ── 7. Verify ───────────────────────────────────────────────────────────
Write-Step "Verifying…"
$bad = @()
foreach ($rel in $patch.files.PSObject.Properties.Name) {
    $dest = Join-Path $appDir $rel
    if (-not (Test-Path -LiteralPath $dest -PathType Leaf)) { $bad += $rel; continue }
    $h = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $patch.files.$rel) { $bad += $rel }
}
if ($bad.Count -gt 0) {
    Write-Host "  $($bad.Count) files failed verification, for example $($bad[0])" -ForegroundColor Red
    Restore-Backup
    Fail "File verification failed"
}
Write-Ok "Verification passed"

Write-Host ""
Write-Ok "Updated to $($patch.appVersion)."
Write-Step "The backup is kept in $backupDir; you can delete it once the new version is confirmed to work."
Write-Host ""
if (-not $env:PROMPTCUT_PATCH_NONINTERACTIVE) { Read-Host "Press Enter to close" }

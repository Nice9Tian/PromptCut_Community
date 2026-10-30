<#
    PromptCut 更新补丁安装器。

    随补丁包一起发出去，在用户机器上运行（不是构建脚本）。它把补丁里的
    payload 覆盖到已安装的 runtime\app 上，只碰构建产物，用户数据一律不动。

    任何一步失败都回滚到备份 —— 更新失败可以接受，装了一半的程序不行。

    用法:
      .\apply-patch.ps1                     # 装到默认位置
      .\apply-patch.ps1 -InstallDir <路径>  # 装到指定位置
      .\apply-patch.ps1 -Force              # 不询问，直接结束正在运行的 PromptCut
      .\apply-patch.ps1 -WhatIf             # 只检查不写入
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
    Write-Host "  更新未完成：$Text" -ForegroundColor Red
    Write-Host "  程序还是原来的版本，可以正常打开。" -ForegroundColor Red
    Write-Host "  如果需要，用完整安装包覆盖安装也能达到同样效果。" -ForegroundColor Red
    Write-Host ""
    if (-not $env:PROMPTCUT_PATCH_NONINTERACTIVE) { Read-Host "按回车关闭" }
    exit 1
}

# 把 "0.2.10" 这种版本号按数字比，字符串比较会把它排在 "0.2.9" 前面。
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
Write-Host "PromptCut 更新" -ForegroundColor Cyan
Write-Host ""

# ── 1. 读补丁清单 ─────────────────────────────────────────────────────
$manifestPath = Join-Path $PatchRoot 'patch.json'
if (-not (Test-Path $manifestPath)) { Fail "补丁包不完整，找不到 patch.json。请重新下载。" }
$patch = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
if ($patch.format -ne 'promptcut-patch/1') { Fail "补丁格式不认识（$($patch.format)）。请下载与本程序匹配的补丁。" }

$payloadDir = Join-Path $PatchRoot 'payload'
if (-not (Test-Path $payloadDir)) { Fail "补丁包不完整，找不到 payload 目录。请重新下载。" }

Write-Step "补丁版本：$($patch.appVersion)"

# ── 2. 找到安装位置 ───────────────────────────────────────────────────
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'PromptCut' }
$runtimeDir  = Join-Path $InstallDir 'runtime'
$appDir      = Join-Path $runtimeDir 'app'
$versionsPath = Join-Path $runtimeDir 'VERSIONS.json'

if (-not (Test-Path $appDir)) {
    Fail "在 $InstallDir 找不到已安装的 PromptCut。装在别处的话用 -InstallDir 指定，或者直接用完整安装包。"
}
Write-Step "安装位置：$InstallDir"

# ── 3. 版本检查 ───────────────────────────────────────────────────────
$installed = $null
if (Test-Path $versionsPath) { $installed = Get-Content -Raw -Encoding UTF8 -LiteralPath $versionsPath | ConvertFrom-Json }

# 内核代次 = 外壳版本的前两段（0.2.x 里的 0.2）。内核（Rust 外壳、Chrome、
# ffmpeg、内置 Python）动了就进位中间那一位，于是「中间那位不一样 = 必须用
# 完整安装包」，用户扫一眼版本号就知道补丁能不能用。同一代次内的外壳小修
# 只进最后一位，补丁照样能装，但不能装到比补丁更旧的外壳上。
function Get-Generation { param([string] $Version) ($Version -split '[.\-+]')[0..1] -join '.' }

$shellExe = Join-Path $InstallDir 'promptcut.exe'
if (Test-Path $shellExe) {
    $shellVersion = (Get-Item -LiteralPath $shellExe).VersionInfo.ProductVersion
    if ($shellVersion) {
        $mine = Get-Generation $shellVersion
        if ($patch.shellGeneration -and $mine -ne $patch.shellGeneration) {
            Fail "内核代次对不上：这台机器是 $mine.x，本补丁针对 $($patch.shellGeneration).x。内核（外壳、Chrome、ffmpeg、内置 Python）换代了，补丁改不了这部分，请用完整安装包。"
        }
        if ((Compare-Version $shellVersion $patch.minShellVersion) -lt 0) {
            Fail "这台机器上的 PromptCut 外壳是 $shellVersion，本补丁需要 $($patch.minShellVersion) 或更新。请先用完整安装包升到该版本。"
        }
    }
}

if ($installed) {
    Write-Step "当前版本：$($installed.app)"
    if ($installed.app -eq $patch.appVersion) {
        Write-Warn "已经是 $($patch.appVersion) 了。继续会重新覆盖一遍。"
        if (-not $Force -and -not $env:PROMPTCUT_PATCH_NONINTERACTIVE) {
            if ((Read-Host "  继续？(y/N)") -notmatch '^[yY]') { Write-Host "  已取消。"; exit 0 }
        }
    }
}

# 补丁不带依赖时，装上去的依赖必须和补丁编译时用的是同一套，
# 否则新代码会 import 到一个根本没装的包。
if (-not $patch.includesDeps) {
    $lockPath = Join-Path $appDir 'package-lock.json'
    if (-not (Test-Path $lockPath)) { Fail "找不到 $lockPath，无法确认依赖是否匹配。请用完整安装包。" }
    $lockHash = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLower()
    # 也认补丁的基准版本那份锁文件：make-patch 只有在「依赖段和基准完全一致」时才出不带依赖的补丁，
    # 而整份文件的哈希会被锁文件里的 version 字段带偏(0.5.2 就是改版本号改到了它，依赖一个没动，
    # 装在 0.5.1 上却被这里拒掉)。锁文件本身在 payload 里，装完就换成新的那份。
    if ($lockHash -ne $patch.lockHash -and -not ($patch.baseLockHash -and $lockHash -eq $patch.baseLockHash)) {
        Fail "这台机器上的依赖和补丁对不上（本补丁不含依赖）。请用完整安装包，或者下载带依赖的补丁。"
    }
    Write-Step "依赖：与补丁一致，不需要更新"
} else {
    Write-Step "依赖：本补丁会一并更新"
}

if ($WhatIf) {
    Write-Host ""
    Write-Ok "检查全部通过。加上 -WhatIf 只做检查，没有写入任何文件。"
    Write-Host ""
    exit 0
}

# ── 4. 请用户关掉正在运行的程序 ───────────────────────────────────────
# 只认可执行文件在本次要更新的目录下的那些进程。按进程名一刀切会连着别处
# 装的、或者开发中跑的 PromptCut 一起杀掉——那些和这次更新没有关系。
#
# **两类进程都要认。** 外壳（promptcut.exe）只是个窗口，真正服务页面、跑 AI
# 循环、握着 runtime\app 里每一个文件的是它起的 node 子进程。原来只按
# promptcut.exe 判「关干净了没有」，node 活着照样算通过 —— 于是补丁在一个
# 正在服务的 dev server 脚下把整棵 runtime\app 换掉了。那种情况下 node **不会崩，
# 只会哑**：它自己的循环照跑、对模型的请求照发，但页面发出的每一个 HTTP 请求
# 都挂住，直到服务重起。用户看到的是一连串莫名其妙的工具超时，查不到原因。
function Get-TargetProcesses {
    $hits = New-Object System.Collections.Generic.List[object]

    foreach ($p in @(Get-Process -Name 'promptcut' -ErrorAction SilentlyContinue)) {
        $path = $null
        try { $path = $p.Path } catch { }
        # 取不到路径（权限不足）时保守地算作目标，不然文件被占住会更新到一半。
        if ((-not $path) -or $path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)) {
            $hits.Add([pscustomobject]@{ Id = $p.Id; Name = $p.ProcessName; Proc = $p })
        }
    }

    # node 子进程：可执行文件在安装目录下（外壳带的那份 node），或者命令行里
    # 指着安装目录（开发期用系统 node 起的也算）。两条任一命中就算。
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

    # 用 ToArray() 而不是 @($hits):Windows PowerShell 5.1 里 `@(...)` 展开一个
    # 装着「包了 Process 对象的 PSCustomObject」的泛型 List 会抛
    # 「Argument types do not match」。ToArray() 没这个毛病。
    $hits.ToArray()
}

function Restore-LegacyPatchWindow {
    param([object[]] $Processes)
    # 老外壳不认识 --quit；其单实例回调未必能还原最小化窗口。
    # 只补齐老版本已定的唤回行为，不碰 0.2.7 的后台退出路径。
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
            // MainWindowHandle 可能选到单实例插件的辅助窗，不能拿它还原。
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
        # 唤回不可用时，后面的 10 秒等待与兜底关闭照常执行。
        Write-Warn "无法还原旧版本窗口，继续关闭并更新。"
    }
}

# 问一下正在跑的那个实例：现在有几轮对话在进行中。
# 取不到就返回 $null（程序没开、端口不对、老版本没有这个字段），那时不拦。
function Get-ActiveAiRuns {
    $port = $env:PROMPTCUT_PORT
    if (-not $port) { $port = '5210' }
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/api/mcp/status")
        # 本机回环不该走系统代理：走了就会连不上，然后被误判成「没在跑」
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
        先问一句「有没有对话正在跑」。

        补丁会把整棵 runtime\app 覆盖掉，而一轮 AI 对话可能已经改了半条时间轴、
        建了几张卡、正等着某个后台作业。这种时候关掉它，用户丢的不是「一次更新」，
        是做到一半的活儿。更新晚几分钟无所谓，所以默认让路。
    #>
    $active = Get-ActiveAiRuns
    if ($active -gt 0) {
        Write-Warn "PromptCut 里还有 $active 轮 AI 对话正在跑。"
        Write-Warn "现在更新会把它们中途掐断，做到一半的改动可能丢失。"
        if ($Force) {
            Write-Warn "已指定 -Force，仍然继续。"
        } elseif ($env:PROMPTCUT_PATCH_NONINTERACTIVE) {
            Fail "有对话正在跑，已停下。等它跑完再更新，或者用 -Force 强行继续。"
        } else {
            Write-Host "  建议等对话跑完再更新。"
            if ((Read-Host "  仍然现在更新？(y/N)") -notmatch '^[yY]') { Write-Host "  已取消。"; exit 0 }
        }
    }

    if (-not $Force -and -not $env:PROMPTCUT_PATCH_NONINTERACTIVE) {
        Write-Warn "PromptCut 正在运行，需要先关掉才能更新。"
        if ((Read-Host "  现在关掉它？(y/N)") -notmatch '^[yY]') { Write-Host "  已取消。"; exit 0 }
    }
    Write-Step "正在关闭 PromptCut…"
    <#
        先请它自己干净退出:对安装目录里的外壳 exe 发一次 `--quit`。已经在跑的那一份由单实例
        插件收到参数,走和托盘「关闭」同一条路(sidecar 整棵树清掉、.proc 锁释放、收在后台的
        主窗先挪回屏幕内再记位置);发参数的这个进程自己马上退出。

        外壳 0.2.7 起才认 `--quit`。0.2.6 及更早的外壳把它当成普通的第二次启动 —— 只是把编辑
        界面唤回到前面,不退出;那样等满 10 秒后照旧走下面的 CloseMainWindow + 强杀,和以前一样,
        不会更差。

        CloseMainWindow 在 0.2.7 起的外壳上只会把编辑界面收到后台(关窗不退出),真正兜底的是
        后面的 Stop-Process -Force(sidecar 在 kill-on-close 的 job 里,外壳一死跟着走;
        .proc 的内核锁随进程收走,Node 那层走 pid 兜底)。
    #>
    if (Test-Path -LiteralPath $shellExe) {
        try {
            $null = Start-Process -FilePath $shellExe -ArgumentList '--quit' -PassThru -ErrorAction Stop
            if ($shellVersion -and (Compare-Version $shellVersion '0.2.7') -lt 0) {
                Restore-LegacyPatchWindow -Processes $running
            }
        } catch {
            Write-Warn "发不出退出请求（$($_.Exception.Message)），改用关窗口 + 强制结束。"
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
    # node 子进程未必跟着外壳退，而它才是握着 runtime\app 的那个。
    Start-Sleep -Seconds 2
    $left = @(Get-TargetProcesses)
    if ($left.Count -gt 0) {
        $names = ($left | ForEach-Object { "$($_.Name)($($_.Id))" }) -join '、'
        Fail "PromptCut 关不掉（还剩：$names）。请手动退出后再运行本更新。"
    }
    Write-Ok "已关闭"
}

# ── 5. 备份 ───────────────────────────────────────────────────────────
# 只备份构建产物（补丁会覆盖的那些），不备份 node_modules / exports /
# .pc-chats —— 那是几百 MB 的依赖和用户自己的东西，补丁也不碰它们。
$backupDir = Join-Path $runtimeDir ("app.backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-Step "备份当前版本…"
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
    Fail "备份失败：$($_.Exception.Message)"
}
Write-Ok "已备份 $($backedUp.Count) 个文件到 $(Split-Path -Leaf $backupDir)"

# ── 6. 覆盖 ───────────────────────────────────────────────────────────
function Restore-Backup {
    Write-Warn "正在回滚…"
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
        Write-Warn "已回滚到更新前的版本。"
    } catch {
        Write-Host "  回滚也失败了：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host "  备份还在 $backupDir，也可以直接用完整安装包覆盖安装。" -ForegroundColor Red
    }
}

Write-Step "正在更新…"
try {
    # dist 整个换掉：它完全由构建产生，留下上一版的碎片会让页面加载到旧资源。
    $distSrc = Join-Path $payloadDir 'dist'
    $distDest = Join-Path $appDir 'dist'
    if ((Test-Path $distSrc) -and (Test-Path $distDest)) {
        Remove-Item -LiteralPath $distDest -Recurse -Force
    }

    $copied = 0
    foreach ($rel in $patch.files.PSObject.Properties.Name) {
        $src = Join-Path $payloadDir $rel
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw "补丁包缺少文件：$rel" }
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
        Write-Step "正在更新依赖（文件较多，请耐心等待）…"
        $depSrc = Join-Path $payloadDir 'node_modules'
        if (-not (Test-Path $depSrc)) { throw "补丁声明含依赖，但 payload\node_modules 不存在" }
        $depDest = Join-Path $appDir 'node_modules'
        $depOld = "$depDest.old"
        if (Test-Path $depOld) { Remove-Item -LiteralPath $depOld -Recurse -Force }
        # 先挪开再复制：直接覆盖会留下上一版删掉的包，混合出一个谁都没测过的依赖树。
        if (Test-Path $depDest) { Move-Item -LiteralPath $depDest -Destination $depOld -Force }
        try {
            # 用 robocopy 而不是 Copy-Item：几万个小文件快得多，深层嵌套的
            # node_modules 路径也不会撞上 260 字符上限。
            $rc = Start-Process -FilePath 'robocopy.exe' -Wait -NoNewWindow -PassThru `
                -ArgumentList @($depSrc, $depDest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
            if ($rc.ExitCode -ge 8) { throw "robocopy 复制依赖失败（代码 $($rc.ExitCode)）" }
        } catch {
            if (Test-Path $depDest) { Remove-Item -LiteralPath $depDest -Recurse -Force }
            if (Test-Path $depOld) { Move-Item -LiteralPath $depOld -Destination $depDest -Force }
            throw
        }
        if (Test-Path $depOld) { Remove-Item -LiteralPath $depOld -Recurse -Force }
    }

    # 版本信息：只改 Node 那半边，Chrome/ffmpeg/Python 保持安装时写下的值。
    # appSrcHash 是构建机上算的东西（源码 size+mtime），补丁装完必然对不上，
    # 干脆去掉，免得留一个看着像真的、其实没有意义的哈希。
    if ($installed) {
        $installed.app = $patch.appVersion
        $installed.PSObject.Properties.Remove('appSrcHash')
        $installed | Add-Member -NotePropertyName 'patchedAt' -NotePropertyValue $patch.builtAt -Force
        $installed | Add-Member -NotePropertyName 'patchLockHash' -NotePropertyValue $patch.lockHash -Force
        $installed | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $versionsPath -Encoding UTF8
    }

    Write-Ok "已更新 $copied 个文件"
} catch {
    Write-Host "  更新过程中出错：$($_.Exception.Message)" -ForegroundColor Red
    Restore-Backup
    Fail $_.Exception.Message
}

# ── 7. 校验 ───────────────────────────────────────────────────────────
Write-Step "正在校验…"
$bad = @()
foreach ($rel in $patch.files.PSObject.Properties.Name) {
    $dest = Join-Path $appDir $rel
    if (-not (Test-Path -LiteralPath $dest -PathType Leaf)) { $bad += $rel; continue }
    $h = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $patch.files.$rel) { $bad += $rel }
}
if ($bad.Count -gt 0) {
    Write-Host "  有 $($bad.Count) 个文件校验不通过，例如 $($bad[0])" -ForegroundColor Red
    Restore-Backup
    Fail "文件校验不通过"
}
Write-Ok "校验通过"

Write-Host ""
Write-Ok "已更新到 $($patch.appVersion)。"
Write-Step "备份留在 $backupDir，确认新版本没问题后可以删掉。"
Write-Host ""
if (-not $env:PROMPTCUT_PATCH_NONINTERACTIVE) { Read-Host "按回车关闭" }

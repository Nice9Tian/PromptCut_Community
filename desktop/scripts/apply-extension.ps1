<#
    PromptCut 拓展库包安装器。随拓展包发给用户，不在构建机运行。

    把预先下好的 wheel 和模型装进已安装的 PromptCut：
      wheel  → <安装目录>\runtime\pylibs      （pip install --no-index，全程离线）
      模型   → %APPDATA%\com.promptcut.desktop\models
               （文件和目录都行：Grounding DINO 那种 HF snapshot 是一整个目录）
      许可证 → %APPDATA%\com.promptcut.desktop\models\THIRD-PARTY-LICENSES-<包名>.txt（各档各一份，互不覆盖）
               （MIT/Apache-2.0/BSD-3-Clause 都要求随分发附带全文，所以它必须跟着
                 模型一起落到用户机器上，而不是只留在 exe 里）

    离线是重点：这个包存在的理由就是用户那边 pip 装不上（断网、内网、镜像不通）。
    所以安装过程绝不联网，--no-index 明确禁掉 PyPI。

    用法：
      .\apply-extension.ps1                     # 装到默认位置
      .\apply-extension.ps1 -InstallDir <路径>  # 装到指定位置
      .\apply-extension.ps1 -WhatIf             # 只检查不写入
#>
[CmdletBinding()]
param(
    [string] $InstallDir,
    [switch] $WhatIf
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Step { param([string] $T) Write-Host "  $T" }
function Ok   { param([string] $T) Write-Host "  $T" -ForegroundColor Green }

function Fail {
    param([string] $T)
    Write-Host ""
    Write-Host "  安装未完成：$T" -ForegroundColor Red
    Write-Host "  软件本身不受影响，该功能会继续用不需要拓展的那条路。" -ForegroundColor Red
    Write-Host ""
    if (-not $env:PROMPTCUT_EXT_NONINTERACTIVE) { Read-Host "按回车关闭" }
    exit 1
}

Write-Host ""
Write-Host "PromptCut 拓展库" -ForegroundColor Cyan
Write-Host ""

$manifestPath = Join-Path $PackRoot 'extension.json'
if (-not (Test-Path $manifestPath)) { Fail "包不完整，缺 extension.json。请重新下载。" }
$m = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
if ($m.format -ne 'promptcut-extension/1') { Fail "包格式不认识（$($m.format)）。" }

Step "拓展：$($m.label) $($m.version)"
# tier 是给用户看的档位（light / full），provides 是这个包让哪几个 promptcut_* 模块能跑起来。
# 老包（shots / track / stt）没有这两个字段，就按「名字即模块名」处理。
if ($m.tier) { Step "档位：$($m.tier)" }
$modules = if ($m.provides) { @($m.provides) } else { @($m.name) }
Step "包含能力：$($modules -join ', ')"

if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'PromptCut' }
$python  = Join-Path $InstallDir 'runtime\python\python.exe'
$pylibs  = Join-Path $InstallDir 'runtime\pylibs'
# 模型和用户下载的语音模型放一起，卸载软件时不会被删掉
$models  = Join-Path $env:APPDATA 'com.promptcut.desktop\models'

if (-not (Test-Path $python)) {
    Fail "在 $InstallDir 找不到 PromptCut 自带的 Python。装在别处就用 -InstallDir 指定。"
}
Step "安装位置：$InstallDir"

# 拓展只带依赖和模型，用到它们的那半边代码在应用里。版本太旧就没有那半边，
# 这时候必须在动手之前拦住 —— 装完了才自检失败，用户已经白等了一分钟，
# 而且盘上多了一堆没人用的 wheel。
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

$versionsPath = Join-Path $InstallDir 'runtime\VERSIONS.json'
if ($m.requiresApp -and (Test-Path $versionsPath)) {
    $appVersion = (Get-Content -Raw -Encoding UTF8 -LiteralPath $versionsPath | ConvertFrom-Json).app
    if ($appVersion -and (Compare-Version $appVersion $m.requiresApp) -lt 0) {
        Fail ("你的 PromptCut 是 $appVersion，这个拓展需要 $($m.requiresApp) 或更新。" +
              "先用更新补丁（或完整安装包）升级，再装这个拓展。")
    }
    Step "应用版本：$appVersion"
}

$wheelDir = Join-Path $PackRoot 'wheels'
$wheels = @(Get-ChildItem -LiteralPath $wheelDir -File -ErrorAction SilentlyContinue)
if ($wheels.Count -eq 0) { Fail "包里没有 wheel。请重新下载。" }
Step "离线依赖：$($wheels.Count) 个"

# 模型条目可以是文件（transnetv2.onnx）也可以是目录（grounding-dino-tiny 那种 HF
# snapshot：config + safetensors + tokenizer 一整套，拆开没有意义）。所以这里不加
# -File，目录也要收进来，下面递归拷。
$modelSrc = Join-Path $PackRoot 'models'
$modelItems = @(Get-ChildItem -LiteralPath $modelSrc -ErrorAction SilentlyContinue)
if ($modelItems.Count -gt 0) {
    $names = $modelItems | ForEach-Object { if ($_.PSIsContainer) { "$($_.Name)\" } else { $_.Name } }
    Step "模型：$($names -join ', ')"
}

# 许可证全文（make-extension.mjs 生成，末尾附了 MIT / Apache-2.0 / BSD-3-Clause 三份正文）。
# 带模型的包一定有这个文件；没有就是包被人拆过或者用老脚本打的，宁可拦下也不要发一份
# 没有许可证的权重出去 —— 这正是 2026-09-07 之前的老包踩的坑。
$licenseSrc = Join-Path $PackRoot 'THIRD-PARTY-LICENSES.txt'
$hasLicense = Test-Path -LiteralPath $licenseSrc
if ($modelItems.Count -gt 0 -and -not $hasLicense) {
    Fail "包里带了模型却没有 THIRD-PARTY-LICENSES.txt，包不完整。请重新下载。"
}
if ($hasLicense) { Step "许可证全文：THIRD-PARTY-LICENSES.txt（$([int]((Get-Item -LiteralPath $licenseSrc).Length / 1024)) KB）" }

if ($WhatIf) {
    Write-Host ""
    Ok "检查通过。加了 -WhatIf，没有写入任何文件。"
    Write-Host ""
    exit 0
}

# ── 装依赖 ────────────────────────────────────────────────────────────
Step "正在安装依赖（离线，不联网）…"
$null = New-Item -ItemType Directory -Force -Path $pylibs
# --no-index + --find-links：只认包里这些 wheel，绝不去 PyPI
& $python -m pip install --no-index --find-links $wheelDir --target $pylibs --upgrade `
    @($wheels | ForEach-Object { $_.FullName })
if ($LASTEXITCODE -ne 0) { Fail "pip 离线安装失败（退出码 $LASTEXITCODE）。" }
Ok "依赖装好了"

# ── 放模型 ────────────────────────────────────────────────────────────
if ($modelItems.Count -gt 0) {
    $null = New-Item -ItemType Directory -Force -Path $models
    foreach ($it in $modelItems) {
        $dest = Join-Path $models $it.Name
        if ($it.PSIsContainer) {
            # 先删再拷：Copy-Item -Recurse 往一个已存在的同名目录里拷会拷成
            # models\grounding-dino-tiny\grounding-dino-tiny\…，而且升级时旧文件不会被清掉
            if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
            Copy-Item -LiteralPath $it.FullName -Destination $dest -Recurse -Force
        } else {
            Copy-Item -LiteralPath $it.FullName -Destination $dest -Force
        }
    }
    Ok "模型已放到 $models"
}

# ── 放许可证 ──────────────────────────────────────────────────────────
# 和模型放在同一个目录：用户要找「这些权重是什么授权」时，看的就是权重旁边。
# 卸载软件不会删 %APPDATA%，所以它和模型同生共死，不会出现「模型还在、许可证没了」。
if ($hasLicense) {
    $null = New-Item -ItemType Directory -Force -Path $models
    # 按包名落地,别用一个共用文件名:装 light 会把 full 留下的那份整个盖掉,
    # 而 bootstapir / grounding-dino 还躺在 models 里,就没有许可证记录了(复查实测)。
    $licenseDst = Join-Path $models "THIRD-PARTY-LICENSES-$($m.name).txt"
    Copy-Item -LiteralPath $licenseSrc -Destination $licenseDst -Force
    Ok "许可证全文已放到 $licenseDst"
}

# ── 验收 ──────────────────────────────────────────────────────────────
# 光是文件到位不算成功，得让程序自己说一句就绪。一个包可能提供好几个能力
# （light 档 = 镜头识别 + 主体检测），逐个问。
Step "正在验证…"
$env:PROMPTCUT_PYLIBS = $pylibs
$env:PROMPTCUT_MODELS = $models

# 每个模块的 status 形状不一样，就绪的判据也不一样：
#   shots / track  顶层 "ready": true
#   subject        分 light / full 两档，engine 不为 null 就算能跑
#   stt            没有 ready 字段，看引擎 installed
function Test-ModuleReady {
    param([string] $Mod, [string] $Text)
    switch ($Mod) {
        'subject' { return ($Text -match '"engine"\s*:\s*"(light|full)"') }
        'stt'     { return ($Text -match '"installed"\s*:\s*true') }
        default   { return ($Text -match '"ready"\s*:\s*true') }
    }
}

foreach ($mod in $modules) {
    $probe = & $python -m "promptcut_$mod" status 2>&1 | Out-String
    if (Test-ModuleReady -Mod $mod -Text $probe) {
        Ok "验证通过：promptcut_$mod 已就绪"
    } elseif ($probe -match 'No module named') {
        # 版本号看着够、但代码确实不在，多半是装了个手改过的目录
        Fail ("这个 PromptCut 里没有 promptcut_$mod 的程序代码，" +
              "拓展只提供依赖和模型。请先把软件升级到 $($m.requiresApp) 或更新。")
    } else {
        Write-Host "  验证没通过，promptcut_$mod 仍报告未就绪：" -ForegroundColor Yellow
        Write-Host "  $($probe.Trim())" -ForegroundColor Yellow
        Fail "文件已就位但自检未通过，请把上面这段反馈给开发者。"
    }
}

Write-Host ""
Ok $m.note
Write-Host ""
if (-not $env:PROMPTCUT_EXT_NONINTERACTIVE) { Read-Host "按回车关闭" }

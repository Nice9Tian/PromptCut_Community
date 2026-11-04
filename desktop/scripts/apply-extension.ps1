<#
    PromptCut extension pack installer. Shipped to users along with the extension pack, not run on the build machine.

    Installs the pre-downloaded wheels and models into an installed PromptCut:
      wheel  → <install-dir>\runtime\pylibs      (pip install --no-index, fully offline)
      models → %APPDATA%\com.promptcut.desktop\models
               (files and directories both work: an HF snapshot like Grounding DINO is a whole directory)
      license → %APPDATA%\com.promptcut.desktop\models\THIRD-PARTY-LICENSES-<pack-name>.txt (one per tier, never overwriting each other)
               (MIT/Apache-2.0/BSD-3-Clause all require the full text to ship with distributions, so it must travel with
                 the models to the user's machine, not just stay inside the exe)

    Offline is the point: this pack exists because pip cannot install on the user's side (no network, intranet, mirror unreachable).
    So installation never touches the network; --no-index explicitly disables PyPI.

    Usage:
      .\apply-extension.ps1                     # install to the default location
      .\apply-extension.ps1 -InstallDir <path>  # install to a specific location
      .\apply-extension.ps1 -WhatIf             # check only, write nothing
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
    Write-Host "  Installation not completed: $T" -ForegroundColor Red
    Write-Host "  The app itself is unaffected; the feature keeps using the path that does not need the extension." -ForegroundColor Red
    Write-Host ""
    if (-not $env:PROMPTCUT_EXT_NONINTERACTIVE) { Read-Host "Press Enter to close" }
    exit 1
}

Write-Host ""
Write-Host "PromptCut extension library" -ForegroundColor Cyan
Write-Host ""

$manifestPath = Join-Path $PackRoot 'extension.json'
if (-not (Test-Path $manifestPath)) { Fail "Incomplete pack: extension.json is missing. Please download it again." }
$m = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
if ($m.format -ne 'promptcut-extension/1') { Fail "Unrecognized pack format ($($m.format))." }

Step "Extension: $($m.label) $($m.version)"
# tier is the tier shown to users (light / full), and provides lists which promptcut_* modules this pack makes runnable.
# Old packs (shots / track / stt) do not have these two fields, so they are handled as "the name is the module name".
if ($m.tier) { Step "Tier: $($m.tier)" }
$modules = if ($m.provides) { @($m.provides) } else { @($m.name) }
Step "Capabilities: $($modules -join ', ')"

if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'PromptCut' }
$python  = Join-Path $InstallDir 'runtime\python\python.exe'
$pylibs  = Join-Path $InstallDir 'runtime\pylibs'
# Models are kept together with the speech models the user downloads, and are not deleted when the app is uninstalled
$models  = Join-Path $env:APPDATA 'com.promptcut.desktop\models'

if (-not (Test-Path $python)) {
    Fail "Cannot find the Python bundled with PromptCut in $InstallDir. If it is installed elsewhere, specify it with -InstallDir."
}
Step "Install location: $InstallDir"

# An extension carries only dependencies and models; the half of the code that uses them lives in the app. A version that is too old lacks that half,
# so it must be stopped before any work starts: if the self-check fails only after installing, the user has already waited a minute for nothing,
# and the disk is left with a pile of wheels nobody uses.
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
        Fail ("Your PromptCut is $appVersion; this extension requires $($m.requiresApp) or newer. " +
              "First upgrade with an update patch (or the full installer), then install this extension.")
    }
    Step "App version: $appVersion"
}

$wheelDir = Join-Path $PackRoot 'wheels'
$wheels = @(Get-ChildItem -LiteralPath $wheelDir -File -ErrorAction SilentlyContinue)
if ($wheels.Count -eq 0) { Fail "The pack contains no wheels. Please download it again." }
Step "Offline dependencies: $($wheels.Count)"

# A model entry can be a file (transnetv2.onnx) or a directory (an HF snapshot like grounding-dino-tiny:
# config + safetensors + tokenizer is one complete set, and splitting it up makes no sense). So we do not add
# -File here; directories must be included too, and are copied recursively below.
$modelSrc = Join-Path $PackRoot 'models'
$modelItems = @(Get-ChildItem -LiteralPath $modelSrc -ErrorAction SilentlyContinue)
if ($modelItems.Count -gt 0) {
    $names = $modelItems | ForEach-Object { if ($_.PSIsContainer) { "$($_.Name)\" } else { $_.Name } }
    Step "Models: $($names -join ', ')"
}

# The full license text (generated by make-extension.mjs, with the three license texts MIT / Apache-2.0 / BSD-3-Clause appended at the end).
# A pack with models always has this file; if it is missing, the pack was taken apart or built with an old script, and blocking it is better than sending out
# weights without a license: that is exactly the pitfall old packs before 2026-09-07 fell into.
$licenseSrc = Join-Path $PackRoot 'THIRD-PARTY-LICENSES.txt'
$hasLicense = Test-Path -LiteralPath $licenseSrc
if ($modelItems.Count -gt 0 -and -not $hasLicense) {
    Fail "The pack contains models but no THIRD-PARTY-LICENSES.txt, so it is incomplete. Please download it again."
}
if ($hasLicense) { Step "Full license text: THIRD-PARTY-LICENSES.txt ($([int]((Get-Item -LiteralPath $licenseSrc).Length / 1024)) KB)" }

if ($WhatIf) {
    Write-Host ""
    Ok "Checks passed. -WhatIf was given, so no files were written."
    Write-Host ""
    exit 0
}

# ── Install dependencies ────────────────────────────────────────────────────────────
Step "Installing dependencies (offline, no network)…"
$null = New-Item -ItemType Directory -Force -Path $pylibs
# --no-index + --find-links: only the wheels in the pack are accepted, never PyPI
& $python -m pip install --no-index --find-links $wheelDir --target $pylibs --upgrade `
    @($wheels | ForEach-Object { $_.FullName })
if ($LASTEXITCODE -ne 0) { Fail "pip offline install failed (exit code $LASTEXITCODE)." }
Ok "Dependencies installed"

# ── Place the models ────────────────────────────────────────────────────────────
if ($modelItems.Count -gt 0) {
    $null = New-Item -ItemType Directory -Force -Path $models
    foreach ($it in $modelItems) {
        $dest = Join-Path $models $it.Name
        if ($it.PSIsContainer) {
            # Delete first, then copy: copying with Copy-Item -Recurse into an existing directory of the same name ends up as
            # models\grounding-dino-tiny\grounding-dino-tiny\…, and on upgrade the old files are not cleared out
            if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
            Copy-Item -LiteralPath $it.FullName -Destination $dest -Recurse -Force
        } else {
            Copy-Item -LiteralPath $it.FullName -Destination $dest -Force
        }
    }
    Ok "Models placed in $models"
}

# ── Place the license ──────────────────────────────────────────────────────────
# Put it in the same directory as the models: when users look for "what license these weights are under", they look right next to the weights.
# Uninstalling the app does not delete %APPDATA%, so it lives and dies with the models, and we never end up with "models still there, license gone".
if ($hasLicense) {
    $null = New-Item -ItemType Directory -Force -Path $models
    # Write it under the pack name, not one shared file name: installing light would overwrite the one full left behind,
    # leaving bootstapir / grounding-dino, which still sit in models, with no license record (confirmed by testing in the re-review).
    $licenseDst = Join-Path $models "THIRD-PARTY-LICENSES-$($m.name).txt"
    Copy-Item -LiteralPath $licenseSrc -Destination $licenseDst -Force
    Ok "Full license text placed at $licenseDst"
}

# ── Acceptance check ──────────────────────────────────────────────────────────────
# Having the files in place does not count as success: the program itself has to report ready. One pack may provide several capabilities
# (light tier = shot detection + subject detection), so ask them one by one.
Step "Verifying…"
$env:PROMPTCUT_PYLIBS = $pylibs
$env:PROMPTCUT_MODELS = $models

# The status of each module has a different shape, so the readiness criterion differs too:
#   shots / track  top-level "ready": true
#   subject        two tiers, light / full; runnable as long as engine is not null
#   stt            no ready field; check whether the engine is installed
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
        Ok "Verified: promptcut_$mod is ready"
    } elseif ($probe -match 'No module named') {
        # The version number looks sufficient but the code really is not there; most likely a hand-modified directory was installed
        Fail ("This PromptCut does not contain the program code for promptcut_$mod; " +
              "the extension only provides dependencies and models. Please upgrade the app to $($m.requiresApp) or newer first.")
    } else {
        Write-Host "  Verification failed; promptcut_$mod still reports not ready:" -ForegroundColor Yellow
        Write-Host "  $($probe.Trim())" -ForegroundColor Yellow
        Fail "The files are in place but the self-check failed. Please send the output above to the developers."
    }
}

Write-Host ""
Ok $m.note
Write-Host ""
if (-not $env:PROMPTCUT_EXT_NONINTERACTIVE) { Read-Host "Press Enter to close" }

// Execute the shutdown block of real patches in Windows PowerShell 5.1; processes and clocks are
// isolated with fake objects.
// Scalar .Count on PSCustomObject is $null, which must not cause skipping the sole remaining process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const source = fs.readFileSync(new URL('../scripts/apply-patch.ps1', import.meta.url), 'utf8');
const closeBlock = source.slice(source.indexOf('$running ='), source.indexOf('# ── 5. Backup'));
assert.ok(closeBlock.includes('Start-Process') && closeBlock.includes('Stop-Process'));

function exercise(count, survives = false) {
  const script = `
$ErrorActionPreference = 'Stop'
$shellExe = 'isolated-test-shell'
$Force = $true
$script:quitCalls = 0
$script:stopCalls = 0
$script:waitCalls = 0
$script:tick = 0
$script:remaining = ${count}
$script:survives = $${survives}
function Get-TargetProcesses {
  for ($i = 0; $i -lt $script:remaining; $i++) {
    $proc = New-Object PSObject
    $proc | Add-Member -MemberType ScriptMethod -Name CloseMainWindow -Value { return $true }
    [pscustomobject]@{ Id = 10000 + $i; Name = 'isolated'; Proc = $proc }
  }
}
function Get-ActiveAiRuns { return 0 }
function Test-Path { return $true }
function Start-Process { $script:quitCalls++ }
function Get-Date { $script:tick++; return ([datetime]'2026-01-01').AddSeconds($script:tick * 5) }
function Start-Sleep {
  param($Milliseconds, $Seconds)
  if ($Milliseconds) { $script:waitCalls++; if (-not $script:survives) { $script:remaining = 0 } }
}
function Stop-Process { param($Id, [switch]$Force, $ErrorAction); $script:stopCalls++ }
function Write-Step { param($message) }
function Write-Warn { param($message) }
function Write-Ok { param($message) }
function Fail { param($message); throw 'remaining-process-blocked' }
$failed = $false
try {
${closeBlock}
} catch { if ($_.Exception.Message -ne 'remaining-process-blocked') { throw }; $failed = $true }
[pscustomobject]@{ quit=$script:quitCalls; stops=$script:stopCalls; waits=$script:waitCalls; failed=$failed; remaining=$script:remaining } | ConvertTo-Json -Compress
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('no need to close when there are no processes', { skip: process.platform !== 'win32' }, () => {
  assert.deepEqual(exercise(0), { quit: 0, stops: 0, waits: 0, failed: false, remaining: 0 });
});
for (const count of [1, 2]) {
  test(`${count} processes all get --quit first and are awaited for a clean exit`, { skip: process.platform !== 'win32' }, () => {
    assert.deepEqual(exercise(count), { quit: 1, stops: 0, waits: 1, failed: false, remaining: 0 });
  });
}
test('after a force kill, a single remaining process must still block overwriting files', { skip: process.platform !== 'win32' }, () => {
  assert.deepEqual(exercise(1, true), { quit: 1, stops: 1, waits: 1, failed: true, remaining: 1 });
});

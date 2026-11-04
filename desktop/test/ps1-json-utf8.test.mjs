import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Check path executing the actual installer script: both manifest and existing version use
// UTF-8 Chinese without BOM.
// Legacy Get-Content swallows JSON quotes on Chinese Windows PowerShell 5.1; do not modify
// system code page.
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
for (const kind of ['patch', 'extension']) {
  test(`${kind} real script reads the UTF-8 Chinese manifest and existing version in PS 5.1, without writing to the install directory`, { skip: process.platform !== 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-json-utf8-'));
    const installed = path.join(dir, 'installed');
    const script = path.join(dir, `apply-${kind}.ps1`);
    try {
      fs.mkdirSync(path.join(installed, 'runtime', 'app'), { recursive: true });
      const versions = path.join(installed, 'runtime', 'VERSIONS.json');
      const versionsText = JSON.stringify({ app: '0.7.14', note: 'dependencies match baseline' });
      fs.writeFileSync(versions, versionsText, 'utf8');
      fs.copyFileSync(new URL(`../scripts/apply-${kind}.ps1`, import.meta.url), script);
      if (kind === 'patch') {
        fs.mkdirSync(path.join(dir, 'payload'));
        const lockText = JSON.stringify({ version: '0.7.14' });
        fs.writeFileSync(path.join(installed, 'runtime', 'app', 'package-lock.json'), lockText);
        const lockHash = createHash('sha256').update(lockText).digest('hex');
        fs.writeFileSync(path.join(dir, 'patch.json'), JSON.stringify({
          format: 'promptcut-patch/1', appVersion: '0.7.14', depsReason: 'dependencies match baseline',
          shellGeneration: '0.2', minShellVersion: '0.2.0', includesDeps: false, lockHash,
          files: {}, removed: [],
        }), 'utf8');
      } else {
        fs.mkdirSync(path.join(installed, 'runtime', 'python'));
        fs.writeFileSync(path.join(installed, 'runtime', 'python', 'python.exe'), 'WhatIf never executes this');
        fs.mkdirSync(path.join(dir, 'wheels'));
        fs.writeFileSync(path.join(dir, 'wheels', 'fixture.whl'), 'WhatIf never installs this');
        fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify({
          format: 'promptcut-extension/1', name: 'stt', label: '听写能力验收甲',
          version: '1.0.0', requiresApp: '0.7.13',
        }), 'utf8');
      }
      const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); & ${quote(script)} -InstallDir ${quote(installed)} -WhatIf; exit $LASTEXITCODE`;
      // Like the bundled launcher, sets policy only for this PowerShell instance; does not change
      // user or system execution policies.
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
        encoding: 'utf8', windowsHide: true, timeout: 15_000,
        env: {
          ...process.env,
          // Starting Node from PowerShell 7 inherits its module directory; the actual installer launched
          // via Explorer uses PS 5.1 modules.
          PSModulePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
          APPDATA: path.join(dir, 'appdata'), LOCALAPPDATA: path.join(dir, 'localappdata'),
          PROMPTCUT_PATCH_NONINTERACTIVE: '1', PROMPTCUT_EXT_NONINTERACTIVE: '1',
        },
      });
      assert.equal(result.status, 0, (result.stderr || result.stdout).slice(-2000));
      assert.match(result.stdout, kind === 'patch' ? /All checks passed/ : /Check passed/);
      assert.equal(fs.readFileSync(versions, 'utf8'), versionsText);
      assert.deepEqual(fs.readdirSync(path.join(installed, 'runtime')).sort(), kind === 'patch' ? ['VERSIONS.json', 'app'] : ['VERSIONS.json', 'app', 'python']);
    } finally {
      assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

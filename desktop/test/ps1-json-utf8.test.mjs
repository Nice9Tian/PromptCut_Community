import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// 执行实际安装脚本的检查路径：清单和既有版本都使用无 BOM 的 UTF-8 中文。
// 旧 Get-Content 在中文 Windows PowerShell 5.1 上会吃掉 JSON 引号；不改变系统代码页。
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
for (const kind of ['patch', 'extension']) {
  test(`${kind} 真脚本在 PS 5.1 读取 UTF-8 中文清单和既有版本，不写安装目录`, { skip: process.platform !== 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-json-utf8-'));
    const installed = path.join(dir, 'installed');
    const script = path.join(dir, `apply-${kind}.ps1`);
    try {
      fs.mkdirSync(path.join(installed, 'runtime', 'app'), { recursive: true });
      const versions = path.join(installed, 'runtime', 'VERSIONS.json');
      const versionsText = JSON.stringify({ app: '0.7.14', note: '依赖与基准一致' });
      fs.writeFileSync(versions, versionsText, 'utf8');
      fs.copyFileSync(new URL(`../scripts/apply-${kind}.ps1`, import.meta.url), script);
      if (kind === 'patch') {
        fs.mkdirSync(path.join(dir, 'payload'));
        const lockText = JSON.stringify({ version: '0.7.14' });
        fs.writeFileSync(path.join(installed, 'runtime', 'app', 'package-lock.json'), lockText);
        const lockHash = createHash('sha256').update(lockText).digest('hex');
        fs.writeFileSync(path.join(dir, 'patch.json'), JSON.stringify({
          format: 'promptcut-patch/1', appVersion: '0.7.14', depsReason: '依赖与基准一致',
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
      // 与随包启动器一样只对本次 PowerShell 指定策略；不改用户或系统执行策略。
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
        encoding: 'utf8', windowsHide: true, timeout: 15_000,
        env: {
          ...process.env,
          // 从 PowerShell 7 起 Node 时会继承它的模块目录；真安装器经 Explorer 使用的是 PS 5.1 模块。
          PSModulePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
          APPDATA: path.join(dir, 'appdata'), LOCALAPPDATA: path.join(dir, 'localappdata'),
          PROMPTCUT_PATCH_NONINTERACTIVE: '1', PROMPTCUT_EXT_NONINTERACTIVE: '1',
        },
      });
      assert.equal(result.status, 0, (result.stderr || result.stdout).slice(-2000));
      assert.match(result.stdout, kind === 'patch' ? /检查全部通过/ : /检查通过/);
      assert.equal(fs.readFileSync(versions, 'utf8'), versionsText);
      assert.deepEqual(fs.readdirSync(path.join(installed, 'runtime')).sort(), kind === 'patch' ? ['VERSIONS.json', 'app'] : ['VERSIONS.json', 'app', 'python']);
    } finally {
      assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

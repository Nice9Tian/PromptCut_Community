import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('incompressible archives stay on disk and large portable snapshots are omitted before reading blocks', { timeout: 120000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'promptcut-disk-memory-'));
  const script = `
    import assert from 'node:assert/strict';
    import { randomBytes, createHash } from 'node:crypto';
    import { FramePipeline } from ${JSON.stringify(new URL('../frame-pipeline.mjs', import.meta.url).href)};
    const options = { root: ${JSON.stringify(root)}, origin: () => '' };
    const project = { id: 'disk', width: 1920, height: 1080, fps: 30, duration: 90, media: [], tracks: [] };
    const hashes = new Map();
    const hash = s => createHash('sha256').update(s).digest('hex');
    let service = new FramePipeline(options), entry = await service.entry(project);
    try {
      for (let n = 0; n < 128; n++) {
        const html = '<article>' + randomBytes(768 * 1024).toString('base64') + '旅行</article>';
        hashes.set(n, hash(html));
        service.record(entry, n, html, [{ id: 'noise', frame: n, html }]);
        if (n % 8 === 7) await service.save(entry);
      }
      assert.equal(await service.portableArchive(entry), null);
      assert.ok(entry.html.blocks.every(b => b.file && b.encodedBytes));
      await service.close();
      service = new FramePipeline(options); entry = await service.entry(project);
      assert.equal(entry.html.size, 128);
      for (const n of [0, 63, 127]) {
        assert.equal(hash(entry.html.get(n)), hashes.get(n));
        assert.equal(hash(entry.controls.get('noise').get(n)), hashes.get(n));
      }
      // Budget inspection must not open any disk block.
      for (const b of entry.html.blocks) Object.defineProperty(b, 'data', { get() { throw Error('eager read'); } });
      assert.equal(await service.portableArchive(entry), null);
      console.log('disk blocks, reopen, controls and portable budget passed');
    } finally { await service.close(); }
  `;
  try {
    const child = spawn(process.execPath, ['--max-old-space-size=192', '--input-type=module', '-e', script], { windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => child.kill(), 110000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }).finally(() => clearTimeout(timer));
    assert.equal(code, 0, output);
    assert.match(output, /portable budget passed/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('cold stage and newly discovered controls survive sampling and saving under a 192 MiB heap', { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'promptcut-memory-'));
  const script = `
    import assert from 'node:assert/strict';
    import { FramePipeline } from ${JSON.stringify(new URL('../frame-pipeline.mjs', import.meta.url).href)};
    const service = new FramePipeline({ root: ${JSON.stringify(root)}, origin: () => '' });
    const entry = await service.entry({ id: 'cold', width: 1920, height: 1080, fps: 30, duration: 90, media: [], tracks: [] });
    const sample = '<article>' + 'x'.repeat(1024 * 1024) + '旅行</article>';
    const html = n => JSON.parse(JSON.stringify(sample + '<!--' + n + '-->'));
    try {
      for (let n = 0; n < 160; n++) service.record(entry, n, html(n), [{ id: 'late-control', frame: n, html: html(n) }]);
      assert.ok(entry.html.overlay.size < 16);
      assert.ok(entry.controls.get('late-control').pendingSpill.size > 0);
      await service.save(entry);
      assert.equal(entry.html.size, 160);
      for (const n of [0, 79, 159]) assert.equal(entry.html.get(n), html(n));
      for (const n of [10, 89]) service.record(entry, n, 'edited-' + n, [{ id: 'late-control', frame: n, html: 'control-' + n }]);
      service.record(entry, 170, html(170), [{ id: 'another-control', frame: 0, html: html(170) }]);
      await service.save(entry);
      for (const n of [10, 89]) {
        assert.equal(entry.html.get(n), 'edited-' + n);
        assert.equal(entry.controls.get('late-control').get(n), 'control-' + n);
      }
      assert.equal(entry.html.get(79), html(79));
      assert.equal(entry.controls.get('another-control').get(0), html(170));
      console.log('bounded sampling, save, sparse edits and control cache passed');
    } finally { await service.close(); }
  `;
  try {
    const child = spawn(process.execPath, ['--max-old-space-size=192', '--input-type=module', '-e', script], { windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => child.kill(), 55000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }).finally(() => clearTimeout(timer));
    assert.equal(code, 0, output);
    assert.match(output, /bounded sampling/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

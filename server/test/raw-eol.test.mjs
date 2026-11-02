import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rawEolPlugin, rawEolTarget, rawModuleCode } from '../raw-eol.mjs';

test('raw-eol: only accepts absolute paths under the project\'s src/ that have ?raw', () => {
  const root = path.resolve('/proj');
  const inSrc = path.join(root, 'src', 'cards', 'a.tsx');
  assert.equal(rawEolTarget(root, `${inSrc}?raw`), inSrc);
  assert.equal(rawEolTarget(root, `${inSrc}?import&raw`), inSrc);
  assert.equal(rawEolTarget(root, inSrc), null, 'without ?raw');
  assert.equal(rawEolTarget(root, `${inSrc}?rawx`), null);
  assert.equal(rawEolTarget(root, `${path.join(root, 'node_modules', 'x.js')}?raw`), null, 'outside src');
  assert.equal(rawEolTarget(root, `${path.join(root, 'srcx', 'x.ts')}?raw`), null);
  assert.equal(rawEolTarget(root, 'src/a.ts?raw'), null, 'relative path');
});

test('raw-eol: CRLF and LF sources yield the same module code', () => {
  const lf = 'const a = 1;\nconst b = `x\ny`;\n';
  assert.equal(rawModuleCode(lf.replace(/\n/g, '\r\n')), rawModuleCode(lf));
  assert.equal(rawModuleCode(lf), `export default ${JSON.stringify(lf)}`);
});

test('raw-eol: the plugin\'s load reads from disk, normalizes line endings and registers a watch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-eol-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const file = path.join(root, 'src', 'a.ts');
    fs.writeFileSync(file, 'a\r\nb\r\n');
    const plugin = rawEolPlugin();
    plugin.configResolved({ root });
    const watched = [];
    const ctx = { addWatchFile: (f) => watched.push(f) };
    assert.equal(plugin.load.call(ctx, `${file}?raw`), 'export default "a\\nb\\n"');
    assert.deepEqual(watched, [file]);
    assert.equal(plugin.load.call(ctx, file), null);
    assert.equal(plugin.load.call(ctx, `${path.join(root, 'src', 'missing.ts')}?raw`), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

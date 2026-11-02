/**
 * X7-legacy-target (`docs/plan/m6c-contract.md` prerequisite of X7, lead session ruling):
 * full-frame requests for `?preview=legacy` must target the **prerender process**.
 *
 * `FramePipeline` in editor process is `interactive: false`; `user` / `playback` lane always
 * returns 503 `USE_PRERENDER` (`laneRefused`). `UnifiedPreview.tsx` previously sent `see` to editor
 * process with `target: "user"`, so legacy page only showed an error "Interactive frame requests
 * must directly target prerender process" with no picture. Two things are guarded here:
 *   1. Prerequisite: `interactive: false` rejects user / playback lane, `interactive: true` does
 *      not reject;
 *   2. In all `see_frames` / `frameRequest` calls in `src/`, as long as lane is `user` or
 *      `playback`, target cannot be `"user"` (uses TypeScript AST to find call sites, not relying
 *      on line numbers).
 *
 * Run: node --experimental-test-module-mocks --test server/test/legacy-preview-target.test.mjs
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('Unit test does not open Chrome'); },
    findFfmpeg: async () => { throw new Error('Unit test does not look for ffmpeg'); },
    streamPngVideo: () => { throw new Error('Unit test does not encode'); },
    bakeFrames: async () => { throw new Error('Unit test does not prerender'); },
  },
});
const { FramePipeline } = await import('../frame-pipeline.mjs');

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/** All .ts / .tsx under `src/` (excluding node_modules) */
function sources(dir = path.join(ROOT, 'src'), out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) { if (item.name !== 'node_modules') sources(file, out); }
    else if (/\.(ts|tsx)$/.test(item.name) && !item.name.endsWith('.d.ts')) out.push(file);
  }
  return out;
}

/** String value of a key in object literal (returns undefined if not string literal) */
function stringProp(obj, name) {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (p.name.text ?? p.name.escapedText) === name && ts.isStringLiteralLike(p.initializer)) return p.initializer.text;
  }
  return undefined;
}

/** `{ target, lane }` for each `see_frames(…)` / `frameRequest(…)` call (takes last object literal in args) */
function frameCalls() {
  const calls = [];
  for (const file of sources()) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/see_frames|frameRequest/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 'see_frames' || node.expression.text === 'frameRequest')) {
        const objs = node.arguments.filter(ts.isObjectLiteralExpression);
        const opts = objs.find(o => stringProp(o, 'lane') !== undefined || stringProp(o, 'target') !== undefined);
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        calls.push({ file: path.relative(ROOT, file).replaceAll('\\', '/'), line: line + 1, fn: node.expression.text,
          target: opts ? stringProp(opts, 'target') : undefined, lane: opts ? stringProp(opts, 'lane') : undefined });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return calls;
}

test('X7-legacy-target precondition: the editor process (interactive: false) refuses the user / playback lane, while the prerender process (interactive: true) does not', async () => {
  const editor = new FramePipeline({ root: path.join(ROOT, 'out', 'x7-legacy-target-unused'), origin: () => 'http://127.0.0.1:1', interactive: false });
  const prerender = new FramePipeline({ root: path.join(ROOT, 'out', 'x7-legacy-target-unused'), origin: () => 'http://127.0.0.1:1', interactive: true });
  try {
    for (const lane of ['user', 'playback']) {
      const refused = editor.laneRefused(lane);
      assert.equal(refused?.status, 503, `The editor process's ${lane} lane returns 503`);
      assert.equal(refused?.code, 'USE_PRERENDER');
      assert.equal(prerender.laneRefused(lane), null, `The prerender process answers the ${lane} lane`);
    }
  } finally {
    await Promise.allSettled([editor.close(), prerender.close()]);
  }
});

test('X7-legacy-target legacy preview whole-frame requests go to the prerender process: no user / playback lane call has target "user"', () => {
  const calls = frameCalls();
  const legacy = calls.filter(c => c.file === 'src/editor/preview/UnifiedPreview.tsx' && c.fn === 'see_frames' && c.lane === 'user');
  assert.equal(legacy.length, 1, `The see_frames in UnifiedPreview that fetches a whole frame when paused: ${JSON.stringify(calls.filter(c => c.file.endsWith('UnifiedPreview.tsx')))}`);
  assert.equal(legacy[0].target, 'prerender', 'The legacy whole-frame request must go to the prerender process');
  const wrong = calls.filter(c => (c.lane === 'user' || c.lane === 'playback') && c.target === 'user');
  assert.deepEqual(wrong, [], 'Sending the user / playback lane to the editor process only gets 503');
});

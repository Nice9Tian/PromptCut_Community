/**
 * X7-legacy-target(`docs/plan/m6c-contract.md` X7 的前提,主会话裁定):`?preview=legacy` 的整帧请求要打**预渲染进程**。
 *
 * 编辑器进程的 `FramePipeline` 是 `interactive: false`,`user` / `playback` lane 一律回 503 `USE_PRERENDER`
 * (`laneRefused`)。`UnifiedPreview.tsx` 以前按 `target: "user"` 把 `see` 发给编辑器进程,legacy 页面于是只有一条
 * 「交互帧请求请直接打预渲染进程」的报错、没有画面。这里守两件事:
 *   1. 前提:`interactive: false` 拒绝 user / playback lane,`interactive: true` 不拒;
 *   2. `src/` 里所有 `see_frames` / `frameRequest` 调用,只要 lane 是 `user` 或 `playback`,target 就不能是 `"user"`
 *      (用 TypeScript 的语法树找调用点,不靠行号)。
 *
 * 跑法:node --experimental-test-module-mocks --test server/test/legacy-preview-target.test.mjs
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('单测不开 Chrome'); },
    findFfmpeg: async () => { throw new Error('单测不找 ffmpeg'); },
    streamPngVideo: () => { throw new Error('单测不编码'); },
    bakeFrames: async () => { throw new Error('单测不预渲染'); },
  },
});
const { FramePipeline } = await import('../frame-pipeline.mjs');

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/** `src/` 下全部 .ts / .tsx(不进 node_modules) */
function sources(dir = path.join(ROOT, 'src'), out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) { if (item.name !== 'node_modules') sources(file, out); }
    else if (/\.(ts|tsx)$/.test(item.name) && !item.name.endsWith('.d.ts')) out.push(file);
  }
  return out;
}

/** 对象字面量里某个键的字符串值(不是字符串字面量回 undefined) */
function stringProp(obj, name) {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (p.name.text ?? p.name.escapedText) === name && ts.isStringLiteralLike(p.initializer)) return p.initializer.text;
  }
  return undefined;
}

/** 每个 `see_frames(…)` / `frameRequest(…)` 调用的 `{ target, lane }`(取实参里最后一个对象字面量) */
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

test('X7-legacy-target 前提:编辑器进程(interactive: false)拒绝 user / playback lane,预渲染进程(interactive: true)不拒', async () => {
  const editor = new FramePipeline({ root: path.join(ROOT, 'out', 'x7-legacy-target-unused'), origin: () => 'http://127.0.0.1:1', interactive: false });
  const prerender = new FramePipeline({ root: path.join(ROOT, 'out', 'x7-legacy-target-unused'), origin: () => 'http://127.0.0.1:1', interactive: true });
  try {
    for (const lane of ['user', 'playback']) {
      const refused = editor.laneRefused(lane);
      assert.equal(refused?.status, 503, `编辑器进程的 ${lane} lane 回 503`);
      assert.equal(refused?.code, 'USE_PRERENDER');
      assert.equal(prerender.laneRefused(lane), null, `预渲染进程答 ${lane} lane`);
    }
  } finally {
    await Promise.allSettled([editor.close(), prerender.close()]);
  }
});

test('X7-legacy-target legacy 预览的整帧请求打预渲染进程:user / playback lane 的调用没有一处 target 是 "user"', () => {
  const calls = frameCalls();
  const legacy = calls.filter(c => c.file === 'src/editor/preview/UnifiedPreview.tsx' && c.fn === 'see_frames' && c.lane === 'user');
  assert.equal(legacy.length, 1, `UnifiedPreview 里暂停取整帧的那一处 see_frames:${JSON.stringify(calls.filter(c => c.file.endsWith('UnifiedPreview.tsx')))}`);
  assert.equal(legacy[0].target, 'prerender', 'legacy 的整帧请求要打预渲染进程');
  const wrong = calls.filter(c => (c.lane === 'user' || c.lane === 'playback') && c.target === 'user');
  assert.deepEqual(wrong, [], 'user / playback lane 发给编辑器进程只会得到 503');
});

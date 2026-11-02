/*
 * Structural gatekeeper test for `server/vision/**`.
 *
 * `server/vite-plugin-vision.ts` was once a single 2011-line file: ffmpeg frame extraction, render
 * concurrency queue, Chrome worker pool, single-card prerender, and HTTP routes were all crammed
 * together. After splitting into `server/vision/`, two things must be pinned down, otherwise the
 * benefits of the split will quietly regress:
 *
 *   1. **No runtime import cycles between modules.** The queue (render-queue) and worker pool
 *      (worker-pool) need each other: the current direction is unidirectional from worker-pool to
 *      render-queue; ui-renderer writing lastRenderOrigin to the worker pool also goes through a
 *      unidirectional setter. If someone carelessly adds a back-edge, module initialization order
 *      becomes a runtime time bomb (getting undefined without throwing errors).
 *   2. **Plugin shell must not grow back.** The shell should only do three things: wiring,
 *      dispatching by isPrerender, and reaping workers when shutting down the service.
 *
 * Run: `node --test server/test/vision-modules.test.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const VISION = path.join(ROOT, 'server', 'vision');
const SHELL = path.join(ROOT, 'server', 'vite-plugin-vision.ts');

/**
 * Upper line-count limit for the shell.
 *
 * It was 56 lines when the split completed. Setting it to 400 is a "prevent regrowth" red line,
 * not a target: writing a second route in the shell or casually stuffing scheduling logic back in
 * will hit this line first. The target required by the task is 300; 400 is chosen here as a looser
 * hard red line: targets are guarded by code review, red lines are guarded by tests.
 */
const SHELL_MAX_LINES = 400;

const CODE = /\.(mjs|mts|ts|tsx)$/;

function walk(dir, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file, out);
    else if (CODE.test(item.name)) out.push(file);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).replaceAll('\\', '/');

/** All module specifiers in a file: static import / export ... from, and import("…") */
function specifiersOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = [];
  for (const m of text.matchAll(/(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/gs)) found.push(m[1]);
  for (const m of text.matchAll(/(?:^|[^\w$.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]);
  for (const m of text.matchAll(/(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g)) found.push(m[1]);
  return found;
}

/**
 * Resolve a specifier to a real file in the repository. Imports among `server/*.ts` omit extensions
 * (see how other server/*.ts in the repo are written), so extension candidates must be tried here;
 * unresolvable ones (third-party packages, node: built-ins) return null and do not enter the graph.
 */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, `${base}.mjs`, `${base}.mts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

test('The import graph inside server/vision/** has no cycles', () => {
  /** File → modules in the same directory (or subdirectory) that it imports */
  const graph = new Map();
  for (const file of walk(VISION)) {
    const edges = [];
    for (const spec of specifiersOf(file)) {
      const target = resolveSpec(file, spec);
      // Only check edges inside server/vision: external ones (such as ../png-post.mjs) are managed by
      // the bakery-deps test
      if (target && target.startsWith(VISION)) edges.push(rel(target));
    }
    graph.set(rel(file), edges);
  }
  assert.ok(graph.size >= 8, `server/vision should contain the modules that were split out, but only ${graph.size} were found`);

  const state = new Map(); // Unvisited / 1 on stack / 2 completed
  const cycles = [];
  const visit = (node, stack) => {
    if (state.get(node) === 2) return;
    if (state.get(node) === 1) {
      cycles.push([...stack.slice(stack.indexOf(node)), node].join(' → '));
      return;
    }
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) || []) visit(next, stack);
    stack.pop();
    state.set(node, 2);
  };
  for (const node of graph.keys()) visit(node, []);
  assert.deepEqual(cycles, [], 'No runtime import cycles are allowed inside server/vision');
});

test('The plugin shell server/vite-plugin-vision.ts must not grow back', () => {
  const lines = fs.readFileSync(SHELL, 'utf8').split(/\r?\n/).length;
  assert.ok(
    lines < SHELL_MAX_LINES,
    `The shell is now ${lines} lines, over the ${SHELL_MAX_LINES}-line limit. New logic belongs in a module under server/vision/, not in the shell.`,
  );
});

test('The shell still exports visionPlugin / bakeTarget / default (the public interface must not change)', async () => {
  const text = fs.readFileSync(SHELL, 'utf8');
  // vite.config.ts / vite.prerender.config.ts import visionPlugin by name; bakeTarget was exported
  // historically
  assert.match(text, /export function visionPlugin\(\): Plugin \{/, 'The shell must define and export visionPlugin directly');
  assert.match(text, /export \{ bakeTarget \} from "\.\/vision\/bake";/, 'bakeTarget must keep being exported from the shell');
  assert.match(text, /export default visionPlugin;/, 'The default export must not be lost');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { commentRanges, inComment } from './community-ownership.mjs';
import {
  Agent,
  MessageHistory,
  buildTools,
  compactHistory,
  splitMessagesForCompact,
  buildCompactedMessages,
  buildCompactPrompt,
  mergeDeltas,
  expandEntry,
} from '#promptcut-harness';
import * as compactSubpath from '#promptcut-harness/compact.mjs';
import * as skillsSubpath from '#promptcut-harness/skills.mjs';
import * as codeCacheSubpath from '#promptcut-harness/code-cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS_DIR = path.join(ROOT, 'server', 'harness');
const NODE_BUILTINS = new Set(
  builtinModules.flatMap((m) => (m.startsWith('node:') ? [m, m.slice(5)] : [m, `node:${m}`])),
);

function listHarnessFiles(dir = HARNESS_DIR, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) listHarnessFiles(full, out);
    else out.push(full);
  }
  return out.sort();
}

function isInsideHarness(targetPath) {
  const rel = path.relative(HARNESS_DIR, targetPath);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

test('boundary: every file in server/harness only imports node:* built-ins or files inside server/harness', () => {
  const codeFiles = listHarnessFiles().filter((f) => /\.(mjs|js|cjs|ts)$/.test(f));
  assert.ok(codeFiles.length >= 20, `Expected harness modules, found ${codeFiles.length}`);

  const SPEC_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
  const violations = [];

  for (const file of codeFiles) {
    const relFile = path.relative(HARNESS_DIR, file).split(path.sep).join('/');
    const src = fs.readFileSync(file, 'utf8');
    const comments = commentRanges(src);

    SPEC_RE.lastIndex = 0;
    for (let m = SPEC_RE.exec(src); m; m = SPEC_RE.exec(src)) {
      if (inComment(comments, m.index)) continue;
      const spec = m[1] || m[2] || m[3];
      if (spec.startsWith('node:')) {
        if (!NODE_BUILTINS.has(spec)) {
          violations.push(`${relFile}: unknown node builtin "${spec}"`);
        }
        continue;
      }
      if (!spec.startsWith('.')) {
        violations.push(`${relFile}: bare external package specifier "${spec}" is forbidden in zero-dependency harness`);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), spec);
      if (!isInsideHarness(resolved)) {
        violations.push(`${relFile}: specifier "${spec}" escapes server/harness -> ${path.relative(ROOT, resolved)}`);
        continue;
      }
      if (!fs.existsSync(resolved)) {
        violations.push(`${relFile}: specifier "${spec}" points to missing file`);
      }
    }

    // Check JSDoc import() type references too so documentation types never point outside server/harness
    const JSDOC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (let m = JSDOC_IMPORT_RE.exec(src); m; m = JSDOC_IMPORT_RE.exec(src)) {
      const spec = m[1];
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec);
        if (!isInsideHarness(resolved)) {
          violations.push(`${relFile}: JSDoc import("${spec}") escapes server/harness`);
        }
      }
    }

    // Check non-comment relative path string literals that would resolve outside server/harness
    const REL_LITERAL_RE = /['"`](\.\.\/[^'"`\s]+)['"`]/g;
    for (let m = REL_LITERAL_RE.exec(src); m; m = REL_LITERAL_RE.exec(src)) {
      if (inComment(comments, m.index)) continue;
      const resolved = path.resolve(path.dirname(file), m[1]);
      if (!isInsideHarness(resolved)) {
        violations.push(`${relFile}: relative path literal ${m[0]} escapes server/harness`);
      }
    }

    const FORBIDDEN_ROOT_RE = /['"`](?:src|cloud)\/[^'"`]*['"`]/g;
    for (let m = FORBIDDEN_ROOT_RE.exec(src); m; m = FORBIDDEN_ROOT_RE.exec(src)) {
      if (!inComment(comments, m.index)) {
        violations.push(`${relFile}: forbidden host root literal ${m[0]}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('package manifest & subpath imports: promptcut-harness has zero dependencies and valid exports', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(HARNESS_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'promptcut-harness');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies, undefined);

  for (const [subpath, target] of Object.entries(pkg.exports)) {
    assert.equal(typeof target, 'string', `export ${subpath} should map to a string path`);
    if (target.includes('*')) {
      const dir = path.resolve(HARNESS_DIR, path.dirname(target));
      assert.ok(fs.existsSync(dir) && fs.statSync(dir).isDirectory(), `wildcard export dir missing for ${subpath}: ${target}`);
    } else {
      const full = path.resolve(HARNESS_DIR, target);
      assert.ok(isInsideHarness(full) || full === path.join(HARNESS_DIR, 'package.json'), `export ${subpath} escapes harness`);
      assert.ok(fs.existsSync(full), `export target missing for ${subpath}: ${target}`);
    }
  }

  assert.equal(typeof Agent, 'function');
  assert.equal(typeof MessageHistory, 'function');
  assert.equal(typeof buildTools, 'function');
  assert.equal(compactSubpath.compactHistory, compactHistory);
  assert.equal(typeof skillsSubpath.loadSkillCatalog, 'function');
  assert.equal(typeof codeCacheSubpath.createCodeCacheStore, 'function');
});

test('standalone execution: copying server/harness outside the repo and running smoke.mjs succeeds with zero node_modules', () => {
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-harness-isolated-'));
  try {
    const isolatedHarness = path.join(isolatedRoot, 'promptcut-harness');
    fs.cpSync(HARNESS_DIR, isolatedHarness, { recursive: true });

    const stdout = execFileSync(process.execPath, ['smoke.mjs'], {
      cwd: isolatedHarness,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });

    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.rounds, 5);
    assert.deepEqual(parsed.toolCalls, ['load_skill', 'calculator', 'code_cache_write', 'echo']);
    assert.equal(parsed.finalReply, 'All checks passed: 6 * 7 = 42.');
    assert.ok(parsed.compacted.summarizedCount >= 4);
    assert.ok(parsed.compacted.remainingMessages >= 2);
  } finally {
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test('generic buildTools & Agent toolNameMapper: supports custom tools, jobWaiters, schemaDecorators, and alias mapping', async () => {
  const events = [];
  let polls = 0;

  const tools = await buildTools({
    localTools: false,
    pollIntervalMs: 5,
    jobTimeoutMs: 2000,
    onEvent: (ev) => events.push(ev),
    only: new Set(['async_render', 'ping']),
    tools: [
      {
        name: 'async_render',
        description: 'Start an asynchronous render.',
        inputSchema: { type: 'object', properties: { scene: { type: 'string' } }, required: ['scene'] },
      },
      {
        name: 'ping',
        description: 'Direct inline tool.',
        inputSchema: { type: 'object', properties: {} },
        async execute() { return { ok: true, pong: true }; },
      },
      {
        name: 'filtered_out',
        description: 'Hidden by only filter.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    callTool: async (name, input) => {
      if (name === 'async_render') return { jobId: 'job-42', scene: input.scene };
      if (name === 'job_status') {
        polls += 1;
        return polls >= 2 ? { done: true, ok: true, result: { rendered: true, jobId: input.jobId } } : { done: false };
      }
      throw new Error(`Unexpected callTool(${name})`);
    },
    jobWaiters: [
      {
        tools: ['async_render'],
        descriptionSuffix: ' [auto-awaited]',
        match: (name, _input, initial) => name === 'async_render' && Boolean(initial?.jobId),
        poll: (jobId, { callTool }) => callTool('job_status', { jobId }),
      },
    ],
    schemaDecorators: [
      async (list) => {
        const ping = list.find((t) => t.name === 'ping');
        ping.inputSchema.properties.tag = { type: 'string' };
      },
    ],
  });

  assert.equal(tools.some((t) => t.name === 'filtered_out'), false);
  assert.equal(tools.some((t) => t.name === 'text_editor'), false);
  const asyncTool = tools.find((t) => t.name === 'async_render');
  assert.ok(asyncTool.description.endsWith('[auto-awaited]'));
  const pingTool = tools.find((t) => t.name === 'ping');
  assert.deepEqual(pingTool.inputSchema.properties.tag, { type: 'string' });

  const renderRes = await asyncTool.execute({ scene: 'intro' }, { callId: 'c-1', round: 1 });
  assert.deepEqual(renderRes, { rendered: true, jobId: 'job-42' });
  assert.equal(polls, 2);
  assert.ok(events.some((e) => e.type === 'progress' && e.phase === 'waiting' && e.jobId === 'job-42'));

  // Verify Agent toolNameMapper resolves legacy aliases without host coupling inside server/harness
  let turn = 0;
  const provider = {
    name: 'alias-test',
    async *stream() {
      turn += 1;
      if (turn === 1) {
        yield { type: 'tool_use', id: 'call_alias', name: 'legacy_ping', input: {} };
        yield { type: 'stop', reason: 'tool_use' };
      } else {
        yield { type: 'text_delta', text: 'Pong received.' };
        yield { type: 'stop', reason: 'end_turn' };
      }
    },
  };
  const agent = new Agent({
    provider,
    system: 'test',
    tools,
    toolNameMapper: (name) => (name === 'legacy_ping' ? 'ping' : name),
  });
  const run = await agent.run('Test legacy alias');
  assert.equal(run.completed, 1);
  assert.equal(run.failed, 0);
  assert.equal(run.text, 'Pong received.');
});

test('compact: mergeDeltas/expandEntry are lossless and compactHistory preserves tool_use/tool_result pairing', async () => {
  const rawEvents = [
    { type: 'thinking', round: 1, delta: 'Let ', seq: 1 },
    { type: 'thinking', round: 1, delta: 'me think.', seq: 2 },
    { type: 'text', delta: 'Hello ', seq: 3 },
    { type: 'text', delta: 'world!', seq: 4 },
    { type: 'tool_call', name: 'ping', seq: 5 },
    { type: 'text', delta: 'Done.', seq: 6 },
  ];
  const merged = mergeDeltas(rawEvents);
  assert.equal(merged.length, 4);
  assert.equal(merged[0].delta, 'Let me think.');
  assert.equal(merged[1].delta, 'Hello world!');
  const expanded = merged.flatMap((e) => [...expandEntry(e)]);
  assert.deepEqual(expanded, rawEvents);

  // Build a multi-round history where keepRecent=3 lands right between tool_use (index 3) and tool_result (index 4)
  const history = MessageHistory.fromJSON([
    { role: 'user', content: [{ type: 'text', text: 'Turn 1 question' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'lookup', input: { q: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: '{"answer":1}' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'u2', name: 'lookup', input: { q: 'b' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u2', content: '{"answer":2}' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Final answer is 1 and 2.' }] },
  ]);

  const split = splitMessagesForCompact(history.get(), { keepRecent: 2 });
  // Index 4 is a tool_result, so split must step back to index 3 (assistant tool_use) so u2 + its tool_result stay paired!
  assert.equal(split.head.length, 3);
  assert.equal(split.tail.length, 3);
  assert.equal(split.tail[0].role, 'assistant');

  const prompt = buildCompactPrompt(split.head, { instructions: 'Keep numbers exact' });
  assert.ok(prompt.includes('Keep numbers exact'));
  assert.ok(prompt.includes('Turn 1 question'));

  const summarizerProvider = {
    async *stream() {
      yield { type: 'text_delta', text: 'User asked Turn 1; lookup(a) returned 1.' };
      yield { type: 'usage', input: 50, output: 12 };
      yield { type: 'stop', reason: 'end_turn' };
    },
  };

  const res = await compactHistory(history, {
    provider: summarizerProvider,
    keepRecent: 2,
    minMessages: 4,
  });

  assert.equal(res.compacted, true);
  assert.equal(res.usage.input, 50);
  assert.equal(res.usage.output, 12);

  const after = history.get();
  // Verify strict user/assistant alternation and intact u2 tool_use -> tool_result pairing
  for (let i = 1; i < after.length; i += 1) {
    assert.notEqual(after[i].role, after[i - 1].role, `Consecutive ${after[i].role} messages at ${i - 1}..${i}`);
  }
  assert.equal(after[0].role, 'user');
  assert.ok(after[0].content[0].text.includes('lookup(a) returned 1'));
  assert.equal(after[1].content[0].id, 'u2');
  assert.equal(after[2].content[0].tool_use_id, 'u2');

  // Also verify buildCompactedMessages when tail starts with user or is empty
  const emptyTail = buildCompactedMessages('Summary only', []);
  assert.equal(emptyTail.length, 2);
  assert.equal(emptyTail[0].role, 'user');
  assert.equal(emptyTail[1].role, 'assistant');
});

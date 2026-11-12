/**
 * Standalone zero-dependency smoke test for `promptcut-harness`.
 *
 * Exercises `Agent`, `buildTools`, custom tools (`calculator`, `echo`), `SKILL.md` discovery +
 * `load_skill`, `code_cache` `@code_cache:` reference expansion, `mergeDeltas`, and `compactHistory`
 * using the built-in `mock` provider — requiring zero network access and zero npm packages.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Agent,
  MessageHistory,
  buildTools,
  createCodeCacheStore,
  createMockProvider,
  loadSkillCatalog,
  skillCatalogPrompt,
  compactHistory,
  mergeDeltas,
  expandEntry,
} from './index.mjs';

export async function runSmoke() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-harness-smoke-'));
  try {
    const skillsDir = path.join(tempRoot, 'skills');
    const workspaceDir = path.join(tempRoot, 'workspace');
    const cacheDir = path.join(tempRoot, 'code-cache');
    fs.mkdirSync(path.join(skillsDir, 'math-guide'), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    fs.writeFileSync(
      path.join(skillsDir, 'math-guide', 'SKILL.md'),
      [
        '---',
        'name: math-guide',
        'description: Guide for verifying arithmetic calculations and echoing formatted notes.',
        '---',
        '',
        '1. Compute products with `calculator`.',
        '2. Store reusable text in `code_cache_write` and pass `@code_cache:<name>` to `echo`.',
      ].join('\n'),
      'utf8',
    );

    const { skills } = loadSkillCatalog({ dirs: [skillsDir] });
    const codeCache = createCodeCacheStore({ dir: cacheDir, writer: 'smoke' });

    const customTools = [
      {
        name: 'calculator',
        description: 'Evaluate basic integer operations.',
        inputSchema: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add', 'mul'] },
            a: { type: 'number' },
            b: { type: 'number' },
          },
          required: ['op', 'a', 'b'],
        },
        async execute({ op, a, b }) {
          const value = op === 'mul' ? a * b : a + b;
          return { ok: true, value };
        },
      },
      {
        name: 'echo',
        description: 'Echo a message string after @code_cache expansion.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
        },
        async execute({ message }) {
          return { ok: true, echoed: message };
        },
      },
    ];

    const events = [];
    let seq = 0;
    const onEvent = (ev) => {
      seq += 1;
      events.push({ ...ev, seq });
    };

    const tools = await buildTools({
      tools: customTools,
      workspaceDir,
      onEvent,
      codeCache,
      skills,
    });

    const provider = createMockProvider({});
    const history = new MessageHistory();
    const system = `You are a standalone test agent.${skillCatalogPrompt(skills)}`;

    const script = [
      { tool: 'load_skill', input: { name: 'math-guide' } },
      { tool: 'calculator', input: { op: 'mul', a: 6, b: 7 } },
      { tool: 'code_cache_write', input: { name: 'answer_note', text: 'Result verified: 42' } },
      { tool: 'echo', input: { message: '@code_cache:answer_note' } },
      { say: 'All checks passed: 6 * 7 = 42.' },
    ];

    const agent = new Agent({
      provider,
      system,
      tools,
      history,
      codeCache,
      onEvent,
    });

    const runResult = await agent.run(`Run smoke check.\n\`\`\`mock-script\n${JSON.stringify(script)}\n\`\`\``);

    const toolCalls = events.filter((e) => e.type === 'tool_call').map((e) => e.name);
    const echoResult = events.find((e) => e.type === 'tool_result' && e.name === 'echo');
    if (echoResult?.output?.echoed !== 'Result verified: 42') {
      throw new Error(`Expected @code_cache ref expansion in echo tool, got ${JSON.stringify(echoResult?.output)}`);
    }

    const merged = mergeDeltas(events);
    const replayed = merged.flatMap((entry) => [...expandEntry(entry)]);
    if (replayed.length !== events.length) {
      throw new Error(`Expected lossless delta replay (${events.length}), got ${replayed.length}`);
    }

    const compacted = await compactHistory(history, {
      keepRecent: 2,
      minMessages: 4,
      summarize: async (head) => `Summarized ${head.length} earlier messages; calculator returned 42.`,
    });

    const rounds = events.filter((e) => e.type === 'diagnostic' && e.stage === 'request').length;
    return {
      ok: runResult.outcome === 'completed' && compacted.compacted === true,
      rounds,
      toolCalls,
      finalReply: runResult.text,
      compacted: {
        summarizedCount: compacted.summarizedCount,
        keptCount: compacted.keptCount,
        remainingMessages: history.get().length,
      },
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = await runSmoke();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

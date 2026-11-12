# `promptcut-harness`

Zero-dependency Node.js (`>=20`) Agent runtime harness powering direct streaming LLM tool-use loops across **Anthropic Messages**, **OpenAI-compatible Chat Completions**, and **Google Gemini `streamGenerateContent`** APIs.

Every module inside this directory depends **only** on sibling files inside `promptcut-harness` and Node built-in `node:*` modules — zero `npm` runtime dependencies and zero host-application couplings.

## Features

- **Multi-vendor streaming providers** (`./providers/anthropic`, `./providers/openai`, `./providers/gemini`, `./providers/mock`) emitting a unified async-iterable event stream (`text_delta`, `thinking_delta`, `tool_use`, `tool_use_partial`, `usage`, `stop`).
- **Resilient Agent loop** (`./agent`, `./history`, `./retry-fetch`, `./idle-timeout`, `./output-speed`, `./model-limits`):
  - Sequential deterministic tool execution per round with automatic credential redaction in debug payloads.
  - Consecutive failure-streak detection, duplicate-round loop breaker, round-budget reminders, and token-aware history fitting (`fitTokens`) + image pruning (`pruneImages`).
  - Automatic truncation salvage (`./truncation`, `./partial-json`, `./code-cache`): half-written tool arguments cut off by `max_tokens` or mid-stream gateway drops (`stream_cut`) are saved into named `@code_cache:<name>` scratch blocks so the model can append and finish without losing work.
- **Generic `SKILL.md` catalog & `load_skill` tool** (`./skills`): frontmatter parser, priority-ordered directory scanner, system-prompt catalog formatter, and sandboxed read-only `load_skill` tool.
- **Conversation & event-stream compaction** (`./compact`):
  - `mergeDeltas` / `expandEntry`: lossless compaction of streaming `text` and `thinking` deltas.
  - `splitMessagesForCompact` / `buildCompactPrompt` / `buildCompactedMessages` / `compactHistory`: summarizes older conversation turns while preserving `tool_use` / `tool_result` pairing and alternating role invariants.
- **Multi-role review loop** (`./loop`, `./loop-prompts`): `judger -> worker -> reviewer -> judger` orchestration with reflection and lesson persistence.
- **Text-protocol fallback** (`./tool-protocol`): streaming ```` ```promptcut-tool ```` fence filter and parser for environments without native tool calling.

## Quick Start

Run the self-contained smoke test (no API key or network needed):

```bash
node smoke.mjs
```

Programmatic usage:

```js
import {
  Agent,
  buildTools,
  createOpenAiProvider,
  loadSkillCatalog,
  skillCatalogPrompt,
  compactHistory,
} from 'promptcut-harness';

const { skills } = loadSkillCatalog({ dirs: ['./skills'] });
const tools = await buildTools({
  workspaceDir: './workspace',
  skills,
  tools: [
    {
      name: 'lookup_weather',
      description: 'Fetch current weather for a city.',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      async execute({ city }) {
        return { ok: true, city, tempC: 21 };
      },
    },
  ],
});

const provider = createOpenAiProvider({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
});

const agent = new Agent({
  provider,
  system: `You are a helpful assistant.${skillCatalogPrompt(skills)}`,
  tools,
});

const result = await agent.run('Check the weather in Tokyo.');
console.log(result.text);

await compactHistory(agent.history, { provider, keepRecent: 4 });
```

## Module Layout

| Subpath | Purpose |
| --- | --- |
| `.` (`./index.mjs`) | Main barrel exporting all public classes, tools, and utilities |
| `./agent` | `Agent` loop, `isUserMessageCall`, `toolErrorResult`, `failureKey` |
| `./history` | `MessageHistory` (turn merging, image pruning, token-budget truncation) |
| `./tools` | Generic `buildTools` (custom tools, `jobWaiters`, `schemaDecorators`, built-ins) |
| `./skills` | `parseSkillMd`, `loadSkillCatalog`, `skillCatalogPrompt`, `loadSkillTool` |
| `./compact` | `mergeDeltas`, `expandEntry`, `compactHistory`, `splitMessagesForCompact` |
| `./code-cache` | `createCodeCacheStore`, `codeCacheTools`, `resolveCodeCacheRefs` |
| `./loop` | `runReviewLoop`, `presentLoopEvent`, `apiBackend`, `SUBMIT_DEFS` |
| `./tool-protocol` | Streaming fence filter & text-protocol tool loop |
| `./providers/*` | `anthropic`, `openai`, `gemini`, `mock`, `base`, `output-fallback` |
| `./schema` | Cross-vendor JSON Schema sanitizer & tool converter |
| `./retry-fetch` / `./idle-timeout` | Exponential backoff fetch wrapper & stream-activity idle timer |
| `./model-limits` / `./output-speed` | Per-model output token caps & adaptive throughput limiter |
| `./smoke` | Self-contained mock-provider end-to-end smoke runner |

## License

MIT

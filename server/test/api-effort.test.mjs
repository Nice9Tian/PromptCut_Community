/**
 * node --test server/test/api-effort.test.mjs
 *
 * Thinking effort for direct API.
 *
 * Previously this path was broken: the three CLI providers each translated effort into CLI flags
 * (claude's --effort, codex's -c model_reasoning_effort, agy's --effort), while direct API never
 * read it at all: that tier in the UI was dead for API (efforts for the api tier in modelOptions
 * was simply an empty array, so it could not even be selected).
 *
 * Relay services following OpenAI-compatible conventions accept `reasoning_effort`. Verified here
 * from provider's **request body**: merely passing the value into cfg is not enough; if it cannot
 * be sent out, it is still broken.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createProvider } = await import('../harness/providers/openai.mjs');

/** Intercept request body, then return minimal SSE to let stream() finish normally */
function spyFetch(seen) {
  return async (url, options) => {
    seen.url = url;
    seen.body = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: (async function* () {
        yield `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`;
        yield `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;
        yield 'data: [DONE]\n\n';
      })(),
    };
  };
}

async function requestBodyFor(cfg) {
  const seen = {};
  const p = createProvider(
    { apiKey: 'k', model: 'm', baseUrl: 'https://relay.example/v1', ...cfg },
    { fetchImpl: spyFetch(seen) },
  );
  for await (const _ of p.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], [], '', undefined)) {
    /* Just needs to finish; this test does not care about event contents */
  }
  return seen.body;
}

test('A tier is selected: reasoning_effort goes into the request body', async () => {
  for (const effort of ['low', 'medium', 'high']) {
    const body = await requestBodyFor({ effort });
    assert.equal(body.reasoning_effort, effort, `${effort} should be sent as is`);
  }
});

test('Choosing "Default" (empty): no field is sent at all, since the upstream may return a 400 right away on a parameter it does not recognize', async () => {
  assert.ok(!('reasoning_effort' in await requestBodyFor({ effort: '' })));
  assert.ok(!('reasoning_effort' in await requestBodyFor({})), 'Even when the field is absent altogether, it must not appear out of nowhere');
});

test('Adding reasoning_effort does not affect the existing fields', async () => {
  const body = await requestBodyFor({ effort: 'high' });
  assert.equal(body.model, 'm');
  assert.equal(body.stream, true);
  assert.ok(Array.isArray(body.messages) && body.messages.length > 0);
  assert.ok(body.max_tokens > 0);
});

/*
 * The above verifies the provider end. Below verifies the runner end: whether opts.effort actually
 * makes it into cfg.
 * Testing both ends separately has a reason: if either end is broken, the symptom is "selecting a tier
 * has no effect", which cannot be seen by testing only one end.
 */
/** Run mock driver once and extract that configuration diagnostic event */
async function configDiagnostic(effort) {
  const api = await import('../runners/api.mjs');
  const events = [];
  const run = api.startRun({
    apiConfig: { vendor: 'mock', apiKey: 'k', model: 'm', baseUrl: 'https://relay.example/v1' },
    prompt: 'hi',
    effort,
    onEvent: (ev) => events.push(ev),
  });
  await run.done.catch(() => {});
  return events.find((e) => e.type === 'diagnostic' && e.stage === 'configuration')?.data;
}

test('runner: opts.effort of startRun goes into cfg and is visible in the diagnostics', async () => {
  const high = await configDiagnostic('high');
  assert.equal(high?.effort, 'high', 'If the tier does not get into cfg, the symptom is "selected but nothing happens" and there is nowhere to start investigating');

  const none = await configDiagnostic('');
  assert.equal(none?.effort, '(default)', 'When no tier is selected, the diagnostics must say it uses the default instead of showing a blank');
});

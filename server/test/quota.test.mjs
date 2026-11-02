// node --test server/test/quota.test.mjs: quota circuit break:
// parsing and determination do not touch the real CLI
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseClaudeUsage, parseCodexRateLimits, summarize, createQuotaGuard, normalizeQuotaConfig, QuotaExceededError, decidingWindows } = await import('../runners/quota.mjs');

const CLAUDE_TEXT = `You are currently using your subscription to power your Claude Code usage

Current session: 18% used · resets Sep 8, 3pm (Asia/Tokyo)
Current week (all models): 51% used · resets Sep 14, 10am (Asia/Tokyo)
Current week (Fable): 75% used · resets Sep 14, 10am (Asia/Tokyo)

What's contributing to your limits usage?
  93% of your usage was at >150k context
`;

test('parseClaudeUsage: all three windows are recognized, and the percentages and reset times match; other percentages in the body text do not count', () => {
  const w = parseClaudeUsage(CLAUDE_TEXT);
  assert.deepEqual(w.map((x) => [x.id, x.usedPercent]), [['session', 18], ['week', 51], ['week-fable', 75]]);
  assert.equal(w[0].label, 'Current 5 hours');
  assert.equal(w[2].label, 'This week (Fable)');
  assert.equal(w[1].resetsText, 'Sep 14, 10am (Asia/Tokyo)');
  assert.equal(parseClaudeUsage('You are using an API key. No subscription limits.').length, 0);
});

test('parseCodexRateLimits: primary is 5 hours, secondary is this week, resetsAt is converted from seconds to milliseconds', () => {
  const w = parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1788848583 }, secondary: { usedPercent: 51, windowDurationMins: 10080, resetsAt: 1789321254 }, planType: 'plus' } });
  assert.deepEqual(w.map((x) => [x.id, x.label, x.usedPercent]), [['session', 'Current 5 hours', 4], ['week', 'This week', 51]]);
  assert.equal(w[0].resetsAt, 1788848583000);
  assert.ok(w[0].resetsText);
  assert.equal(parseCodexRateLimits({}).length, 0);
  assert.equal(parseCodexRateLimits(null).length, 0);
});

test('summarize: the highest window determines worst and maxUsedPercent', () => {
  const s = summarize('claude', parseClaudeUsage(CLAUDE_TEXT));
  assert.equal(s.ok, true);
  assert.equal(s.maxUsedPercent, 75);
  assert.equal(s.worst.id, 'week-fable');
  assert.equal(summarize('codex', []).ok, false);
});

test('normalizeQuotaConfig: defaults are 80% / 256KB; out-of-range values are clamped back', () => {
  assert.deepEqual(normalizeQuotaConfig(undefined), { enabled: true, thresholdPercent: 80, checkEveryBytes: 262144 });
  assert.equal(normalizeQuotaConfig({ thresholdPercent: 250 }).thresholdPercent, 100);
  assert.equal(normalizeQuotaConfig({ thresholdPercent: 0 }).thresholdPercent, 1);
  assert.equal(normalizeQuotaConfig({ checkEveryBytes: 10 }).checkEveryBytes, 16384);
  assert.equal(normalizeQuotaConfig({ enabled: false }).enabled, false);
});

function fakeProbe(seq) {
  const calls = [];
  const probe = async (provider) => {
    calls.push(provider);
    const pct = typeof seq === 'function' ? seq(calls.length) : seq[Math.min(calls.length, seq.length) - 1];
    if (pct === 'fail') return { provider, label: 'Codex', supported: true, ok: false, windows: [], maxUsedPercent: null, worst: null, error: 'not logged in' };
    return summarize(provider, [{ id: 'session', label: 'Current 5 hours', usedPercent: pct, resetsText: '12:00', resetsAt: null }]);
  };
  return { probe, calls };
}

test('gate: the first call checks before letting through; under the threshold lets through; over the threshold throws QuotaExceededError, with an error message in plain language', async () => {
  const { probe, calls } = fakeProbe([40]);
  const g = createQuotaGuard({ probe, now: () => 1000 });
  const info = await g.gate('claude', { thresholdPercent: 80 });
  assert.equal(info.maxUsedPercent, 40);
  assert.equal(calls.length, 1);
  await g.gate('claude', { thresholdPercent: 80 });
  assert.equal(calls.length, 1, 'no re-check within ten minutes');

  const hot = createQuotaGuard({ probe: fakeProbe([85]).probe });
  await assert.rejects(() => hot.gate('codex', { thresholdPercent: 80 }), (e) => {
    assert.ok(e instanceof QuotaExceededError);
    assert.match(e.message, /Codex quota used 85%/);
    assert.match(e.message, /over the 80% threshold/);
    assert.match(e.message, /resets 12:00/);
    return true;
  });
});

test('gate: circuit breaker off, unsupported driver, usage cannot be found: none of these block', async () => {
  const off = createQuotaGuard({ probe: fakeProbe([99]).probe });
  assert.equal(await off.gate('claude', { enabled: false }), null);
  assert.equal(await off.gate('agy', { thresholdPercent: 80 }), null);
  const failing = createQuotaGuard({ probe: fakeProbe(['fail']).probe });
  const info = await failing.gate('codex', { thresholdPercent: 80 });
  assert.equal(info.ok, false);
});

test('gate: re-checks when the result is too old', async () => {
  let t = 0;
  const { probe, calls } = fakeProbe([40, 90]);
  const g = createQuotaGuard({ probe, now: () => t, staleMs: 1000 });
  await g.gate('claude', {});
  t = 5000;
  await assert.rejects(() => g.gate('claude', {}), /90%/);
  assert.equal(calls.length, 2);
});

test('note: no check while the accumulated bytes have not reached the threshold; once it is reached, a background re-check runs and gives a verdict, and the byte count resets to zero', async () => {
  const { probe, calls } = fakeProbe([40, 88]);
  const g = createQuotaGuard({ probe });
  await g.gate('claude', {});
  assert.equal(g.note('claude', 100, { checkEveryBytes: 20000 }), null);
  assert.equal(calls.length, 1);
  const v = await g.note('claude', 25000, { checkEveryBytes: 20000 });
  assert.equal(calls.length, 2);
  assert.equal(v.blocked, true);
  assert.match(v.message, /88%/);
  assert.equal(g.bytesSince('claude'), 0);
  // Subsequent gates block directly based on the new result, no need to check again
  await assert.rejects(() => g.gate('claude', {}), /88%/);
  assert.equal(calls.length, 2);
});

test('concurrent refresh calls check only once', async () => {
  const { probe, calls } = fakeProbe([10]);
  const g = createQuotaGuard({ probe });
  await Promise.all([g.get('codex', { refresh: true }), g.get('codex', { refresh: true }), g.gate('codex', {})]);
  assert.equal(calls.length, 1);
});

/*
 * A model-specific window should not block other models.
 *
 * claude's /usage reports both "This week (all models)" and "This week (Fable)". Previously it
 * compared the highest value across all windows against the threshold, so when Fable rose to 75%,
 * chats running opus were also circuit-broken, even though half the quota remained on that path.
 */
test('decidingWindows: session and "all models" always count; week-<model> counts only when that model is running', () => {
  const w = parseClaudeUsage(CLAUDE_TEXT);
  const ids = (model) => decidingWindows(w, model).map((x) => x.id);

  assert.deepEqual(ids(''), ['session', 'week'], 'no model specified: no model-specific window is considered');
  assert.deepEqual(ids('opus'), ['session', 'week'], 'running opus: the Fable row is irrelevant to it');
  assert.deepEqual(ids('sonnet'), ['session', 'week']);
  assert.deepEqual(ids('fable'), ['session', 'week', 'week-fable'], 'aliases must be recognized too');
  assert.deepEqual(ids('claude-fable-5-1'), ['session', 'week', 'week-fable'], 'full names must be recognized too');
  assert.deepEqual(ids('FABLE'), ['session', 'week', 'week-fable'], 'case-insensitive');
  assert.deepEqual(decidingWindows(null, 'fable'), []);
});

test('summarize still reports the highest of all windows: that is for the UI to show, not for blocking', () => {
  const s = summarize('claude', parseClaudeUsage(CLAUDE_TEXT));
  assert.equal(s.maxUsedPercent, 75);
  assert.equal(s.worst.id, 'week-fable');
});

test('gate: when Fable reaches 75%, running opus is not blocked, only running fable is', async () => {
  const probe = async (provider) => summarize(provider, parseClaudeUsage(CLAUDE_TEXT));
  const cfg = { thresholdPercent: 70 };

  const a = createQuotaGuard({ probe });
  const info = await a.gate('claude', cfg, 'opus');
  assert.ok(info, 'running opus should be allowed through: the all-models row is only at 51%, below 70%');

  const b = createQuotaGuard({ probe });
  await assert.rejects(() => b.gate('claude', cfg, 'fable'), (e) => {
    assert.ok(e instanceof QuotaExceededError);
    assert.match(e.message, /75%/);
    assert.match(e.message, /This week \(Fable\)/, 'the message must say explicitly which window blocked it');
    return true;
  });

  const c = createQuotaGuard({ probe });
  assert.ok(await c.gate('claude', cfg, ''), 'also allowed through when no model is specified');
});

test('gate: when the "all models" row goes over the threshold, every model is blocked', async () => {
  const probe = async (provider) => summarize(provider, parseClaudeUsage(CLAUDE_TEXT));
  const g = createQuotaGuard({ probe });
  await assert.rejects(() => g.gate('claude', { thresholdPercent: 50 }, 'opus'), (e) => {
    assert.match(e.message, /51%/);
    assert.match(e.message, /all models/);
    return true;
  });
});

test('verdict: the same cache gives different conclusions depending on which model is asked about', async () => {
  const g = createQuotaGuard({ probe: async (p) => summarize(p, parseClaudeUsage(CLAUDE_TEXT)) });
  await g.get('claude');
  assert.equal(g.verdict('claude', { thresholdPercent: 70 }, 'opus').blocked, false);
  assert.equal(g.verdict('claude', { thresholdPercent: 70 }, 'fable').blocked, true);
});

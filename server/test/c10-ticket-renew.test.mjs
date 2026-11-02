/**
 * C10 frame-by-frame export ticket renewal (`docs/plan/c10-contract.md` section 12;
 * acceptance check C10-A10 "frame-by-frame export spanning ticket expiration finishes normally").
 * Run: node --test server/test/c10-ticket-renew.test.mjs
 *
 *   C10-TR-01 Export spans three ticket expirations (15-minute ticket, 45-minute export, ticket
 *             used every 200 ms): every ticket used is not expired, renewal happens before
 *             expiration (renewed in advance, not replaced after hitting 401);
 *   C10-TR-02 Renewal does not spam: ticket fetches in 45 minutes do not exceed 45 / 5 + 2 times
 *             (order of magnitude of replacing only when at least 1/3 remains);
 *   C10-TR-03 Shortened expiration (2-minute ticket) also holds: shortening expiration in tests
 *             (the approach in acceptance check C10-A10);
 *   C10-TR-04 A renewal fails (returns null): retries before the old ticket expires, acquires
 *             a new one, export is not interrupted;
 *   C10-TR-05 No more tickets fetched after `stop()`.
 *
 * Time uses `mock.timers` (advancing setTimeout together with Date), without looking at wall clock.
 * For assumptions, see K12 of `c10-kit.mjs`. Skip the entire group when implementation is absent.
 */
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { renewGate, importRepo, pickMethod, RENEW_METHODS } from './c10-kit.mjs';

const gate = renewGate();
const it = (name, fn) => test(name, { skip: gate.ok ? false : gate.reason }, fn);
afterEach(() => mock.timers.reset());

const MIN = 60_000;

/** Mock ticket fetching: issues a ticket of `ttl` ms each time; returns null on attempts in `failAt` */
function issuer(ttl, { failAt = [] } = {}) {
  const iss = { calls: 0, issued: [] };
  iss.fetchTicket = async () => {
    iss.calls++;
    if (failAt.includes(iss.calls)) return null;
    const t = { ticket: `t${iss.calls}`, exp: Date.now() + ttl };
    iss.issued.push(t);
    return t;
  };
  iss.expOf = (ticket) => iss.issued.find((t) => t.ticket === ticket)?.exp;
  return iss;
}

async function renewer(iss) {
  const mod = await importRepo(gate.file);
  const r = mod[gate.name]({ fetchTicket: iss.fetchTicket, now: () => Date.now() });
  const m = {};
  for (const [k, names] of Object.entries(RENEW_METHODS)) {
    m[k] = pickMethod(r, names);
    assert.ok(m[k], `Assumption K12: ${k} not found on the renewer (candidates ${names.join(' / ')}); available: ${Object.keys(r).join(', ')}`);
  }
  return { start: () => r[m.start](), ticket: () => r[m.ticket](), stop: () => r[m.stop]() };
}

const drain = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

/** Simulate export: uses a ticket every `stepMs`, for `totalMs` in total; returns whether all used tickets were unexpired */
async function simulate(iss, r, { totalMs, stepMs = 200 }) {
  const bad = [];
  for (let t = 0; t < totalMs; t += stepMs) {
    mock.timers.tick(stepMs);
    await drain();
    const tk = r.ticket();
    const exp = iss.expOf(tk);
    if (!tk || !(exp > Date.now())) bad.push({ at: t, tk, exp, now: Date.now() });
  }
  return bad;
}

async function run(ttl, opts) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  const iss = issuer(ttl, opts);
  const r = await renewer(iss);
  const first = r.start();
  await drain();
  await first;
  assert.ok(r.ticket(), 'A ticket is held after start()');
  const bad = await simulate(iss, r, { totalMs: 3 * ttl });
  r.stop();
  return { iss, bad, r };
}

it('C10-TR-01 45-minute export, 15-minute ticket: every ticket used is unexpired (renewed ahead of time)', async () => {
  const { bad, iss } = await run(15 * MIN);
  assert.deepEqual(bad.slice(0, 3), [], `An expired or empty ticket was used ${bad.length} times`);
  assert.ok(iss.calls >= 3, `The ticket was replaced at least twice in 45 minutes (tickets fetched ${iss.calls} times)`);
});

it('C10-TR-02 renewal does not spam: no more than 11 ticket fetches in 45 minutes', async () => {
  const { iss } = await run(15 * MIN);
  assert.ok(iss.calls <= 45 / 5 + 2, `Fetched tickets ${iss.calls} times`);
});

it('C10-TR-03 a shorter lifetime (2-minute ticket) holds as well', async () => {
  const { bad, iss } = await run(2 * MIN);
  assert.deepEqual(bad.slice(0, 3), [], `An expired or empty ticket was used ${bad.length} times`);
  assert.ok(iss.calls >= 3 && iss.calls <= 6 / (2 / 3) + 2, `Fetched tickets ${iss.calls} times`);
});

it('C10-TR-04 a renewal fails once: retries before the old ticket expires, and the export is not interrupted', async () => {
  const { bad, iss } = await run(15 * MIN, { failAt: [2] });
  assert.deepEqual(bad.slice(0, 3), [], `An expired or empty ticket was used ${bad.length} times`);
  assert.ok(iss.calls >= 4, `Tickets were fetched again after the failure (fetched ${iss.calls} times)`);
});

it('C10-TR-05 no tickets are fetched after stop()', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  const iss = issuer(15 * MIN);
  const r = await renewer(iss);
  const p = r.start();
  await drain();
  await p;
  r.stop();
  const calls = iss.calls;
  mock.timers.tick(60 * MIN);
  await drain();
  assert.equal(iss.calls, calls);
});

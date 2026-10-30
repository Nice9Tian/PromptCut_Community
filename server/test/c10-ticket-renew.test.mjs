/**
 * C10 逐帧导出续签票据（`docs/plan/c10-contract.md` 第 12 节；验收 C10-A10「逐帧导出跨过票据时限照常完成」）。
 * 跑：node --test server/test/c10-ticket-renew.test.mjs
 *
 *   C10-TR-01 导出跨过三个票据时限（票据 15 分钟，导出 45 分钟，每 200 ms 用一次票据）：每一次用到的票据都没过期，
 *             续签发生在过期之前（提前续签，不是撞到 401 再换）；
 *   C10-TR-02 续签不刷屏：45 分钟里取票次数不超过 45 / 5 + 2 次（至少剩 1/3 才换的量级）；
 *   C10-TR-03 缩短时限（2 分钟票据）同样成立——测试里缩短时限（验收 C10-A10 的做法）；
 *   C10-TR-04 某次续签失败（回 null）：在旧票据过期前再试，拿到新的，导出不中断；
 *   C10-TR-05 `stop()` 之后不再取票。
 *
 * 时间用 `mock.timers`（setTimeout 与 Date 一起推），不看墙钟。假设见 `c10-kit.mjs` 的 K12。实现不在时整组 skip。
 */
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { renewGate, importRepo, pickMethod, RENEW_METHODS } from './c10-kit.mjs';

const gate = renewGate();
const it = (name, fn) => test(name, { skip: gate.ok ? false : gate.reason }, fn);
afterEach(() => mock.timers.reset());

const MIN = 60_000;

/** 假的取票：每次签一张 `ttl` 毫秒的票据；`failAt` 里的第几次回 null */
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
    assert.ok(m[k], `假设 K12：续签器上找不到 ${k}（候选 ${names.join(' / ')}）；有的：${Object.keys(r).join(', ')}`);
  }
  return { start: () => r[m.start](), ticket: () => r[m.ticket](), stop: () => r[m.stop]() };
}

const drain = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

/** 模拟导出：每 `stepMs` 用一次票据，共 `totalMs`；回用到的票据是否都没过期 */
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
  assert.ok(r.ticket(), 'start() 之后手里有票据');
  const bad = await simulate(iss, r, { totalMs: 3 * ttl });
  r.stop();
  return { iss, bad, r };
}

it('C10-TR-01 45 分钟导出、15 分钟票据：每次用到的票据都没过期（提前续签）', async () => {
  const { bad, iss } = await run(15 * MIN);
  assert.deepEqual(bad.slice(0, 3), [], `有 ${bad.length} 次用到的是过期或空票据`);
  assert.ok(iss.calls >= 3, `45 分钟至少换过两次票（取票 ${iss.calls} 次）`);
});

it('C10-TR-02 续签不刷屏：45 分钟里取票不超过 11 次', async () => {
  const { iss } = await run(15 * MIN);
  assert.ok(iss.calls <= 45 / 5 + 2, `取票 ${iss.calls} 次`);
});

it('C10-TR-03 缩短时限（2 分钟票据）同样成立', async () => {
  const { bad, iss } = await run(2 * MIN);
  assert.deepEqual(bad.slice(0, 3), [], `有 ${bad.length} 次用到的是过期或空票据`);
  assert.ok(iss.calls >= 3 && iss.calls <= 6 / (2 / 3) + 2, `取票 ${iss.calls} 次`);
});

it('C10-TR-04 某次续签失败：在旧票据过期前再试，导出不中断', async () => {
  const { bad, iss } = await run(15 * MIN, { failAt: [2] });
  assert.deepEqual(bad.slice(0, 3), [], `有 ${bad.length} 次用到的是过期或空票据`);
  assert.ok(iss.calls >= 4, `失败之后又取过票（取票 ${iss.calls} 次）`);
});

it('C10-TR-05 stop() 之后不再取票', async () => {
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

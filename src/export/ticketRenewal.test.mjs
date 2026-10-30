/**
 * 逐帧导出续签票据(C10 契约第 12 节、第 18 节第 5 条):start / 同步的 ticket() / stop;剩三分之一寿命时提前续签;
 * 失败不换掉旧的、在过期之前再试;素材地址里的 ?t= 换成新的一张。
 * 跑:node --test src/export/ticketRenewal.test.mjs
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createTicketRenewer, withTicket, RENEW_RETRY_MS } from "./ticketRenewal.ts";

test("C10-TR-01 提前续签:30 秒寿命的票据在第 20 秒换新;导出跨过好几个时限,ticket() 始终是没过期的那一张", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    let n = 0;
    const fetchTicket = async () => ({ ticket: `T${++n}`, exp: Date.now() + 30_000 });
    const r = createTicketRenewer({ fetchTicket, now: () => Date.now() });
    assert.equal(await r.start(), "T1");
    assert.equal(r.ticket(), "T1");
    for (let s = 0; s < 120; s++) {
      mock.timers.tick(1000);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      const st = r.stats();
      assert.ok(st.exp > Date.now(), `第 ${s + 1} 秒:手里的票据没过期(exp ${st.exp - Date.now()} ms 之后)`);
    }
    assert.ok(r.stats().renewals >= 5, `两分钟里续签了 ${r.stats().renewals} 次`);
    r.stop();
    const before = n;
    mock.timers.tick(60_000);
    await Promise.resolve();
    assert.equal(n, before, "stop 之后不再取");
  } finally {
    mock.timers.reset();
  }
});

test("C10-TR-02 续签失败不换掉旧的,在过期之前再试;恢复之后照常", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 5_000_000 });
  try {
    let n = 0;
    let down = false;
    const fetchTicket = async () => { if (down) throw new Error("断网"); return { ticket: `T${++n}`, exp: Date.now() + 60_000 }; };
    const r = createTicketRenewer({ fetchTicket, now: () => Date.now() });
    await r.start();
    down = true;
    mock.timers.tick(40_000);                // 剩 1/3 时续签:失败
    await Promise.resolve(); await Promise.resolve();
    assert.equal(r.ticket(), "T1", "失败了旧的照用");
    assert.ok(r.stats().failures >= 1);
    mock.timers.tick(RENEW_RETRY_MS);          // 过期之前再试:还失败
    await Promise.resolve(); await Promise.resolve();
    down = false;
    mock.timers.tick(RENEW_RETRY_MS);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(r.ticket(), "T2", "恢复后续上");
    assert.ok(r.stats().exp > Date.now());
    r.stop();
  } finally {
    mock.timers.reset();
  }
});

test("C10-TR-03 取回来的还是同一张不算续上;素材地址的 ?t= 换成新的一张", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 9_000_000 });
  try {
    const exp = Date.now() + 30_000;
    let calls = 0;
    const r = createTicketRenewer({ fetchTicket: async () => { calls++; return { ticket: "SAME", exp }; }, now: () => Date.now() });
    await r.start();
    mock.timers.tick(20_000);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(r.stats().renewals, 0);
    assert.ok(r.stats().failures >= 1);
    assert.ok(calls >= 2);
    r.stop();
  } finally {
    mock.timers.reset();
  }
  assert.equal(withTicket("/media/api/asset/media/abc?t=OLD", "NEW"), "/media/api/asset/media/abc?t=NEW");
  assert.equal(withTicket("https://h/x?a=1&t=OLD&b=2", "N+W"), "https://h/x?a=1&t=N%2BW&b=2");
  assert.equal(withTicket("/media/abc", "NEW"), "/media/abc", "没带票据的原样");
  assert.equal(withTicket("/media/abc?t=OLD", null), "/media/abc?t=OLD");
});

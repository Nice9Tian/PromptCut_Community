/**
 * Frame-by-frame export ticket renewal (C10 contract Section 12, Section 18 Clause 5): start /
 * synchronous ticket() / stop; renew early when one third of lifetime remains;
 * do not replace the old one on failure, retry before expiration; replace ?t= in the asset URL with
 * the new ticket.
 * Run: node --test src/export/ticketRenewal.test.mjs
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createTicketRenewer, withTicket, RENEW_RETRY_MS } from "./ticketRenewal.ts";

test("C10-TR-01 Early renewal: a ticket with a 30-second lifetime is replaced at second 20; the export spans several time limits and ticket() always returns an unexpired one", async () => {
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
      assert.ok(st.exp > Date.now(), `At second ${s + 1}: the ticket in hand has not expired (exp in ${st.exp - Date.now()} ms)`);
    }
    assert.ok(r.stats().renewals >= 5, `Renewed ${r.stats().renewals} times in two minutes`);
    r.stop();
    const before = n;
    mock.timers.tick(60_000);
    await Promise.resolve();
    assert.equal(n, before, "No more fetching after stop");
  } finally {
    mock.timers.reset();
  }
});

test("C10-TR-02 A failed renewal does not replace the old ticket, retry before it expires; carry on as usual after recovery", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 5_000_000 });
  try {
    let n = 0;
    let down = false;
    const fetchTicket = async () => { if (down) throw new Error("Network down"); return { ticket: `T${++n}`, exp: Date.now() + 60_000 }; };
    const r = createTicketRenewer({ fetchTicket, now: () => Date.now() });
    await r.start();
    down = true;
    mock.timers.tick(40_000);                // Renew when 1/3 remains: fails
    await Promise.resolve(); await Promise.resolve();
    assert.equal(r.ticket(), "T1", "On failure the old one is still used");
    assert.ok(r.stats().failures >= 1);
    mock.timers.tick(RENEW_RETRY_MS);          // Retry before expiration: still fails
    await Promise.resolve(); await Promise.resolve();
    down = false;
    mock.timers.tick(RENEW_RETRY_MS);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(r.ticket(), "T2", "Resumes after recovery");
    assert.ok(r.stats().exp > Date.now());
    r.stop();
  } finally {
    mock.timers.reset();
  }
});

test("C10-TR-03 Getting back the same ticket does not count as renewed; the ?t= in the asset URL is replaced with the new one", async () => {
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
  assert.equal(withTicket("/media/abc", "NEW"), "/media/abc", "One without a ticket is left as is");
  assert.equal(withTicket("/media/abc?t=OLD", null), "/media/abc?t=OLD");
});

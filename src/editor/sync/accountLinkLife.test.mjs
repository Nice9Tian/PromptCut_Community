/**
 * When the page connection in an account cloud project switches sessions and what to do if it
 * fails (`accountLinkLife.ts`). Connection uses a test double; tests against real services are in
 * `server/test/account-page-link.test.mjs`. Run: npm test -- src/editor/sync/accountLinkLife.test.mjs
 *
 *   ALL-01 Fetch ticket: requires access token to have at least 60 seconds remaining; if the
 *          session upon entering the project is sufficient, use it directly, otherwise fetch another
 *   ALL-02 Do nothing when more than 30 seconds from expiration; switch when under 30 seconds;
 *          after switching, calculate by new ticket's expiration time
 *   ALL-03 Account service temporarily unreachable: only retry before expiration without touching
 *          connection; if still not switched at expiration → expire (switch to offline), report once
 *   ALL-04 Session endpoint returns 401 / 403: pass to onTerminal, do not expire
 *   ALL-05 Discovered only after already expired (wake from sleep) or rejected by gate: do not
 *          switch session, expire directly (run offline reconnect version check), do not fetch ticket
 *   ALL-06 Ignore when there is no session (reconnecting after disconnect); incoming ticks during
 *          switching do not re-enter
 *   ALL-07 Permissions changed (read-only to writable), switch session; record if busy, catch up
 *          on the next tick after finishing
 *   ALL-08 Ticket fetch request hangs: expire if busy for over 5 seconds after expiration, do not
 *          keep showing online
 *   ALL-09 Local clock is fast: if ticket is calculated to be insufficient, do not trust its
 *          expiration time; count 60 seconds from now, do not judge expiration by local clock;
 *          leave at least 20 seconds between switches
 */
import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const L = await import("./accountLinkLife.ts");

function harness({ renew = async () => true, life = 120_000 } = {}) {
  const h = { now: 1_000_000, sessions: [], renews: 0, expired: 0, terminal: [], connected: true, sessionError: null, renew, life, hang: null };
  const link = {
    get connected() { return h.connected; },
    renew: async () => { h.renews++; await h.life_.ticket(); const ok = await h.renew(); if (ok) h.life_.opened(); return ok; },
    expire: () => { h.expired++; h.connected = false; },
  };
  h.life_ = L.createAccountLinkLife({
    session: async ({ minRemainingMs }) => {
      h.sessions.push(minRemainingMs);
      if (h.hang) await h.hang;
      if (h.sessionError) throw h.sessionError;
      return { connectionTicket: `t${h.sessions.length}`, expiresAt: h.now + h.life };
    },
    link: () => link, onTerminal: (e) => h.terminal.push(e.status), now: () => h.now,
  });
  return h;
}
async function open(h) { await h.life_.ticket(); h.life_.opened(); }

test("ALL-01 fetching a ticket requires the token to have at least 60 seconds left; the session obtained when entering the project is used if it is sufficient", async () => {
  const h = harness();
  assert.equal(await h.life_.ticket({ connectionTicket: "first", expiresAt: h.now + 90_000 }), "first");
  assert.deepEqual(h.sessions, []);
  assert.equal(await h.life_.ticket({ connectionTicket: "stale", expiresAt: h.now + 20_000 }), "t1");
  assert.deepEqual(h.sessions, [L.MIN_TICKET_LIFE_MS]);
  h.life_.opened();
  assert.deepEqual([h.life_.describe().expiresAt, h.life_.describe().trusted], [h.now + 120_000, true]);
});

test("ALL-02 once the connection is established, do not invalidate or replace the session by the clock: the passage of time neither replaces it automatically nor disconnects", async () => {
  const h = harness();
  await open(h);
  h.now += 80_000;
  assert.equal(await h.life_.tick(), "idle");
  h.now += 50_000;
  assert.equal(await h.life_.tick(), "idle");
  h.now += 300_000;
  assert.equal(await h.life_.tick(), "idle");
  assert.equal(h.renews, 0);
  assert.equal(h.expired, 0);
});

test("ALL-03 do nothing when there is no session: reconnection after a drop is handled by the reconnect logic", async () => {
  const h = harness();
  assert.equal(await h.life_.tick(), "idle");
  h.connected = false;
  assert.equal(await h.life_.tick(), "idle");
});

test("ALL-04 session endpoint returns 401 / 403: hand over to onTerminal, do not expire", async () => {
  for (const status of [401, 403]) {
    const h = harness();
    await open(h);
    h.sessionError = Object.assign(new Error("x"), { status });
    await h.life_.accessSeen("r");
    await h.life_.accessSeen("rw");
    assert.deepEqual(h.terminal, [status]);
    assert.equal(h.expired, 0);
  }
});

test("ALL-05 expire only when the server reports credential expiry (authExpired); the mere passage of clock time (waking from sleep) does not invalidate automatically", async () => {
  const slept = harness();
  await open(slept);
  slept.now += 300_000;
  assert.equal(await slept.life_.tick(), "idle", "the passage of time does not invalidate an established connection");
  assert.equal(slept.expired, 0);

  const refused = harness();
  await open(refused);
  assert.equal(await refused.life_.authExpired(), "expired");
  assert.deepEqual([refused.renews, refused.expired], [0, 1]);
  assert.equal(await refused.life_.authExpired(), "idle", "already handled as a disconnect, later ones are not repeated");
});

test("ALL-06 do nothing when there is no session; no reentry while a replacement is in progress", async () => {
  const h = harness();
  await open(h);
  h.connected = false;
  h.now += 200_000;
  assert.equal(await h.life_.tick(), "idle");
  assert.equal(await h.life_.authExpired(), "idle");
});

test("ALL-07 when permissions change (read-only to writable), replace the session; do nothing on the first read or when unchanged; if busy, note it and make up the replacement on the next tick", async () => {
  const h = harness();
  await open(h);
  assert.equal(await h.life_.accessSeen("r"), "idle", "the first read only records it");
  assert.equal(await h.life_.accessSeen("r"), "idle");
  assert.equal(await h.life_.accessSeen("rw"), "renewed");
  assert.equal(h.renews, 1);
  h.connected = false;
  assert.equal(await h.life_.accessSeen("rw"), "idle", "no session (the server has already closed the old connection): hand over to reconnection");
});

test("ALL-08 when the local clock runs fast, do not judge expiry by the local clock", async () => {
  const far = harness({ life: -30_000 });
  await open(far);
  assert.equal(far.life_.describe().trusted, false);
  assert.equal(await far.life_.tick(), "idle");
  assert.equal(far.expired, 0);
});

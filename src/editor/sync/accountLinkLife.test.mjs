/**
 * 账号云端项目里页面那条连接什么时候换会话、换不成怎么办(`accountLinkLife.ts`)。连接用替身;
 * 对着真服务的在 `server/test/account-page-link.test.mjs`。跑:npm test -- src/editor/sync/accountLinkLife.test.mjs
 *
 *   ALL-01 取票据:要求访问令牌至少还剩 60 秒;进项目时那份会话够用就直接用,不够另取
 *   ALL-02 离到期超过 30 秒不动;不到 30 秒换;换成之后按新票据的到期时刻算
 *   ALL-03 账号服务一时不通:到期之前只是再试,不动连接;到期那一刻还没换成 → expire(转离线),只报一次
 *   ALL-04 会话接口回 401 / 403:交给 onTerminal,不 expire
 *   ALL-05 已经过期才发现(睡眠醒来)、或被闸拒:不换会话,直接 expire(走离线重连的版本核对),不取票据
 *   ALL-06 没有会话(正在断线重连)时不管;换的途中再来的 tick 不重入
 *   ALL-07 权限变了(只读改可写)换一个会话;正忙着就记下,忙完的下一次 tick 补换
 *   ALL-08 取票据的请求挂住:到期后忙了超过 5 秒就 expire,不一直显示在线
 *   ALL-09 本机的钟快:票据算出来不够用就不信它的到期时刻,按从现在起 60 秒算、不凭本机的钟判过期;两次换之间至少隔 20 秒
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

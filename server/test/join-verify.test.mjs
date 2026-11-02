/**
 * `POST shared/verify`〔裁〕（`claude/join-error`）：拿一份进入证明问服务端认不认，页面借它分清
 * 「用户名或密码不对」与「连不上服务器」（浏览器里握手被 401 拒与没连上都是 1006）。
 * 跑：node --test server/test/join-verify.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostFor, createProject, proofFor, PROTOCOL } from './auth-kit.mjs';

const PUBLIC = '203.0.113.41';

for (const attached of [false, true]) {
  const label = attached ? 'Attached mode (LAN host)' : 'Standalone mode (hosted side)';

  test(`${label}: correct proof → 200 ok; wrong passphrase → 401 unauthorized, consistent with the handshake result`, async (t) => {
    const env = await hostFor(t, { attached });
    const proj = await createProject(env, { mode: 'free' });

    const good = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
    const r1 = await env.http('shared/verify', { method: 'POST', body: { protocols: good.protocols }, remote: PUBLIC });
    assert.equal(r1.status, 200, r1.text);
    assert.deepEqual(r1.json, { ok: true });

    const bad = await proofFor(env, proj, { username: 'zoe', password: 'wrong-pw', remote: PUBLIC });
    const r2 = await env.http('shared/verify', { method: 'POST', body: { protocols: bad.protocols }, remote: PUBLIC });
    assert.equal(r2.status, 401, r2.text);
    assert.deepEqual(r2.json, { ok: false, error: 'unauthorized' });
    // 同一份错证明拿去握手，也是 401
    const bad2 = await proofFor(env, proj, { username: 'zoe', password: 'wrong-pw', remote: PUBLIC });
    assert.equal((await env.handshake(bad2.protocols, PUBLIC)).status, 401);
  });

  test(`${label}: a nonce can be used only once (a proof that was already verified is rejected when used for the handshake again)`, async (t) => {
    const env = await hostFor(t, { attached });
    const proj = await createProject(env, { mode: 'free' });
    const p = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
    const r = await env.http('shared/verify', { method: 'POST', body: { protocols: p.protocols }, remote: PUBLIC });
    assert.equal(r.status, 200, r.text);
    assert.equal((await env.handshake(p.protocols, PUBLIC)).status, 401);
  });

  test(`${label}: no proof entries (empty, only promptcut.v1, ticket) → 400`, async (t) => {
    const env = await hostFor(t, { attached });
    for (const protocols of [[], [PROTOCOL], [PROTOCOL, 'promptcut.ticket.abc'], 'x', [PROTOCOL, 'a,b']]) {
      const r = await env.http('shared/verify', { method: 'POST', body: { protocols }, remote: PUBLIC });
      assert.equal(r.status, 400, `${JSON.stringify(protocols)}: ${r.text}`);
    }
  });
}

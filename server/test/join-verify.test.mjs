/**
 * `POST shared/verify` [ruling] (`claude/join-error`): asks the server whether it accepts an entry
 * proof, which the page uses to distinguish "incorrect username or password" from "cannot connect to
 * server" (in browsers, handshake rejected with 401 and connection failure are both 1006).
 * Run: node --test server/test/join-verify.test.mjs
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
    // Taking the same invalid proof to handshake also yields 401
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

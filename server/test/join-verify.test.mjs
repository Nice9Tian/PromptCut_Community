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
  const label = attached ? '挂载模式（局域网主机）' : '独立模式（托管端）';

  test(`${label}：证明对 → 200 ok；口令错 → 401 unauthorized，与握手结论一致`, async (t) => {
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

  test(`${label}：nonce 只能用一次（核对过的证明再拿去握手被拒）`, async (t) => {
    const env = await hostFor(t, { attached });
    const proj = await createProject(env, { mode: 'free' });
    const p = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
    const r = await env.http('shared/verify', { method: 'POST', body: { protocols: p.protocols }, remote: PUBLIC });
    assert.equal(r.status, 200, r.text);
    assert.equal((await env.handshake(p.protocols, PUBLIC)).status, 401);
  });

  test(`${label}：没有证明项（空、只有 promptcut.v1、票据）→ 400`, async (t) => {
    const env = await hostFor(t, { attached });
    for (const protocols of [[], [PROTOCOL], [PROTOCOL, 'promptcut.ticket.abc'], 'x', [PROTOCOL, 'a,b']]) {
      const r = await env.http('shared/verify', { method: 'POST', body: { protocols }, remote: PUBLIC });
      assert.equal(r.status, 400, `${JSON.stringify(protocols)}：${r.text}`);
    }
  });
}

/**
 * `server/auth/` 的编码与派生（实现方自测；契约 `docs/plan/auth-contract.md` 第 2、5、7、8 节）。
 * 跑：node --test server/test/auth-impl-crypto.test.mjs
 *
 * 纯 JS 的 SHA-256 / HMAC / PBKDF2 以 `node:crypto` 对拍；客户端的 WebCrypto 路径与纯 JS 路径结果相同。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256, hmacSha256, pbkdf2Sha256 } from '../auth/pure.mjs';
import {
  b64urlEncode, b64urlDecode, authPurpose, adminPurpose, isProjectId, isProjectName, nameKey, isUsername, isDeviceId,
  isDeviceName, isKdf, normalizeOwner, splitUserId, isB64Bytes,
} from '../auth/protocol.mjs';
import {
  deriveKey, makeCredential, authProof, adminProof, httpBaseOf, ticketExpiry, ticketPayload, ticketProtocols, newSalt,
} from '../auth/client.mjs';

const rnd = (n) => crypto.randomBytes(n);

test('pure：SHA-256 与 node:crypto 对拍（0～300 字节的各种长度，含块边界）', () => {
  for (const len of [0, 1, 3, 31, 32, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 200, 300]) {
    const d = rnd(len);
    assert.equal(Buffer.from(sha256(d)).toString('hex'), crypto.createHash('sha256').update(d).digest('hex'), `长度 ${len}`);
  }
  assert.equal(Buffer.from(sha256(new TextEncoder().encode('abc'))).toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('pure：HMAC-SHA256 与 node:crypto 对拍（短密钥、64 字节、超过一块的长密钥）', () => {
  for (const klen of [0, 1, 16, 32, 63, 64, 65, 100, 200]) {
    for (const dlen of [0, 10, 64, 100]) {
      const k = rnd(klen);
      const d = rnd(dlen);
      assert.equal(Buffer.from(hmacSha256(k, d)).toString('hex'), crypto.createHmac('sha256', k).update(d).digest('hex'), `k=${klen} d=${dlen}`);
    }
  }
});

test('pure：PBKDF2-HMAC-SHA256 与 node:crypto 对拍（1、2、1000、10000 次；输出 20 / 32 / 64 字节）', () => {
  const pw = Buffer.from('pässwörd 口令', 'utf8');
  for (const [iter, len] of [[1, 32], [2, 32], [1000, 32], [10000, 32], [3, 20], [5, 64]]) {
    const salt = rnd(16);
    assert.equal(
      Buffer.from(pbkdf2Sha256(pw, salt, iter, len)).toString('hex'),
      crypto.pbkdf2Sync(pw, salt, iter, len, 'sha256').toString('hex'),
      `iter=${iter} len=${len}`,
    );
  }
  assert.throws(() => pbkdf2Sha256(pw, rnd(16), 0, 32), RangeError);
});

test('pure：60 万次的一整轮与 node:crypto 相同', { timeout: 30_000 }, () => {
  const pw = Buffer.from('correct horse battery staple');
  const salt = rnd(16);
  assert.equal(Buffer.from(pbkdf2Sha256(pw, salt, 600000, 32)).toString('hex'), crypto.pbkdf2Sync(pw, salt, 600000, 32, 'sha256').toString('hex'));
});

test('base64url：与 Buffer 的编码相同；解码严格（不带 =、非法字符、多余位、4n+1 长度都回 null）', () => {
  for (let n = 0; n < 70; n++) {
    const b = rnd(n);
    const t = b64urlEncode(b);
    assert.equal(t, b.toString('base64url'), `长度 ${n}`);
    assert.deepEqual(Buffer.from(b64urlDecode(t)), b);
  }
  for (const bad of ['a', 'ab=', 'a+b/', 'ab c', 'AB', 'AAB', null, 12]) {
    if (bad === 'AB' || bad === 'AAB') continue;
    assert.equal(b64urlDecode(bad), null, String(bad));
  }
  assert.equal(b64urlDecode('AB'), null, '末尾多余的位不是 0');
  assert.equal(b64urlDecode('AAB'), null, '末尾多余的位不是 0');
  assert.deepEqual([...b64urlDecode('AA')], [0]);
  assert.equal(isB64Bytes(rnd(16).toString('base64url'), 16), true);
  assert.equal(isB64Bytes(rnd(15).toString('base64url'), 16), false);
});

test('用途串：字段按契约的顺序与分隔符拼', () => {
  const t = (u8) => Buffer.from(u8).toString('utf8');
  assert.equal(t(authPurpose({ projectId: 'sp_x', username: '阿丽', deviceId: 'dev', as: 'member', nonce: 'N' })), 'promptcut.auth.v1\nsp_x\n阿丽\ndev\nmember\nN');
  assert.equal(t(adminPurpose({ projectId: 'sp_x', username: 'alice', op: 'kick', nonce: 'N' })), 'promptcut.admin.v1\nsp_x\nalice\nkick\nN');
});

test('字段校验：projectId、项目名、用户名、设备、kdf、归属、userId 拆分', () => {
  assert.equal(isProjectId(`sp_${'a'.repeat(26)}`), true);
  assert.equal(isProjectId(`sp_${'a'.repeat(25)}`), false);
  assert.equal(isProjectId(`sp_${'A'.repeat(26)}`), false);
  assert.equal(isProjectId(`sp_${'1'.repeat(26)}`), false, 'base32 没有 0、1、8、9');
  assert.equal(isProjectName('演示 Demo'), true);
  assert.equal(isProjectName('a'.repeat(64)), true);
  assert.equal(isProjectName('a'.repeat(65)), false);
  assert.equal(isProjectName('a/b'), false);
  assert.equal(isProjectName('a\nb'), false);
  assert.equal(isProjectName(''), false);
  assert.equal(nameKey('Ｄemo'), nameKey('Ｄemo'.normalize('NFC')));
  assert.equal(nameKey('Café'), nameKey('Café'), 'NFC 不同形同名');
  assert.equal(nameKey('DEMO'), nameKey('demo'));
  assert.equal(isUsername('bob'), true);
  assert.equal(isUsername(' bob'), false);
  assert.equal(isUsername('b\nob'), false);
  assert.equal(isDeviceId('a'.repeat(16)), true);
  assert.equal(isDeviceId('a'.repeat(15)), false);
  assert.equal(isDeviceId('a@b'.repeat(8)), false);
  assert.equal(isDeviceName('Bob 的电脑'), true);
  assert.equal(isKdf({ alg: 'pbkdf2-sha256', iter: 600000 }), true);
  assert.equal(isKdf({ alg: 'pbkdf2-sha256', iter: 99999 }), false);
  assert.equal(isKdf({ alg: 'pbkdf2-sha256', iter: 5000001 }), false);
  assert.equal(isKdf({ alg: 'scrypt', iter: 600000 }), false);
  assert.equal(isKdf({ alg: 'pbkdf2-sha256', iter: 600000, extra: 1 }), false);
  assert.deepEqual(normalizeOwner({ kind: 'user' }), { kind: 'user' });
  assert.deepEqual(normalizeOwner({ kind: 'agent', c: 3 }), { kind: 'agent', c: 3 });
  assert.equal(normalizeOwner({ kind: 'agent' }), null);
  assert.equal(normalizeOwner({ kind: 'user', x: 1 }), null);
  assert.deepEqual(splitUserId('a@b@dev-0000000000000001'), { username: 'a@b', deviceId: 'dev-0000000000000001' });
  assert.equal(splitUserId('bob'), null);
});

test('client：deriveKey 走 WebCrypto 与走纯 JS 结果相同，且等于 node:crypto.pbkdf2', async () => {
  const salt = newSalt();
  const kdf = { alg: 'pbkdf2-sha256', iter: 100000 };
  const a = await deriveKey('口令 pw', salt, kdf);
  const b = await deriveKey('口令 pw', salt, kdf, { pure: true });
  const c = crypto.pbkdf2Sync(Buffer.from('口令 pw', 'utf8'), Buffer.from(salt, 'base64url'), 100000, 32, 'sha256').toString('base64url');
  assert.equal(a, c);
  assert.equal(b, c);
  await assert.rejects(deriveKey('', salt, kdf), TypeError);
  await assert.rejects(deriveKey('x', 'short', kdf), TypeError);
  await assert.rejects(deriveKey('x', salt, { alg: 'pbkdf2-sha256', iter: 10 }), TypeError);
  const cred = await makeCredential('pw', kdf);
  assert.equal(Buffer.from(cred.salt, 'base64url').length, 16);
  assert.equal(cred.key, await deriveKey('pw', cred.salt, kdf));
});

test('client：authProof / adminProof = HMAC(K, 用途串)，WebCrypto 与纯 JS 相同', async () => {
  const key = rnd(32).toString('base64url');
  const f = { key, projectId: `sp_${'b'.repeat(26)}`, username: 'bob', deviceId: 'dev-000000000001', as: 'member', nonce: 'nnn' };
  const expected = crypto.createHmac('sha256', Buffer.from(key, 'base64url')).update(Buffer.from(authPurpose(f))).digest('base64url');
  assert.equal(await authProof(f), expected);
  assert.equal(await authProof(f, { pure: true }), expected);
  const g = { key, projectId: f.projectId, username: 'alice', op: 'delete', nonce: 'z' };
  const e2 = crypto.createHmac('sha256', Buffer.from(key, 'base64url')).update(Buffer.from(adminPurpose(g))).digest('base64url');
  assert.equal(await adminProof(g), e2);
  assert.equal(await adminProof(g, { pure: true }), e2);
  await assert.rejects(authProof({ ...f, key: 'short' }), TypeError);
});

test('client：httpBaseOf、票据解析与子协议', () => {
  assert.equal(httpBaseOf('ws://h:8787'), 'http://h:8787');
  assert.equal(httpBaseOf('wss://h/'), 'https://h');
  assert.equal(httpBaseOf('ws://h:5190/docservice'), 'http://h:5190/docservice');
  assert.equal(httpBaseOf('http://h:5190/docservice/'), 'http://h:5190/docservice');
  assert.throws(() => httpBaseOf('ftp://h'), TypeError);
  const payload = { kid: 'k', k: 'asset', p: 'sp_x', u: 'u@d', r: 'r', g: 1, ug: 1, exp: 12345, iat: 1 };
  const t = `v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
  assert.equal(ticketExpiry(t), 12345);
  assert.deepEqual(ticketPayload(t), payload);
  assert.equal(ticketExpiry('v2.x.y'), null);
  assert.equal(ticketExpiry('garbage'), null);
  assert.deepEqual(ticketProtocols('T'), ['promptcut.v1', 'promptcut.ticket.T']);
});

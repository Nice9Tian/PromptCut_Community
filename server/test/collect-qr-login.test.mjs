// Bilibili QR code login (API version): mock fetch replays various generate / poll responses.
// Run command: node --test server/test/collect-qr-login.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createQrLogin, parseSetCookie, cookiesFromCrossDomainUrl, mergeCookies,
} from '../collect-qr-login.mjs';
import { savedCookieStatus } from '../collect-cookies.mjs';

const KEY = 'aa6b16028dda91ae6543bed069a249ea';
const GEN = { code: 0, message: 'OK', data: { url: `https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=${KEY}&from=`, qrcode_key: KEY } };
const pollBody = (code, message, url = '') => ({ code: 0, message: 'OK', data: { url, refresh_token: '', timestamp: 0, code, message } });

/** Create a mock fetch: replays poll responses in order */
function fakeFetch(pollResponses) {
  const calls = [];
  const queue = [...pollResponses];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('/generate')) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => GEN };
    }
    const next = queue.shift();
    if (!next) throw new Error('poll was called one extra time');
    const headers = new Headers();
    for (const l of next.setCookie ?? []) headers.append('set-cookie', l);
    return { ok: next.ok ?? true, status: next.status ?? 200, headers, json: async () => next.body };
  };
  return { fetchImpl, calls };
}

test('parseSetCookie: name and value, Domain, Path, Expires, Secure, HttpOnly', () => {
  const c = parseSetCookie('SESSDATA=abc%2Cdef; Path=/; Domain=bilibili.com; Expires=Sun, 07 Mar 2027 00:00:00 GMT; HttpOnly; Secure');
  assert.equal(c.name, 'SESSDATA');
  assert.equal(c.value, 'abc%2Cdef');
  assert.equal(c.domain, '.bilibili.com', 'A Domain without a leading dot gets one added');
  assert.equal(c.path, '/');
  assert.equal(c.expires, Math.floor(Date.parse('Sun, 07 Mar 2027 00:00:00 GMT') / 1000));
  assert.equal(c.secure, true);
  assert.equal(c.httpOnly, true);
  const s = parseSetCookie('sid=x; Path=/');
  assert.equal(s.expires, -1, 'No Expires means a session cookie');
  assert.equal(s.domain, '.bilibili.com', 'Default domain');
  assert.equal(parseSetCookie(''), null);
  assert.equal(parseSetCookie('=nope'), null);
});

test('cookiesFromCrossDomainUrl: fills in cookies from the url of a successful response, Expires is relative seconds', () => {
  const before = Math.floor(Date.now() / 1000);
  const cs = cookiesFromCrossDomainUrl('https://passport.biligame.com/x/passport-login/web/crossDomain?DedeUserID=123&DedeUserID__ckMd5=m&SESSDATA=s&bili_jct=j&Expires=15552000&gourl=https%3A%2F%2Fwww.bilibili.com');
  const names = cs.map((c) => c.name);
  assert.deepEqual(names, ['DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA', 'bili_jct']);
  assert.ok(cs[0].expires >= before + 15552000 - 2);
  assert.deepEqual(cookiesFromCrossDomainUrl('not a url'), []);
});

test('mergeCookies: for the same name, Set-Cookie wins', () => {
  const m = mergeCookies([parseSetCookie('SESSDATA=header; Path=/')], cookiesFromCrossDomainUrl('https://x/?SESSDATA=url&bili_jct=j&Expires=10'));
  assert.equal(m.find((c) => c.name === 'SESSDATA').value, 'header');
  assert.equal(m.find((c) => c.name === 'bili_jct').value, 'j');
});

test('start → waiting → scanned → ok: saves to disk on successful login, then poll returns ok directly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-qr-'));
  const soon = new Date(Date.now() + 30 * 86400 * 1000).toUTCString();
  const { fetchImpl, calls } = fakeFetch([
    { body: pollBody(86101, 'Not scanned') },
    { body: pollBody(86090, 'QR code scanned, not yet confirmed') },
    {
      body: pollBody(0, '', 'https://passport.biligame.com/x/passport-login/web/crossDomain?DedeUserID=42&SESSDATA=s&bili_jct=j&Expires=15552000'),
      setCookie: [
        `SESSDATA=sess%2C1; Path=/; Domain=bilibili.com; Expires=${soon}; HttpOnly; Secure`,
        `bili_jct=csrf; Path=/; Domain=bilibili.com; Expires=${soon}`,
        `DedeUserID=42; Path=/; Domain=bilibili.com; Expires=${soon}`,
        `sid=abc; Path=/; Domain=bilibili.com`,
      ],
    },
  ]);
  const q = createQrLogin({ fetchImpl });
  try {
    const s = await q.start('bilibili');
    assert.equal(s.key, KEY);
    assert.equal(s.expiresIn, 180);
    assert.match(s.url, /qrcode_key=/);
    assert.match(calls[0].opts.headers['User-Agent'], /Chrome/);
    assert.match(q.svg(KEY), /^<svg /);
    assert.equal(q.svg('nope'), null);

    assert.equal((await q.poll(KEY, { dataDir: dir })).state, 'waiting');
    assert.equal((await q.poll(KEY, { dataDir: dir })).state, 'scanned');
    const ok = await q.poll(KEY, { dataDir: dir });
    assert.equal(ok.state, 'ok');
    assert.equal(ok.userId, '42');
    assert.equal(ok.loggedIn, true);
    assert.ok(ok.expiresAt);
    assert.ok(fs.existsSync(ok.path));
    assert.equal(ok.count, 4);
    // Saved content can be read back by collect-cookies as the login state
    const st = savedCookieStatus(dir, 'bilibili');
    assert.equal(st.loggedIn, true);
    assert.equal(st.userId, '42');
    // No longer hits the network after success
    const again = await q.poll(KEY, { dataDir: dir });
    assert.equal(again.state, 'ok');
    assert.equal(calls.filter((c) => c.url.includes('/poll')).length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Expired: when Bilibili says 86038 or the local ttl is exceeded, expired is returned; a nonexistent key also returns expired', async () => {
  let t = 1_800_000_000_000;
  const { fetchImpl } = fakeFetch([{ body: pollBody(86038, 'QR code has expired') }]);
  const q = createQrLogin({ fetchImpl, now: () => t });
  await q.start();
  assert.equal((await q.poll(KEY)).state, 'expired');
  // Determining expiration locally does not hit the network
  const q2 = createQrLogin({ fetchImpl: fakeFetch([]).fetchImpl, now: () => t });
  await q2.start();
  t += 181 * 1000;
  const r = await q2.poll(KEY);
  assert.equal(r.state, 'expired');
  assert.match(r.message, /expired/);
  assert.equal((await q2.poll('missing')).state, 'expired');
});

test('The login response lacks some key cookies: nothing is saved, returns expired and says what is missing', async () => {
  const { fetchImpl } = fakeFetch([{ body: pollBody(0, ''), setCookie: ['SESSDATA=s; Path=/; Domain=bilibili.com'] }]);
  const q = createQrLogin({ fetchImpl });
  await q.start();
  const r = await q.poll(KEY);
  assert.equal(r.state, 'expired');
  assert.match(r.message, /bili_jct/);
});

test('generate fails or has a bad format: start throws a readable message', async () => {
  const bad = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ code: -412, message: 'Request blocked' }) });
  await assert.rejects(createQrLogin({ fetchImpl: bad }).start(), /Request blocked/);
  const http = async () => ({ ok: false, status: 503, headers: new Headers(), json: async () => ({}) });
  await assert.rejects(createQrLogin({ fetchImpl: http }).start(), /HTTP 503/);
  await assert.rejects(createQrLogin({ fetchImpl: bad }).start('youtube'), /no QR code login/);
});

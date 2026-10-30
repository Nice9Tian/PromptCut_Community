// 哔哩哔哩扫码登录(接口版):假 fetch 回放 generate / poll 的各种响应。
// 跑法:node --test server/test/collect-qr-login.test.mjs
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

/** 造一个假 fetch:按顺序回放 poll 的响应 */
function fakeFetch(pollResponses) {
  const calls = [];
  const queue = [...pollResponses];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('/generate')) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => GEN };
    }
    const next = queue.shift();
    if (!next) throw new Error('poll 被多调了一次');
    const headers = new Headers();
    for (const l of next.setCookie ?? []) headers.append('set-cookie', l);
    return { ok: next.ok ?? true, status: next.status ?? 200, headers, json: async () => next.body };
  };
  return { fetchImpl, calls };
}

test('parseSetCookie:名值、Domain、Path、Expires、Secure、HttpOnly', () => {
  const c = parseSetCookie('SESSDATA=abc%2Cdef; Path=/; Domain=bilibili.com; Expires=Sun, 07 Mar 2027 00:00:00 GMT; HttpOnly; Secure');
  assert.equal(c.name, 'SESSDATA');
  assert.equal(c.value, 'abc%2Cdef');
  assert.equal(c.domain, '.bilibili.com', '没带点的 Domain 补上点');
  assert.equal(c.path, '/');
  assert.equal(c.expires, Math.floor(Date.parse('Sun, 07 Mar 2027 00:00:00 GMT') / 1000));
  assert.equal(c.secure, true);
  assert.equal(c.httpOnly, true);
  const s = parseSetCookie('sid=x; Path=/');
  assert.equal(s.expires, -1, '没 Expires 是会话 cookie');
  assert.equal(s.domain, '.bilibili.com', '默认域');
  assert.equal(parseSetCookie(''), null);
  assert.equal(parseSetCookie('=nope'), null);
});

test('cookiesFromCrossDomainUrl:从成功响应的 url 里补 cookie,Expires 是相对秒数', () => {
  const before = Math.floor(Date.now() / 1000);
  const cs = cookiesFromCrossDomainUrl('https://passport.biligame.com/x/passport-login/web/crossDomain?DedeUserID=123&DedeUserID__ckMd5=m&SESSDATA=s&bili_jct=j&Expires=15552000&gourl=https%3A%2F%2Fwww.bilibili.com');
  const names = cs.map((c) => c.name);
  assert.deepEqual(names, ['DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA', 'bili_jct']);
  assert.ok(cs[0].expires >= before + 15552000 - 2);
  assert.deepEqual(cookiesFromCrossDomainUrl('not a url'), []);
});

test('mergeCookies:同名以 Set-Cookie 为准', () => {
  const m = mergeCookies([parseSetCookie('SESSDATA=header; Path=/')], cookiesFromCrossDomainUrl('https://x/?SESSDATA=url&bili_jct=j&Expires=10'));
  assert.equal(m.find((c) => c.name === 'SESSDATA').value, 'header');
  assert.equal(m.find((c) => c.name === 'bili_jct').value, 'j');
});

test('start → waiting → scanned → ok:登录成功时存盘,再 poll 直接回 ok', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-qr-'));
  const soon = new Date(Date.now() + 30 * 86400 * 1000).toUTCString();
  const { fetchImpl, calls } = fakeFetch([
    { body: pollBody(86101, '未扫码') },
    { body: pollBody(86090, '二维码已扫码未确认') },
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
    // 存盘的能被 collect-cookies 读回来当登录态
    const st = savedCookieStatus(dir, 'bilibili');
    assert.equal(st.loggedIn, true);
    assert.equal(st.userId, '42');
    // 成功之后不再打网络
    const again = await q.poll(KEY, { dataDir: dir });
    assert.equal(again.state, 'ok');
    assert.equal(calls.filter((c) => c.url.includes('/poll')).length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('过期:B 站说 86038,或本地超过 ttl,都回 expired;不存在的 key 也回 expired', async () => {
  let t = 1_800_000_000_000;
  const { fetchImpl } = fakeFetch([{ body: pollBody(86038, '二维码已失效') }]);
  const q = createQrLogin({ fetchImpl, now: () => t });
  await q.start();
  assert.equal((await q.poll(KEY)).state, 'expired');
  // 本地判过期不打网络
  const q2 = createQrLogin({ fetchImpl: fakeFetch([]).fetchImpl, now: () => t });
  await q2.start();
  t += 181 * 1000;
  const r = await q2.poll(KEY);
  assert.equal(r.state, 'expired');
  assert.match(r.message, /过期/);
  assert.equal((await q2.poll('missing')).state, 'expired');
});

test('登录响应里关键 cookie 不全:不存盘,回 expired 并说明缺什么', async () => {
  const { fetchImpl } = fakeFetch([{ body: pollBody(0, ''), setCookie: ['SESSDATA=s; Path=/; Domain=bilibili.com'] }]);
  const q = createQrLogin({ fetchImpl });
  await q.start();
  const r = await q.poll(KEY);
  assert.equal(r.state, 'expired');
  assert.match(r.message, /bili_jct/);
});

test('generate 失败或格式不对:start 抛人话', async () => {
  const bad = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ code: -412, message: '请求被拦截' }) });
  await assert.rejects(createQrLogin({ fetchImpl: bad }).start(), /请求被拦截/);
  const http = async () => ({ ok: false, status: 503, headers: new Headers(), json: async () => ({}) });
  await assert.rejects(createQrLogin({ fetchImpl: http }).start(), /HTTP 503/);
  await assert.rejects(createQrLogin({ fetchImpl: bad }).start('youtube'), /没有扫码登录/);
});

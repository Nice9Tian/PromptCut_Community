// Media collection login state: cookie evaluation, Netscape read/write, decisions on automatically
// attaching cookies. All pure logic, without touching the browser or network. Run command:
// node --test server/test/collect-cookies.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SITES, siteOfUrl, toNetscape, parseNetscape, assessLogin,
  saveCookies, savedCookieStatus, forgetCookies, pickCookies, cookieFilePath,
} from '../collect-cookies.mjs';

const NOW = 1_800_000_000_000; // 2027-01
const IN_A_MONTH = Math.floor(NOW / 1000) + 30 * 86400;

/** Field shape measured from CDP Network.getAllCookies */
const LOGGED_IN = [
  { name: 'buvid3', value: '2AF9E3A3-x', domain: '.bilibili.com', path: '/', expires: IN_A_MONTH + 86400 * 300, httpOnly: false, secure: false, session: false },
  { name: 'SESSDATA', value: 'abc%2Cdef', domain: '.bilibili.com', path: '/', expires: IN_A_MONTH, httpOnly: true, secure: true, session: false },
  { name: 'bili_jct', value: 'csrf123', domain: '.bilibili.com', path: '/', expires: IN_A_MONTH + 10, httpOnly: false, secure: false, session: false },
  { name: 'DedeUserID', value: '123456', domain: '.bilibili.com', path: '/', expires: IN_A_MONTH + 20, httpOnly: false, secure: false, session: false },
  { name: 'sid', value: 'sess', domain: '.bilibili.com', path: '/', expires: -1, httpOnly: false, secure: false, session: true },
  { name: 'other', value: 'x', domain: 'example.com', path: '/', expires: IN_A_MONTH, httpOnly: false, secure: false, session: false },
];

test('siteOfUrl: recognizes BV IDs, av IDs and all kinds of Bilibili links, not other sites', () => {
  for (const u of ['BV1BYtB6GEFV', 'av170001', 'https://www.bilibili.com/video/BV1BYtB6GEFV', 'bilibili.com/video/BV1x', 'https://b23.tv/abc', 'https://m.bilibili.com/video/BV1x?p=2']) {
    assert.equal(siteOfUrl(u), 'bilibili', u);
  }
  assert.equal(siteOfUrl('https://www.youtube.com/watch?v=x'), null);
  assert.equal(siteOfUrl('https://example.com/bilibili.com/x'), null);
});

test('assessLogin: logged in only when all three key cookies are present, expiry is taken from the earliest one', () => {
  const a = assessLogin('bilibili', LOGGED_IN, NOW);
  assert.equal(a.loggedIn, true);
  assert.deepEqual(a.missing, []);
  assert.equal(a.userId, '123456');
  assert.equal(a.expiresAt, IN_A_MONTH * 1000, 'SESSDATA expires first, take it');
  assert.equal(a.cookies.length, 5, 'Cookies of other sites are not included');
});

test('assessLogin: missing one means not logged in, and lists which one is missing', () => {
  const a = assessLogin('bilibili', LOGGED_IN.filter((c) => c.name !== 'SESSDATA'), NOW);
  assert.equal(a.loggedIn, false);
  assert.deepEqual(a.missing, ['SESSDATA']);
});

test('assessLogin: not logged in once a key cookie has expired', () => {
  const a = assessLogin('bilibili', LOGGED_IN, IN_A_MONTH * 1000 + 1);
  assert.equal(a.loggedIn, false);
  assert.equal(a.expired, true);
});

test('assessLogin: an unknown site throws directly', () => {
  assert.throws(() => assessLogin('nope', [], NOW), /No site named nope/);
});

test('toNetscape / parseNetscape round-trip consistently, session cookies are written as 0, domains including subdomains use TRUE', () => {
  const text = toNetscape(LOGGED_IN);
  assert.ok(text.startsWith('# Netscape HTTP Cookie File\n'), 'The first line must be this one, yt-dlp relies on it to recognize the format');
  const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.equal(lines.length, LOGGED_IN.length);
  assert.equal(lines[0], `.bilibili.com\tTRUE\t/\tFALSE\t${IN_A_MONTH + 86400 * 300}\tbuvid3\t2AF9E3A3-x`);
  assert.equal(lines[1].split('\t')[3], 'TRUE', 'secure column');
  assert.equal(lines[4].split('\t')[4], '0', 'A session cookie\'s expires is written as 0');
  assert.equal(lines[5].split('\t')[1], 'FALSE', 'A domain without a leading dot does not include subdomains');

  const back = parseNetscape(text);
  assert.equal(back.length, LOGGED_IN.length);
  assert.equal(back[1].name, 'SESSDATA');
  assert.equal(back[1].value, 'abc%2Cdef');
  assert.equal(back[1].secure, true);
  assert.equal(back[1].expires, IN_A_MONTH);
  assert.equal(back[4].expires, -1, '0 is read back as a session cookie');
  // Evaluate again after parsing; the result is the same as the original cookie
  assert.equal(assessLogin('bilibili', back, NOW).loggedIn, true);
});

test('parseNetscape: lines with the #HttpOnly_ prefix are not dropped as comments, tabs inside values are not truncated', () => {
  const back = parseNetscape('# x\n#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tv\n.b.com\tTRUE\t/\tFALSE\t0\tn\ta\tb\n');
  assert.equal(back[0].name, 'SESSDATA');
  assert.equal(back[0].domain, '.bilibili.com');
  assert.equal(back[1].value, 'a\tb');
});

test('Save to disk / read status / log out / automatically include cookies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cookies-'));
  try {
    // No file: not logged in, pickCookies explains the reason but provides no path
    const s0 = savedCookieStatus(dir, 'bilibili', NOW);
    assert.equal(s0.exists, false);
    assert.equal(s0.loggedIn, false);
    const p0 = pickCookies(dir, 'BV1BYtB6GEFV');
    assert.equal(p0.path, null);
    assert.match(p0.reason, /Not logged in/);
    // Not a site with login support: say nothing
    assert.deepEqual(pickCookies(dir, 'https://youtube.com/watch?v=x'), { path: null, site: null, reason: null });

    // After saving to disk: logged in, pickCookies provides the path
    const file = saveCookies(dir, 'bilibili', LOGGED_IN);
    assert.equal(file, cookieFilePath(dir, 'bilibili'));
    assert.ok(fs.existsSync(file));
    const s1 = savedCookieStatus(dir, 'bilibili', NOW);
    assert.equal(s1.loggedIn, true);
    assert.equal(s1.userId, '123456');
    const p1 = pickCookies(dir, 'https://www.bilibili.com/video/BV1BYtB6GEFV');
    assert.equal(p1.path, file);
    assert.match(p1.reason, /123456/);

    // Explicitly provided path takes precedence; if a non-existent path is given, treat as not logged in
    // and explain
    assert.equal(pickCookies(dir, 'BV1x', file).path, file);
    const bad = pickCookies(dir, 'BV1x', path.join(dir, 'nope.txt'));
    assert.equal(bad.path, null);
    assert.match(bad.reason, /does not exist/);

    // Expired: file still exists but is not attached
    const sExp = savedCookieStatus(dir, 'bilibili', IN_A_MONTH * 1000 + 1);
    assert.equal(sExp.exists, true);
    assert.equal(sExp.expired, true);
    assert.equal(sExp.loggedIn, false);

    // Log out
    assert.equal(forgetCookies(dir, 'bilibili'), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(forgetCookies(dir, 'bilibili'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('The login page of SITES.bilibili is on the passport domain, three key cookies', () => {
  assert.match(SITES.bilibili.loginUrl, /^https:\/\/passport\.bilibili\.com\//);
  assert.deepEqual(SITES.bilibili.required, ['SESSDATA', 'bili_jct', 'DedeUserID']);
});

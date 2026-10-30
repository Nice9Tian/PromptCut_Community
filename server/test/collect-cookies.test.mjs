// 素材收集的登录态:cookie 判定、Netscape 读写、自动带 cookie 的决定。
// 全是纯逻辑,不碰浏览器和网络。跑法:node --test server/test/collect-cookies.test.mjs
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

/** CDP Network.getAllCookies 实测的字段形状 */
const LOGGED_IN = [
  { name: 'buvid3', value: '2AF9E3A3-x', domain: '.bilibili.com', path: '/', expires: IN_A_MONTH + 86400 * 300, httpOnly: false, secure: false, session: false },
  { name: 'SESSDATA', value: 'abc%2Cdef', domain: '.bilibili.com', path: '/', expires: IN_A_MONTH, httpOnly: true, secure: true, session: false },
  { name: 'bili_jct', value: 'csrf123', domain: '.bilibili.com', path: '/', expires: IN_A_MONTH + 10, httpOnly: false, secure: false, session: false },
  { name: 'DedeUserID', value: '123456', domain: '.bilibili.com', path: '/', expires: IN_A_MONTH + 20, httpOnly: false, secure: false, session: false },
  { name: 'sid', value: 'sess', domain: '.bilibili.com', path: '/', expires: -1, httpOnly: false, secure: false, session: true },
  { name: 'other', value: 'x', domain: 'example.com', path: '/', expires: IN_A_MONTH, httpOnly: false, secure: false, session: false },
];

test('siteOfUrl:BV 号、av 号、各种 B 站链接都认,别的站不认', () => {
  for (const u of ['BV1BYtB6GEFV', 'av170001', 'https://www.bilibili.com/video/BV1BYtB6GEFV', 'bilibili.com/video/BV1x', 'https://b23.tv/abc', 'https://m.bilibili.com/video/BV1x?p=2']) {
    assert.equal(siteOfUrl(u), 'bilibili', u);
  }
  assert.equal(siteOfUrl('https://www.youtube.com/watch?v=x'), null);
  assert.equal(siteOfUrl('https://example.com/bilibili.com/x'), null);
});

test('assessLogin:三个关键 cookie 都在才算登录,过期时间取最早的那个', () => {
  const a = assessLogin('bilibili', LOGGED_IN, NOW);
  assert.equal(a.loggedIn, true);
  assert.deepEqual(a.missing, []);
  assert.equal(a.userId, '123456');
  assert.equal(a.expiresAt, IN_A_MONTH * 1000, 'SESSDATA 最早过期,取它');
  assert.equal(a.cookies.length, 5, '别的站的 cookie 不带');
});

test('assessLogin:缺一个就不算登录,并列出缺哪个', () => {
  const a = assessLogin('bilibili', LOGGED_IN.filter((c) => c.name !== 'SESSDATA'), NOW);
  assert.equal(a.loggedIn, false);
  assert.deepEqual(a.missing, ['SESSDATA']);
});

test('assessLogin:关键 cookie 过期了就不算登录', () => {
  const a = assessLogin('bilibili', LOGGED_IN, IN_A_MONTH * 1000 + 1);
  assert.equal(a.loggedIn, false);
  assert.equal(a.expired, true);
});

test('assessLogin:不认识的站点直接抛', () => {
  assert.throws(() => assessLogin('nope', [], NOW), /没有叫 nope/);
});

test('toNetscape / parseNetscape 往返一致,会话 cookie 写 0、含子域用 TRUE', () => {
  const text = toNetscape(LOGGED_IN);
  assert.ok(text.startsWith('# Netscape HTTP Cookie File\n'), '首行必须是这句,yt-dlp 靠它认格式');
  const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.equal(lines.length, LOGGED_IN.length);
  assert.equal(lines[0], `.bilibili.com\tTRUE\t/\tFALSE\t${IN_A_MONTH + 86400 * 300}\tbuvid3\t2AF9E3A3-x`);
  assert.equal(lines[1].split('\t')[3], 'TRUE', 'secure 列');
  assert.equal(lines[4].split('\t')[4], '0', '会话 cookie 的 expires 写 0');
  assert.equal(lines[5].split('\t')[1], 'FALSE', '不带点的域不含子域');

  const back = parseNetscape(text);
  assert.equal(back.length, LOGGED_IN.length);
  assert.equal(back[1].name, 'SESSDATA');
  assert.equal(back[1].value, 'abc%2Cdef');
  assert.equal(back[1].secure, true);
  assert.equal(back[1].expires, IN_A_MONTH);
  assert.equal(back[4].expires, -1, '0 读回来当会话 cookie');
  // 解析后再判定,结果和原始 cookie 一样
  assert.equal(assessLogin('bilibili', back, NOW).loggedIn, true);
});

test('parseNetscape:#HttpOnly_ 前缀的行不当注释丢掉,值里的 tab 不截断', () => {
  const back = parseNetscape('# x\n#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tv\n.b.com\tTRUE\t/\tFALSE\t0\tn\ta\tb\n');
  assert.equal(back[0].name, 'SESSDATA');
  assert.equal(back[0].domain, '.bilibili.com');
  assert.equal(back[1].value, 'a\tb');
});

test('存盘 / 读状态 / 退出登录 / 自动带 cookie', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cookies-'));
  try {
    // 没文件:未登录,pickCookies 说明原因但不给路径
    const s0 = savedCookieStatus(dir, 'bilibili', NOW);
    assert.equal(s0.exists, false);
    assert.equal(s0.loggedIn, false);
    const p0 = pickCookies(dir, 'BV1BYtB6GEFV');
    assert.equal(p0.path, null);
    assert.match(p0.reason, /未登录/);
    // 不是有登录支持的站:什么都不说
    assert.deepEqual(pickCookies(dir, 'https://youtube.com/watch?v=x'), { path: null, site: null, reason: null });

    // 存盘之后:登录,pickCookies 给路径
    const file = saveCookies(dir, 'bilibili', LOGGED_IN);
    assert.equal(file, cookieFilePath(dir, 'bilibili'));
    assert.ok(fs.existsSync(file));
    const s1 = savedCookieStatus(dir, 'bilibili', NOW);
    assert.equal(s1.loggedIn, true);
    assert.equal(s1.userId, '123456');
    const p1 = pickCookies(dir, 'https://www.bilibili.com/video/BV1BYtB6GEFV');
    assert.equal(p1.path, file);
    assert.match(p1.reason, /123456/);

    // 显式给的路径优先;给了个不存在的就按未登录并说明
    assert.equal(pickCookies(dir, 'BV1x', file).path, file);
    const bad = pickCookies(dir, 'BV1x', path.join(dir, 'nope.txt'));
    assert.equal(bad.path, null);
    assert.match(bad.reason, /不存在/);

    // 过期:文件还在但不带
    const sExp = savedCookieStatus(dir, 'bilibili', IN_A_MONTH * 1000 + 1);
    assert.equal(sExp.exists, true);
    assert.equal(sExp.expired, true);
    assert.equal(sExp.loggedIn, false);

    // 退出登录
    assert.equal(forgetCookies(dir, 'bilibili'), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(forgetCookies(dir, 'bilibili'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SITES.bilibili 的登录页是 passport 域,关键 cookie 三个', () => {
  assert.match(SITES.bilibili.loginUrl, /^https:\/\/passport\.bilibili\.com\//);
  assert.deepEqual(SITES.bilibili.required, ['SESSDATA', 'bili_jct', 'DedeUserID']);
});

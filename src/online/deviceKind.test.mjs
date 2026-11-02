/**
 * 在线浏览器身份「电脑 / 手机」与界面选择(`src/online/deviceKind.ts`;语义 `mechanism/platforms.md`「身份」)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeDeviceKind, resolveIpad, pickLayout } from './deviceKind.ts';

const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipadSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
};

test('DK1 Android Chrome: userAgentData.mobile=true → phone', () => {
  assert.deepEqual(judgeDeviceKind({ ua: UA.androidChrome, uaData: { mobile: true }, maxTouchPoints: 5 }), { kind: 'phone', by: 'uaData', ipadLike: false });
});

test('DK2 desktop Chrome: userAgentData.mobile=false → computer', () => {
  assert.deepEqual(judgeDeviceKind({ ua: UA.desktopChrome, uaData: { mobile: false }, maxTouchPoints: 0 }), { kind: 'desktop', by: 'uaData', ipadLike: false });
});

test('DK3 iPhone Safari: no userAgentData, the user agent contains iPhone → phone', () => {
  assert.deepEqual(judgeDeviceKind({ ua: UA.iphoneSafari, uaData: null, maxTouchPoints: 5 }), { kind: 'phone', by: 'ua', ipadLike: false });
});

test('DK4 iPad Safari (desktop claim + multi-touch) → computer, flagged ipadLike; Mac Safari is not flagged', () => {
  assert.deepEqual(judgeDeviceKind({ ua: UA.ipadSafari, uaData: null, maxTouchPoints: 5 }), { kind: 'desktop', by: 'ua', ipadLike: true });
  assert.deepEqual(judgeDeviceKind({ ua: UA.macSafari, uaData: null, maxTouchPoints: 0 }), { kind: 'desktop', by: 'ua', ipadLike: false });
});

test('DK5 neither can be read → computer', () => {
  assert.deepEqual(judgeDeviceKind({}), { kind: 'desktop', by: 'none', ipadLike: false });
  assert.deepEqual(judgeDeviceKind({ ua: '', uaData: {} }), { kind: 'desktop', by: 'none', ipadLike: false });
});

test('DK6 iPad stage gate interface: no tier leaves it unchanged; tier 1 counts as phone, tiers 2 and 3 count as computer', () => {
  const ipad = judgeDeviceKind({ ua: UA.ipadSafari, maxTouchPoints: 5 });
  assert.equal(resolveIpad(ipad), 'desktop');
  assert.equal(resolveIpad(ipad, 1), 'phone');
  assert.equal(resolveIpad(ipad, 2), 'desktop');
  assert.equal(resolveIpad(ipad, 3), 'desktop');
  const phone = judgeDeviceKind({ ua: UA.androidChrome, uaData: { mobile: true } });
  assert.equal(resolveIpad(phone, 3), 'phone');
});

test('DK7 layout selection: identity is phone → mobile app, regardless of where the document service is; ?layout= forces it', () => {
  assert.equal(pickLayout({ kind: 'phone', search: '' }), 'mobile');
  assert.equal(pickLayout({ kind: 'desktop', search: '' }), 'desktop');
  assert.equal(pickLayout({ kind: 'phone' }), 'mobile', 'decide by identity even when search is not passed');
  assert.equal(pickLayout({ kind: 'desktop', search: '?layout=mobile' }), 'mobile');
  assert.equal(pickLayout({ kind: 'phone', search: '?layout=desktop' }), 'desktop');
  assert.equal(pickLayout({ kind: 'phone', search: '?layout=bogus' }), 'mobile');
});

test('DK7b no userAgentData over plain HTTP: Android phones must still be recognized by user agent (2026-10-26 end-to-end probe)', () => {
  // `navigator.userAgentData` 只在安全上下文里有；局域网里用 http://192.168.x.y:口 打开时读不到，
  // 只剩标识可看。不认安卓的话，手机在局域网里会拿到桌面界面。
  const androidNoHints = judgeDeviceKind({ ua: UA.androidChrome, uaData: null });
  assert.equal(androidNoHints.kind, 'phone');
  assert.equal(androidNoHints.by, 'ua');
  assert.equal(pickLayout({ kind: androidNoHints.kind, search: '' }), 'mobile');
  // 安卓平板(标识里没有 Mobile)照旧按电脑算
  assert.equal(judgeDeviceKind({ ua: UA.androidChrome.replace(' Mobile', ''), uaData: null }).kind, 'desktop');
  // 有 client hints 时仍以它为准
  assert.equal(judgeDeviceKind({ ua: UA.androidChrome, uaData: { mobile: false } }).kind, 'desktop');
});

test('DK8 second screen on the LAN: a phone identity on a local page still gets the mobile app layout', () => {
  // 2026-10-26 之前这里是 `online: false → 恒为桌面界面`,所以局域网里的手机拿不到手机版;
  // 语义改成「界面跟身份走,不看文档服务在哪」(product/platforms.md「桌面应用」的「局域网里的第二块屏」)。
  const phone = judgeDeviceKind({ ua: UA.androidChrome, uaData: { mobile: true } });
  assert.equal(phone.kind, 'phone');
  assert.equal(pickLayout({ kind: phone.kind, search: '?join=abc123' }), 'mobile', 'scanning the code with a phone to join a local project must give the mobile app layout');
  const pc = judgeDeviceKind({ ua: UA.desktopChrome, uaData: { mobile: false } });
  assert.equal(pickLayout({ kind: pc.kind, search: '?join=abc123' }), 'desktop', 'the desktop app\'s own window is still the desktop layout');
  // 开发和验收用的强制参数在本机页面上也认
  assert.equal(pickLayout({ kind: pc.kind, search: '?editor&layout=mobile' }), 'mobile');
});

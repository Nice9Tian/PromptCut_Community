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

test('DK1 安卓 Chrome:userAgentData.mobile=true → 手机', () => {
  assert.deepEqual(judgeDeviceKind({ ua: UA.androidChrome, uaData: { mobile: true }, maxTouchPoints: 5 }), { kind: 'phone', by: 'uaData', ipadLike: false });
});

test('DK2 桌面 Chrome:userAgentData.mobile=false → 电脑', () => {
  assert.deepEqual(judgeDeviceKind({ ua: UA.desktopChrome, uaData: { mobile: false }, maxTouchPoints: 0 }), { kind: 'desktop', by: 'uaData', ipadLike: false });
});

test('DK3 iPhone Safari:没有 userAgentData,标识里有 iPhone → 手机', () => {
  assert.deepEqual(judgeDeviceKind({ ua: UA.iphoneSafari, uaData: null, maxTouchPoints: 5 }), { kind: 'phone', by: 'ua', ipadLike: false });
});

test('DK4 iPad Safari(桌面声明 + 多点触控)→ 电脑,标 ipadLike;Mac Safari 不标', () => {
  assert.deepEqual(judgeDeviceKind({ ua: UA.ipadSafari, uaData: null, maxTouchPoints: 5 }), { kind: 'desktop', by: 'ua', ipadLike: true });
  assert.deepEqual(judgeDeviceKind({ ua: UA.macSafari, uaData: null, maxTouchPoints: 0 }), { kind: 'desktop', by: 'ua', ipadLike: false });
});

test('DK5 两样都读不到 → 电脑', () => {
  assert.deepEqual(judgeDeviceKind({}), { kind: 'desktop', by: 'none', ipadLike: false });
  assert.deepEqual(judgeDeviceKind({ ua: '', uaData: {} }), { kind: 'desktop', by: 'none', ipadLike: false });
});

test('DK6 iPad 的舞台闸门接口:没级别不变;第一级算手机,第二、三级算电脑', () => {
  const ipad = judgeDeviceKind({ ua: UA.ipadSafari, maxTouchPoints: 5 });
  assert.equal(resolveIpad(ipad), 'desktop');
  assert.equal(resolveIpad(ipad, 1), 'phone');
  assert.equal(resolveIpad(ipad, 2), 'desktop');
  assert.equal(resolveIpad(ipad, 3), 'desktop');
  const phone = judgeDeviceKind({ ua: UA.androidChrome, uaData: { mobile: true } });
  assert.equal(resolveIpad(phone, 3), 'phone');
});

test('DK7 选界面:身份为手机 → 手机版,不看文档服务在哪;?layout= 强制', () => {
  assert.equal(pickLayout({ kind: 'phone', search: '' }), 'mobile');
  assert.equal(pickLayout({ kind: 'desktop', search: '' }), 'desktop');
  assert.equal(pickLayout({ kind: 'phone' }), 'mobile', 'search 不传也按身份判');
  assert.equal(pickLayout({ kind: 'desktop', search: '?layout=mobile' }), 'mobile');
  assert.equal(pickLayout({ kind: 'phone', search: '?layout=desktop' }), 'desktop');
  assert.equal(pickLayout({ kind: 'phone', search: '?layout=bogus' }), 'mobile');
});

test('DK7b 明文 HTTP 上没有 userAgentData:安卓手机按标识也要认出来（2026-10-26 端到端探针）', () => {
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

test('DK8 局域网里的第二块屏:本机页面上手机身份照样拿手机版界面', () => {
  // 2026-10-26 之前这里是 `online: false → 恒为桌面界面`,所以局域网里的手机拿不到手机版;
  // 语义改成「界面跟身份走,不看文档服务在哪」(product/platforms.md「桌面应用」的「局域网里的第二块屏」)。
  const phone = judgeDeviceKind({ ua: UA.androidChrome, uaData: { mobile: true } });
  assert.equal(phone.kind, 'phone');
  assert.equal(pickLayout({ kind: phone.kind, search: '?join=abc123' }), 'mobile', '手机扫码进本机项目要手机版界面');
  const pc = judgeDeviceKind({ ua: UA.desktopChrome, uaData: { mobile: false } });
  assert.equal(pickLayout({ kind: pc.kind, search: '?join=abc123' }), 'desktop', '桌面应用自己的窗口照旧是桌面界面');
  // 开发和验收用的强制参数在本机页面上也认
  assert.equal(pickLayout({ kind: pc.kind, search: '?editor&layout=mobile' }), 'mobile');
});

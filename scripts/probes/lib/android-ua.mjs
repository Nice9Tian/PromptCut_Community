/**
 * 安卓手机的浏览器声明(UA 字符串 + `navigator.userAgentData`)。Puppeteer 的 `page.emulate` / `setUserAgent` 只改 UA 字符串,
 * `userAgentData` 还是本机(Windows、非手机);在线页面按 `userAgentData` 判身份与「安卓、内存不到 8 GB」(`src/online/stageGate.ts`、
 * `deviceKind.ts`),所以模拟手机要经 CDP 的 `Emulation.setUserAgentOverride` 一并给 `userAgentMetadata`(和 `lib/mobile-env.mjs` 的 DEVICES.phone 同一份)。
 * 会话留在 `page.__androidUa` 上,别让它被回收(回收了覆盖就没了)。
 */
export const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
export const ANDROID_UA_META = { brands: [{ brand: 'Chromium', version: '140' }, { brand: 'Google Chrome', version: '140' }], fullVersion: '140.0.0.0', platform: 'Android', platformVersion: '14', architecture: '', model: 'Pixel 8', mobile: true };

export async function androidUaData(page, ua = ANDROID_UA) {
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: ua, userAgentMetadata: ANDROID_UA_META });
  page.__androidUa = cdp;
  return cdp;
}

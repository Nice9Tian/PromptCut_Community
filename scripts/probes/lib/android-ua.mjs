/**
 * Browser declaration (UA string + `navigator.userAgentData`) for Android phones. Puppeteer's
 * `page.emulate` / `setUserAgent` only changes the UA string, while `userAgentData` remains
 * this machine (Windows, non-phone); online pages determine identity and "Android, memory under
 * 8 GB" via `userAgentData` (`src/online/stageGate.ts`, `deviceKind.ts`), so phone emulation
 * must also provide `userAgentMetadata` via CDP's `Emulation.setUserAgentOverride` (the same copy
 * as `DEVICES.phone` in `lib/mobile-env.mjs`).
 * The session stays on `page.__androidUa`; do not let it be garbage collected (if collected,
 * the override is lost).
 */
export const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
export const ANDROID_UA_META = { brands: [{ brand: 'Chromium', version: '140' }, { brand: 'Google Chrome', version: '140' }], fullVersion: '140.0.0.0', platform: 'Android', platformVersion: '14', architecture: '', model: 'Pixel 8', mobile: true };

export async function androidUaData(page, ua = ANDROID_UA) {
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: ua, userAgentMetadata: ANDROID_UA_META });
  page.__androidUa = cdp;
  return cdp;
}

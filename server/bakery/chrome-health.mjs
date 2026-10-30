/** A launched process is usable only when about:blank can create WebGL2. */
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function assertChromeWebGL2(browser) {
  // Puppeteer launches with about:blank already present. Do not create a new
  // native target here: every export target requires explicit offscreen bounds.
  const page = (await browser.pages()).find(candidate => candidate.url() === 'about:blank');
  if (!page) throw new Error('Chrome startup page is unavailable');
  const available = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  });
  if (!available) throw new Error('about:blank cannot create a WebGL2 context');
}

/** Launch at most twice; every rejected launch is closed before retrying. */
export async function launchHealthyChrome({ launch, attempts = 2, retryDelayMs = 500, jitterMs = 120, random = Math.random } = {}) {
  if (typeof launch !== 'function') throw new TypeError('launchHealthyChrome requires a launch callback');
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let browser;
    try {
      browser = await launch(attempt);
      await assertChromeWebGL2(browser);
      return browser;
    } catch (error) {
      // This is consumed by openBakery's existing installation fallback.
      await browser?.close().catch(() => {});
      if (/could not find/i.test(String(error?.message || error))) throw error;
      failures.push(`attempt ${attempt}: ${String(error?.message || error)}`);
      if (attempt < attempts) await pause(Math.max(0, retryDelayMs + Math.floor(Math.max(0, jitterMs) * random())));
    }
  }
  throw new Error(`Chrome WebGL2 health check failed after ${attempts} launch attempts (${failures.join('; ')})`);
}

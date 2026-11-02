import { describeEnvironment } from '../render-node/fingerprint.mjs';

/**
 * What environment the Chrome used for prerendering is (design 2.1, contract E.1).
 *
 * Pixels rendered in different environments have deterministic differences (font hinting,
 * anti-aliasing), so the prerender result key must be multiplied by the environment fingerprint
 * (`render-node/fingerprint.mjs`). Among the three fingerprint items, `os` comes from Node's
 * `process.platform`, while the other two can only be answered by a real Chrome:
 *
 *   - `chromeVersion`: `browser.version()`, e.g. `HeadlessChrome/138.0.7204.49`;
 *   - `renderer` / `vendor`: open a WebGL context in the page and read `UNMASKED_RENDERER_WEBGL` /
 *     `UNMASKED_VENDOR_WEBGL` (or `gl.RENDERER` / `gl.VENDOR` if there is no debug extension).
 *
 * Chrome for prerendering carries `--disable-gpu` and `--enable-unsafe-swiftshader` (CHROME_ARGS in
 * `chrome.mjs`), with WebGL using SwiftShader, so `gpuClass` of the local prerender process is
 * expected to be `software`. This is its true rasterization environment, without special-casing:
 * when launch arguments change on a standalone render host with a GPU in the future, the
 * fingerprint will naturally change accordingly.
 *
 * **Never throws**: if any step fails or times out, the missing item is treated as empty, with
 * `detected: false`. The caller (`FramePipeline.ensureEnvironment`) still adopts it as this
 * process's fingerprint: it is better for the fingerprint to be slightly coarser than to halt
 * prerendering because detection failed.
 */

/**
 * Probe function running inside the page. **Must be self-contained**: `page.evaluate` serializes
 * it into source code to send into the page, and closed-over values cannot be carried over.
 *
 * The canvas is not attached to the document, and is released immediately via `WEBGL_lose_context`
 * after use: there is an upper limit on WebGL contexts that can be opened concurrently on the page
 * (the export page of the prerender room); probing cannot take up a slot without releasing it, nor
 * can it touch the document, to avoid modifying the page's mutation count.
 */
function readWebglIdentity() {
  const canvas = document.createElement('canvas');
  for (const kind of ['webgl2', 'webgl']) {
    let gl = null;
    try { gl = canvas.getContext(kind); } catch { gl = null; }
    if (!gl) continue;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String((debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? '');
    const vendor = String((debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)) ?? '');
    try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* Failure to release does not affect the read values */ }
    return { renderer, vendor };
  }
  return { renderer: '', vendor: '' };
}

/**
 * If `work()` completes within `ms`, returns `{ ok: true, value }`; if it throws or times out,
 * returns `{ ok: false }`. Never throws.
 */
async function attempt(work, ms) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ ok: false }), Math.max(0, Number(ms) || 0));
    timer.unref?.();
  });
  let pending;
  try {
    pending = Promise.resolve(work());
  } catch {
    clearTimeout(timer);
    return { ok: false };
  }
  // After timeout, the original promise may still be rejected: catch it to avoid an unhandled
  // rejection
  pending.catch(() => {});
  try {
    return await Promise.race([pending.then(value => ({ ok: true, value }), () => ({ ok: false })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe the rendering environment where `browser` / `page` resides.
 * → `{ os, gpuClass, chromeMajor, fingerprint, renderer, vendor, chromeVersion, detected }`
 *
 * The two steps run in parallel, each bounded by `timeoutMs`, so the entire probe takes at most
 * ~`timeoutMs`. Only when both steps succeed is `detected: true`; failing to obtain a WebGL
 * context (two empty strings) also counts as success: that is the true reality of this environment
 * (`gpuClassOf` classifies it as `software`).
 */
export async function probeBrowserEnvironment({ browser, page } = {}, { platform = process.platform, timeoutMs = 5000 } = {}) {
  const [version, webgl] = await Promise.all([
    attempt(() => browser.version(), timeoutMs),
    attempt(() => page.evaluate(readWebglIdentity), timeoutMs),
  ]);
  const chromeVersion = version.ok && typeof version.value === 'string' ? version.value : '';
  const identity = webgl.ok && webgl.value && typeof webgl.value === 'object' ? webgl.value : null;
  const renderer = typeof identity?.renderer === 'string' ? identity.renderer : '';
  const vendor = typeof identity?.vendor === 'string' ? identity.vendor : '';
  const detected = version.ok && !!chromeVersion && !!identity;
  return { ...describeEnvironment({ platform, renderer, vendor, chromeVersion }), renderer, vendor, chromeVersion, detected };
}

/**
 * The rendering environment of this page's browser (contract F.4; semantics `mechanism/rendering.md`,
 * section "Reuse of prerender output").
 *
 * Frames pushed during page measurement are handed to the prerender process to be stored as shared
 * snapshots. The key carries the environment fingerprint of the **browser where the measurement took
 * place**, and this card's snapshots are locked to that environment (per-card fingerprint lock). The
 * fingerprint is computed by the prerender process from the raw values reported here, using the same
 * `describeEnvironment` as the render node (`server/render-node/fingerprint.mjs`) -- the page only reports
 * raw values and does not compute the fingerprint itself, so the normalization rules of the two sides live
 * in only one place.
 *
 *   platform   `navigator.userAgentData.platform` (`Windows` / `macOS` / `Linux`), or `navigator.platform` if absent
 *   userAgent  the full UA, from which the server takes the Chrome major version
 *   renderer / vendor  WebGL's `UNMASKED_RENDERER_WEBGL` / `UNMASKED_VENDOR_WEBGL`, or `RENDERER` /
 *              `VENDOR` if the debug extension is absent; the canvas is not attached to the document, and
 *              after reading, the context is released with `WEBGL_lose_context`
 *
 * Any failed step counts as an empty string and never throws.
 */

const text = value => (typeof value === 'string' ? value : value == null ? '' : String(value));

function readGl(document) {
  try {
    const canvas = document?.createElement?.('canvas');
    if (!canvas?.getContext) return { renderer: '', vendor: '' };
    let gl = null;
    for (const kind of ['webgl2', 'webgl']) {
      try { gl = canvas.getContext(kind); } catch { gl = null; }
      if (gl) break;
    }
    if (!gl) return { renderer: '', vendor: '' };
    let renderer = '', vendor = '';
    try {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = text(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      vendor = text(info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
    } catch { renderer = ''; vendor = ''; }
    try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* Not getting back does not count as a failure either */ }
    return { renderer, vendor };
  } catch {
    return { renderer: '', vendor: '' };
  }
}

/**
 * @param {{ navigator?: any, document?: any }} [scope] defaults to `globalThis` (tests pass a fake navigator / document)
 * @returns {{ platform: string, userAgent: string, renderer: string, vendor: string }}
 */
export function readPageEnvironment({ navigator, document } = globalThis) {
  let platform = '', userAgent = '';
  try { platform = text(navigator?.userAgentData?.platform || navigator?.platform || ''); } catch { platform = ''; }
  try { userAgent = text(navigator?.userAgent || ''); } catch { userAgent = ''; }
  const { renderer, vendor } = readGl(document);
  return { platform, userAgent, renderer, vendor };
}

let cached = null;

/** Cached result of `readPageEnvironment()`: the environment never changes within one page, so there is no need to create a new WebGL context every frame */
export function pageEnvironment() {
  return (cached ||= readPageEnvironment());
}

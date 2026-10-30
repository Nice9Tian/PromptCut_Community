/**
 * 页面这台浏览器的渲染环境(契约 F.4;语义 `mechanism/rendering.md`「预渲染结果的复用」)。
 *
 * 页面测量时推过的帧交给预渲染进程存成共享快照,键里带的是**测量所在浏览器**的环境指纹,
 * 这张卡的快照随之锁定到这个环境(卡片级指纹锁)。指纹由预渲染进程按这里报上去的原始值,
 * 用和渲染节点同一份 `describeEnvironment`(`server/render-node/fingerprint.mjs`)算 ——
 * 页面只报原始值,不自己算指纹,两边的归一规则只有一处。
 *
 *   platform   `navigator.userAgentData.platform`(`Windows` / `macOS` / `Linux`),没有就 `navigator.platform`
 *   userAgent  完整 UA,服务端从里面取 Chrome 主版本
 *   renderer / vendor  WebGL 的 `UNMASKED_RENDERER_WEBGL` / `UNMASKED_VENDOR_WEBGL`,没有调试扩展就读
 *              `RENDERER` / `VENDOR`;画布不挂进文档,读完用 `WEBGL_lose_context` 释放上下文
 *
 * 任何一步失败按空串计,从不抛出。
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
    try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* 还不回去也不算失败 */ }
    return { renderer, vendor };
  } catch {
    return { renderer: '', vendor: '' };
  }
}

/**
 * @param {{ navigator?: any, document?: any }} [scope] 缺省是 `globalThis`(测试传假的 navigator / document)
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

/** 缓存一次的 `readPageEnvironment()`:同一个页面里环境不会变,不必每帧新建 WebGL 上下文 */
export function pageEnvironment() {
  return (cached ||= readPageEnvironment());
}

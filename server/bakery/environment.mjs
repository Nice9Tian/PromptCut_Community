import { describeEnvironment } from '../render-node/fingerprint.mjs';

/**
 * 预渲染用的 Chrome 是什么环境(设计 2.1,契约 E.1)。
 *
 * 不同环境渲出的像素有确定的差异(字体微调、抗锯齿),所以预渲染的结果键要乘上环境指纹
 * (`render-node/fingerprint.mjs`)。指纹的三项里,`os` 取自 Node 的 `process.platform`,
 * 另外两项只有真的 Chrome 答得出来:
 *
 *   - `chromeVersion`:`browser.version()`,例如 `HeadlessChrome/138.0.7204.49`;
 *   - `renderer` / `vendor`:在页面里开一个 WebGL 上下文,读 `UNMASKED_RENDERER_WEBGL` /
 *     `UNMASKED_VENDOR_WEBGL`(没有调试扩展就读 `gl.RENDERER` / `gl.VENDOR`)。
 *
 * 预渲染的 Chrome 带 `--disable-gpu` 和 `--enable-unsafe-swiftshader`(`chrome.mjs` 的 CHROME_ARGS),
 * WebGL 走 SwiftShader,所以本机预渲染进程的 `gpuClass` 预期是 `software`。这就是它真实的栅格化
 * 环境,不做特判:以后在带 GPU 的独立渲染主机上换了启动参数,指纹自然跟着变。
 *
 * **从不抛出**:任何一步失败或超时,缺的那项按空值计,`detected: false`。调用方
 * (`FramePipeline.ensureEnvironment`)照样把它定为这个进程的指纹 —— 指纹宁可粗一点,
 * 也不能让预渲染因为探测失败停下来。
 */

/**
 * 在页面里跑的探测函数。**必须自包含**:`page.evaluate` 把它序列化成源码送进页面,
 * 闭包里的东西带不过去。
 *
 * 画布不挂进文档,用完立刻 `WEBGL_lose_context` 释放 —— 页面(预渲染间的导出页)同时能开的
 * WebGL 上下文有上限,探测不能占一个名额不还;也不能碰文档,免得改动页面的变更计数。
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
    try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* 释放失败不影响读到的值 */ }
    return { renderer, vendor };
  }
  return { renderer: '', vendor: '' };
}

/** `work()` 在 `ms` 内完成就回 `{ ok: true, value }`,抛出或超时回 `{ ok: false }`。不抛。 */
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
  // 超时之后原来那个承诺可能还会被拒绝:接住它,免得成为未处理的拒绝
  pending.catch(() => {});
  try {
    return await Promise.race([pending.then(value => ({ ok: true, value }), () => ({ ok: false })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测 `browser` / `page` 所在的渲染环境。
 * → `{ os, gpuClass, chromeMajor, fingerprint, renderer, vendor, chromeVersion, detected }`
 *
 * 两步并行做,各自受 `timeoutMs` 限制,所以整次探测最多约 `timeoutMs`。
 * 两步都成功才是 `detected: true`;拿不到 WebGL 上下文(两个空串)也算成功 —— 那就是
 * 这个环境的真实情况(`gpuClassOf` 把它归为 `software`)。
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

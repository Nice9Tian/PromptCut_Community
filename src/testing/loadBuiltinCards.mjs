/**
 * 在 Node 里读出全部内置卡的声明(守门测试 `src/cards/capabilities.test.mjs` 和
 * `scripts/probes/card-table-digest-compare.mjs` 共用)。
 *
 * 内置卡 = `src/cards/index.ts` 里和 `registerCards` 一起注册的那四组:magicui、native、
 * 素材封装卡(由素材目录生成)、探针卡。卡片是 `.tsx`,又用了 `import.meta.glob`,所以借 vite 的
 * `ssrLoadModule` 载入;只读声明,不渲染。
 *
 * 用法:
 *   const kit = await loadBuiltinCards(root);
 *   try { kit.groups.native …; await kit.load('/src/kernel/registry.ts') } finally { await kit.close() }
 *
 * 用完 `close()` 之后进程能自己收场(守门测试靠这一点;浏览器空壳里专门处理了播放库留下的定时器)。
 */
import { createServer } from "vite";

/** `src/cards/index.ts` 里 `registerCards([...])` 的那四组:导出名 → 模块 */
export const BUILTIN_CARD_GROUPS = {
  magicuiCards: "/src/cards/magicui/index.ts",
  nativeCards: "/src/cards/native/index.ts",
  assetCards: "/src/cards/assets/index.ts",
  probeCards: "/src/cards/_probe/index.ts",
};

/** 卡片模块一载入就要的浏览器全局量(lottie-web、tsParticles 等),给个空壳,只为能读到卡片的声明 */
export function stubBrowserGlobals() {
  const g = globalThis;
  g.window ??= g;
  // lottie-web 载入时就往一块画布上画东西试特性:给一个什么都接、什么都不做的上下文
  const context = () => new Proxy({}, { get: () => () => ({ data: [0, 0, 0, 0] }), set: () => true });
  const el = () => ({ style: {}, setAttribute() {}, appendChild() {}, getContext: context, addEventListener() {} });
  // readyState 写成 complete:lottie-web 载入后每 100 毫秒查一次文档好了没有,查到才停,不停进程就收不了场
  g.document ??= { readyState: "complete", createElement: el, createElementNS: el, documentElement: { style: {} }, body: el(), head: el(),
    getElementsByTagName: () => [], getElementsByClassName: () => [], addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
  if (!g.navigator) Object.defineProperty(g, "navigator", { value: { userAgent: "node" }, configurable: true });
  // 不真的排回调:这里只读声明、不渲染;排了的话库里的循环会一直续下去,进程收不了场
  g.requestAnimationFrame ??= () => 0;
  g.cancelAnimationFrame ??= () => {};
  g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
}

/**
 * @param {string} root 仓库(或某个提交解出来的目录)的根
 * @returns {Promise<{ groups: Record<string, any[]>, cards: any[], load: (file: string) => Promise<any>, close: () => Promise<void> }>}
 *   `cards` 是四组按注册顺序拼起来的原始声明(没有经过注册表改写)
 */
export async function loadBuiltinCards(root) {
  stubBrowserGlobals();
  const vite = await createServer({ root, configFile: false, logLevel: "error",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const load = (file) => vite.ssrLoadModule(file);
    const groups = {};
    for (const [name, file] of Object.entries(BUILTIN_CARD_GROUPS)) {
      const cards = (await load(file))[name];
      if (!Array.isArray(cards)) throw new Error(`${file} 没有导出 ${name}`);
      groups[name] = cards;
    }
    return { groups, cards: Object.values(groups).flat(), load, close: () => vite.close() };
  } catch (error) {
    await vite.close();
    throw error;
  }
}

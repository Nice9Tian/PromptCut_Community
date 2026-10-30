/**
 * 探针共用：让探针自己起的浏览器里的页面，把「已不存在」证明的信任表看成带着几条测试签发方的样子。
 *
 * 产品代码里信任表只有随软件分发的那一张（`server/recovery/gone-proof.mjs` 的 `TRUSTED_GONE_AUTHORITIES`），没有任何
 * 环境变量、配置文件、页面钩子能扩充它。探针要把页面指到自己起的假文档服务，就在**自己起的浏览器**里拦下页面对那个模块的
 * 请求，把表的内容换掉再交给页面。拦截是浏览器调试协议的事，装好的桌面版里没有这条路。
 *
 *   await interceptGoneTrust(page, [{ authorityId, origin, services: [...], keys: { kid: publicKey } }]);   // 在 page.goto 之前
 */
const MODULE = /\/server\/recovery\/gone-proof\.mjs(?:\?|$)/;
const ANCHOR = 'export const TRUSTED_GONE_AUTHORITIES = deepFreeze([';

export async function interceptGoneTrust(page, authorities) {
  const state = { served: 0 };
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    if (request.isInterceptResolutionHandled()) return;
    if (!MODULE.test(request.url())) { request.continue().catch(() => {}); return; }
    try {
      const original = await (await fetch(request.url())).text();
      if (!original.includes(ANCHOR)) throw new Error('信任表的写法变了，探针的拦截要跟着改');
      const body = original.replace(ANCHOR, `${ANCHOR}...${JSON.stringify(authorities)},`);
      state.served++;
      await request.respond({ status: 200, contentType: 'text/javascript', headers: { 'cache-control': 'no-store' }, body });
    } catch (error) { state.error = String(error?.message ?? error); request.abort().catch(() => {}); }
  });
  return state;
}

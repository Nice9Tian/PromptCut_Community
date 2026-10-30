import type { Plugin, ViteDevServer } from "vite";
import { isPrerender } from "./render-role.mjs";
import { onCardSourceChange } from "./card-overrides.mjs";
import { invalidateWorkers, killWorker, renderWorkers } from "./vision/worker-pool";
import { registerEditorSide, registerPrerenderSide } from "./vision/routes";

export { bakeTarget } from "./vision/bake";

/**
 * 给模型一双眼睛:把「时间轴第 t 秒长什么样」渲染成一张图交回去。
 *
 * 为什么不在浏览器里截:编辑器的预览是一个 iframe(?stage=1),页面脚本没有任何
 * 办法把 iframe 的画面读成位图。所以只能在服务端渲染。
 *
 * 为什么直接复用 server/bakery/ 而不是自己再起一个 puppeteer:
 * 那个脚本里那套虚拟时钟、动画钉位、素材预热的做法是导出确定性的**全部**依据
 * (见它文件头的说明)。另起一套的话「模型看到的画面」和「用户导出的画面」会
 * 悄悄分叉 —— 那比没有视觉更糟:模型会照着一张不存在的画面去改。代价是每次要起
 * 一个 Chrome(几秒),对一次调用几次的看图来说可以接受。
 */

/*
 * 给模型看的图:缩到长边 768、透明处铺中间调棋盘格。实现和理由都搬到了 server/png-post.mjs ——
 * 那是逐像素的同步活,由渲染 worker 在自己的进程里做,不再占这个进程的事件循环。
 *
 * 为什么是棋盘格而不是纯色底(原来的说明,留在这里):以前垫的是近黑的纯色,**深色的卡片贴上去
 * 等于消失**,"什么都没有"和"有一张深色的卡"长得一模一样。真实案例(诊断报告
 * 对话诊断-20260909-045354):一张深色金属的三维 logo 卡,模型连着看了 20 次 see_frames,
 * 以为卡没渲出来,把同样的 5 次调用原样重复了三轮。换成棋盘格,透明的地方才露出格子。
 */
export function visionPlugin(): Plugin {
  return {
    name: "promptcut-vision",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      // 卡片源码一变,两端各自的渲染 worker 都要扔掉备用页
      onCardSourceChange(() => invalidateWorkers());
      /*
       * 服务关掉(包括改了配置依赖、vite 在同一个进程里重启)就把这个进程拉起的渲染 worker 全杀掉。
       * 重启会重新加载这个模块,旧模块手里的 worker 就没人管了 —— 常驻的那几个(热备、前台)永不闲置退出,
       * 每重启一次漏两个 Chrome。
       */
      server.httpServer?.on("close", () => {
        for (const w of [...renderWorkers]) killWorker(w, new Error("服务已关闭"));
      });

      if (!isPrerender) {
        registerEditorSide(server, root);
        return;
      }
      registerPrerenderSide(server, root);
    },
  };
}

export default visionPlugin;

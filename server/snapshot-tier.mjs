/**
 * 快照档位判定,纯函数,不引任何模块(Node 内置模块也不引)。
 *
 * 从 `snapshot-store.mjs` 搬出来:那个文件引 `frame-mov.mjs`(`atomic`),而后者引
 * npm 包 `pngjs`。队列节点(`server/render-node/`)要在没有 node_modules 的机器上
 * 跑(契约 A.1 / B 节:只靠 Node 内置模块和 `server/render-queue/`),所以从这里
 * 取 `snapshotTier`。`snapshot-store.mjs` 从这里转出同名导出,其余调用方不变。
 * 守门测试:`server/test/render-node-deps.test.mjs`。
 */

/**
 * 每个控件走哪一档(A3a)。输入是审阅表给的 capabilities
 * (`src/kernel/frameMode.mjs` 的 `cardCapabilities`,或 `cardGraph` 给合成节点
 * 写的那一份)。
 *
 *   共享档:审阅表 independent / sourceDependent **且** stateful —— canvas 卡同样
 *           按这个判据(它的快照里 [data-pc-gl-plane] 已转成 <img>,M4);
 *   本地档:其余 stateful,含 belowDependent 毛玻璃卡、需要整场景上下文的 context,
 *           **以及 unknown**(计划 3.1(2):真实项目里的定制卡和带部件的组合卡片段
 *           都是 unknown,底稿的「一律判重、没有死素材、只能透明」会让它们在播放和
 *           拖动时整片消失;改成一律按下层依赖卡 belowDependent 处理 —— 照测、照实测
 *           分派,判轻就活渲,判重用本地档快照,不上云、不进流);
 *   不预渲染:非 stateful 的轻卡(渲染 9:在所有位置都判轻的不产快照)。
 */
/**
 * 快照作废以后（2026-10-13 用户定：契约 prerender-products-contract.md 第 1.1 节第 32 行）
 * 对所有卡一律返回 'none'。
 */
export function snapshotTier(_capabilities) {
  return 'none';
}

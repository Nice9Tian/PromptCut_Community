/**
 * 片段框宽高的数值解析 —— 舞台和服务端共用的**唯一一份**。
 *
 * 为什么单独一个 .mjs:
 *   - 舞台侧 `layout.ts` 的 `resolveFrame` / `frameBox` 按这个宽高摆卡片;
 *   - 服务端 `server/card-identity.mjs` 的 `cardSnapshotIdentity` 把同一个宽高
 *     写进共享快照键 —— 快照里内联的是**使用值**(px),两个片段的框宽高不同就是
 *     两张不同的快照,键必须不同(A3 验收);
 *   - Node 直接 import 不了 `.ts`,所以数值部分下沉到这里,两边各自 import。
 *     两处各写一遍 `frame?.w ?? parent.width` 的话,将来改默认值一定会漏一处,
 *     而漏掉不报错,只是键和实际画出来的框悄悄对不上。
 *
 * 没有 frame = 铺满父坐标系(舞台画幅),和 `resolveFrame` 的默认值同义。
 */
export function resolveFrameSize(frame, parent) {
  return { w: frame?.w ?? parent?.width, h: frame?.h ?? parent?.height };
}

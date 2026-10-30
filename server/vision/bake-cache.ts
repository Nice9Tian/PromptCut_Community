/**
 * 预渲染产物(PNG 快照)的盘点与清理。
 *
 * 原来直接列、删素材目录里的 `bake-*.png`;现在字节在素材服务的 `px` 里,这里只经 `bake-store.mjs`
 * 读写「输入哈希 → 内容哈希」的索引(`docs/semantics/product/asset-service.md`「预渲染的产物」:
 * 预渲染进程经素材服务的接口读写产物,不直接读它的存储目录)。键怎么算在 bake.ts 的 `bakeTarget`。
 *
 * 素材目录里以前落下的旧文件一个不动:老项目参数里的 `/@media/bake-….png` 靠它们照常能取,
 * 同一个键再被要时由 bake.ts 经素材服务迁进 `px`。它们不再计入盘点、也不再被这里删。
 */
import { bakeStoreFor } from "./bake";

/**
 * 索引里现有的 PNG 快照:键(12 位输入哈希)、老文件名、字节数、内容哈希。不问素材服务。
 *
 * 预渲染的调度要先知道「哪些已经有了、各自多大」才能排队和算占用 ——
 * 而这个答案只有服务端有:浏览器那边关一次页面就忘了。
 */
export async function listBakes(root: string): Promise<{ key: string; name: string; bytes: number; hash: string; url: string }[]> {
  return (await bakeStoreFor(root).list()).map((e: any) => ({ key: e.key, name: e.name || `${e.key}.png`, bytes: e.bytes, hash: e.hash, url: e.url }));
}

/**
 * 这些键里哪些已经渲好:索引里有、且素材服务上这一块收全了(同步状态只问素材服务)。
 * 素材服务不可达时抛(消息写明地址与原因)。
 */
export async function bakedOf(root: string, keys: string[]): Promise<Map<string, { key: string; bytes: number; hash: string; url: string }>> {
  return await bakeStoreFor(root).status(keys);
}

/**
 * 淘汰指定的 PNG 快照。**只认键,不认路径**:和自己列出来的索引逐个比对,只有对得上的才删,
 * 删的是索引条目,碰不到索引以外的文件。字节留在素材服务里(素材服务没有删除接口,按内容寻址、写入后不可变),
 * 回收交给素材服务那一侧;同一张图再渲时入库只是一次对账,不重复占空间。
 */
export async function evictBakes(root: string, keys: unknown): Promise<{ deleted: string[]; freedBytes: number }> {
  return await bakeStoreFor(root).evict(keys);
}

/**
 * 感知工具(镜头识别、运动追踪、主体检测)发给服务端的素材标识。
 *
 * 服务端经素材服务的接口取字节(`server/perception-source.mjs`;语义 `docs/semantics/product/agent.md`「素材与产物」),
 * 所以这里**只发标识**:id、名字、种类、url(`/@media/<hash>` 或迁移期的 `/@media/<文件名>`)、内容哈希。
 * 不发 `path` —— 那是某一台机器上的磁盘路径,共享项目里别的设备没有它,服务端也不再按它读盘。
 */
import type { MediaAsset } from "../kernel/project";

export interface PerceptionMediaRef {
  id: string;
  name?: string;
  kind?: string;
  url?: string;
  hash?: string;
}

export function perceptionMediaRef(m: Pick<MediaAsset, "id" | "name" | "kind" | "url" | "hash">): PerceptionMediaRef {
  return {
    id: m.id,
    ...(m.name ? { name: m.name } : null),
    ...(m.kind ? { kind: m.kind } : null),
    ...(m.url ? { url: m.url } : null),
    ...(m.hash ? { hash: m.hash } : null),
  };
}

/**
 * 服务端能不能经素材服务找到这份素材:入库完了(不在 pending),且有内容哈希或一个素材服务认得的地址。
 * `blob:` / `data:` 是这个页面私有的,素材服务上没有。
 */
export function mediaReadyForServer(m: Pick<MediaAsset, "url" | "hash" | "pending">): boolean {
  if (m.pending) return false;
  if (m.hash) return true;
  const url = m.url || "";
  return !!url && !/^(blob|data):/i.test(url);
}

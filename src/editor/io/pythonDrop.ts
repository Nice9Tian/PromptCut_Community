/**
 * 旧 `.proc` 里的 Python 卡**不向前兼容**(用户决定,滤镜、转场、音效在内)。
 *
 * Python 卡运行时整套已经归档到 `archive/python-cards/`,仓库里不再有
 * 隔离运行时的 HTTP 接口、浏览器侧的宿主组件、`adapter: 'python'` 节点。所以打开一份带 Python 卡的
 * 旧项目时,在原始 JSON **转成 `Project` 之前**就把它们丢掉:
 *
 * - `cardDefinitions` **整个字段**删掉 —— 不是只删 python 条目。`proc.ts` 的
 *   `{ ...createEmptyProject(), ...project, id }` 会把原始 JSON 里的它原样铺进
 *   `Project`,再原样存回下一份 `.proc`,留着就是一个永远传下去的死字段;
 * - `cardNodes` 里 `adapter: 'python'` 的节点直接丢弃;
 * - 引用这些节点的片段清掉 `nodeId` —— 素材段回到普通素材段(原生音轨自然恢复出声),
 *   只有 `nodeId` 没有 `cardId` 的纯 python 片段既没节点也没 `cardId`,被
 *   `flattenOverlay`(`src/kernel/project.ts`)跳过,不显示、也不报错。
 *
 * 不做占位卡、不做 `list_cards` 提示、不自动翻译。
 */

/** 丢弃的**实例**张数(被删掉的 python 节点数)——用户看得见消失的就是它们。 */
export function dropPythonNodes(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  const project = raw as Record<string, any>;

  // 整个字段删掉,不是只删 python 条目
  delete project.cardDefinitions;

  const nodes: any[] = Array.isArray(project.cardNodes) ? project.cardNodes : [];
  const dropped = new Set<string>();
  for (const node of nodes) if (node?.adapter === "python" && typeof node.id === "string") dropped.add(node.id);
  if (dropped.size) {
    project.cardNodes = nodes.filter((node) => node?.adapter !== "python");
    for (const track of Array.isArray(project.tracks) ? project.tracks : []) {
      for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
        if (clip && typeof clip === "object" && dropped.has(clip.nodeId)) delete clip.nodeId;
      }
    }
  }
  return dropped.size;
}

/*
 * 通知栏:丢了几张只提示**一次**。和素材分类迁移(`mediaMigrationBus.ts`)同一套做法 ——
 * 加载路径是纯逻辑,攒在这里,由界面那一侧取走并显示。
 */
let pending = 0;
const EVENT = "pc-python-nodes-dropped";

/** 加载路径调它;界面没挂起来(无头实例、单元测试)时只是攒着,不报错。 */
export function publishPythonDrop(count: number): void {
  if (!(count > 0)) return;
  pending += count;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

export function takePythonDrops(): number {
  const out = pending;
  pending = 0;
  return out;
}

export function onPythonDrops(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

/** 通知栏那句话。只有一处,免得两边写得不一样。 */
export function pythonDropMessage(count: number): string {
  return `${count} 张 Python 卡已停用，不再显示`;
}

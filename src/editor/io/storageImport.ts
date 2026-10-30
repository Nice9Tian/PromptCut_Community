import { actions, getState } from "../../store/project";
import type { MediaAsset } from "../../kernel/project";
import { applyUploadedMedia, type UploadedMedia } from "./mediaUpload";
import { onlineUnsupported } from "../../online/pageFlag";

/**
 * 从用户的网盘导入素材(任务书 `docs/plan/drive-connector-task.md` 第 5 节)。
 *
 * # 和本地导入的差别:页面手里没有 File
 *
 * 本地导入时字节经过页面,所以 `io/index.ts` 的 `importVideoFiles` 能用 `blob:` 探时长宽高,
 * 还能把 File 存进 io 的私有表给语音转写用。网盘这条路**字节不经过页面** —— 编辑器进程直接从网盘拉、
 * 直接入库,页面只递一个文件 id 和一张票。所以这里:
 *
 * - 探元数据改用入库后的 `/@media/<哈希>`(那时字节已经在本地内容库里了),不用 `blob:`;
 * - 不调 `registerMediaFile`,页面没有 File 可登记。**代价**:这类素材暂时不能做语音转写,
 *   `io/stt.ts` 会回「素材文件不在内存里」。这和「打开一个已有项目之后的素材」是同一种情形,
 *   不是本条路新引入的毛病;记在任务书第 9 节的待办里。
 *
 * # 先占位,再填内容
 *
 * 和本地导入一样:先往素材库里放一条 `pending: true` 的,用户立刻看得见「在传」;拉完入库了再把
 * 地址、哈希、两档和时长宽高补上。所有导入路径最后都汇到 `applyUploadedMedia`。
 */

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export interface StorageProviderConfig {
  kind: string;
  label: string;
  configured: boolean;
  /** 这台机器支不支持 A2（把长期授权交给它保管）。只配了前三样时为假，仍可用一次性授权 */
  canManage?: boolean;
  scope?: string | null;
  clientId?: string;
  apiKey?: string;
  appId?: string;
  redirectUri?: string;
  /** 没配好时说明为什么,直接显示给用户 */
  reason?: string;
  /** 能用一次性授权但不能托管时,说明为什么 */
  manageReason?: string;
}

/** 已连接的网盘。只有元信息,没有任何令牌 */
export interface StorageConnection {
  projectId: string;
  userId: string;
  provider: string;
  grantedScope: string;
  createdAt: number;
  updatedAt: number;
}

export interface PickedFile {
  id: string;
  name: string;
  /** Picker 给的类型,用来预判落到哪一组;最终以服务端读到的为准 */
  mimeType?: string;
  sizeBytes?: number;
}

export interface StorageImportResult extends UploadedMedia {
  source?: { kind: string; fileId: string; name: string; mimeType: string; size: number };
  pulled?: { bytes: number; total: number; resumedFrom: number; segments: number };
}

/** 网盘连接器在这个构建里能不能用:在线浏览器没有本机的编辑器进程,拉不了 */
export const storageImportSupported = !ONLINE_BUILD;

/** 读服务端的公开参数。读不到就当没配,界面置灰 */
export async function loadStorageProviders(): Promise<StorageProviderConfig[]> {
  if (!storageImportSupported) return [];
  try {
    const res = await fetch("/api/media/storage/config");
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.providers) ? (data.providers as StorageProviderConfig[]) : [];
  } catch {
    return [];
  }
}

/**
 * 在线浏览器构建里 `/api/media/storage/*` 都没有对端:这些口由**本机编辑器进程**发,在线页面没有它。
 *
 * 下面每个函数开头都内联写一遍 `if (!storageImportSupported) throw …`,**不抽成辅助函数**。
 * 抽成函数就剪不掉了:`storageImportSupported` 在在线构建里是编译期常量 `false`,内联的判断恒真、
 * 后面的代码连同 `/api/…` 字面量一起被打包器剪掉;换成函数调用,打包器没法静态判定后面不可达,
 * 字面量就留在产物里。
 *
 * **这不只是省几行**:C10A-API-03 那道在线 API 棘轮要求「产物里的 `/api/` 路径」和
 * `server/test/c10a-online-api-paths.json` 逐条一致。2026-10-24 合入时 connect / disconnect / import
 * 三个函数漏了这道判断,字面量进了在线产物、把那道门弄红过一次;补上之后它们不再出现,清单里那三条
 * 也一并删掉(该测试同时断言清单里不许有产物中已没有的路径)。我第一次是抽成函数写的,产物里照旧有,
 * 改成内联才剪掉 —— 这就是为什么这里看着啰嗦。
 */
async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(String(data?.message || `请求失败(HTTP ${res.status})`));
  return data;
}

/** A2:列出已连接的网盘。读不到就当没有 */
export async function loadConnections(): Promise<StorageConnection[]> {
  if (!storageImportSupported) return [];
  try {
    const res = await fetch("/api/media/storage/connections");
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.connections) ? (data.connections as StorageConnection[]) : [];
  } catch {
    return [];
  }
}

/** A2:把授权码交给编辑器进程换 refresh token。页面不碰 refresh token */
export async function connectStorage(provider: string, code: string, codeVerifier: string): Promise<void> {
  if (!storageImportSupported) throw new Error(onlineUnsupported("从网盘导入"));
  await postJson("/api/media/storage/connect", { kind: provider, code, codeVerifier });
}

/** A2:断开。回包里说明网盘那边撤没撤成 */
export async function disconnectStorage(provider: string): Promise<{ revoked: boolean; why?: string }> {
  if (!storageImportSupported) throw new Error(onlineUnsupported("从网盘导入"));
  const data = await postJson("/api/media/storage/disconnect", { kind: provider });
  return { revoked: !!data.revoked, ...(data.why ? { why: String(data.why) } : {}) };
}

function kindOf(mimeType: string | undefined, name: string): MediaAsset["kind"] {
  const mt = String(mimeType || "").toLowerCase();
  if (mt.startsWith("video/")) return "video";
  if (mt.startsWith("audio/")) return "audio";
  if (mt.startsWith("image/")) return "image";
  // Picker 偶尔不给 mimeType,退回看扩展名
  const ext = name.toLowerCase().split(".").pop() || "";
  if (["mp4", "mov", "m4v", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "aac", "flac", "ogg"].includes(ext)) return "audio";
  return "image";
}

/** 探一下时长 / 宽高。探不到不算失败,留空交给后面按默认值处理(和本地导入同样的兜底) */
function probe(url: string, kind: MediaAsset["kind"], name: string): Promise<{ duration?: number; width?: number; height?: number }> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v: { duration?: number; width?: number; height?: number }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    // 和本地导入一样给 5 秒上限:坏文件不该把导入卡死
    const timer = setTimeout(() => settle({}), 5000);

    if (kind === "image") {
      const img = new Image();
      img.onload = () => settle({ width: img.naturalWidth || undefined, height: img.naturalHeight || undefined });
      img.onerror = () => { console.warn(`[storage] 探测图片失败: ${name}`); settle({}); };
      img.src = url;
      return;
    }
    const el = document.createElement(kind === "video" ? "video" : "audio") as HTMLVideoElement;
    el.preload = "metadata";
    el.muted = true;
    el.onloadedmetadata = () => settle({
      duration: Number.isFinite(el.duration) ? el.duration : undefined,
      width: el.videoWidth || undefined,
      height: el.videoHeight || undefined,
    });
    el.onerror = () => { console.warn(`[storage] 探测素材失败: ${name}`); settle({}); };
    el.src = url;
  });
}

/**
 * 把一份选中的网盘文件导进素材库。
 *
 * @param token 一次性 access token（A3）。传 `null` 走 A2：编辑器进程用它托管的凭据自己换票
 * @param place 视频是否顺手放到播放头处(和本地导入视频一致)
 * @returns 新素材的 id
 */
export async function importFromStorage(
  provider: string,
  token: string | null,
  file: PickedFile,
  { place = true }: { place?: boolean } = {},
): Promise<string> {
  if (!storageImportSupported) throw new Error(onlineUnsupported("从网盘导入"));
  const kind = kindOf(file.mimeType, file.name);

  // 先占位:用户立刻看得见这条在传
  const media = actions.addMedia({ kind, name: file.name, url: "", pending: true });

  let uploaded: StorageImportResult;
  try {
    const res = await fetch("/api/media/storage/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 不带 token 就是 A2:让编辑器进程用托管的凭据自己换票
      body: JSON.stringify({ kind: provider, fileId: file.id, name: file.name, ...(token ? { token } : {}) }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(String(data?.message || `导入失败(HTTP ${res.status})`));
    }
    uploaded = data as StorageImportResult;
  } catch (err) {
    // 失败就把占位撤掉,别在素材库里留一条永远「在传」的
    actions.removeMedia(media.id);
    throw err;
  }

  // 字节已经在本地内容库里,这时才探得到时长宽高
  const meta = await probe(uploaded.url, kind, file.name);
  if (meta.duration !== undefined || meta.width !== undefined || meta.height !== undefined) {
    actions.updateMedia(media.id, {
      ...(meta.duration !== undefined ? { duration: meta.duration } : {}),
      ...(meta.width !== undefined ? { width: meta.width } : {}),
      ...(meta.height !== undefined ? { height: meta.height } : {}),
    });
  }

  applyUploadedMedia(media.id, uploaded);

  if (kind === "video" && place) {
    actions.addMediaClip(media.id, getState().t);
  }
  return media.id;
}

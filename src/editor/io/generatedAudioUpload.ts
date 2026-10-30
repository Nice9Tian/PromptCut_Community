/**
 * Shared sound/AV WAV ingest. Bytes go through the ordinary asset-service media protocol.
 *
 * 写票据从哪来:旧共享项目在页面的文档连接上签(`auth.ticket { kind: 'asset', access: 'rw' }`);
 * 账号云端项目里那条消息被拒,用账号会话签发的素材票据(进项目时已经接好,`assetTiers.ts` 的 `remoteAssetTicketInfo`,
 * 读写同一张,只读成员拿它写会被素材服务拒)。账号项目的请求不带网站的登录 Cookie(素材服务见到 Cookie 就拒)。
 */
import { getState } from "../../store/project";
import { createSnapUploader, sha256Hex } from "../../online/snapUploader";
import { docRequest, hasDocLink, remoteAccountProjectId, remoteAssetBase, remoteAssetTicketInfo } from "../media/assetTiers";
import { onlinePage } from "../../online/pageFlag";

function generatedAudioService(signal: AbortSignal) {
  const projectId = getState().project.id;
  const remoteBase = remoteAssetBase();
  const accountProject = remoteBase ? remoteAccountProjectId() : null;
  const base = remoteBase ?? (onlinePage() ? null : "/api/asset");
  if (!base) throw new Error("尚未连接素材服务,请连接项目后重试");
  if (hasDocLink() && !remoteBase) throw new Error("共享项目素材服务尚未就绪,请稍后重试");
  const stillCurrent = () => {
    signal.throwIfAborted();
    if (getState().project.id !== projectId || remoteAssetBase() !== remoteBase || (remoteBase ? remoteAccountProjectId() : null) !== accountProject) throw new Error("素材服务或项目已切换,取消上传");
  };
  const uploader = createSnapUploader({
    base: () => base,
    ticket: async (force) => {
      stillCurrent();
      if (!remoteBase) return null;
      if (accountProject) {
        const info = await remoteAssetTicketInfo(force === true);
        stillCurrent();
        if (!info?.ticket) throw new Error("无法取得素材写入票据");
        return info.ticket;
      }
      const response = await docRequest({ type: "auth.ticket", kind: "asset", access: "rw" });
      stillCurrent();
      if (response.type !== "auth.ticket.ok" || typeof response.ticket !== "string") throw new Error("无法取得素材写入票据");
      return response.ticket;
    },
    fetch: (url, init) => { stillCurrent(); return fetch(url, { ...init, signal, ...(accountProject ? { credentials: "omit" as const } : {}) }); },
  });
  return { uploader, stillCurrent };
}

/** 缓存复用也必须核对当前素材服务字节，不只相信项目内的旧引用。 */
export async function hasGeneratedAudio(hash: string, signal: AbortSignal): Promise<boolean> {
  const { uploader, stillCurrent } = generatedAudioService(signal);
  const exists = await uploader.has("media", hash);
  stillCurrent();
  return exists;
}

export async function uploadGeneratedAudio(wav: Uint8Array, signal: AbortSignal): Promise<{ hash: string; bytes: number }> {
  const { uploader, stillCurrent } = generatedAudioService(signal);
  const hash = await sha256Hex(wav);
  stillCurrent();
  await uploader.put("media", hash, wav, "wav");
  stillCurrent();
  return { hash, bytes: wav.byteLength };
}

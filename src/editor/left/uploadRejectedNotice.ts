import { useEffect } from "react";
import { subscribeMediaUploadRejected, type MediaUploadRejection } from "../../online/mediaUploadQueue";
import { formatUploadRejectionReason } from "../sync/accountExtensions";

/**
 * 在线上传队列里有一项被素材服务永久拒掉（游客视频条数满了、文件太大，`mediaUploadQueue.ts` 的 `PERMANENT_REFUSALS`）时
 * 给用户看的那句话（claude/guest-fix〔裁〕，二级；审查 D：原先上传路径上没人用 `accountErrorText` 里的这几句，
 * 用户只看到本机有、云端和别的设备上没有）。那句话本身照 `src/account/client.ts` 的 `accountErrorText`，数从 `GUEST_LIMITS` 拼。
 */
export function uploadRejectedText(rejection: Pick<MediaUploadRejection, "name" | "code">): string {
  const what = rejection.name ? `「${rejection.name}」` : "这个素材";
  return `${what}没有传上云端：${formatUploadRejectionReason(rejection.code)}`;
}

/** 编辑台（素材库分区、手机版编辑页）挂一个：有一项被拒就用它自己的提示条说一句 */
export function useUploadRejectedNotice(show: (text: string) => void): void {
  useEffect(() => subscribeMediaUploadRejected((rejection) => show(uploadRejectedText(rejection))), [show]);
}

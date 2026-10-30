import { useSyncExternalStore } from "react";
import type { MediaAsset } from "../../kernel/project";
import { confirmedMissing } from "../../audio/missingMaterialRecord";
import { mediaTierPolicy, previewMediaUrl, subscribeMediaTierPolicy, type MediaTierPolicy } from "../../render/mediaTier";

/**
 * 编辑界面里素材预览(缩略、波形、静帧)的地址,取档策略变了就重画(`mediaTier.ts` 的 `previewMediaUrl`)。
 * 桌面运行环境原样是 `media.url`;在线浏览器模式换成远程素材服务的地址,还没就绪时是 ""(不挂 src、不发请求)。
 */
export function useMediaTierPolicy(): MediaTierPolicy {
  return useSyncExternalStore(subscribeMediaTierPolicy, mediaTierPolicy, mediaTierPolicy);
}

export function usePreviewMediaUrl(media: Pick<MediaAsset, "url" | "hash" | "tiers" | "ext" | "kind"> | undefined | null): string {
  const policy = useMediaTierPolicy();
  // 认定过「确认缺失」的素材地址留着没清(记录要和它对得上),但那个地址取不到东西:缩略、波形一律不挂、不发请求
  if (media && confirmedMissing(media as MediaAsset)) return "";
  return media ? previewMediaUrl(media, policy) : "";
}

/** 波形这类要整份读下来再解码的,缓存按地址去掉查询串(在线的查询串是会轮换的票据,不能因为换票据重下一遍) */
export function previewCacheKey(url: string): string {
  return String(url || "").split(/[?#]/, 1)[0];
}

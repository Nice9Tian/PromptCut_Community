/**
 * 在线浏览器模式能在本页执行哪些卡片的声音代码(`docs/semantics/product/platforms.md`「卡片声音的平台边界」)。
 *
 * 第一段只放开**内置**卡(页面构建时自带、注册表里有定义的):内置提示音、键盘声、内置有声卡。
 * 用户卡与素材效果卡的声音随「在线执行用户卡与素材效果卡」在第二段放开 —— 那时由隔离环境那一侧调 `setOnlineUserCardAudioGate`
 * 接进来,这里不用再改判据。带素材输入的素材效果卡另有一道闸:在线页面取不到素材的采样块(`audioSources.ts` 的 `mediaBlock`)。
 *
 * 轻重(判轻才在浏览器里合成)不在这里判:这里只回答「这段代码这台设备能不能跑」,轻重由
 * `src/editor/io/onlineSoundJudge.ts` 判。
 *
 * 本模块属于 render 这一层(`src/online/`):只引 kernel。
 */
import type { CardDef } from "../kernel/types";

type AudioCard = Pick<CardDef<any>, "source" | "audio">;

let userCardGate: ((def: AudioCard) => boolean) | null = null;

/** 第二段的接口:用户卡、素材效果卡的声音能不能在本页执行,由隔离环境那一侧决定。不接时一律不能 */
export function setOnlineUserCardAudioGate(gate: ((def: AudioCard) => boolean) | null): void {
  userCardGate = gate;
}

/** 这张卡的 `audio()` 在线页面能不能执行 */
export function onlineCardAudioRunnable(def: AudioCard | undefined | null): boolean {
  if (!def || typeof def.audio !== "function") return false;
  if (def.source === "user") return userCardGate ? userCardGate(def) : false;
  return true;
}

export const ONLINE_CARD_AUDIO_BLOCKED = "在线浏览器模式暂不能执行这张卡的声音代码(用户卡、素材效果卡的声音要在本地 PC 生成后同步)";

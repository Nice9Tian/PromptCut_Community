/**
 * 在**渲染页**里替云端 Agent 生成一段卡片声音(`render_card_audio` 的云端路;契约 `docs/plan/cloud-agent-contract.md` 第 9.4c 节)。
 *
 * 云端 Agent 服务的进程不执行卡片代码。它把「项目 × 片段」交给同机的渲染服务(`POST /look` → 工作进程的 `/api/cards/audio`,
 * `server/vite-plugin-cards.ts`),工作进程让渲染页动态载入本模块并调 `renderClipCardAudio`:卡片的 `audio()` 在这一页里求值——
 * 带卡片源码的项目只由按项目隔离的工作进程碰,页面请求闸与出口限制照旧管着这一页。
 *
 * 求值、WAV 的写法、身份记录与桌面版(`src/editor/io/cardAudioGeneration.ts`)是同一份函数,所以别的成员的页面按同一算法核对
 * 记录时不会判它过期。本模块静态引入 `../cards`:注册表与声音钩子和本模块在同一棵模块树里。
 */
import "../cards";
import type { Project } from "../kernel/project";
import { findClip } from "../kernel/project";
import { cardJson } from "../kernel/cardGraph.mjs";
import { cardAudioIdentity, cardAudioSourceOffset, clipHasEmbeddedAudio, resolveCardAudioRendition } from "../kernel/cardAudioRendition.mjs";
import { requireCardAudioHooks, renderEmbeddedCardWav } from "./cardAudio";
import { tr } from "../i18n/index.ts";

export interface HostedCardAudioResult {
  ok: true;
  clipId: string;
  /** 已有的记录还对得上(没传 force):不重算,回它指的素材 */
  reusable?: { mediaId: string; hash: string };
  name?: string;
  bytes?: number;
  expectedClip: string;
  rendition?: Record<string, unknown>;
}

const sha256Hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** 生成好的 WAV 留在这里,由工作进程分块取走(`takeCardAudioChunk`),取完清掉 */
let held: Uint8Array | null = null;

export async function renderClipCardAudio(project: Project, clipId: string, options: { force?: boolean; maxBytes?: number } = {}): Promise<HostedCardAudioResult> {
  held = null;
  const hooks = requireCardAudioHooks();
  const hit = findClip(project, clipId);
  if (!hit || !clipHasEmbeddedAudio(project, hit.clip, hooks.getCard)) throw new Error(tr("Cannot find a motion graphics card with embedded audio"));
  if (hit.track.locked) throw new Error(tr("Unlock the track containing the card first"));
  const clip = hit.clip;
  const expectedClip = JSON.stringify(clip);
  const identity = cardAudioIdentity(project, clip, hooks), sourceOffset = cardAudioSourceOffset(project, clip);
  if (new TextEncoder().encode(cardJson(identity)).byteLength > 96 * 1024) throw new Error(tr("Card audio parameter record is too large. Shorten the clip or simplify the input"));
  if (!options.force) {
    try {
      const reusable = resolveCardAudioRendition(project, clip, hooks);
      return { ok: true, clipId, expectedClip, reusable: { mediaId: reusable.media.id, hash: reusable.media.hash! } };
    } catch { /* 缺失或过期时重新生成 */ }
  }
  const rendered = await renderEmbeddedCardWav(project, clip, new AbortController().signal);
  if (options.maxBytes && rendered.wav.byteLength > options.maxBytes) throw new Error(tr("This card audio is too large for the cloud to generate in one pass. Shorten the clip"));
  const sourceKey = await sha256Hex(new TextEncoder().encode(cardJson({ version: 1, identity, sourceOffset, frames: rendered.frames, sampleRate: 48000 })));
  held = rendered.wav;
  return {
    ok: true, clipId, expectedClip, bytes: rendered.wav.byteLength,
    name: tr("{0} · card audio.wav", clip.label || hooks.getCard(clip.cardId)?.name || clip.cardId),
    rendition: { version: 1, cardId: clip.cardId, sourceKey, sourceOffset, duration: rendered.frames / 48000,
      sampleRate: 48000, frames: rendered.frames, channels: rendered.channels, identity },
  };
}

/** 取走一块(base64);`from` 到头时清掉留着的 WAV */
export function takeCardAudioChunk(from: number, size: number): string {
  if (!held) throw new Error(tr("No retained card audio"));
  const part = held.subarray(from, Math.min(held.byteLength, from + size));
  if (from + size >= held.byteLength) held = null;
  let text = "";
  for (let i = 0; i < part.length; i += 0x8000) text += String.fromCharCode(...part.subarray(i, i + 0x8000));
  return btoa(text);
}

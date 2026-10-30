/**
 * 编辑台预览里的音频效果:把 <video> / <audio> 元素接进 Web Audio,挂上 fxChain。
 *
 * 元素只在**第一次需要效果时**才接进 AudioContext(createMediaElementSource):接上之后声音就只走节点图,
 * 再也回不到元素直出;所以没挂效果的片段一律不碰,老行为一点不变。接上过的元素,片段换成没效果的,
 * 就直通(source → destination)。
 *
 * 音量还是走 el.volume(MediaLayers 的 driveMedia),节点图在它后面 —— 顺序和导出一致:音量 → 效果。
 *
 * # 两个坑
 *   1. AudioContext 没有用户手势之前是 suspended,接进去的元素会没声。播放时 resume 一次;编辑台里点过任何
 *      地方之后 Chrome 就放行了(sticky activation)。Agent 驱动的 play 也一样,只要用户在这个页面点过。
 *   2. createMediaElementSource 对跨域且没开 CORS 的素材输出静音。所以只接同源(/@media/、blob:)的元素;
 *      外链素材挂了效果,预览里不生效(console 提示一次),导出照常 —— 导出走的是 ffmpeg 抽出来的本地 wav。
 */

import { audioFxOfClip, isAudioFxAnimated, type AudioFxDef } from "../kernel/audioFx.mjs";
import type { TrackClip } from "../kernel/project";
import { buildFxChain, fxChainKey, type FxChain } from "./fxChain";

interface Routed {
  src: MediaElementAudioSourceNode;
  chain: FxChain | null;
  key: string;
}

let ctx: AudioContext | null = null;
const routed = new WeakMap<HTMLMediaElement, Routed>();
const warned = new Set<string>();

function context(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

function sameOrigin(el: HTMLMediaElement): boolean {
  const s = el.currentSrc || el.src;
  if (!s) return false;
  if (s.startsWith("blob:") || s.startsWith("data:")) return true;
  try {
    return new URL(s, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * 每帧调一次(MediaLayers 的布局 effect 里):clip 是这个元素此刻播的片段(没有就 null),t 是时间轴时刻。
 * 只在需要时接入;接入过的元素按片段换链 / 直通;随时间变的效果每帧写参数。
 */
export function routePreviewAudio(el: HTMLMediaElement | null, audioFx: AudioFxDef[] | undefined, clip: TrackClip | null, t: number, playing: boolean): void {
  if (!el) return;
  const def = clip && audioFx?.length ? audioFxOfClip({ audioFx }, clip) : null;
  let r = routed.get(el);
  if (!r) {
    if (!def) return; // 没挂效果、也没接过:什么都不做
    if (!sameOrigin(el)) {
      const s = el.currentSrc || el.src;
      if (!warned.has(s)) {
        warned.add(s);
        console.warn(`[previewAudio] 外链素材接不进 Web Audio(跨域会静音),预览里效果不生效,导出不受影响: ${s}`);
      }
      return;
    }
    const c = context();
    const src = c.createMediaElementSource(el);
    src.connect(c.destination);
    r = { src, chain: null, key: "" };
    routed.set(el, r);
  }
  const c = context();
  if (playing && c.state === "suspended") void c.resume();
  // 同一个元素会轮换 src(MediaLayers 两个槽位):接进来之后换到跨域外链,MediaElementAudioSourceNode 会输出静音,
  // 而且回不去元素直出。没法修,只能每次都判、每个地址提示一次
  if (!sameOrigin(el)) {
    const s = el.currentSrc || el.src;
    if (s && !warned.has(s)) {
      warned.add(s);
      console.warn(`[previewAudio] 这个播放槽位已经接进了 Web Audio,现在换到跨域外链素材会没声(预览限制,导出不受影响): ${s}`);
    }
  }

  const d = clip ? clip.end - clip.start : 0;
  const key = def && clip ? fxChainKey(def, clip.audioFx?.params, d) : "";
  if (key !== r.key) {
    if (r.chain) {
      r.src.disconnect();
      r.chain.dispose();
      r.chain = null;
    } else {
      r.src.disconnect();
    }
    if (def && clip) {
      const chain = buildFxChain(c, def, clip.audioFx?.params, d, isAudioFxAnimated(def));
      r.src.connect(chain.input);
      chain.output.connect(c.destination);
      chain.setTime(t - clip.start, d);
      r.chain = chain;
    } else {
      r.src.connect(c.destination);
    }
    r.key = key;
  } else if (r.chain && r.chain.animated && clip) {
    r.chain.setTime(t - clip.start, d);
  }
}

/** 元素卸载时把它的链拆掉(source 节点跟着元素走,不用管) */
export function releasePreviewAudio(el: HTMLMediaElement | null): void {
  if (!el) return;
  const r = routed.get(el);
  if (!r) return;
  try { r.src.disconnect(); } catch { /* 已断 */ }
  r.chain?.dispose();
  routed.delete(el);
}

/** 调试 / 端到端测试用:接进 Web Audio 的元素数、上下文状态。挂在 window.__pcPreviewAudio 上 */
export function previewAudioStats(): { routed: number; withChain: number; state: string | null } {
  let n = 0;
  let withChain = 0;
  for (const el of document.querySelectorAll<HTMLMediaElement>("video, audio")) {
    const r = routed.get(el);
    if (!r) continue;
    n++;
    if (r.chain) withChain++;
  }
  return { routed: n, withChain, state: ctx ? ctx.state : null };
}
if (typeof window !== "undefined") (window as unknown as { __pcPreviewAudio?: unknown }).__pcPreviewAudio = previewAudioStats;

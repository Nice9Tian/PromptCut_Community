/**
 * 登录页左栏那块极光的**成品**：一段由 PromptCut 自己的渲染器预渲染出来的循环视频。
 *
 * 用户 2026-10-24 定：「左侧为渲染器经过预渲染的动画」「用视频循环」「可以出两个版本」。
 * 实测一个版本 512 宽、CRF 32 只有 ~520 KB，而页面只加载当前皮肤那一个，
 * 所以干脆**一套皮肤一个**（六个），预渲染唯一的代价——左栏不再跟着 `--ui-accent` 变——就补回来了。
 * 视频由 `scripts/login-art/render-all.mjs` 批量产出，源头是 `BrandCanvas.tsx` 里那同一段 GLSL
 * （经 `scripts/login-art/make-card.mjs` 生成的用户卡），所以这一版和兜底那一版画的是同一个东西。
 *
 * 循环为什么接得上：卡片里时间走的是一个闭合的圈（`uLoop` 0→1 走满回到起点），
 * 所以第 0 帧和第 N 帧算出来**逐字节相同**。2026-10-24 实测：把项目拉到 49 秒、
 * 单独导第 0 帧与第 1152 帧，两张 SHA-256 完全一致、逐字节零差异。
 *
 * 兜底：视频**真的坏了**（解码不支持、文件取不到）才退回实时着色器 `BrandCanvas`，
 * 那一版自己还有一层 CSS 兜底（`BrandAurora`）。所以这一块任何时候都不会是一片空白。
 *
 * 「减少动态效果」：不自动播，停在第一帧——有图、不动。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { BrandCanvas } from "./BrandCanvas";
import { useSkin } from "../skins/useSkin";
import "./brandCanvas.css";

/*
 * 用 glob 收，不逐个 import：少一个文件就整页 500（2026-10-24 撞到 —— 页面先改成
 * import 六个，而当时只渲出一个，导出页加载应用时 vite 直接 500，把批量渲染也带挂了）。
 * glob 的另一个好处：以后 palettes.ts 加一套皮肤，渲出文件丢进来就认，不用改这里。
 */
const FILES = import.meta.glob<string>("./art/login-art-*.mp4", { eager: true, query: "?url", import: "default" });
/** 调色盘 id → 那一套的循环视频。键和 `src/skins/palettes.ts` 里的 id 一一对应 */
const LOOPS: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([file, url]) => [/login-art-(.+)\.mp4$/.exec(file)?.[1] ?? file, url]),
);

/** `data-skin` 是「调色盘-深浅」，取前半截 */
const paletteOf = (skinId: string) => skinId.replace(/-(dark|light)$/, "");

export function BrandLoop(): JSX.Element {
  const { skinId } = useSkin();
  const [failed, setFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const src = LOOPS[paletteOf(skinId)] ?? LOOPS.studio ?? Object.values(LOOPS)[0];

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) { el.pause(); return; }
    /*
     * play() 被拒**不算坏**，所以这里只吞掉、由 canplay 再试一次。
     * 页面刚加载、或者换皮肤刚换 src 时，浏览器常以「播放请求被新的加载打断」拒掉第一次，
     * 可视频本身好好的。**2026-10-24 就栽在这儿**：原来写成一拒就 setFailed，
     * 0.7.28 上线后线上登录页一直显示兜底的实时着色器 —— 视频 200、play() 手动调也成功，
     * 只有组件自己那一次被拒，于是永久退回。真要撤回着色器只认一种情况：媒体自己报错（见 onError）。
     */
    const tryPlay = () => { void el.play().catch(() => {}); };
    tryPlay();
    el.addEventListener("canplay", tryPlay);
    return () => el.removeEventListener("canplay", tryPlay);
  }, [src]);

  // 一个视频都没有（还没渲、或者被裁掉了）就走实时着色器，不留空白
  if (failed || !src) return <BrandCanvas />;
  return (
    <video
      ref={video}
      className="ps-brand-loop"
      data-pc="start-brand-loop"
      src={src}
      loop
      muted
      playsInline
      preload="auto"
      aria-hidden="true"
      // 只认媒体自己的错（解码不支持、文件取不到）；error 事件里 el.error 为空的不算
      onError={(e) => { if (e.currentTarget.error) setFailed(true); }}
    />
  );
}

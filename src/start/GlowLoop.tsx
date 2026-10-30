/**
 * 首页那层背景光的**成品**：一段由 PromptCut 自己的渲染器预渲染出来的循环视频。
 *
 * 用户 2026-10-24 定：「三处都改成渲染器预渲染的循环视频：桌面登录页、手机版登录、官网首页。」
 * 桌面登录页左栏那块极光是 `BrandLoop`；这一支管手机版登录的背景
 * （官网首页那一处不走 React，是 VisuHive 仓库 `site/` 里的静态页，用的是同一个渲染器产的横版）。
 *
 * 视频由 `scripts/login-art/render-glow.mjs` 批量产出，源头是 `BrandGlow.tsx` 里那同一段 GLSL
 * （经 `scripts/login-art/make-card.mjs` 生成的用户卡 `pc-brand-glow`），
 * 所以这一版和兜底那一版画的是同一个东西。
 *
 * 一套皮肤一个：预渲染之后这一层就不能像实时着色器那样跟着 `--ui-accent` 变了，
 * 六个各一百多 KB、页面只加载当前皮肤那一个，这个代价就补回来了（同 `BrandLoop` 的取舍）。
 *
 * 循环为什么接得上：两团光的相位都是 `uLoop` 的**整数倍频**（4 和 3），
 * `uLoop` 从 0 走到 1 正好回到出发点，所以第一帧和最后一帧算出来一样。
 *
 * 兜底：视频**真的坏了**（解码不支持、文件取不到）才退回实时着色器 `BrandGlow`，
 * 那一版自己还有一层 CSS 兜底。所以这一块任何时候都不会是一片空白。
 *
 * 「减少动态效果」：不自动播，停在第一帧 —— 有图、不动。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { BrandGlow } from "./BrandGlow";
import { useSkin } from "../skins/useSkin";
import "./brandGlow.css";

/*
 * 用 glob 收，不逐个 import：少一个文件就整页 500（`BrandLoop` 的文件头记了那次）。
 * 另一个好处：以后 palettes.ts 加一套皮肤，渲出文件丢进来就认，不用改这里。
 */
const FILES = import.meta.glob<string>("./art/glow-*.mp4", { eager: true, query: "?url", import: "default" });

/**
 * 调色盘 id → 那一套的循环视频。键和 `src/skins/palettes.ts` 里的 id 一一对应。
 *
 * 这个目录里**只放竖版**。官网首页用的那个横版（`glow-wide.mp4`）在
 * `scripts/login-art/out/`，不在这儿 —— 上面那条 glob 是 eager 的，
 * 放进来就会被打进在线产物，白白多三百多 KB，而页面一次都不会去取它。
 */
const LOOPS: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([file, url]) => [/glow-(.+)\.mp4$/.exec(file)?.[1] ?? file, url]),
);

/** `data-skin` 是「调色盘-深浅」，取前半截 */
const paletteOf = (skinId: string) => skinId.replace(/-(dark|light)$/, "");

export function GlowLoop(): JSX.Element {
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
  if (failed || !src) return <BrandGlow />;
  return (
    <video
      ref={video}
      className="ps-brand-glow ps-glow-loop"
      data-pc="start-glow-loop"
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

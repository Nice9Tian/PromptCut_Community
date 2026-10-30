import type { CardDef, CardProps } from "../../kernel/types";
import { useRef } from "react";
import { isExportMode } from "../../kernel/clock";

/**
 * K6 的判例卡：**每一次 React 渲染都烧掉 `burnMs` 毫秒**。
 *
 * K6 的验收要「人为把一张卡的成本拉到 50 ms，播放不跳帧、`frame` 间隔变成约 50 ms、
 * 每拍都超过 40 ms……一秒内 K6 触发降级」。卡库里没有一张卡能**稳定**地这么慢：
 * 真正贵的那些（粒子、三维）贵在 rAF 回调和 GPU 上，而且机器一换数就变，
 * 验收里的「50 ms」就成了一个量不准的数。所以这里放一张成本由参数直接定的卡。
 *
 * 为什么把时间烧在 render 里而不是 rAF 回调里：K6 挑「最贵的那张轻卡」靠的是
 * `FrameScene` 的 live 路给每个片段套的 `<Profiler>`（`onRender` 的 `actualDuration`），
 * 它量的是这个片段子树的渲染 / 提交。rAF 回调跑在 `clock.tick` 里，
 * 回调和片段之间没有可靠的归属关系（见报告里的更正建议）。
 *
 * 计时用 `__pcRealNow`（舞台把 `performance.now` 换成了虚拟时钟，用它会空转到死）。
 */
/**
 * `padNodes`:在橙块里多画这么多个小点(每个一个绝对定位的 `<span>`),只为把这一层的快照做大 —— 在线按拍换快照的
 * 换帧成本按快照大小估(`src/render/beatSwap.mjs` 的 `swapCostOfSize`),`c10-browser-probe` 要一层「真的换不过来」的重层。
 * 缺省 0:一个节点都不多,画面与快照和以前逐字相同。
 */
function PadDots({ n }: { n: number }) {
  const dots = [];
  for (let i = 0; i < n; i++) {
    dots.push(
      <span key={i} style={{ position: "absolute", left: 488 + (i % 20) * 15, top: 428 + Math.floor(i / 20) * 11, width: 6, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.35)" }} />,
    );
  }
  return <>{dots}</>;
}

function ProbeSlowCard({ params, t }: CardProps<{ burnMs: number; label: string; padNodes?: number }>) {
  const burn = Math.max(0, Number(params.burnMs) || 0);
  if (burn > 0) {
    const now = (window as unknown as { __pcRealNow?: () => number }).__pcRealNow ?? (() => Date.now());
    const until = now() + burn;
    // 忙等:要的就是「这一拍的 React 渲染真的花了这么久」
    while (now() < until) { /* 烧时间 */ }
  }
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div
        data-pc-probe="slow"
        style={{
          position: "absolute", left: 480, top: 420, width: 320, height: 240, borderRadius: 24,
          background: "#f97316", color: "#fff", fontSize: 40, display: "grid", placeItems: "center",
          // 让它每帧都有变化,免得 React 把这一支 memo 掉
          transform: `translateX(${((t ?? 0) * 10).toFixed(2)}px)`,
        }}
      >
        {params.label}
      </div>
      {Number(params.padNodes) > 0 ? <PadDots n={Math.min(2000, Math.floor(Number(params.padNodes)))} /> : null}
    </div>
  );
}

export const probeSlowCard: CardDef<{ burnMs: number; label: string; padNodes?: number }> = {
  id: "probe-slow",
  name: "探针卡 · 可调成本",
  description: "K6 的判例:每次渲染烧掉 burnMs 毫秒(用 __pcRealNow 忙等),用来人为把一张卡的每拍成本拉高",
  source: "native",
  // direct:按 t 直接求值,没有动画历史 —— K6 要的是「一张**轻**卡被降级」,
  // 走推帧那条路的话它会先被 K2 的追帧上界判重,根本进不了轻管线
  frameMode: "direct",
  defaults: { burnMs: 0, label: "slow" },
  controls: [
    { key: "burnMs", type: "number", label: "每帧烧掉(ms)" },
    { key: "label", type: "text", label: "文字" },
  ],
  Component: ProbeSlowCard,
};

/**
 * 同一张卡的推帧版(C10 本机验收,`scripts/probes/c10-browser-probe.mjs`):`direct` 卡在预渲染管线里不产快照,
 * 渲染节点预渲染不了;在线双舞台要验「重层贴节点预渲染好的原尺寸快照」,得有一张在哪台机器上都稳定判重、
 * 又由渲染节点产快照的卡。画法与 `probe-slow` 相同(只画自己那一块,审阅表里 `independent`)。
 *
 * **只在舞台里、每个新时刻烧一次时间**(导出页 / 预渲染间里不烧;被抑制、t 冻住时的重渲染不烧):成本是给「舞台上活渲装不下」用的;预渲染间推一帧要渲好几次、
 * 推帧卡还要从入点推到目标帧,在那里也烧就会把预渲染拖到协议超时。画面与烧不烧无关。
 */
function ProbeSlowSteppedCard(props: CardProps<{ burnMs: number; label: string; padNodes?: number }>) {
  // 每个新的时刻只烧一次:被抑制(t 冻住)时的重渲染不算这张卡在活渲
  const last = useRef<number | null>(null);
  const fresh = last.current !== (props.t ?? 0);
  last.current = props.t ?? 0;
  const burnMs = isExportMode() || !fresh ? 0 : props.params.burnMs;
  return <ProbeSlowCard {...props} params={{ ...props.params, burnMs }} />;
}

export const probeSlowSteppedCard: CardDef<{ burnMs: number; label: string; padNodes?: number }> = {
  ...probeSlowCard,
  id: "probe-slow-stepped",
  name: "探针卡 · 可调成本(推帧)",
  description: "probe-slow 的推帧版:舞台里每次渲染烧掉 burnMs 毫秒(预渲染间里不烧);渲染节点能为它产快照",
  frameMode: "stateful",
  Component: ProbeSlowSteppedCard,
};

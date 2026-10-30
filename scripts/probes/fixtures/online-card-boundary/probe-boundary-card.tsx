/**
 * 越权探测用户卡(夹具):画面组件一挂上就把探测跑一遍,`audio()` 在声音线程里再跑 Worker 那一组。探测代码本体在 `probe-boundary-attempts.ts`。
 * 经真实加载路径用(`online-card-security-probe.mjs`):`content.put` 到 `src/cards/user/probe-boundary-card.tsx`
 * (探测代码本体放 `src/cards/user/probe-boundary-attempts.ts`)→ 编辑页面转译 → 发给舞台 → 加载器执行。
 *
 * 参数从片段的 `params.ctx` 来(收集站地址、会话号、素材哈希……;没有就什么都不做)。窗口那一半只在可见的那台舞台
 * (`role: "front"`)里跑一次,结果在那台舞台的 `globalThis.__pcBoundary["user-card"]`;声音那一半的结果从线程里 `postMessage` 出来
 * (探针在舞台里给 `Worker` 包了一层来接)。
 * 模块顶层往 `globalThis` 写一个记号:编辑页面、同源单舞台的文档里都不该出现它(契约第 10 节「编辑页面不执行」)。
 */
import { useEffect } from "react";
import { runAll, workerAttempts } from "./probe-boundary-attempts";

(globalThis as any).__pcBoundaryLoaded = { ...((globalThis as any).__pcBoundaryLoaded ?? {}), "user-card": true };

function BoundaryCard({ params }: { params: any }) {
  useEffect(() => {
    const g = globalThis as any;
    const base = params?.ctx;
    if (!base?.collector || g.__pcBoundaryStarted?.["user-card"]) return;
    if (!base.anyRole && g.__pcStageDiag?.().role !== "front") return;
    g.__pcBoundaryStarted = { ...(g.__pcBoundaryStarted ?? {}), "user-card": true };
    void runAll({ ...base, tag: "user-card", graph: false }).then((r: unknown) => { g.__pcBoundary = { ...(g.__pcBoundary ?? {}), "user-card": r }; });
  }, []);
  return <div className="absolute inset-0 flex items-center justify-center text-[80px]">probe-boundary-card</div>;
}

let audioStarted = false;

export const probeBoundaryCard = {
  id: "probe-boundary-card",
  name: "探针越权探测用户卡",
  description: "安全验收探针用:尝试读凭证、票据、本机存储、父页对象,并向外部地址发请求",
  tags: ["探针"],
  frameMode: "stateful",
  defaults: { ctx: null },
  controls: [],
  Component: BoundaryCard,
  // 声音线程里没有 DOM:只跑 Worker 那一组,结果从线程里发出去
  audio: (_sources: unknown, range: { start: number; count: number }, params: any) => {
    const base = params?.ctx;
    if (base?.collector && !audioStarted) {
      audioStarted = true;
      void workerAttempts({ ...base, tag: "user-card-audio" }).then((r: unknown) => { (self as any).postMessage({ __pcBoundary: "user-card-audio", r }); });
    }
    return new Float32Array(range.count);
  },
};

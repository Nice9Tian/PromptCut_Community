/**
 * 越权探测卡（测试夹具，用户卡；定义见 `docs/plan/sound-online-render-task.md`「越权探测卡」一节）。
 *
 * **防御性测试夹具，不是攻击代码**：给托管方渲染服务的按项目隔离做验收用（`scripts/probes/hosted-render-isolation-probe.mjs`），
 * 只在测试环境里用，不进卡片库、不随发版。它是一张普通的用户卡：画面组件挂上时把固定清单（`overreach-probe-lib.ts`）跑一遍——
 * 逐项*尝试*读取本不该读到的东西，只读、只报告，把结果打进页面日志由探针取回。探针放的都是假凭证（`PROBE-FAKE-…`）。
 *
 * 用法：探针把本文件与清单文件原样 `content.put` 进测试项目的内容库（`card-source`，键 `src/cards/user/overreach-probe.tsx` 与
 * `src/cards/user/overreach-probe-lib.ts`），片段的 `params.ctx` 给清单要用的测试地址；没有 `ctx` 时什么都不做。
 * 模块顶层往 `globalThis.__pcOverreachLoaded` 记一笔「这个项目的卡片代码载入过」：换去渲别的项目时，那个页面里不该有它。
 */
import { useEffect, useState } from "react";
import type { CardDef } from "../../kernel/types";
import { beginFrameWork } from "../../kernel/frameReady";
import { runOverreach, emitReport } from "./overreach-probe-lib";

const G = globalThis as any;
G.__pcOverreachLoaded = { ...(G.__pcOverreachLoaded ?? {}), "overreach-probe": true };

type Params = { ctx: any };

/** 一个页面只跑一遍（同一页里这张卡可能挂好几次） */
let started: Promise<void> | null = null;

function OverreachProbe({ params }: { params: Params }) {
  const [state, setState] = useState("待命");
  useEffect(() => {
    const ctx = params?.ctx;
    if (!ctx?.tag) return;
    G.__pcOverreachLoaded = { ...(G.__pcOverreachLoaded ?? {}), [`ran:${ctx.tag}`]: true };
    // 这一帧等清单跑完再出（卡片的常规办法，同 Lottie 卡等素材载入）：不然页面渲完就关，结果来不及打出来
    const ready = beginFrameWork("overreach-probe");
    started ??= runOverreach(ctx).then((report) => { emitReport(report); }, (e) => { console.log(`OVERREACH-ERROR ${ctx.tag} ${String(e?.message ?? e).slice(0, 200)}`); });
    void started.then(() => { ready.ready(); setState("已报告"); });
    return () => ready.dispose();
  }, []);
  return (
    <div className="absolute inset-0 grid place-items-center text-white">
      <div className="rounded-xl bg-slate-700 px-10 py-6 text-4xl font-bold">越权探测卡 · {state}</div>
    </div>
  );
}

export const overreachProbe: CardDef<Params> = {
  id: "overreach-probe",
  name: "越权探测卡",
  description: "隔离验收用的测试夹具：按固定清单尝试读取本不该读到的东西，只读、只报告",
  tags: ["探针"],
  frameMode: "stateful",
  defaults: { ctx: null },
  controls: [],
  Component: OverreachProbe,
};

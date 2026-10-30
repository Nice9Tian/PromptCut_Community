/**
 * 越权探测卡的素材效果卡形态（测试夹具，防御性测试，不是攻击代码；定义见 `docs/plan/sound-online-render-task.md`「越权探测卡」一节）。
 *
 * `card()` 第一次被求值时把同一份固定清单（`overreach-probe-lib.ts`）跑一遍并报告（结果的标签带 `-graph`）。
 * 渲染节点报的能力位是 `graphCards: false`，但服务端现在分不出一张卡是不是素材效果卡（切分时 `requires.graphCards` 恒为假），
 * 所以含素材效果卡的片段照样被认领、`card()` 照样在渲染页里求值——探针把这一点如实记下（结果里的 `graph`），并对它的结果做同样的断言。
 */
import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";
import { beginFrameWork } from "../../kernel/frameReady";
import { runOverreach, emitReport } from "./overreach-probe-lib";

const G = globalThis as any;
G.__pcOverreachLoaded = { ...(G.__pcOverreachLoaded ?? {}), "overreach-graph": true };

let started = false;

export const overreachGraph: CardDef<any> = {
  id: "overreach-graph",
  name: "越权探测卡（素材效果卡）",
  description: "隔离验收用的测试夹具：素材效果卡形态的同一份固定清单，只读、只报告",
  tags: ["探针"],
  kind: "animation",
  frameMode: "direct",
  defaults: { ctx: null },
  controls: [],
  card: (_sources: unknown, _t: number, params: any) => {
    const ctx = params?.ctx;
    if (ctx?.tag && !started) {
      started = true;
      console.log(`OVERREACH-GRAPH-EVALUATED ${ctx.tag}`);
      const ready = beginFrameWork("overreach-graph");
      void runOverreach({ ...ctx, tag: `${ctx.tag}-graph` }).then((report) => emitReport(report), () => {}).then(() => ready.ready());
    }
    return glsl(`void main() { outColor = vec4(0.2, 0.2, 0.3, 1.0); }`, [], {});
  },
};

/**
 * Media effect card form of overreach probe card (test fixture, defensive test, not attack code;
 * defined in `docs/plan/sound-online-render-task.md` section "Overreach probe card").
 *
 * When `card()` is evaluated for the first time, it runs the same fixed manifest
 * (`overreach-probe-lib.ts`) and reports (result tags include `-graph`). Render node reports
 * capability bit `graphCards: false`, but the server currently cannot distinguish whether a card
 * is a media effect card (during splitting, `requires.graphCards` is always false), so clips
 * containing media effect cards are still claimed and `card()` is still evaluated in render page:
 * probe records this faithfully (`graph` in results) and makes same assertions on its results.
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
  name: "Overreach probe card (media effect card)",
  description: "Test fixture for the isolation acceptance check: the same fixed manifest in media effect card form, read-only, report-only",
  tags: ["probe"],
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

/**
 * Overreach probe card (test fixture, user card; defined in
 * `docs/plan/sound-online-render-task.md` section "Overreach probe card").
 *
 * **Defensive test fixture, not attack code**: used for acceptance check of per-project isolation
 * in host render service (`scripts/probes/hosted-render-isolation-probe.mjs`), used only in test
 * environments, never enters card library, does not ship with releases. It is an ordinary user
 * card: when visual component mounts, it runs fixed manifest (`overreach-probe-lib.ts`): item by
 * item it *attempts* to read things it should not, read-only and report-only, printing results to
 * page logs for probe to retrieve. Probe places fake credentials everywhere (`PROBE-FAKE-…`).
 *
 * Usage: probe performs `content.put` of this file and manifest file as-is into test project's
 * content store (`card-source`, keys `src/cards/user/overreach-probe.tsx` and
 * `src/cards/user/overreach-probe-lib.ts`), clip's `params.ctx` provides test addresses needed by
 * manifest; does nothing when `ctx` is missing. Module top level records note "this project's card
 * code has loaded" into `globalThis.__pcOverreachLoaded`: when switching to render another project,
 * that page should not contain it.
 */
import { useEffect, useState } from "react";
import type { CardDef } from "../../kernel/types";
import { beginFrameWork } from "../../kernel/frameReady";
import { runOverreach, emitReport } from "./overreach-probe-lib";

const G = globalThis as any;
G.__pcOverreachLoaded = { ...(G.__pcOverreachLoaded ?? {}), "overreach-probe": true };

type Params = { ctx: any };

/** Runs only once per page (this card may mount multiple times on the same page) */
let started: Promise<void> | null = null;

function OverreachProbe({ params }: { params: Params }) {
  const [state, setState] = useState("Standby");
  useEffect(() => {
    const ctx = params?.ctx;
    if (!ctx?.tag) return;
    G.__pcOverreachLoaded = { ...(G.__pcOverreachLoaded ?? {}), [`ran:${ctx.tag}`]: true };
    // This frame waits for manifest to finish before emitting (standard card approach, same as asset
    // loading for Lottie cards, etc.): otherwise page closes right after rendering, before results can
    // be printed
    const ready = beginFrameWork("overreach-probe");
    started ??= runOverreach(ctx).then((report) => { emitReport(report); }, (e) => { console.log(`OVERREACH-ERROR ${ctx.tag} ${String(e?.message ?? e).slice(0, 200)}`); });
    void started.then(() => { ready.ready(); setState("Reported"); });
    return () => ready.dispose();
  }, []);
  return (
    <div className="absolute inset-0 grid place-items-center text-white">
      <div className="rounded-xl bg-slate-700 px-10 py-6 text-4xl font-bold">Overreach probe card · {state}</div>
    </div>
  );
}

export const overreachProbe: CardDef<Params> = {
  id: "overreach-probe",
  name: "Overreach probe card",
  description: "Test fixture for the isolation acceptance check: tries to read, per a fixed manifest, things it should not be able to read; read-only, report-only",
  tags: ["probe"],
  frameMode: "stateful",
  defaults: { ctx: null },
  controls: [],
  Component: OverreachProbe,
};

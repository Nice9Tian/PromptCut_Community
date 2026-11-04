/**
 * Supporting fixture for overreach probe card: a user card that **exists only in Project Jia**
 * (test fixture, defensive test, not attack code).
 *
 * It probes nothing, only leaving a marker at module top level (a placeholder string shaped like a
 * fake credential, known to probe). Isolation probe uses it to verify "when switching to render Yi
 * after rendering Jia, Jia's card code does not exist in Yi's page": Yi's overreach probe card
 * looks for this marker in its own page and tries to fetch this file, neither of which should
 * succeed.
 */
import type { CardDef } from "../../kernel/types";

const G = globalThis as any;
G.__pcOverreachLoaded = { ...(G.__pcOverreachLoaded ?? {}), "marker-jia": "PROBE-FAKE-JIA-CARD-CODE-7d1f0c" };

function MarkerJia() {
  return <div className="absolute inset-0 grid place-items-center text-white text-4xl">Project A marker card</div>;
}

export const overreachMarkerJia: CardDef<Record<string, never>> = {
  id: "overreach-marker-jia",
  name: "Project A marker card",
  description: "Test fixture for the isolation acceptance check: card code that only project A has",
  tags: ["probe"],
  frameMode: "stateful",
  defaults: {},
  controls: [],
  Component: MarkerJia,
};

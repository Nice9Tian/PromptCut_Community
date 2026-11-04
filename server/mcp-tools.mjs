// Facade for backward compatibility
//
// Each tool's `side` (C6.5 D1, `docs/plan/c65-design.md` section 5; per-tool rationale in docs/archive/agent-reports/AGENT-c65-agent.md):
//   - "agent": Executed on the Agent server side (editor vite process). When a project replica is
//              present (the page has connected to the document service, see server/agent/), runs
//              src/mcp/handlers on the replica, computing operations to submit to the document
//              service with the expected version under the Agent chat identity; when there is no
//              replica (the page has not connected to the document service yet, or headless
//              instances disabled the document service), executed via the page as before. Tools
//              that both read page state and write to the project (set_project_meta, switch_cut,
//              add_cut, remove_cut, attach_clip_motion) are also on this side (c65-integ2 ruling,
//              D1 criterion): required page state (playhead, tracks in page memory) is requested
//              read-only once via the page channel, see PAGE_STATE_TOOLS in
//              server/agent/agent-exec.mjs.
//   - "page":  Executed only on the page: reads page-only state (selection, playhead, panel UI,
//              job table in the page), or requires browser capabilities and writes to the project
//              only when background jobs complete; moving to the server side would lose state or
//              fail to write into the same submission.
//   - "server": Executed in place on the server side without touching the project (wait,
//              report_progress, and the four multi-Agent tools for spawn_agent and bulletin board).
import { projectTools } from "./tools/project.mjs";
import { clipsTools } from "./tools/clips.mjs";
import { layoutTools } from "./tools/layout.mjs";
import { tracksTools } from "./tools/tracks.mjs";
import { partsTools } from "./tools/parts.mjs";
import { effectsTools } from "./tools/effects.mjs";
import { cutsTools } from "./tools/cuts.mjs";
import { audioTools } from "./tools/audio.mjs";
import { aiTools } from "./tools/ai.mjs";
import { cardsTools } from "./tools/cards.mjs";
import { visionTools } from "./tools/vision.mjs";
import { collectTools } from "./tools/collect.mjs";
import { browserTools } from "./tools/browser.mjs";
import { agentTools } from "./tools/agent.mjs";
import { coreTools } from "./tools/core.mjs";

/** Tool name → group (filename in server/tools/). Used by tool call event icons (C6.5 D2) */
export const toolGroups = Object.fromEntries([
  ["project", projectTools], ["clips", clipsTools], ["layout", layoutTools], ["tracks", tracksTools], ["parts", partsTools],
  ["effects", effectsTools], ["cuts", cutsTools], ["audio", audioTools], ["ai", aiTools], ["cards", cardsTools],
  ["vision", visionTools], ["collect", collectTools], ["browser", browserTools], ["agent", agentTools], ["core", coreTools],
].flatMap(([group, list]) => list.map((t) => [t.name, group])));

export const tools = [
  ...projectTools,
  ...clipsTools,
  ...layoutTools,
  ...tracksTools,
  ...partsTools,
  ...effectsTools,
  ...cutsTools,
  ...audioTools,
  ...aiTools,
  ...cardsTools,
  ...visionTools,
  ...collectTools,
  ...browserTools,
  ...agentTools,
  ...coreTools,
];

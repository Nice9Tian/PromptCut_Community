import type { ToolCallInfo } from "../../../ai/types.ts";
import { isReportTool } from "../../../ai/progressReport.ts";
import { tr } from "../../../i18n/index.ts";

/**
 * Pure functions behind the row of action icons in a chat bubble (ToolIcons.tsx): action classification and icon grouping.
 *
 * Kept in its own file, free of React and styles, so node can run the tests directly (iconRuns.test.mjs).
 */

/**
 * Color classification of icons.
 *
 * Classified by "what this step did to the project", not by tool name in alphabetical order: the user should be able to see at a glance
 * which steps are deleting things. Reads deliberately use the faintest color: they are the most numerous but the least worth noticing,
 * and if everything on screen is equally bright, the real actions become hard to see.
 */
export type ToolKind = "add" | "remove" | "edit" | "read" | "look" | "download" | "ui" | "agent" | "wait" | "job";

/**
 * Strip the server prefix before the tool name. Claude Code reports `mcp__promptcut__add_clip`,
 * while others use a bare name or `promptcut.add_clip`. Classification, comparison and display all use the bare name:
 * without stripping, none of the regexes below would match, and every step Claude runs would fall into the catch-all "Process".
 */
export function bareToolName(name: string): string {
  return name.replace(/^mcp__.+?__/, "").replace(/^[\w-]+\.(?=\w)/, "");
}

/*
 * "Process" is the catch-all and should only be left with work that really takes a while to run (transcription, tracking, detection, prerender, auto workflow).
 * If a new tool falls into "Process", first consider whether it is really collecting, changing, reading or clicking the UI.
 */
export function toolKind(rawName: string): ToolKind {
  const name = bareToolName(rawName);
  // UI actions: playhead, switching cuts, popups, things that act on the user interface without changing the project. Since 2026-10-21 these tool names carry the user_interface_ prefix;
  // old chat history still has the old names (play / pause / seek / switch_cut), and both are recognized. Placed first: user_interface_collect_login does not count as collecting
  if (/^user_interface_|^(play|pause|seek)$|^switch_/.test(name)) return "ui";
  // Collecting goes after UI actions: search_web, collect_*, web_* all aim to bring media and material back, so they belong here even if the name looks like "read" or "view".
  // *_install installs extension packs, and like collect_install counts as bringing things back
  if (/^(collect|web)_|^search_web$|_install$|download/i.test(name)) return "download";
  // Multiple Agents reporting scope and passing messages to each other. Placed before reads: list_agents / check_messages look like reads by name, but are really collaboration
  if (/^(declare_scope|send_message|check_messages|list_agents)$/.test(name)) return "agent";
  if (/^(remove|delete|clear)_/.test(name)) return "remove";
  // duplicate_clip adds one more clip and fill_captions lays out a batch of captions, both count as additions
  if (/^(add|create|import|insert|duplicate|fill)_/.test(name)) return "add";
  // align / nudge move positions; attach / detach attach and remove motion on a clip: all of them modify the clip
  if (/^(set|update|edit|move|rename|reorder|split|trim|attach|detach)_|^(align|nudge)$/.test(name)) return "edit";
  // Looking at the picture (see_frames, view_file and the like) is split out, separate from reads that browse data
  if (/^(see|view)_/.test(name)) return "look";
  // detect_* needs to run an analysis for a while, so it is not here: it falls through to "Process" below. *_status only asks about progress, so it counts as a read
  if (/^(list|get|read|search|find|check|inspect)_|_status$|_guide$/.test(name)) return "read";
  if (/^wait/.test(name)) return "wait";
  return "job";
}

export const KIND_LABEL: Record<ToolKind, string> = {
  add: tr("Add"),
  remove: tr("Delete"),
  edit: tr("Change"),
  read: tr("Read"),
  look: tr("View"),
  download: tr("Collect"),
  ui: tr("UI actions"),
  agent: tr("Multi-Agent"),
  wait: tr("Wait"),
  job: tr("Process"),
};

/**
 * The maximum number of actions one icon holds.
 *
 * It used to be "4 consecutive actions of the same kind fold into the first one ×N, and expand on click": a run of 30 reads folded into one small square,
 * and expanding it filled a whole screen at once. Now each icon stacks at most 5, and the 6th starts a new icon:
 * where more is done there are more icons, so you can see at a glance which stretch was busy; a single icon expands to only a few lines of manifest.
 */
export const ICON_RUN_MAX = 5;

/** iconRuns only looks at the name (to recognize the category and the report tool) and success or failure */
export type ToolPartLike = Pick<ToolCallInfo, "name" | "ok">;

export interface IconRun {
  /**
   * Unique and stable within this row: the index of the first action it holds.
   * While streaming, new actions are only appended at the end, so the keys of icons that already appeared do not change, and the expanded state and carousel focus do not jump to another icon.
   */
  key: string;
  /** Action type of the first action, which decides the background color and glyph */
  kind: ToolKind;
  /** Any failure → err; any with no result yet → run; otherwise ok */
  state: "run" | "ok" | "err";
  /** Indexes in the input array of the actions held by this icon, in order */
  items: number[];
}

/**
 * Split a run of actions into icons.
 *
 * - A report tool (report_progress) produces no icon: it is drawn as a report card. Here it is treated as nonexistent, and does not interrupt same-kind actions before and after it;
 * - Adjacent actions with the same group key merge into one icon. Group key = "err" for failures (the red exclamation mark is its own kind,
 *   and breaks a run of the same type), otherwise the action type;
 * - stt_install always stands alone: it may render as a progress bar rather than an icon, and is merged with nothing;
 * - One icon holds at most ICON_RUN_MAX actions, and when full a new icon starts (12 of the same kind → 5, 5, 2).
 */
export function iconRuns(tools: readonly ToolPartLike[]): IconRun[] {
  const runs: IconRun[] = [];
  let lastGroup = "";
  tools.forEach((t, i) => {
    if (isReportTool(t.name)) return;
    const group = bareToolName(t.name) === "stt_install" ? `install:${i}` : t.ok === false ? "err" : toolKind(t.name);
    const last = runs[runs.length - 1];
    if (last && group === lastGroup && last.items.length < ICON_RUN_MAX) {
      last.items.push(i);
      return;
    }
    runs.push({ key: `r${i}`, kind: toolKind(t.name), state: "ok", items: [i] });
    lastGroup = group;
  });
  for (const run of runs) {
    const items = run.items.map((i) => tools[i]);
    run.state = items.some((t) => t.ok === false) ? "err" : items.some((t) => t.ok === undefined) ? "run" : "ok";
  }
  return runs;
}

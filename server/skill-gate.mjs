/**
 * Toggle and gate for SKILL mode.
 *
 * In short: **when SKILL mode is closed, any tool call from desktop app sessions is forbidden
 * from taking effect**, returning only a message explaining that the mode is not enabled and what
 * to do.
 * Blocks by caller type (plan `docs/plan/agent-workflow-plan.md` A4): type comes from the Agent
 * session registry (`server/agent/agent-sessions.mjs`); `desktop` is blocked, while `api` / `cli`
 * from the AI panel are not.
 *
 * Why: between the two working modes (`user-workflow.md` "Working mode"), in Classic mode the user
 * and the Agent in the AI panel take action, while in SKILL mode the Agent in the desktop app takes
 * action. When the user switches back to Classic mode, they retract the desktop app's hands:
 * sessions over there might be running midway without knowing; without this gate, it would continue
 * writing into the project. So the gate blocks **before executing the tool**, rather than rolling
 * back after execution. The Agent in the AI panel can be used under both working modes and is not
 * blocked.
 *
 * Where state is stored: a fixed-path JSON, not a field in the project. The editor process and the
 * Rust shell (`desktop/src-tauri/src/skill_shell.rs`, another process that cannot read web page
 * content) must read the same state, and a fixed path is a mutually agreed location. It is placed
 * under Documents:
 *   1. **Will not be virtualized by MSIX containers** (%LOCALAPPDATA% will, experienced before);
 *   2. Users can also open and inspect it themselves.
 * The shell also reads two fields, `jobId` and `procPath` (job id and project file of the legacy
 * headless instance, archived); now they are never written, and the shell treats them as absent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tr } from "./i18n.mjs";

/** State directory for SKILL; tests and probes point to a temporary directory via `PROMPTCUT_SKILL_DIR` */
export function skillRoot() {
  return process.env.PROMPTCUT_SKILL_DIR || path.join(os.homedir(), "Documents", "PromptCut-Skill");
}

export function statePath() {
  return path.join(skillRoot(), "skill-state.json");
}

/**
 * @typedef {object} SkillState
 * @property {boolean} active      Whether SKILL mode is active
 * @property {string|null} since   When it was activated
 * @property {string|null} closedAt When it was closed
 * @property {string|null} closedBy Who closed it: user / …
 */

/** Closed state. If the file cannot be read or is corrupted, treat as "closed": default deny is safer than default allow */
function closed() {
  return { active: false, since: null, closedAt: null, closedBy: null };
}

export function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    return { ...closed(), active: raw.active === true, since: raw.since ?? null, closedAt: raw.closedAt ?? null, closedBy: raw.closedBy ?? null };
  } catch {
    return closed();
  }
}

export function writeState(patch) {
  const next = { ...readState(), ...patch };
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write to a temporary file before renaming: the shell reads it every second, and overwriting
  // directly risks reading partially written content
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return next;
}

/** Opens the gate: user switches to SKILL in the editor */
export function openGate() {
  return writeState({ active: true, since: new Date().toISOString(), closedAt: null, closedBy: null });
}

export function closeGate(by = "user") {
  return writeState({ active: false, closedAt: new Date().toISOString(), closedBy: by });
}

/**
 * The message given to the Agent upon rejection.
 *
 * Written as a readable explanation rather than a bare false: the recipient is a model, which needs
 * to know "it's not that I called with wrong parameters, but that the user hasn't enabled SKILL",
 * and what to do next (tell the user, do not retry). Repeatedly retrying the same tool is the most
 * common failure mode for this type of interception.
 */
export function gateMessage(tool) {
  return [
    tr("PromptCut is not in SKILL mode right now. Sessions in the desktop app cannot operate on projects."),
    "",
    `\`${tool}\` was not executed and the project was **not** changed at all. PromptCut has two working modes: in Classic mode the user and the Agent in the editor's AI panel do the work, and only SKILL mode hands work to the Agent in the desktop app.`,
    "",
    "Please do the following:",
    "1. **Do not retry** this tool, and do not try a different tool either: when SKILL mode is off, all tool calls are blocked the same way, including read-only ones;",
    "2. If you have already done part of the work, tell the user what is done and what is still left;",
    "3. Tell the user: to let you continue, switch \"Classic mode / SKILL\" to SKILL in the PromptCut top bar, then come back and tell you.",
  ].join("\n");
}

/**
 * Whether to allow this tool call through.
 *
 * @param {string} tool
 * @param {string} callerType Caller type (the `type` registered in the registry): only `desktop`
 *   is governed by this gate.
 *   The AI panel Agent (`api` / `cli`) can be used under both working modes. Unregistered calls
 *   that did not report identity (tests, diagnostic scripts directly POSTing to `/api/mcp/call`)
 *   pass `unknown` as caller, and are not blocked: just like before the change ("only block
 *   headless instances"), it only manages the recognizable category.
 */
export function checkGate(tool, callerType) {
  if (callerType !== "desktop") return { ok: true };
  const state = readState();
  if (state.active) return { ok: true };
  return { ok: false, message: gateMessage(tool) };
}

/**
 * SKILL 模式的开关与闸门。
 *
 * 一句话:**SKILL 模式关着时,桌面 APP 会话的任何工具调用都不许落地**,只回一段话告诉它模式没开、该怎么办。
 * 按调用方的类型拦(计划 `docs/plan/agent-workflow-plan.md` A4):类型来自 Agent 会话登记表
 * (`server/agent/agent-sessions.mjs`),`desktop` 拦,AI 栏的 `api` / `cli` 不拦。
 *
 * 为什么:两种工作方式(`user-workflow.md`「工作方式」)里,传统式动手的是用户和 AI 栏里的 Agent,SKILL 动手的是
 * 桌面 APP 里的 Agent。用户切回传统式就是收回了桌面 APP 的手 —— 那边的会话可能正跑在半路并不知情,没有这道闸,
 * 它会继续往项目里写。所以闸在**执行工具之前**拦,不是执行完再回滚。AI 栏的 Agent 两种方式下都能用,不拦。
 *
 * 状态存哪:一个固定路径的 JSON,不是项目里的字段。编辑器进程和 Rust 外壳(`desktop/src-tauri/src/skill_shell.rs`,
 * 另一个进程,读不到网页里的东西)要读同一份状态,固定路径是都能约定的地方。它放在 Documents 下:
 *   1. **不会被 MSIX 容器虚拟化**(%LOCALAPPDATA% 会,踩过);
 *   2. 用户自己也能打开看。
 * 外壳还读 `jobId`、`procPath` 两个字段(旧版无头实例的任务号与项目文件,已归档),现在一律不写,外壳按没有处理。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** SKILL 的状态目录;测试与探针用 `PROMPTCUT_SKILL_DIR` 指到临时目录 */
export function skillRoot() {
  return process.env.PROMPTCUT_SKILL_DIR || path.join(os.homedir(), "Documents", "PromptCut-Skill");
}

export function statePath() {
  return path.join(skillRoot(), "skill-state.json");
}

/**
 * @typedef {object} SkillState
 * @property {boolean} active      SKILL 模式开着没有
 * @property {string|null} since   什么时候开的
 * @property {string|null} closedAt 什么时候关的
 * @property {string|null} closedBy 谁关的:user / …
 */

/** 关着的状态。读不到文件、文件坏了,都按「关着」处理 —— 默认拒绝比默认放行安全 */
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
  // 先写临时文件再改名:外壳每秒都在读它,直接覆盖有可能被读到写了一半的内容
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return next;
}

/** 开闸:用户在编辑界面里切到 SKILL */
export function openGate() {
  return writeState({ active: true, since: new Date().toISOString(), closedAt: null, closedBy: null });
}

export function closeGate(by = "user") {
  return writeState({ active: false, closedAt: new Date().toISOString(), closedBy: by });
}

/**
 * 拒绝时给 Agent 的那段话。
 *
 * 写成一段能读懂的说明而不是干巴巴一个 false:收到它的是模型,它得知道「不是我调错了参数,是用户没开
 * SKILL」,以及接下来该干什么(告诉用户、别重试)。反复重试同一个工具是这类拦截最常见的失败模式。
 */
export function gateMessage(tool) {
  return [
    "PromptCut 现在不在 SKILL 模式,桌面 APP 的会话不能操作项目。",
    "",
    `\`${tool}\` 没有执行,项目**没有**任何改动。PromptCut 有两种工作方式:传统式由用户和编辑界面 AI 栏里的 Agent 动手,SKILL 才交给桌面 APP 里的 Agent。`,
    "",
    "接下来请这样做:",
    "1. **不要重试**这个工具,也不要换个工具再试 —— SKILL 模式没开时所有工具调用都会被同样拦下,包括只读的;",
    "2. 如果你已经做了一部分,把做完的和还差的告诉用户;",
    "3. 告诉用户:想让你继续,请在 PromptCut 顶栏把「传统式 / SKILL」切到 SKILL,然后回来跟你说一声。",
  ].join("\n");
}

/**
 * 这次工具调用放不放行。
 *
 * @param {string} tool
 * @param {string} callerType 调用方类型(登记表里登记过的 `type`):只有 `desktop` 受这道闸管。
 *   AI 栏的 Agent(`api` / `cli`)在两种工作方式下都能用。没登记过、也没报身份的调用(测试、诊断脚本直接 POST
 *   `/api/mcp/call`)由调用方传 `unknown`,不拦 —— 和改之前「只拦无头实例」一样,只管认得出来的那一类。
 */
export function checkGate(tool, callerType) {
  if (callerType !== "desktop") return { ok: true };
  const state = readState();
  if (state.active) return { ok: true };
  return { ok: false, message: gateMessage(tool) };
}

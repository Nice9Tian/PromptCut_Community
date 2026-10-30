import { useEffect, useState } from "react";
import type { JSX } from "react";
import { closeSkillMode, subscribeSkill } from "../skill/skillMode";
import { onlinePage, onlineUnsupported } from "../online/pageFlag";
import "./ModeSwitch.css";

/**
 * 顶栏的工作方式开关:氛围式 / 传统式 / SKILL(`user-workflow.md`「工作方式」)。
 *
 * 做成**一个整体控件**而不是三个独立按钮:几种方式是互斥的一件事,滑块滑到哪一格就是哪一格。
 *
 *   * 氛围式:不打开编辑界面,对着 Agent 说话把片子做出来(名词表里也叫这个名字)。
 *     **它是个去处,不是个状态** —— 人在编辑界面里就
 *     不可能同时在氛围式,所以滑块永远不会停在这一格;点它等于离开编辑界面、回到氛围式那一屏
 *     (从那儿点一张项目卡片,又回到传统式)。
 *   * 传统式:用户和 AI 栏里的 Agent 动手;桌面 APP 的会话被 SKILL 闸拦下(`server/skill-gate.mjs`)。
 *   * SKILL:桌面 APP 里的 Agent 经 MCP 直连这个项目(计划 `docs/plan/agent-workflow-plan.md` A4),AI 栏照常可用。
 *     进 SKILL 走「SKILL…」对话框(登记到 Claude Code / Codex、看接进来的会话、进入 SKILL);
 *     退出就点这里的「传统式」,手边最近的就是这个控件。
 *
 * 原来只有传统式与 SKILL 两格(更早还有一格「对话式」布局,已去掉)。氛围式这一格是 2026-10-23 加的:
 * 在那之前语义里没有这种工作方式,加完名词表里就有三种了。刚加时那一屏只有在线浏览器有,桌面版这一格置灰;
 * 同日桌面版的氛围式也做出来了(`src/start/DesktopStart.tsx`),两边都能点。
 */

type Mode = "vibe" | "classic" | "skill";

/**
 * 在线构建的编译期常量(写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」)。在线页面进不了 SKILL 模式
 * (这一格置灰,`skillMode.ts` 也不轮询),订阅与退出在在线构建里剪掉,连同 `skillMode.ts` 背后的 /api 调用(M8 遗留 L24)。
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

// 顺序照 `user-workflow.md`「工作方式」那张表:氛围式、传统式、SKILL
const ITEMS: { id: Mode; label: string; hint: string }[] = [
  { id: "vibe", label: "氛围式", hint: "不打开编辑界面，对着 Agent 说话把片子做出来" },
  { id: "classic", label: "传统式", hint: "用户和 AI 栏里的 Agent 一起改" },
  { id: "skill", label: "SKILL", hint: "桌面 APP 里的 Agent 经 MCP 改这个项目" },
];

export function ModeSwitch(props: { onOpenSkill: () => void; onEnterVibe?: () => void }): JSX.Element {
  const [skillOn, setSkillOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => (ONLINE_BUILD ? undefined : subscribeSkill((s) => setSkillOn(s.state.active))), []);

  const active: Mode = skillOn ? "skill" : "classic";

  const pick = async (id: Mode) => {
    if (id === "vibe") {
      // 离开编辑界面、回到氛围式那一屏。脏数据的确认在 TopBar 的 goHome 里,和「回开始页」共用一套
      props.onEnterVibe?.();
      return;
    }
    if (id === "skill") {
      // 进 SKILL(或已经在 SKILL 时看接进来的会话、登记)都在对话框里
      props.onOpenSkill();
      return;
    }
    if (id === active || ONLINE_BUILD) return;
    // 切回传统式 = 退出 SKILL 模式:之后桌面 APP 会话的工具调用都会被拒
    setBusy(true);
    try {
      await closeSkillMode("user");
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const index = ITEMS.findIndex((i) => i.id === active);

  // 两边都有氛围式那一屏了(在线 `src/start/OnlineStart.tsx`、桌面 `src/start/DesktopStart.tsx`,
  // 桌面版 2026-10-23 补上)。只有调用方没给去处时才置灰 —— 那是还没接上这颗键的地方
  const vibeOff = !props.onEnterVibe;

  /** 每一格的悬停说明。三格之后嵌套三目读不动了,拆出来 */
  const titleOf = (item: (typeof ITEMS)[number], on: boolean): string => {
    if (item.id === "vibe") {
      return vibeOff ? "这里还接不到氛围式那一屏" : item.hint;
    }
    if (item.id === "skill") {
      if (!on && onlinePage()) return onlineUnsupported("SKILL 模式");
      return on
        ? "当前为 SKILL 模式。点这里看接进来的桌面 APP 会话;点「传统式」退出"
        : "打开 SKILL 对话框:登记到 Claude Code / Codex,进入 SKILL";
    }
    return item.hint;
  };

  return (
    <div className="pc-modeswitch" role="group" aria-label="工作方式" data-pc="mode-switch">
      {/* 滑块:绝对定位,按选中项的序号平移。三格等宽、滑块宽一格,所以平移 index 个自身宽度就对位 */}
      <span
        className={`pc-modeswitch-thumb${active === "skill" ? " is-skill" : ""}`}
        style={{ transform: `translateX(${index * 100}%)` }}
        aria-hidden="true"
      />
      {ITEMS.map((item) => {
        const on = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            data-pc={`mode-${item.id}`}
            className={`pc-modeswitch-item${on ? " is-on" : ""}`}
            aria-pressed={on}
            // 在线浏览器模式:SKILL 要本机的桌面 APP 与编辑器进程(C10 契约第 10 节),置灰
            disabled={busy || (item.id === "skill" && !on && onlinePage()) || (item.id === "vibe" && vibeOff)}
            title={titleOf(item, on)}
            onClick={() => void pick(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

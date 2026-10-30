import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { useBackdropClose } from "../ui/backdropClose";
import { openSkillMode, subscribeSkill } from "../skill/skillMode";
import { shortSessionId, useDesktopSessions } from "../ai/desktopSessions";
import { operationText } from "./right/DesktopSessionsStrip";
import "./SkillDialog.css";

/**
 * SKILL 对话框(计划 `docs/plan/agent-workflow-plan.md` A4;语义 `user-workflow.md`「工作方式」「Agent 接入方式」)。
 *
 * SKILL = 桌面 APP 里的 Agent 经 MCP 直连用户正在用的这个项目。这里做三件事:
 *   1. **登记到 Claude Code / Codex**:把 PromptCut 的 MCP 服务写进它们的用户级配置(条目名固定 `promptcut`,
 *      不写端口,写之前备份,能撤销;`server/desktop-register.mjs`)。登记一次就行,换项目、重开 PromptCut 不用重登;
 *   2. **看接进来的会话**:每个桌面 APP 会话一个身份,标厂商和正在进行的操作(AI 栏里也按会话分组显示);
 *   3. **进入 SKILL 模式**:之后桌面 APP 的会话才能动手;退出点顶栏的「传统式」。
 *
 * 原来这里是「选驱动 → 快照项目进任务目录 → 起无头实例 → 深链拉起新对话 → 回来三方合并」,已归档。
 */

interface TargetStatus {
  target: "claude-code" | "codex";
  label: string;
  file: string;
  exists: boolean;
  registered: boolean;
  /** 登记的正是这份 PromptCut(命令与脚本一致) */
  current: boolean;
  undoable: boolean;
  registeredAt?: string;
  error: string | null;
}

const TARGET_DESC: Record<TargetStatus["target"], string> = {
  "claude-code": "Claude 桌面版的「Code」与命令行共用这份配置;登记后新开的会话里就有 PromptCut 的工具",
  codex: "Codex 桌面版与命令行共用这份配置;登记后新开的线程里就有 PromptCut 的工具",
};

async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `请求失败(${res.status})`);
  }
  return data as T;
}

function statusText(t: TargetStatus): { text: string; tone: "ok" | "warn" | "muted" | "err" } {
  if (t.error) return { text: t.error, tone: "err" };
  if (t.current) return { text: "已登记", tone: "ok" };
  if (t.registered) return { text: "已有一条 promptcut 登记,但指向别处(比如另一份安装);点「登记」改成这一份", tone: "warn" };
  return { text: t.exists ? "未登记" : "未登记(还没有这个配置文件,登记时会新建)", tone: "muted" };
}

export function SkillDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const backdrop = useBackdropClose(onClose);
  const [targets, setTargets] = useState<TargetStatus[] | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [skillOn, setSkillOn] = useState(false);
  const sessions = useDesktopSessions();

  useEffect(() => subscribeSkill((s) => setSkillOn(s.state.active)), []);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ targets: TargetStatus[] }>("/api/skill/desktop-register");
      setTargets(data.targets);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), tone: "err" });
    }
  }, []);

  useEffect(() => {
    if (open) {
      setMsg(null);
      void refresh();
    }
  }, [open, refresh]);

  if (!open) return null;

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ text, tone: "ok" });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), tone: "err" });
    } finally {
      setBusy("");
      void refresh();
    }
  };

  const register = (t: TargetStatus) =>
    run(`reg:${t.target}`, async () => {
      if (!confirm(`把 PromptCut 登记到 ${t.label}:\n\n在 ${t.file} 里写入一条名为 promptcut 的 MCP 服务。\n写之前整份文件先备份,随时可以在这里撤销登记。\n\n继续?`)) return;
      const out = await api<{ backup?: string | null; unchanged?: boolean }>("/api/skill/desktop-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: t.target, action: "register" }),
      });
      if (out.unchanged) return `${t.label} 已经登记过这一份 PromptCut,没有改动。`;
      return `已登记到 ${t.label}。新开一个 ${t.label} 的会话就能用了${out.backup ? `(原文件备份在 ${out.backup})` : ""}。`;
    });

  const unregister = (t: TargetStatus) =>
    run(`unreg:${t.target}`, async () => {
      if (!confirm(`从 ${t.label} 撤销登记:把 ${t.file} 里的 promptcut 条目还原成登记之前的样子。\n\n继续?`)) return;
      const out = await api<{ restored?: boolean; unchanged?: boolean }>("/api/skill/desktop-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: t.target, action: "unregister" }),
      });
      if (out.unchanged) return `${t.label} 里没有 promptcut 条目,不用撤销。`;
      return out.restored ? `已撤销:${t.label} 里的 promptcut 条目还原成了登记之前的那一条。` : `已撤销:${t.label} 里的 promptcut 条目删掉了。`;
    });

  const enter = () =>
    run("enter", async () => {
      await openSkillMode();
      onClose();
    });

  return createPortal(
    <div className="pc-dialog-mask" {...backdrop}>
      <div
        className="pc-dialog pc-skill-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pc-dialog-title-skill"
        data-pc="skill-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div id="pc-dialog-title-skill" className="pc-dialog-title">SKILL</div>

        <div className="pc-skill-intro">
          让桌面 APP 里的 Agent(Claude Code、Codex)经 MCP 直接改<b>你现在打开的这个项目</b>:和编辑界面里的你、
          AI 栏里的 Agent 同时协作,每个会话一个身份,改动都经文档服务落地、可撤销。先登记一次,
          再进入 SKILL 模式;在桌面 APP 里新开会话,跟它说要做什么。它交的进度会显示在 AI 栏里。
        </div>

        <div className="pc-dialog-body">
          <div className="pc-dialog-label">登记到桌面 APP</div>
          <div className="pc-skill-providers">
            {(targets ?? []).map((t) => {
              const st = statusText(t);
              return (
                <div key={t.target} className={`pc-skill-provider${t.current ? " is-on" : ""}`} data-pc={`skill-target-${t.target}`}>
                  <span className="pc-skill-provider-name">{t.label}</span>
                  <span className="pc-skill-provider-desc">{TARGET_DESC[t.target]}</span>
                  <span className={`pc-skill-target-state is-${st.tone}`}>{st.text}</span>
                  <code className="pc-skill-target-file" title={t.file}>{t.file}</code>
                  <span className="pc-skill-target-acts">
                    <button type="button" className="pc-dialog-opt" disabled={busy !== "" || t.current} onClick={() => void register(t)}>
                      {t.registered && !t.current ? "改成这一份" : "登记"}
                    </button>
                    <button type="button" className="pc-dialog-opt" disabled={busy !== "" || !t.registered} onClick={() => void unregister(t)}>
                      撤销登记
                    </button>
                  </span>
                </div>
              );
            })}
            {targets === null && <div className="pc-skill-intro">正在读取登记状态…</div>}
          </div>
        </div>

        <div className="pc-dialog-body">
          <div className="pc-dialog-label">接进来的会话</div>
          {sessions.length ? (
            <div className="pc-skill-sessions">
              {sessions.map((s) => (
                <div key={s.id} className="pc-skill-session" data-pc="skill-session">
                  <b>{s.label || s.vendor || "桌面 APP"}</b>
                  <span>会话 {shortSessionId(s.id)}</span>
                  <span className="pc-skill-session-op">{operationText(s)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="pc-skill-intro">还没有桌面 APP 的会话接进来。登记之后在 Claude Code / Codex 里新开一个会话,让它调一次 PromptCut 的工具。</div>
          )}
        </div>

        {msg && <div className={`pc-skill-msg${msg.tone === "err" ? " is-err" : ""}`}>{msg.text}</div>}

        <div className="pc-skill-actions" style={{ justifyContent: "flex-end" }}>
          {skillOn ? (
            <span className="pc-skill-intro" style={{ marginRight: "auto" }}>当前是 SKILL 模式。退出请点顶栏的「传统式」。</span>
          ) : (
            <button type="button" className="pc-dialog-opt is-on" data-pc="skill-enter" disabled={busy !== ""} onClick={() => void enter()}>
              进入 SKILL 模式
            </button>
          )}
          <button type="button" className="pc-dialog-opt" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

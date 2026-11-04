import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { useBackdropClose } from "../ui/backdropClose";
import { openSkillMode, subscribeSkill } from "../skill/skillMode";
import { shortSessionId, useDesktopSessions } from "../ai/desktopSessions";
import { operationText } from "./right/DesktopSessionsStrip";
import "./SkillDialog.css";
import { tr } from "../i18n/index.ts";

/**
 * SKILL dialog (plan `docs/plan/agent-workflow-plan.md` A4; semantics `user-workflow.md`,
 * sections "Working mode" and "Agent connection type").
 *
 * SKILL = the Agent in the desktop app connects directly, via MCP, to the project the user is
 * working on. This does three things:
 *   1. **Register with Claude Code / Codex**: write PromptCut's MCP service into their user-level
 *      config (the entry name is fixed as `promptcut`, no port is written, a backup is made before
 *      writing, and it can be undone; `server/desktop-register.mjs`). Registering once is enough;
 *      switching projects or restarting PromptCut does not require registering again;
 *   2. **See the connected sessions**: each desktop app session has one identity, labeled with its
 *      vendor and the operation in progress (the AI panel also groups them by session);
 *   3. **Enter SKILL mode**: only after that can desktop app sessions take action; to exit, click
 *      "Classic mode" in the top bar.
 *
 * This used to be "pick a driver → snapshot the project into the task directory → start a headless
 * instance → deep link to open a new chat → come back and three-way merge"; it is archived.
 */

interface TargetStatus {
  target: "claude-code" | "codex";
  label: string;
  file: string;
  exists: boolean;
  registered: boolean;
  /** The registration targets exactly this PromptCut (the command matches the script) */
  current: boolean;
  undoable: boolean;
  registeredAt?: string;
  error: string | null;
}

const TARGET_DESC: Record<TargetStatus["target"], string> = {
  "claude-code": tr("The Claude desktop app's \"Code\" and the command line share this config; once registered, new sessions have PromptCut's tools"),
  codex: tr("The Codex desktop app and the command line share this config; once registered, new threads have PromptCut's tools"),
};

async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || tr("Request failed ({0})", res.status));
  }
  return data as T;
}

function statusText(t: TargetStatus): { text: string; tone: "ok" | "warn" | "muted" | "err" } {
  if (t.error) return { text: t.error, tone: "err" };
  if (t.current) return { text: tr("Registered"), tone: "ok" };
  if (t.registered) return { text: tr("A promptcut entry is already registered but points elsewhere (for example, another install); click \"Register\" to switch it to this one"), tone: "warn" };
  return { text: t.exists ? tr("Not registered") : tr("Not registered (this config file doesn't exist yet; it will be created on registration)"), tone: "muted" };
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
      if (!confirm(tr("Register PromptCut with {0}:\n\nThis writes an MCP server entry named promptcut into {1}.\nThe whole file is backed up first, and you can undo the registration here at any time.\n\nContinue?", t.label, t.file))) return;
      const out = await api<{ backup?: string | null; unchanged?: boolean }>("/api/skill/desktop-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: t.target, action: "register" }),
      });
      if (out.unchanged) return tr("{0} already has this PromptCut registered. No changes made.", t.label);
      return tr("Registered with {0}. Start a new {1} session and it is ready to use{2}.", t.label, t.label, out.backup ? tr("(original file backed up at {0})", out.backup) : "");
    });

  const unregister = (t: TargetStatus) =>
    run(`unreg:${t.target}`, async () => {
      if (!confirm(tr("Unregister from {0}: restores the promptcut entry in {1} to what it was before registration.\n\nContinue?", t.label, t.file))) return;
      const out = await api<{ restored?: boolean; unchanged?: boolean }>("/api/skill/desktop-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: t.target, action: "unregister" }),
      });
      if (out.unchanged) return tr("No promptcut entry in {0}; nothing to unregister.", t.label);
      return out.restored ? tr("Unregistered: the promptcut entry in {0} was restored to the one from before registration.", t.label) : tr("Unregistered: the promptcut entry in {0} was removed.", t.label);
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
          {tr("Let the Agent in the desktop app (Claude Code, Codex) directly edit, via MCP, ")}<b>{tr("the project you currently have open")}</b>{tr(": it works at the same time as you in the editor and the Agent in the AI panel, one identity per session, with every change landing through the document service and undoable. Register once, then enter SKILL mode; start a new session in the desktop app and tell it what to do. The progress it reports is shown in the AI panel.")}
        </div>

        <div className="pc-dialog-body">
          <div className="pc-dialog-label">{tr("Register with the desktop app")}</div>
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
                      {t.registered && !t.current ? tr("Switch to this one") : tr("Register")}
                    </button>
                    <button type="button" className="pc-dialog-opt" disabled={busy !== "" || !t.registered} onClick={() => void unregister(t)}>
                      {tr("Unregister")}
                    </button>
                  </span>
                </div>
              );
            })}
            {targets === null && <div className="pc-skill-intro">{tr("Reading registration status…")}</div>}
          </div>
        </div>

        <div className="pc-dialog-body">
          <div className="pc-dialog-label">{tr("Connected sessions")}</div>
          {sessions.length ? (
            <div className="pc-skill-sessions">
              {sessions.map((s) => (
                <div key={s.id} className="pc-skill-session" data-pc="skill-session">
                  <b>{s.label || s.vendor || tr("Desktop app")}</b>
                  <span>{tr("Session {0}", shortSessionId(s.id))}</span>
                  <span className="pc-skill-session-op">{operationText(s)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="pc-skill-intro">{tr("No desktop app session is connected yet. After registering, start a new session in Claude Code / Codex and have it call a PromptCut tool once.")}</div>
          )}
        </div>

        {msg && <div className={`pc-skill-msg${msg.tone === "err" ? " is-err" : ""}`}>{msg.text}</div>}

        <div className="pc-skill-actions" style={{ justifyContent: "flex-end" }}>
          {skillOn ? (
            <span className="pc-skill-intro" style={{ marginRight: "auto" }}>{tr("SKILL mode is active. To exit, click \"Classic mode\" in the top bar.")}</span>
          ) : (
            <button type="button" className="pc-dialog-opt is-on" data-pc="skill-enter" disabled={busy !== ""} onClick={() => void enter()}>
              {tr("Enter SKILL mode")}
            </button>
          )}
          <button type="button" className="pc-dialog-opt" onClick={onClose}>{tr("Close")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

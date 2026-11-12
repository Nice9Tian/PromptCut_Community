/**
 * Desktop Render Server Data Panel (Issues #7 and #8).
 *
 * Mounted in two contexts:
 *   - `mode="embedded"` inside `NewProjectDialog` ("More" -> "Render server")
 *   - `mode="workspace"` when clicking "Become render server" in `ProjectSettingsDialog`
 *
 * Displays live node readiness, throughput metrics, active bound projects, controls to add an
 * already-joined project or add via invite link, and the recent render task log.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { tr } from "../../i18n/index.ts";
import { useSync } from "./syncManager";
import "./ServerPanels.css";

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export interface RenderPoolProject {
  projectId: string;
  name: string;
  url: string;
  httpBase: string;
  mode: "free" | "restricted" | null;
  source: "current" | "joined" | "invite";
  username: string | null;
  addedAt: number;
  activeBinding: boolean;
  connected: boolean;
  state: string;
  error: string | null;
  stats: {
    claimed: number;
    completed: number;
    dedup: number;
    failed: number;
    lost: number;
  };
}

export interface RenderTaskRecord {
  id: string;
  projectId: string;
  projectName: string;
  kind: string;
  status: "running" | "completed" | "failed";
  frames: number;
  segments: number;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number;
}

export interface RenderServerStatus {
  ok: boolean;
  prerenderReady: boolean;
  projects: RenderPoolProject[];
  records: RenderTaskRecord[];
  throughput: {
    completedTasks: number;
    inFlightTasks: number;
    failedTasks: number;
    dedupTasks: number;
    totalFrames: number;
    totalSegments: number;
    totalRenderMs: number;
    framesPerSec: number;
    segmentsPerMin: number;
    uptimeMs: number;
  };
}

interface KnownJoinedCandidate {
  projectId: string;
  name: string;
  url: string;
  username?: string;
  tag: string;
}

async function fetchRenderServerStatus(): Promise<RenderServerStatus | null> {
  if (ONLINE_BUILD) return null;
  try {
    const r = await fetch("/api/render-server/status", { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as RenderServerStatus;
    return j?.ok ? j : null;
  } catch {
    return null;
  }
}

async function postRenderServerAdd(payload: Record<string, unknown>): Promise<{
  ok: boolean;
  code?: string;
  error?: string;
  project?: { projectId?: string; name?: string; mode?: string };
}> {
  if (ONLINE_BUILD) return { ok: false, error: "Unsupported in online build" };
  try {
    const r = await fetch("/api/render-server/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = (await r.json()) as {
      ok?: boolean;
      code?: string;
      error?: string;
      project?: { projectId?: string; name?: string; mode?: string };
    };
    return { ok: Boolean(r.ok && j?.ok), code: j?.code, error: j?.error, project: j?.project };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function postRenderServerRemove(projectId: string): Promise<boolean> {
  if (ONLINE_BUILD) return false;
  try {
    const r = await fetch("/api/render-server/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function fetchLocalDiscoverCandidates(): Promise<KnownJoinedCandidate[]> {
  if (ONLINE_BUILD) return [];
  try {
    const r = await fetch("/api/lan/discover?timeoutMs=600", { cache: "no-store" });
    if (!r.ok) return [];
    const j = (await r.json()) as {
      localProjects?: Array<{ projectId: string; name: string; base: string }>;
      hosts?: Array<{ address: string; port: number; hostDeviceName?: string; projects?: Array<{ projectId: string; name: string }> }>;
    };
    const out: KnownJoinedCandidate[] = [];
    for (const lp of j.localProjects ?? []) {
      if (lp.projectId && lp.base) {
        out.push({ projectId: lp.projectId, name: lp.name || lp.projectId, url: lp.base, tag: tr("This machine") });
      }
    }
    for (const h of j.hosts ?? []) {
      const base = `http://${h.address}:${h.port}/docservice`;
      for (const p of h.projects ?? []) {
        if (p.projectId) {
          out.push({
            projectId: p.projectId,
            name: p.name || p.projectId,
            url: base,
            tag: h.hostDeviceName || `${h.address}:${h.port}`,
          });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function readStoredJoinedCandidates(): KnownJoinedCandidate[] {
  const out: KnownJoinedCandidate[] = [];
  if (typeof window === "undefined") return out;
  try {
    const resumeRaw = sessionStorage.getItem("pc.shared.resume");
    if (resumeRaw) {
      const parsed = JSON.parse(resumeRaw) as {
        candidate?: { projectId?: string; name?: string; base?: string };
        cred?: { username?: string };
      };
      if (parsed?.candidate?.projectId && parsed?.candidate?.base) {
        out.push({
          projectId: parsed.candidate.projectId,
          name: parsed.candidate.name || parsed.candidate.projectId,
          url: parsed.candidate.base,
          username: parsed.cred?.username,
          tag: tr("Recent session"),
        });
      }
    }
  } catch { /* ignore */ }
  try {
    const localRaw = localStorage.getItem("pc.shared.local");
    if (localRaw) {
      const dict = JSON.parse(localRaw) as Record<string, { projectId?: string; name?: string; where?: string; creatorUsername?: string }>;
      for (const item of Object.values(dict ?? {})) {
        if (item?.projectId) {
          const fallbackBase = item.where === "lan" ? `${location.origin}/docservice` : "";
          if (fallbackBase) {
            out.push({
              projectId: item.projectId,
              name: item.name || item.projectId,
              url: fallbackBase,
              username: item.creatorUsername,
              tag: tr("Saved room"),
            });
          }
        }
      }
    }
  } catch { /* ignore */ }
  return out;
}

function formatClock(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function RenderServerPanel(props: {
  mode: "workspace" | "embedded";
  onBack: () => void;
}): JSX.Element {
  const shared = useSync((v) => v.shared);
  const [status, setStatus] = useState<RenderServerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [discovered, setDiscovered] = useState<KnownJoinedCandidate[]>([]);
  const [addTab, setAddTab] = useState<"joined" | "invite">("joined");
  const [showManualJoined, setShowManualJoined] = useState(false);

  // Manual joined-project fields
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualUrl, setManualUrl] = useState(() =>
    typeof location !== "undefined" ? `${location.origin}/docservice` : "http://127.0.0.1:5190/docservice",
  );
  const [manualUser, setManualUser] = useState("");
  const [manualPw, setManualPw] = useState("");

  // Invite-link fields
  const [inviteLink, setInviteLink] = useState("");
  const [inviteUser, setInviteUser] = useState("");
  const [invitePw, setInvitePw] = useState("");
  const [needInviteCreds, setNeedInviteCreds] = useState(false);

  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; err?: boolean } | null>(null);

  const refresh = useCallback(async () => {
    const [nextStatus, lanCandidates] = await Promise.all([
      fetchRenderServerStatus(),
      fetchLocalDiscoverCandidates(),
    ]);
    if (nextStatus) setStatus(nextStatus);
    setDiscovered(lanCandidates);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void fetchRenderServerStatus().then((s) => {
        if (s) setStatus(s);
      });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const knownCandidates = useMemo(() => {
    const map = new Map<string, KnownJoinedCandidate>();
    if (shared?.projectId && shared?.base) {
      map.set(shared.projectId, {
        projectId: shared.projectId,
        name: shared.name || shared.projectId,
        url: shared.base,
        username: shared.username,
        tag: tr("Current project"),
      });
    }
    for (const c of readStoredJoinedCandidates()) {
      if (!map.has(c.projectId)) map.set(c.projectId, c);
    }
    for (const c of discovered) {
      if (!map.has(c.projectId)) map.set(c.projectId, c);
    }
    const boundIds = new Set((status?.projects ?? []).map((p) => p.projectId));
    return [...map.values()].filter((c) => !boundIds.has(c.projectId));
  }, [shared, discovered, status?.projects]);

  const handleAddKnown = async (c: KnownJoinedCandidate) => {
    setBusy(true);
    setFeedback(null);
    const res = await postRenderServerAdd({
      kind: "joined",
      projectId: c.projectId,
      name: c.name,
      url: c.url,
      username: c.username,
    });
    setBusy(false);
    if (!res.ok) {
      setFeedback({ text: res.error || tr("Could not add project to render server."), err: true });
      return;
    }
    setFeedback({ text: tr("Added \"{0}\" to render server.", c.name) });
    await refresh();
  };

  const handleAddManualJoined = async () => {
    if (!manualId.trim() || !manualUrl.trim()) {
      setFeedback({ text: tr("Enter both Project ID and service URL."), err: true });
      return;
    }
    setBusy(true);
    setFeedback(null);
    const res = await postRenderServerAdd({
      kind: "joined",
      projectId: manualId.trim(),
      name: manualName.trim() || manualId.trim(),
      url: manualUrl.trim(),
      username: manualUser.trim() || undefined,
      password: manualPw || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setFeedback({ text: res.error || tr("Could not add project to render server."), err: true });
      return;
    }
    setFeedback({ text: tr("Added \"{0}\" to render server.", manualName.trim() || manualId.trim()) });
    setManualId("");
    setManualName("");
    setManualPw("");
    await refresh();
  };

  const handleAddInvite = async () => {
    if (!inviteLink.trim()) {
      setFeedback({ text: tr("Paste a project invite link first."), err: true });
      return;
    }
    setBusy(true);
    setFeedback(null);
    const res = await postRenderServerAdd({
      kind: "invite",
      inviteLink: inviteLink.trim(),
      username: inviteUser.trim() || undefined,
      password: invitePw || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      if (res.code === "password-required") {
        setNeedInviteCreds(true);
        setFeedback({
          text: tr("Project \"{0}\" uses a member list. Enter a member username and password below.", res.project?.name || ""),
          err: true,
        });
        return;
      }
      if (res.code === "bad-invite-link" || res.code === "legacy-invite-link") {
        setFeedback({ text: tr("This is not a valid invite link."), err: true });
        return;
      }
      setFeedback({ text: res.error || tr("Could not join project via invite link."), err: true });
      return;
    }
    setFeedback({ text: tr("Bound invite project \"{0}\" to render server.", res.project?.name || "") });
    setInviteLink("");
    setInvitePw("");
    setNeedInviteCreds(false);
    await refresh();
  };

  const handleRemove = async (projectId: string) => {
    setBusy(true);
    setFeedback(null);
    await postRenderServerRemove(projectId);
    setBusy(false);
    await refresh();
  };

  const tp = status?.throughput;
  const projects = status?.projects ?? [];
  const records = status?.records ?? [];

  const sourceLabel = (s: RenderPoolProject["source"]) =>
    s === "current" ? tr("Open project") : s === "invite" ? tr("Invite link") : tr("Joined project");

  const stateLabel = (p: RenderPoolProject) =>
    p.connected ? tr("Connected") : p.state === "bound" ? tr("Bound") : p.state === "connecting" ? tr("Connecting…") : tr("Standby");

  const kindLabel = (k: string) =>
    k === "see_frames" || k === "snapshot"
      ? tr("Snapshot frames")
      : k === "preload" || k === "prerender"
        ? tr("Segment prerender")
        : k === "stream"
          ? tr("Stream segment")
          : k;

  const recordStatusLabel = (s: RenderTaskRecord["status"]) =>
    s === "completed" ? tr("Completed") : s === "running" ? tr("Running") : tr("Failed");

  const body = (
    <>
      <div className="pc-srv-topbar">
        <div className="pc-srv-head-main">
          <div className="pc-srv-title-row">
            <h2 className="pc-srv-title">{tr("Render server")}</h2>
            <span className={`pc-srv-badge ${status?.prerenderReady ? "is-ok" : "is-warn"}`} data-pc="rs-ready-badge">
              {loading ? tr("Loading…") : status?.prerenderReady ? tr("Prerender ready") : tr("Worker starting")}
            </span>
          </div>
          <div className="pc-srv-sub">
            {tr("Executes background prerender and snapshot tasks for bound projects and reports live throughput.")}
          </div>
        </div>
        <div className="pc-srv-actions">
          <button type="button" className="pc-btn" data-pc="rs-refresh-btn" disabled={busy} onClick={() => void refresh()}>
            {tr("Refresh")}
          </button>
          <button type="button" className="pc-btn pc-btn--primary" data-pc="rs-back-btn" onClick={props.onBack}>
            {props.mode === "workspace" ? tr("Return to editor") : tr("Back")}
          </button>
        </div>
      </div>

      <div className={props.mode === "workspace" ? "pc-srv-scroll" : undefined}>
        <div className="pc-srv-container">
          <div className="pc-srv-metrics" data-pc="rs-metrics">
            <div className="pc-srv-metric-card">
              <span className="pc-srv-metric-label">{tr("Completed tasks")}</span>
              <span className="pc-srv-metric-val" data-pc="rs-metric-completed">{tp?.completedTasks ?? 0}</span>
              <span className="pc-srv-metric-sub">
                {tr("Dedup {0} · Failed {1}", tp?.dedupTasks ?? 0, tp?.failedTasks ?? 0)}
              </span>
            </div>
            <div className="pc-srv-metric-card">
              <span className="pc-srv-metric-label">{tr("In-flight tasks")}</span>
              <span className="pc-srv-metric-val" data-pc="rs-metric-inflight">{tp?.inFlightTasks ?? 0}</span>
              <span className="pc-srv-metric-sub">{tr("{0} bound projects", projects.length)}</span>
            </div>
            <div className="pc-srv-metric-card">
              <span className="pc-srv-metric-label">{tr("Frames rendered")}</span>
              <span className="pc-srv-metric-val" data-pc="rs-metric-frames">{tp?.totalFrames ?? 0}</span>
              <span className="pc-srv-metric-sub">{tr("{0} segments", tp?.totalSegments ?? 0)}</span>
            </div>
            <div className="pc-srv-metric-card">
              <span className="pc-srv-metric-label">{tr("Throughput")}</span>
              <span className="pc-srv-metric-val" data-pc="rs-metric-fps">{tp ? `${tp.framesPerSec} fps` : "0 fps"}</span>
              <span className="pc-srv-metric-sub">{tr("{0} segments/min", tp?.segmentsPerMin ?? 0)}</span>
            </div>
          </div>

          <section className="pc-srv-card" data-pc="rs-projects-section">
            <div className="pc-srv-card-head">
              <h3 className="pc-srv-card-title">{tr("Bound projects")}</h3>
              <div className="pc-srv-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={addTab === "joined"}
                  className={`pc-srv-tab${addTab === "joined" ? " is-on" : ""}`}
                  data-pc="rs-add-joined-tab"
                  onClick={() => { setAddTab("joined"); setFeedback(null); }}
                >
                  {tr("Add joined project")}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={addTab === "invite"}
                  className={`pc-srv-tab${addTab === "invite" ? " is-on" : ""}`}
                  data-pc="rs-add-invite-tab"
                  onClick={() => { setAddTab("invite"); setFeedback(null); }}
                >
                  {tr("Add invite link")}
                </button>
              </div>
            </div>

            {feedback && (
              <div className={`pc-srv-msg${feedback.err ? " is-err" : " is-ok"}`} data-pc="rs-feedback" role={feedback.err ? "alert" : "status"}>
                {feedback.text}
              </div>
            )}

            {addTab === "joined" ? (
              <div className="pc-srv-list" data-pc="rs-joined-pane">
                {knownCandidates.length > 0 ? (
                  knownCandidates.map((c) => (
                    <div key={c.projectId} className="pc-srv-item" data-pc="rs-known-candidate">
                      <div className="pc-srv-item-main">
                        <div className="pc-srv-item-title">
                          <span>{c.name}</span>
                          <span className="pc-srv-badge">{c.tag}</span>
                        </div>
                        <div className="pc-srv-item-sub">{c.url}</div>
                      </div>
                      <button
                        type="button"
                        className="pc-btn pc-btn--primary"
                        data-pc="rs-add-known-btn"
                        disabled={busy}
                        onClick={() => void handleAddKnown(c)}
                      >
                        {tr("Add")}
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="pc-sync-hint">
                    {tr("No unbound local or recently joined projects found automatically. You can enter a joined project's connection details below or switch to \"Add invite link\".")}
                  </div>
                )}

                <div>
                  <button
                    type="button"
                    className="pc-sync-link-btn"
                    data-pc="rs-toggle-manual-joined"
                    onClick={() => setShowManualJoined((v) => !v)}
                  >
                    {showManualJoined ? tr("Hide manual project entry") : tr("Enter joined project details manually")}
                  </button>
                </div>

                {showManualJoined && (
                  <div className="pc-srv-form-row" data-pc="rs-manual-joined-form">
                    <div className="pc-srv-field">
                      <label htmlFor="rs-manual-id">{tr("Project ID")}</label>
                      <input
                        id="rs-manual-id"
                        className="pc-dialog-input"
                        data-pc="rs-manual-id"
                        value={manualId}
                        placeholder="proj-..."
                        onChange={(e) => setManualId(e.target.value)}
                      />
                    </div>
                    <div className="pc-srv-field">
                      <label htmlFor="rs-manual-name">{tr("Project name")}</label>
                      <input
                        id="rs-manual-name"
                        className="pc-dialog-input"
                        data-pc="rs-manual-name"
                        value={manualName}
                        placeholder={tr("Untitled")}
                        onChange={(e) => setManualName(e.target.value)}
                      />
                    </div>
                    <div className="pc-srv-field" style={{ flex: "2 1 220px" }}>
                      <label htmlFor="rs-manual-url">{tr("Service URL")}</label>
                      <input
                        id="rs-manual-url"
                        className="pc-dialog-input"
                        data-pc="rs-manual-url"
                        value={manualUrl}
                        onChange={(e) => setManualUrl(e.target.value)}
                      />
                    </div>
                    <div className="pc-srv-field">
                      <label htmlFor="rs-manual-user">{tr("Username (optional)")}</label>
                      <input
                        id="rs-manual-user"
                        className="pc-dialog-input"
                        value={manualUser}
                        onChange={(e) => setManualUser(e.target.value)}
                      />
                    </div>
                    <div className="pc-srv-field">
                      <label htmlFor="rs-manual-pw">{tr("Password (optional)")}</label>
                      <input
                        id="rs-manual-pw"
                        type="password"
                        className="pc-dialog-input"
                        value={manualPw}
                        onChange={(e) => setManualPw(e.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      className="pc-btn pc-btn--primary"
                      data-pc="rs-joined-submit"
                      disabled={busy}
                      onClick={() => void handleAddManualJoined()}
                    >
                      {tr("Add")}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="pc-srv-list" data-pc="rs-invite-pane">
                <div className="pc-srv-form-row">
                  <div className="pc-srv-field" style={{ flex: "3 1 280px" }}>
                    <label htmlFor="rs-invite-url">{tr("Invite link")}</label>
                    <input
                      id="rs-invite-url"
                      className="pc-dialog-input"
                      data-pc="rs-invite-input"
                      value={inviteLink}
                      placeholder="http://.../#invite=...&doc=..."
                      onChange={(e) => setInviteLink(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void handleAddInvite(); }}
                    />
                  </div>
                  <button
                    type="button"
                    className="pc-btn pc-btn--primary"
                    data-pc="rs-invite-submit"
                    disabled={busy || !inviteLink.trim()}
                    onClick={() => void handleAddInvite()}
                  >
                    {tr("Add by invite link")}
                  </button>
                </div>
                <div className="pc-srv-form-row">
                  <div className="pc-srv-field">
                    <label htmlFor="rs-invite-user">
                      {needInviteCreds ? tr("Member username") : tr("Username (optional)")}
                    </label>
                    <input
                      id="rs-invite-user"
                      className="pc-dialog-input"
                      data-pc="rs-invite-username"
                      value={inviteUser}
                      placeholder={tr("Render node username")}
                      onChange={(e) => setInviteUser(e.target.value)}
                    />
                  </div>
                  <div className="pc-srv-field">
                    <label htmlFor="rs-invite-pw">
                      {needInviteCreds ? tr("Member password") : tr("Password (for restricted projects)")}
                    </label>
                    <input
                      id="rs-invite-pw"
                      type="password"
                      className="pc-dialog-input"
                      data-pc="rs-invite-password"
                      value={invitePw}
                      placeholder={tr("Leave blank for open projects")}
                      onChange={(e) => setInvitePw(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            )}

            {projects.length > 0 ? (
              <div className="pc-srv-list" data-pc="rs-bound-list">
                {projects.map((p) => (
                  <div key={p.projectId} className="pc-srv-item" data-pc="rs-bound-project" data-project-id={p.projectId}>
                    <div className="pc-srv-item-main">
                      <div className="pc-srv-item-title">
                        <span>{p.name}</span>
                        <span className={`pc-srv-badge ${p.connected || p.activeBinding ? "is-ok" : ""}`}>
                          {stateLabel(p)}
                        </span>
                        <span className="pc-srv-badge">{sourceLabel(p.source)}</span>
                      </div>
                      <div className="pc-srv-item-sub">
                        {p.projectId} · {p.httpBase} · {tr("Completed {0} / Claimed {1}", p.stats.completed, p.stats.claimed)}
                        {p.error ? ` · ${p.error}` : ""}
                      </div>
                    </div>
                    {p.source !== "current" && (
                      <button
                        type="button"
                        className="pc-btn"
                        data-pc="rs-remove-project"
                        disabled={busy}
                        onClick={() => void handleRemove(p.projectId)}
                      >
                        {tr("Remove")}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="pc-srv-empty" data-pc="rs-empty-projects">
                {tr("No projects bound yet. Add an already-joined project or paste an invite link above.")}
              </div>
            )}
          </section>

          <section className="pc-srv-card" data-pc="rs-records-section">
            <div className="pc-srv-card-head">
              <h3 className="pc-srv-card-title">{tr("Render records")}</h3>
              <span className="pc-sync-hint">{tr("{0} recent tasks", records.length)}</span>
            </div>
            {records.length > 0 ? (
              <div className="pc-srv-table-wrap">
                <table className="pc-srv-table" data-pc="rs-records-table">
                  <thead>
                    <tr>
                      <th>{tr("Time")}</th>
                      <th>{tr("Project")}</th>
                      <th>{tr("Task type")}</th>
                      <th>{tr("Output")}</th>
                      <th>{tr("Duration")}</th>
                      <th>{tr("Status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r) => (
                      <tr key={r.id} data-pc="rs-record-row">
                        <td>{formatClock(r.finishedAt ?? r.startedAt)}</td>
                        <td>{r.projectName}</td>
                        <td>{kindLabel(r.kind)}</td>
                        <td>{tr("{0} frames · {1} segs", r.frames, r.segments)}</td>
                        <td>{formatDurationMs(r.durationMs)}</td>
                        <td>
                          <span className={`pc-srv-badge ${r.status === "completed" ? "is-ok" : r.status === "failed" ? "is-warn" : ""}`}>
                            {recordStatusLabel(r.status)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="pc-srv-empty" data-pc="rs-empty-records">
                {tr("No render records yet. Tasks executed by this machine will appear here automatically.")}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );

  if (props.mode === "embedded") {
    return (
      <div className="pc-srv-embedded" data-pc="render-server-panel" data-mode="embedded">
        {body}
      </div>
    );
  }
  return (
    <div className="pc-srv-workspace" data-pc="render-server-panel" data-mode="workspace">
      {body}
    </div>
  );
}

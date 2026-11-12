/**
 * Desktop Data Server Panel: Member Accounts & Project Document Modification History (Issue #8).
 *
 * Displayed when the project creator promotes this desktop machine to be the active Data Server
 * (either directly on a local project or after completing the mutual 6-digit pairing handover).
 * Includes the prominent "Join own project in editor" action so the Data Server machine can edit
 * its own hosted project directly in the full Editor while keeping the local document service live.
 */
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useStore } from "../../store/project";
import { tr } from "../../i18n/index.ts";
import { createInvite, generatePassword, localCollab } from "./collab";
import { useSync } from "./syncManager";
import "./ServerPanels.css";

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

interface AllowlistMember {
  username: string;
  access: "r" | "rw";
}

interface BannedDevice {
  deviceId: string;
  username: string | null;
  displayName: string | null;
  at: number | null;
}

interface CommitRecord {
  rev: number;
  opId: string;
  at: number;
  actor: {
    userId: string;
    username: string;
    deviceId: string | null;
    displayName: string | null;
    creator: boolean;
    role: string;
  };
  entities: string[];
  opCount: number;
  summary: string[];
}

interface DataServerStatusResponse {
  ok: boolean;
  localDeviceId: string | null;
  localDeviceName: string | null;
  lanHost: boolean;
  port: number | null;
  base: string | null;
  isLocalHost: boolean;
  project: {
    projectId: string;
    name: string;
    mode: "free" | "restricted";
    createdAt: number | null;
    creatorUsername: string | null;
    allowlist: AllowlistMember[];
    bans: BannedDevice[];
  } | null;
  history: {
    latestRev: number;
    records: CommitRecord[];
  };
}

async function fetchDataServerStatus(projectId: string, contentId: string): Promise<DataServerStatusResponse | null> {
  if (ONLINE_BUILD) return null;
  try {
    const qs = new URLSearchParams();
    if (projectId) qs.set("projectId", projectId);
    if (contentId) qs.set("contentId", contentId);
    const r = await fetch(`/api/data-server/status?${qs.toString()}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as DataServerStatusResponse;
    return j?.ok ? j : null;
  } catch {
    return null;
  }
}

async function postMemberMutation(payload: Record<string, unknown>): Promise<{
  ok: boolean;
  status?: DataServerStatusResponse;
  error?: string;
}> {
  if (ONLINE_BUILD) return { ok: false, error: "Unsupported in online build" };
  try {
    const r = await fetch("/api/data-server/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = (await r.json()) as DataServerStatusResponse & { error?: string };
    if (!r.ok || !j?.ok) {
      return { ok: false, error: j?.error || `HTTP ${r.status}` };
    }
    return { ok: true, status: j };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function formatCommitTime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function DataServerPanel(props: {
  onOpenEditor: () => void;
}): JSX.Element {
  const shared = useSync((v) => v.shared);
  const onlineMembers = useSync((v) => v.members);
  const syncRev = useSync((v) => v.rev);
  const contentId = useStore((s) => s.project.id ?? "");
  const storeName = useStore((s) => s.project.name);

  const projectId = shared?.projectId ?? "";
  const [data, setData] = useState<DataServerStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; err?: boolean } | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newAccess, setNewAccess] = useState<"rw" | "r">("rw");
  const [openModePw, setOpenModePw] = useState("");
  const [showOpenModeForm, setShowOpenModeForm] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetchDataServerStatus(projectId, contentId);
    if (res) setData(res);
    setLoading(false);
  }, [projectId, contentId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const savedSecrets = projectId ? localCollab(projectId) : null;
  const inviteLink = savedSecrets?.invite?.link ?? "";
  const projInfo = data?.project;
  const displayName = projInfo?.name || shared?.name || storeName || tr("Untitled");
  const latestRev = Math.max(syncRev ?? 0, data?.history?.latestRev ?? 0);
  const records = data?.history?.records ?? [];
  const allowlist = projInfo?.allowlist ?? [];
  const bans = projInfo?.bans ?? [];

  const handleAddMember = async () => {
    if (!projectId) return;
    if (!newUsername.trim()) {
      setFeedback({ text: tr("Enter a member username."), err: true });
      return;
    }
    const pw = newPassword || generatePassword(12);
    setBusy(true);
    setFeedback(null);
    const res = await postMemberMutation({
      projectId,
      action: "add-member",
      username: newUsername.trim(),
      password: pw,
      access: newAccess,
    });
    setBusy(false);
    if (!res.ok) {
      setFeedback({ text: res.error || tr("Could not save member account."), err: true });
      return;
    }
    if (res.status) setData(res.status);
    setFeedback({
      text: newPassword
        ? tr("Saved member account \"{0}\".", newUsername.trim())
        : tr("Added member \"{0}\" with generated password: {1}", newUsername.trim(), pw),
    });
    setNewUsername("");
    setNewPassword("");
  };

  const handleRemoveMember = async (username: string) => {
    if (!projectId) return;
    setBusy(true);
    setFeedback(null);
    const res = await postMemberMutation({
      projectId,
      action: "remove-member",
      username,
    });
    setBusy(false);
    if (!res.ok) {
      setFeedback({ text: res.error || tr("Could not remove member account."), err: true });
      return;
    }
    if (res.status) setData(res.status);
    setFeedback({ text: tr("Removed member account \"{0}\".", username) });
  };

  const handleSwitchMode = async (targetMode: "restricted" | "free") => {
    if (!projectId) return;
    if (targetMode === "free" && !openModePw.trim()) {
      setShowOpenModeForm(true);
      return;
    }
    setBusy(true);
    setFeedback(null);
    const res = await postMemberMutation({
      projectId,
      action: "set-mode",
      mode: targetMode,
      projectPassword: openModePw.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setFeedback({ text: res.error || tr("Could not switch entry mode."), err: true });
      return;
    }
    if (res.status) setData(res.status);
    setShowOpenModeForm(false);
    setOpenModePw("");
    setFeedback({
      text: targetMode === "restricted"
        ? tr("Switched room to member account allowlist mode.")
        : tr("Switched room to shared project password mode."),
    });
  };

  const handleUnban = async (deviceId: string) => {
    if (!projectId) return;
    setBusy(true);
    setFeedback(null);
    const res = await postMemberMutation({
      projectId,
      action: "unban",
      deviceId,
    });
    setBusy(false);
    if (res.ok && res.status) setData(res.status);
  };

  const handleCopyInvite = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const handleRefreshInvite = async () => {
    const pw = savedSecrets?.creatorPassword;
    if (!pw) {
      setFeedback({ text: tr("Creator password is not cached in this session; manage invite links in Project settings."), err: true });
      return;
    }
    setBusy(true);
    const res = await createInvite(pw);
    setBusy(false);
    if (!res.ok) {
      setFeedback({ text: tr("Could not regenerate invite link."), err: true });
      return;
    }
    setFeedback({ text: tr("Generated a fresh invite link.") });
    await refresh();
  };

  return (
    <div className="pc-srv-workspace" data-pc="data-server-panel">
      <div className="pc-srv-topbar">
        <div className="pc-srv-head-main">
          <div className="pc-srv-title-row">
            <h2 className="pc-srv-title">{tr("Data server (member accounts & project document)")}</h2>
            <span className="pc-srv-badge is-ok" data-pc="ds-host-badge">
              {loading ? tr("Loading…") : data?.isLocalHost ? tr("Hosting on this machine") : tr("Connected")}
            </span>
            <span className="pc-srv-badge" data-pc="ds-rev-badge">{`r${latestRev}`}</span>
          </div>
          <div className="pc-srv-sub">
            {tr("Project \"{0}\" · Host: {1} · {2}", displayName, data?.localDeviceName || tr("This machine"), data?.lanHost ? tr("LAN broadcast active") : tr("Local document service active"))}
          </div>
        </div>
        <div className="pc-srv-actions">
          <button type="button" className="pc-btn" data-pc="ds-refresh-btn" disabled={busy} onClick={() => void refresh()}>
            {tr("Refresh")}
          </button>
          <button
            type="button"
            className="pc-btn pc-btn--primary"
            data-pc="data-server-open-editor"
            onClick={props.onOpenEditor}
          >
            {tr("Join own project in editor")}
          </button>
        </div>
      </div>

      <div className="pc-srv-scroll">
        <div className="pc-srv-container">
          {feedback && (
            <div className={`pc-srv-msg${feedback.err ? " is-err" : " is-ok"}`} data-pc="ds-feedback" role={feedback.err ? "alert" : "status"}>
              {feedback.text}
            </div>
          )}

          <div className="pc-srv-split">
            <section className="pc-srv-card" data-pc="ds-accounts-section">
              <div className="pc-srv-card-head">
                <h3 className="pc-srv-card-title">{tr("Member accounts")}</h3>
                <div className="pc-srv-tabs">
                  <button
                    type="button"
                    className={`pc-srv-tab${(projInfo?.mode ?? "restricted") === "restricted" ? " is-on" : ""}`}
                    data-pc="ds-mode-restricted"
                    disabled={busy}
                    onClick={() => void handleSwitchMode("restricted")}
                  >
                    {tr("Account list")}
                  </button>
                  <button
                    type="button"
                    className={`pc-srv-tab${projInfo?.mode === "free" ? " is-on" : ""}`}
                    data-pc="ds-mode-free"
                    disabled={busy}
                    onClick={() => void handleSwitchMode("free")}
                  >
                    {tr("Open password")}
                  </button>
                </div>
              </div>

              {showOpenModeForm && (
                <div className="pc-srv-form-row" data-pc="ds-open-mode-form">
                  <div className="pc-srv-field">
                    <label htmlFor="ds-open-pw">{tr("Shared project password")}</label>
                    <input
                      id="ds-open-pw"
                      type="password"
                      className="pc-dialog-input"
                      value={openModePw}
                      placeholder={tr("Set password for open entry")}
                      onChange={(e) => setOpenModePw(e.target.value)}
                    />
                  </div>
                  <button type="button" className="pc-btn pc-btn--primary" disabled={busy || !openModePw.trim()} onClick={() => void handleSwitchMode("free")}>
                    {tr("Apply")}
                  </button>
                  <button type="button" className="pc-btn" onClick={() => setShowOpenModeForm(false)}>
                    {tr("Cancel")}
                  </button>
                </div>
              )}

              <div className="pc-srv-item" data-pc="ds-creator-account">
                <div className="pc-srv-item-main">
                  <div className="pc-srv-item-title">
                    <span>{projInfo?.creatorUsername || shared?.username || tr("Creator")}</span>
                    <span className="pc-srv-badge is-ok">{tr("Creator")}</span>
                  </div>
                  <div className="pc-srv-item-sub">
                    {tr("Project owner · Full document & server administration")}
                  </div>
                </div>
              </div>

              {inviteLink ? (
                <div className="pc-srv-form-row" data-pc="ds-invite-row">
                  <div className="pc-srv-field" style={{ flex: "2 1 200px" }}>
                    <label htmlFor="ds-invite-link">{tr("Invite link")}</label>
                    <input id="ds-invite-link" className="pc-dialog-input" readOnly value={inviteLink} />
                  </div>
                  <button type="button" className="pc-btn" data-pc="ds-copy-invite" onClick={() => void handleCopyInvite()}>
                    {inviteCopied ? tr("Copied") : tr("Copy")}
                  </button>
                  {savedSecrets?.creatorPassword ? (
                    <button type="button" className="pc-btn" data-pc="ds-refresh-invite" disabled={busy} onClick={() => void handleRefreshInvite()}>
                      {tr("Regenerate")}
                    </button>
                  ) : null}
                </div>
              ) : savedSecrets?.creatorPassword ? (
                <div>
                  <button type="button" className="pc-btn" data-pc="ds-refresh-invite" disabled={busy} onClick={() => void handleRefreshInvite()}>
                    {tr("Generate invite link")}
                  </button>
                </div>
              ) : null}

              <div className="pc-srv-form-row" data-pc="ds-add-member-form">
                <div className="pc-srv-field">
                  <label htmlFor="ds-mem-user">{tr("Member username")}</label>
                  <input
                    id="ds-mem-user"
                    className="pc-dialog-input"
                    data-pc="ds-member-username"
                    autoComplete="off"
                    value={newUsername}
                    placeholder={tr("e.g. editor_alice")}
                    maxLength={64}
                    onChange={(e) => setNewUsername(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !busy && projectId) {
                        e.preventDefault();
                        void handleAddMember();
                      }
                    }}
                  />
                </div>
                <div className="pc-srv-field">
                  <label htmlFor="ds-mem-pw">{tr("Password")}</label>
                  <input
                    id="ds-mem-pw"
                    type="password"
                    className="pc-dialog-input"
                    data-pc="ds-member-password"
                    autoComplete="new-password"
                    value={newPassword}
                    placeholder={tr("Auto-generate if empty")}
                    onChange={(e) => setNewPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !busy && projectId) {
                        e.preventDefault();
                        void handleAddMember();
                      }
                    }}
                  />
                </div>
                <div className="pc-srv-field" style={{ flex: "0 0 120px" }}>
                  <label htmlFor="ds-mem-access">{tr("Permission")}</label>
                  <select
                    id="ds-mem-access"
                    className="pc-dialog-select"
                    data-pc="ds-member-access"
                    value={newAccess}
                    onChange={(e) => setNewAccess(e.target.value === "r" ? "r" : "rw")}
                  >
                    <option value="rw">{tr("Can edit")}</option>
                    <option value="r">{tr("Read-only")}</option>
                  </select>
                </div>
                <button
                  type="button"
                  className="pc-btn pc-btn--primary"
                  data-pc="ds-add-member-btn"
                  disabled={busy || !projectId}
                  onClick={() => void handleAddMember()}
                >
                  {tr("Add member")}
                </button>
              </div>

              <div className="pc-srv-list" data-pc="ds-allowlist">
                {allowlist.length > 0 ? (
                  allowlist.map((m) => (
                    <div key={m.username} className="pc-srv-item" data-pc="ds-member-row" data-username={m.username}>
                      <div className="pc-srv-item-main">
                        <div className="pc-srv-item-title">
                          <span>{m.username}</span>
                          <span className="pc-srv-badge">
                            {m.access === "r" ? tr("Read-only") : tr("Can edit")}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="pc-btn"
                        data-pc="ds-remove-member"
                        disabled={busy}
                        onClick={() => void handleRemoveMember(m.username)}
                      >
                        {tr("Remove")}
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="pc-srv-empty" data-pc="ds-empty-members">
                    {tr("No member accounts added yet. Add accounts above to grant team members edit or read-only access.")}
                  </div>
                )}
              </div>

              {onlineMembers.length > 0 && (
                <div className="pc-srv-list" data-pc="ds-online-members">
                  <div className="pc-sync-group-title">{tr("Currently connected ({0})", onlineMembers.length)}</div>
                  {onlineMembers.map((m) => (
                    <div key={`${m.deviceId}:${m.username}`} className="pc-srv-item">
                      <div className="pc-srv-item-main">
                        <div className="pc-srv-item-title">
                          <span>{m.displayName || m.username}</span>
                          <span className="pc-srv-badge is-ok">{tr("Online")}</span>
                          {m.creator && <span className="pc-srv-badge">{tr("Creator")}</span>}
                        </div>
                        <div className="pc-srv-item-sub">{m.deviceName || m.deviceId}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {bans.length > 0 && (
                <div className="pc-srv-list" data-pc="ds-banned-list">
                  <div className="pc-sync-group-title">{tr("Blocked devices ({0})", bans.length)}</div>
                  {bans.map((b) => (
                    <div key={b.deviceId} className="pc-srv-item">
                      <div className="pc-srv-item-main">
                        <div className="pc-srv-item-title">
                          <span>{b.displayName || b.username || b.deviceId}</span>
                        </div>
                        <div className="pc-srv-item-sub">{b.deviceId}</div>
                      </div>
                      <button type="button" className="pc-btn" data-pc="ds-unban-btn" disabled={busy} onClick={() => void handleUnban(b.deviceId)}>
                        {tr("Unblock")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="pc-srv-card" data-pc="ds-history-section">
              <div className="pc-srv-card-head">
                <h3 className="pc-srv-card-title">{tr("Document modification history")}</h3>
                <span className="pc-sync-hint">{tr("Latest revision r{0} · {1} commits", latestRev, records.length)}</span>
              </div>

              {records.length > 0 ? (
                <div className="pc-srv-table-wrap">
                  <table className="pc-srv-table" data-pc="ds-history-table">
                    <thead>
                      <tr>
                        <th>{tr("Rev")}</th>
                        <th>{tr("Account")}</th>
                        <th>{tr("Modified paths / entities")}</th>
                        <th>{tr("Ops")}</th>
                        <th>{tr("Time")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((rec) => (
                        <tr key={`${rec.rev}-${rec.opId}`} data-pc="ds-history-row">
                          <td>{`r${rec.rev}`}</td>
                          <td>
                            <span>{rec.actor.displayName || rec.actor.username}</span>
                            {rec.actor.creator ? ` (${tr("Creator")})` : ""}
                          </td>
                          <td>
                            {rec.summary.length > 0
                              ? rec.summary.slice(0, 3).join(", ")
                              : rec.entities.length > 0
                                ? rec.entities.slice(0, 3).join(", ")
                                : tr("Document update")}
                          </td>
                          <td>{rec.opCount}</td>
                          <td>{formatCommitTime(rec.at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="pc-srv-empty" data-pc="ds-empty-history">
                  {tr("Initial project document snapshot is active (r{0}). Subsequent edits from any connected editor will appear here.", latestRev)}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

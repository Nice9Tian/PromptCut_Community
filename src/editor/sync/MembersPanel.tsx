/**
 * The members button in the top bar, the members popover and the creator actions (c65-ux-draft.md sections
 * 3 and 4; contract `auth-contract.md` section 7).
 *
 * - One row per device; duplicate names carry the device name (the displayName given by the server); your
 *   own row is bold with the suffix "(you)"; the creator has "[creator]"; tags [editing] [rendering]
 *   [Agent ×n]; clicking a row expands the Agent: "username · Agent · chat n".
 * - When I am the creator: other rows show "Kick" on hover; at the bottom of the popover "Project management
 *   (visible to the creator only)": change project password / change list, change creator password, banned
 *   devices, delete project. Each time, first "verify creator identity" (enter the password on the spot and
 *   use `list-bans` to do a side-effect-free proof check); the verified K is used only for this one action
 *   flow and is dropped when closed.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { adminOp, getSyncView, leaveBlocked, makeCredential, pushToast, setHostedOption, setHostedService, useSync, type MemberRow } from "./syncManager";
import { ListEditor } from "./SharedDialogs";
import { createInvite, localCollab, rememberPasswords } from "./collab";
import { HOSTED_SERVICE_TEXT, cloudAgentConns, cloudAgentLabel, hostedFailText, hostedFlowNeedsPassword, hostedOptionText, isCloudAgentOnly, isCloudAgentRunning, memberCountLabel, serviceRowLabel, splitMembers, visibleMembers, type HostedOptionName, type HostedServiceName } from "./hostedServices";
import { useCloudRunning } from "./presence";
import "./sync.css";
// The registration of the default LAN member source has moved to the entry (`src/main.tsx` → `./lanBoot.ts`):
// it used to live at the top level of this file, which meant "whoever imports this panel registers it as
// a side effect", and on the mobile app path it is not in the closure
import { getMemberSource, subscribeAccountExtensions } from "./accountExtensions";
import { tr } from "../../i18n/index.ts";

export type Flow =
  | { kind: "password" }
  | { kind: "creator-password" }
  | { kind: "list" }
  | { kind: "bans" }
  | { kind: "delete" }
  | { kind: "kick"; row: MemberRow }
  | { kind: "hosted-service"; service: HostedServiceName; enabled: boolean }
  | { kind: "hosted-option"; service: HostedServiceName; option: HostedOptionName; enabled: boolean };

export function MembersButton() {
  const account = useSync(v => !!v.shared?.accountId);
  const source = useSyncExternalStore(subscribeAccountExtensions, getMemberSource, getMemberSource);
  const DesktopAccountPanel = source.DesktopAccountPanel;
  return account && DesktopAccountPanel ? <DesktopAccountPanel /> : <LegacyMembersButton />;
}

function LegacyMembersButton() {
  const shared = useSync((v) => v.shared);
  const members = useSync((v) => v.members);
  const device = useSync((v) => v.device);
  /** Which members' Cloud Agent currently has a round running (`cloud-run` in the presence state): redraw when the table changes (start, end, expiry) */
  const running = useCloudRunning();
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!shared) return null;
  const isMe = (r: MemberRow) => r.username === shared.username && r.deviceId === device?.deviceId;
  // The host's service (render node) is not a member: it is listed after the members, not counted in the member count, and has no kick button
  const split = splitMembers(members);
  const services = split.services;
  // A row whose user is offline and has only an idle Cloud Agent connection left is not shown or counted (a Cloud Agent connection stays connected for a while after a round ends)
  const people = visibleMembers(split.people, running);
  const others = people.filter((r) => !isMe(r));
  const mine = people.find(isMe);
  const iAmCreator = shared.creator || !!mine?.creator;
  const startFlow = (f: Flow) => {
    setOpen(false);
    setFlow(f);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="pc-sync-chip"
        data-pc="members-button"
        title={tr("Members")}
        onClick={() => {
          if (!open && btnRef.current) setRect(btnRef.current.getBoundingClientRect());
          setOpen(!open);
        }}
      >
        <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
          <circle cx="5.5" cy="4" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M1 13c0-2.6 2-4.3 4.5-4.3S10 10.4 10 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="11" cy="4.6" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M11.5 8.8c2 .2 3.5 1.8 3.5 4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        <span data-pc="members-count">{memberCountLabel(people, running)}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="pc-members-pop"
            data-pc="members-pop"
            style={{ top: (rect?.bottom ?? 40) + 6, left: Math.max(8, Math.min((rect?.right ?? 340) - 330, window.innerWidth - 338)) }}
          >
            {[...(mine ? [mine] : []), ...others].map((row) => {
              const key = `${row.username}@${row.deviceId}`;
              const allAgents = row.conns.filter((c) => c.role === "agent");
              // A Cloud Agent connection that enters the project on behalf of this member: it goes in the member's row and does not get a row of its own (contract cloud-agent-contract.md section 5)
              // An idle Cloud Agent connection does not count: the marker and sub-row are shown only while a round is running
              const cloud = isCloudAgentRunning(row, running) ? cloudAgentConns(row.conns) : [];
              const local = allAgents.filter((c) => c.service !== "agent");
              const agents = [...local, ...cloud];
              const me = isMe(row);
              return (
                <div className="pc-members-row" key={key}>
                  <div
                    className={`pc-members-row-main${agents.length ? " is-expandable" : ""}`}
                    onClick={() => agents.length && setExpanded(expanded === key ? null : key)}
                  >
                    <span className={`pc-members-name${me ? " is-me" : ""}`}>
                      {row.displayName}
                      {me ? tr(" (you)") : ""}
                    </span>
                    {row.creator ? <span className="pc-sync-tag pc-sync-tag--creator">{tr("[creator]")}</span> : null}
                    {isCloudAgentOnly(row, running) ? <span className="pc-sync-tag" data-pc="members-offline-agent" title={tr("This member is offline but their Cloud Agent is still running; not counted in the member count, counted in the Agent count")}>{tr("[offline, Agent running]")}</span> : null}
                    {row.tags.editing ? <span className="pc-sync-tag pc-sync-tag--editing">{tr("[editing]")}</span> : null}
                    {row.tags.rendering ? <span className="pc-sync-tag pc-sync-tag--rendering">{tr("[rendering]")}</span> : null}
                    {local.length > 0 ? <span className="pc-sync-tag">[Agent ×{local.length}]</span> : null}
                    {cloud.length > 0 ? <span className="pc-sync-tag" data-pc="members-cloud-agent" title={cloudAgentLabel(row.username)}>{tr("[Cloud Agent]")}</span> : null}
                    {iAmCreator && !me && row.deviceId ? (
                      <button
                        type="button"
                        className="pc-members-kick"
                        onClick={(e) => {
                          e.stopPropagation();
                          startFlow({ kind: "kick", row });
                        }}
                      >
                        {tr("Kick")}
                      </button>
                    ) : null}
                  </div>
                  {expanded === key && agents.length ? (
                    <div className="pc-members-sub">
                      {local.map((a, i) => (
                        <span key={i}>
                          {tr("{0} · Agent · chat {1}", row.username, a.conversation ?? i + 1)}
                        </span>
                      ))}
                      {cloud.length > 0 ? <span data-pc="members-cloud-agent-row">{cloudAgentLabel(row.username)}</span> : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {others.length === 0 ? <div className="pc-members-empty">{tr("Only you are online.")}</div> : null}
            {services.length ? <div className="pc-members-sep" data-pc="members-services-sep" /> : null}
            {services.map((row) => (
              <div className="pc-members-row" key={`service:${row.service}@${row.deviceId}`} data-pc={`members-service-${row.service}`}>
                <div className="pc-members-row-main">
                  <span className="pc-members-name">{serviceRowLabel(row.service)}</span>
                  {row.tags.rendering ? <span className="pc-sync-tag pc-sync-tag--rendering">{tr("[rendering]")}</span> : null}
                </div>
              </div>
            ))}
            {iAmCreator ? (
              <>
                <div className="pc-members-sep" />
                <div className="pc-members-admin-title">{tr("Project management (visible to the creator only)")}</div>
                {shared.mode === "free" ? (
                  <button type="button" className="pc-members-admin-item" onClick={() => startFlow({ kind: "password" })}>
                    {tr("Change project password")}
                  </button>
                ) : (
                  <button type="button" className="pc-members-admin-item" onClick={() => startFlow({ kind: "list" })}>
                    {tr("Edit allowlist")}
                  </button>
                )}
                <button type="button" className="pc-members-admin-item" onClick={() => startFlow({ kind: "creator-password" })}>
                  {tr("Change creator password")}
                </button>
                <button type="button" className="pc-members-admin-item" onClick={() => startFlow({ kind: "bans" })}>
                  {tr("Banned devices")}
                </button>
                <button type="button" className="pc-members-admin-item is-danger" onClick={() => startFlow({ kind: "delete" })}>
                  {tr("Delete project")}
                </button>
              </>
            ) : null}
          </div>,
          document.body,
        )}
      {flow ? <CreatorFlow flow={flow} onClose={() => setFlow(null)} /> : null}
    </>
  );
}

/* ---------------- Creator actions ---------------- */

type Verified = { key: string; bans: { username: string; deviceId: string }[]; list: string[] };

export function CreatorFlow({ flow, onClose }: { flow: Flow; onClose: () => void }) {
  const account = useSync((v) => !!v.shared?.accountId);
  const [checked, setVerified] = useState<Verified | null>(null);
  // The switch for an account project to change the host's service: there is no creator password step (it relies on the account's login state, and the server checks the creator identity), so go straight to confirmation
  const direct = (flow.kind === "hosted-service" || flow.kind === "hosted-option") && !hostedFlowNeedsPassword(account);
  const verified: Verified | null = checked ?? (direct ? { key: "", bans: [], list: [] } : null);
  if (!verified) return <VerifyDialog onClose={onClose} onOk={setVerified} />;
  switch (flow.kind) {
    case "password":
    case "creator-password":
      return <PasswordDialog creator={flow.kind === "creator-password"} v={verified} onClose={onClose} />;
    case "list":
      return <ListDialog v={verified} onClose={onClose} />;
    case "bans":
      return <BansDialog v={verified} onClose={onClose} />;
    case "delete":
      return <DeleteDialog v={verified} onClose={onClose} />;
    case "kick":
      return <KickDialog row={flow.row} v={verified} onClose={onClose} />;
    case "hosted-service":
      return <HostedServiceDialog service={flow.service} enabled={flow.enabled} v={verified} onClose={onClose} />;
    case "hosted-option":
      return <HostedOptionDialog service={flow.service} option={flow.option} enabled={flow.enabled} v={verified} onClose={onClose} />;
  }
}

function Dialog({ title, children, foot, pc }: { title?: string; children: React.ReactNode; foot: React.ReactNode; pc: string }) {
  return createPortal(
    <div className="pc-dialog-mask">
      <div className="pc-dialog pc-sync-dialog" role="dialog" aria-modal="true" data-pc={pc}>
        {title ? <div className="pc-dialog-title">{title}</div> : null}
        <div className="pc-dialog-body">{children}</div>
        <div className="pc-dialog-foot">{foot}</div>
      </div>
    </div>,
    document.body,
  );
}

const LOCK_MS = 60_000;

function VerifyDialog({ onClose, onOk }: { onClose: () => void; onOk: (v: Verified) => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [lockUntil, setLockUntil] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!lockUntil) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [lockUntil]);
  const locked = lockUntil > Date.now();
  const verify = async () => {
    if (!pw || busy || locked) return;
    setBusy(true);
    const r = await adminOp("list-bans", { password: pw });
    setBusy(false);
    if (r.ok) {
      onOk({ key: r.key, bans: (r.reply.bans as Verified["bans"]) ?? [], list: (r.reply.list as string[]) ?? [] });
      return;
    }
    if (r.error === "rate-limited") {
      setLockUntil(Date.now() + LOCK_MS);
      setErr(tr("Too many attempts, try again in 60 seconds."));
    } else setErr(tr("Wrong password."));
  };
  return (
    <Dialog
      title={tr("Verify creator identity")}
      pc="creator-verify"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            {tr("Cancel")}
          </button>
          <button type="button" className="pc-btn pc-btn--primary" disabled={!pw || busy || locked} onClick={() => void verify()}>
            {tr("Verify")}
          </button>
        </>
      }
    >
      <div className="pc-sync-field">
        <label htmlFor="pc-cv-pw">{tr("Creator password")}</label>
        <input id="pc-cv-pw" type="password" autoFocus className={`pc-dialog-input${err ? " is-invalid" : ""}`} placeholder={tr("Enter the creator password")} value={pw} disabled={locked}
          onChange={(e) => { setPw(e.target.value); setErr(""); }} onKeyDown={(e) => { if (e.key === "Enter") void verify(); }} />
        {err ? <div className="pc-sync-err">{err}</div> : null}
      </div>
    </Dialog>
  );
}

function failText(error: string): string {
  if (error === "rate-limited") return tr("Too many attempts, try again in 60 seconds.");
  if (error === "forbidden") return tr("Wrong password.");
  if (error === "offline") return tr("Could not connect to the document service, try again later.");
  return tr("Did not succeed, try again later.");
}

function PasswordDialog({ creator, v, onClose }: { creator: boolean; v: Verified; onClose: () => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!a || a !== b) {
      setErr(a !== b ? tr("The two entries do not match.") : "");
      return;
    }
    setBusy(true);
    const cred = await makeCredential(a);
    const r = creator ? await adminOp("set-creator-password", { key: v.key }, { creator: cred }) : await adminOp("set-password", { key: v.key }, { project: cred });
    setBusy(false);
    if (!r.ok) return setErr(failText(r.error));
    // The project settings "multi-user collaboration" shows the password recorded on this machine (C10a): follow it when it changes
    const pid = getSyncView().shared?.projectId;
    if (pid) await rememberPasswords(pid, creator ? { creatorPassword: a } : { projectPassword: a });
    pushToast(creator ? tr("Creator password changed. Use the new password for project management from now on.") : tr("Project password changed. People who are online are not affected; the new password is needed next time they join."), "info");
    onClose();
  };
  return (
    <Dialog
      title={creator ? tr("Change creator password") : tr("Change project password")}
      pc={creator ? "creator-password" : "project-password"}
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            {tr("Cancel")}
          </button>
          <button type="button" className="pc-btn pc-btn--primary" disabled={busy || !a || !b} onClick={() => void submit()}>
            {tr("Confirm change")}
          </button>
        </>
      }
    >
      <div className="pc-sync-field">
        <label htmlFor="pc-pw-a">{tr("New password")}</label>
        <input id="pc-pw-a" type="password" autoFocus className="pc-dialog-input" value={a} onChange={(e) => { setA(e.target.value); setErr(""); }} />
      </div>
      <div className="pc-sync-field">
        <label htmlFor="pc-pw-b">{tr("Confirm new password")}</label>
        <input id="pc-pw-b" type="password" className={`pc-dialog-input${err ? " is-invalid" : ""}`} value={b} onChange={(e) => { setB(e.target.value); setErr(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
        {err ? <div className="pc-sync-err">{err}</div> : null}
      </div>
      <div className="pc-sync-hint">{creator ? tr("People who are online are not affected. Use the new creator password for project management from now on.") : tr("People who are online are not affected; the new password is needed next time they join.")}</div>
    </Dialog>
  );
}

function ListDialog({ v, onClose }: { v: Verified; onClose: () => void }) {
  const shared = useSync((s) => s.shared);
  const [rows, setRows] = useState<{ username: string; password?: string; kept?: boolean }[]>(v.list.map((u) => ({ username: u, kept: true })));
  const [rowName, setRowName] = useState("");
  const [rowPw, setRowPw] = useState("");
  const [rowErr, setRowErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const add = () => {
    const u = rowName.trim();
    if (!u) return setRowErr(tr("Username cannot be empty."));
    if (!rowPw) return setRowErr(tr("Password cannot be empty."));
    if (u === shared?.username || rows.some((r) => r.username === u)) return setRowErr(tr("This name is already in the list, use a different one to tell them apart."));
    setRows([...rows, { username: u, password: rowPw }]);
    setRowName("");
    setRowPw("");
  };
  const changePassword = (u: string) => {
    const pw = window.prompt(tr("Set a new password for {0}", u));
    if (pw) setRows(rows.map((r) => (r.username === u ? { username: u, password: pw } : r)));
  };
  const submit = async () => {
    setBusy(true);
    const list = [];
    for (const r of rows) list.push(r.password ? { username: r.username, ...(await makeCredential(r.password)) } : { username: r.username, keep: true });
    const res = await adminOp("set-list", { key: v.key }, { list });
    setBusy(false);
    if (!res.ok) return setErr(failText(res.error));
    pushToast(tr("List updated."), "info", 4000);
    onClose();
  };
  return (
    <Dialog
      title={tr("Edit list")}
      pc="list-dialog"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            {tr("Cancel")}
          </button>
          <button type="button" className="pc-btn pc-btn--primary" disabled={busy} onClick={() => void submit()}>
            {tr("Confirm change")}
          </button>
        </>
      }
    >
      <ListEditor
        creatorName={shared?.username ?? ""}
        list={rows}
        onRemove={(u) => setRows(rows.filter((r) => r.username !== u))}
        onChangePassword={changePassword}
        rowName={rowName}
        rowPw={rowPw}
        setRowName={(x) => { setRowName(x); setRowErr(""); }}
        setRowPw={(x) => { setRowPw(x); setRowErr(""); }}
        onAdd={add}
        rowErr={rowErr}
        hint={tr("A standalone render host is a PromptCut instance on another machine that runs background prerender for you. If you have one, add a dedicated list entry for it here, and log in there with that username and password.")}
      />
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}

function BansDialog({ v, onClose }: { v: Verified; onClose: () => void }) {
  const [bans, setBans] = useState(v.bans);
  const [err, setErr] = useState("");
  const unban = async (b: { username: string; deviceId: string }) => {
    const r = await adminOp("unban", { key: v.key }, b);
    if (!r.ok) return setErr(failText(r.error));
    setBans(bans.filter((x) => !(x.username === b.username && x.deviceId === b.deviceId)));
  };
  return (
    <Dialog
      title={tr("Banned devices")}
      pc="bans-dialog"
      foot={
        <button type="button" className="pc-btn" onClick={onClose}>
          {tr("Back")}
        </button>
      }
    >
      {bans.length ? (
        <div className="pc-backups">
          {bans.map((b) => (
            <div className="pc-backup-row" key={`${b.username}@${b.deviceId}`}>
              <span>{b.username}</span>
              <small>{b.deviceId}</small>
              <button type="button" className="pc-dialog-opt" onClick={() => void unban(b)}>
                {tr("Revoke")}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="pc-sync-hint">{tr("(No banned devices)")}</div>
      )}
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}

function KickDialog({ row, v, onClose }: { row: MemberRow; v: Verified; onClose: () => void }) {
  const shared = useSync((s) => s.shared);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const kick = async () => {
    setBusy(true);
    const r = await adminOp("kick", { key: v.key }, { username: row.username, deviceId: row.deviceId });
    setBusy(false);
    if (!r.ok) return setErr(failText(r.error));
    if (shared?.mode === "free") pushToast(tr("Kicked out. In open entry mode, to block them completely, you need to change the project password."), "info", 8000);
    else pushToast(tr("Kicked."), "info", 4000);
    onClose();
  };
  return (
    <Dialog
      pc="kick-dialog"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            {tr("Cancel")}
          </button>
          <button type="button" className="pc-btn pc-sync-danger-btn" disabled={busy} onClick={() => void kick()}>
            {tr("Kick")}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
        {tr("Are you sure you want to kick {0} ({1}) from the project?", row.username, row.deviceName ?? row.deviceId)}
      </div>
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}

/** The creator toggles the host's service (the checkbox in project settings; after verifying creator identity, this step confirms) */
function HostedServiceDialog({ service, enabled, v, onClose }: { service: HostedServiceName; enabled: boolean; v: Verified; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const label = HOSTED_SERVICE_TEXT[service]?.label ?? serviceRowLabel(service);
  const apply = async () => {
    setBusy(true);
    const r = await setHostedService(service, enabled, v.key);
    setBusy(false);
    if (!r.ok) return setErr(hostedFailText(r, tr("This cloud node does not currently have this service."), failText));
    pushToast(enabled ? tr("Enabled {0}.", label) : tr("Disabled {0}.", label), "info", 4000);
    onClose();
  };
  return (
    <Dialog
      title={label}
      pc="hosted-service-dialog"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            {tr("Cancel")}
          </button>
          <button type="button" className="pc-btn pc-btn--primary" data-pc="hosted-service-confirm" disabled={busy} onClick={() => void apply()}>
            {enabled ? tr("Enable") : tr("Close")}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
        {HOSTED_SERVICE_TEXT[service]?.confirm(enabled) ?? (enabled ? tr("Enable {0}.", label) : tr("Turn off {0}.", label))}
      </div>
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}

/** The creator changes the sub-option under the host's service (the "generate track stream" checkbox in project settings; after verifying creator identity, this step confirms) */
function HostedOptionDialog({ service, option, enabled, v, onClose }: { service: HostedServiceName; option: HostedOptionName; enabled: boolean; v: Verified; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const text = hostedOptionText(service, option);
  const label = text?.label ?? option;
  const apply = async () => {
    setBusy(true);
    const r = await setHostedOption(service, option, enabled, v.key);
    setBusy(false);
    if (!r.ok) return setErr(hostedFailText(r, tr("This cloud node doesn't have this option right now."), failText));
    pushToast(enabled ? tr("Enabled {0}.", label) : tr("Disabled {0}.", label), "info", 4000);
    onClose();
  };
  return (
    <Dialog
      title={label}
      pc="hosted-option-dialog"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            {tr("Cancel")}
          </button>
          <button type="button" className="pc-btn pc-btn--primary" data-pc="hosted-option-confirm" disabled={busy} onClick={() => void apply()}>
            {enabled ? tr("Enable") : tr("Close")}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>{text?.confirm(enabled) ?? (enabled ? tr("Enable {0}.", label) : tr("Turn off {0}.", label))}</div>
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}

function DeleteDialog({ v, onClose }: { v: Verified; onClose: () => void }) {
  const shared = useSync((s) => s.shared);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!shared) return null;
  const del = async () => {
    setBusy(true);
    const r = await adminOp("delete", { key: v.key });
    setBusy(false);
    if (!r.ok) return setErr(failText(r.error));
    onClose();
    // Deleted by the user themself: do not show "The project was deleted by the creator", go straight back to the start page
    leaveBlocked();
  };
  return (
    <Dialog
      title={tr("Delete project")}
      pc="delete-dialog"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            {tr("Cancel")}
          </button>
          <button type="button" className="pc-btn pc-sync-danger-btn" disabled={busy || typed !== shared.name} onClick={() => void del()}>
            {tr("Permanently delete project")}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
        {shared.where === "hosted"
          ? tr("Are you sure you want to delete this project? The project document and media hosted on Alibaba Cloud will be permanently destroyed and all members will be disconnected immediately. This cannot be undone.")
          : tr("Are you sure you want to delete this project? The project data hosted on this machine will be permanently destroyed and all members will be disconnected immediately. This cannot be undone.")}
      </div>
      <input className="pc-dialog-input" style={{ marginLeft: 0 }} placeholder={tr("Enter the project name to confirm")} value={typed} onChange={(e) => setTyped(e.target.value)} />
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}

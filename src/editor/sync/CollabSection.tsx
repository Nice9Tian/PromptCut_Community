/**
 * The "Multi-user collaboration" section in project settings (C10a contract
 * `docs/plan/c10a-contract.md` sections 6 and 7; copy follows table B in section 14).
 *
 * - Not enabled: a checkbox. Once checked it offers defaults (hosted on this machine, open entry,
 *   creator username taken from the device name, both passwords auto-generated and stored on this
 *   machine), all editable; setup only starts when the dialog's "OK" is clicked (semantics: "check
 *   and save"), and the dialog stays to show progress and results.
 * - Enabled (currently connected to a shared project): project name and project password (open
 *   entry, with copy), invite link and QR code (cloud hosting, only on the creator's machine), invite
 *   code status, creator actions (revoke and regenerate the invite code, entering the creator
 *   password on the spot each time; and C6.5's change project password, change list, kick, delete
 *   project).
 * - Uncheck and then "OK": after confirmation, a cloud-hosted project is pulled back to this
 *   machine first and then the cloud project is deleted, while a locally hosted one stops local
 *   hosting; if it fails midway it is restored to enabled.
 *
 * - "Abandon this move" ([ruling] H04): appears when the previous move to the cloud was not finished
 *   and the cloud project has already been created (criteria in `pendingAttempt` of
 *   `accountMove.ts`); clicking it first asks for a confirmation in this section (which cloud
 *   project is deleted, deletion cannot be undone, the local project is unaffected), and after
 *   confirmation it deletes that cloud project and clears the local move record.
 * - "Move to the cloud" (desktop app): when the target is the account cloud configured on this
 *   desktop app, use the account method (`accountMoveFlow.ts`): a new project belonging to the
 *   logged-in account is created in the cloud with content identical to the local one, and the editor
 *   then continues inside the cloud project; the local collaboration room is closed once the move is
 *   done and the old invite code is revoked. Two entry points: when collaboration is not enabled,
 *   check it, choose "Cloud" and click "OK"; when local collaboration is already enabled, click
 *   "Move to the cloud". If not logged in, log in here first. When the target is another node (an
 *   address the user entered), the old method applies.
 *
 * The room link is written into the ordinary project file, and credentials live only in the device
 * protected store; connection state comes from the sync manager (`syncManager.ts`) and the local
 * record (`collab.ts`).
 */
import { forwardRef, useEffect, useImperativeHandle, useState, useSyncExternalStore } from "react";
import { qrSvg } from "../../../server/qr.mjs";
import { ONLINE } from "../../online/mode";
import { hosted, hostedTarget, type SharedMode, type Where } from "./sharedApi";
import { ListEditor, LanRestartHint, readHostedUrl, writeHostedUrl } from "./SharedDialogs";
import { CreatorFlow, type Flow } from "./MembersPanel";
import { HostedServiceRows } from "./HostedServiceRows";
import { useSync, moveSharedToHosted, moveSharedToLan, pushToast, regenAccountProjectLink, setAccountSecondaryPassword } from "./syncManager";
import { ACCOUNT_MOVE_TEXT, abandonFailureText, moveFailureText } from "./accountMove";
import { abandonPendingMove, accountCloud, accountCloudLogin, accountCloudSignIn, accountShellTooOld, moveCurrentToAccountCloud, oldShellBlocksAccountMove, pendingMove, targetsAccountCloud, type AccountCloud } from "./accountMoveFlow";
import { OLD_SHELL_ACCOUNT_TEXT } from "./desktopShellBridge";
import { getAccountExtensions, projectLink, subscribeAccountExtensions, type Account } from "./accountExtensions";
function AccountEntryOption(props: { disabled?: boolean }) {
  const ext = useSyncExternalStore(subscribeAccountExtensions, getAccountExtensions, getAccountExtensions);
  return ext.AccountEntryOption ? <ext.AccountEntryOption disabled={props.disabled} /> : null;
}
import {
  createInvite, defaultCreatorName, disableCollab, enableCollab, fetchInviteStatus, generatePassword, localCollab,
  type InviteInfo, type InviteStatus,
} from "./collab";
import "./sync.css";
import { tr } from "../../i18n/index.ts";

/** Table B (contract section 14): copied verbatim */
export const COLLAB_TEXT = {
  enabling: tr("Setting up multi-user collaboration…"),
  enabled: tr("Multi-user collaboration is on."),
  offline: tr("You are offline, so it cannot be moved to the cloud. Try again once you are online."),
  unreachable: tr("Cannot reach the cloud, setup did not finish."),
  copied: tr("Copied"),
  regenConfirm: tr("Once revoked, the old link and old QR code stop working immediately (the project password is not affected). Revoke and regenerate?"),
  regenDone: tr("A new invite link and QR code have been generated."),
  inviteDead: tr("The invite code has expired. You can generate a new one."),
  cancelConfirm: tr("After canceling, other members can no longer join. The project content and original-size media will first be pulled back to this machine. Cancel?"),
  cancelling: tr("Pulling project content back to this machine…"),
  cancelled: tr("Multi-user collaboration is off, and the content has been pulled back to this machine."),
  cancelFailed: tr("Pulling back to this machine did not finish, and collaboration was restored to on. Check the network and try again."),
  localNote: tr("Others cannot open it when your computer is off. You can move it to the cloud in settings"),
  localLimit: tr("When kept on this machine, other members can join through the relay once the host is online and cloud registration succeeds; temporary network failures retry registration automatically."),
} as const;

export interface CollabHandle {
  /** Called when the dialog's "OK" is clicked: returns true if this section has an action in progress (the dialog stays), false if there is nothing to do */
  apply(projectName: string): Promise<boolean>;
}

function copy(text: string, done: () => void) {
  void navigator.clipboard?.writeText(text).then(done, () => undefined);
}

function when(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const CollabSection = forwardRef<CollabHandle, { open: boolean }>(function CollabSection({ open }, ref) {
  const shared = useSync((v) => v.shared);
  const rev = useSync((v) => v.rev);
  const device = useSync((v) => v.device);
  const association = useSync((v) => v.association);
  const hostRegistration = useSync((v) => v.hostRegistration);
  const hostedServices = useSync((v) => v.hosted);
  const isOn = !!shared || !!association;
  const isAccount = !!shared?.accountId;
  const [checked, setChecked] = useState(isOn);
  const [where, setWhere] = useState<Where>("lan");
  const [mode, setMode] = useState<SharedMode>("free");
  const [creator, setCreator] = useState("");
  const [creatorPw, setCreatorPw] = useState("");
  const [projectPw, setProjectPw] = useState("");
  const [list, setList] = useState<{ username: string; password: string }[]>([]);
  const [rowName, setRowName] = useState("");
  const [rowPw, setRowPw] = useState("");
  const [rowErr, setRowErr] = useState("");
  const [hostedUrl, setHostedUrl] = useState(readHostedUrl());
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "err" | "info" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [movingHosted, setMovingHosted] = useState(false);
  const [movingLan, setMovingLan] = useState(false);
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [inviteStatus, setInviteStatus] = useState<InviteStatus | null>(null);
  const [regenPw, setRegenPw] = useState<string | null>(null);
  const [cancelPw, setCancelPw] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [secondaryModalOpen, setSecondaryModalOpen] = useState(false);
  const [secondaryPw, setSecondaryPw] = useState("");
  const [secondaryBusy, setSecondaryBusy] = useState(false);
  // The account method's "Move to the cloud": the account cloud configured on this desktop app (null if there is no account bridge), and the logged-in account (undefined = still checking)
  const [acct, setAcct] = useState<AccountCloud | null>(null);
  const [acctUser, setAcctUser] = useState<Account | null | undefined>(undefined);
  /** The desktop shell is too old (patched before 0.2.8) and has no account bridge: "Move to the cloud" for the default cloud explains that the full installer is needed, and does not go further */
  const [shellOld, setShellOld] = useState(false);
  /** Login is needed first: continue the move after a successful login (`name` is the cloud project name to use for that attempt) */
  const [loginFor, setLoginFor] = useState<{ name: string } | null>(null);
  const [loginName, setLoginName] = useState("");
  const [loginPw, setLoginPw] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  /** Move the collaboration room to the cloud: cloud project name (change it if it clashes), creator password (fill in if this machine did not store it) */
  const [cloudName, setCloudName] = useState("");
  const [askCloudName, setAskCloudName] = useState(false);
  const [movePw, setMovePw] = useState("");
  const [askMovePw, setAskMovePw] = useState(false);
  /** The project link given when the move is done (or when the cloud project is created but the move is unfinished) */
  const [moveLink, setMoveLink] = useState<string | null>(null);
  /** Abandon this move: the button was clicked, waiting for confirmation */
  const [abandonAsk, setAbandonAsk] = useState(false);

  const local = shared ? localCollab(shared.projectId) : null;
  const iAmCreator = !!shared?.creator;
  const lanOk = !ONLINE && !!device?.localEditor;
  useEffect(() => {
    if (movingHosted && shared?.where === "hosted") {
      setMovingHosted(false); setStatus({ text: tr("Moved to the cloud, still the original room."), tone: "ok" });
    }
  }, [movingHosted, shared?.where]);
  useEffect(() => {
    if (movingLan && shared?.where === "lan") {
      setMovingLan(false); setStatus({ text: tr("Moved back to this machine, still the original room."), tone: "ok" });
    }
  }, [movingLan, shared?.where]);

  // Reset by current state when the dialog opens; only the creation form that has not yet enabled collaboration generates default passwords, restoring the original room does not generate new ones.
  useEffect(() => {
    if (!open) return;
    setChecked(isOn);
    setStatus(null);
    setBusy(false);
    setRegenPw(null);
    setCancelPw("");
    setCopied(null);
    setWhere(ONLINE ? "hosted" : "lan");
    setMode("free");
    setCreatorPw(isOn ? "" : generatePassword());
    setProjectPw(isOn ? "" : generatePassword());
    setList([]);
    setHostedUrl(readHostedUrl());
    void defaultCreatorName().then(setCreator);
    setLoginFor(null); setLoginPw(""); setLoginBusy(false);
    setCloudName(""); setAskCloudName(false); setMovePw(""); setAskMovePw(false); setMoveLink(null); setAbandonAsk(false);
    // Account cloud and login state: checked once when settings open (without an account bridge there is none of this, and "Cloud" uses the old method)
    let live = true;
    setAcctUser(undefined); setShellOld(false);
    void accountCloud().then(async (c) => {
      if (!live) return;
      setAcct(c); setShellOld(accountShellTooOld());
      if (!c) { setAcctUser(null); return; }
      try { const user = await accountCloudLogin(c); if (live) setAcctUser(user); }
      catch { if (live) setAcctUser(null); }
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Enabled: the invite link is the one recorded on this machine; the status is queried live with the creator password recorded on this machine (read-only, not queried if there is none)
  useEffect(() => {
    if (!open || !shared) {
      setInvite(null);
      setInviteStatus(null);
      return;
    }
    const rec = localCollab(shared.projectId);
    setInvite(rec?.invite ?? null);
    setInviteStatus(null);
    if (shared.where === "hosted" && shared.creator && rec?.creatorPassword) {
      void fetchInviteStatus(rec.creatorPassword).then((r) => { if (r.ok) setInviteStatus(r.status); });
    }
  }, [open, shared]);

  const addRow = () => {
    const u = rowName.trim();
    if (!u) return setRowErr(tr("Username cannot be empty."));
    if (!rowPw) return setRowErr(tr("Password cannot be empty."));
    if (u === creator.trim() || list.some((r) => r.username === u)) return setRowErr(tr("This name is already in the list, use a different one to tell them apart."));
    setList([...list, { username: u, password: rowPw }]);
    setRowName("");
    setRowPw("");
    setRowErr("");
  };

  useImperativeHandle(ref, () => ({
    async apply(projectName: string) {
      if (busy) return true;
      if (checked && !isOn) {
        // Hosted in the cloud, target is the account cloud: turn the current project into the account's cloud project (no creator username and password needed)
        if (where === "hosted") {
          const c = acct ?? await accountCloud();
          if (targetsAccountCloud(hostedUrl, c)) {
            void startAccountMove(c!, projectName);
            return true;
          }
          if (oldShellBlocksAccountMove(hostedUrl)) { setStatus({ text: OLD_SHELL_ACCOUNT_TEXT, tone: "info" }); return true; }
        }
        if (!creator.trim() || !creatorPw || (mode === "free" && !projectPw)) {
          setStatus({ text: tr("Creator username and password cannot be empty."), tone: "err" });
          return true;
        }
        if (where === "lan" && !lanOk) return true;
        setBusy(true);
        setStatus({ text: COLLAB_TEXT.enabling, tone: "info" });
        if (where === "hosted") writeHostedUrl(hostedUrl);
        const r = await enableCollab({
          where,
          mode,
          name: projectName,
          creator: { username: creator.trim(), password: creatorPw },
          ...(mode === "free" ? { projectPassword: projectPw } : { list }),
          hostedUrl: where === "hosted" && hostedUrl.trim() !== hosted.DEFAULT_HOSTED_URL ? hostedUrl.trim() : null,
        });
        setBusy(false);
        if (!r.ok) {
          const text = r.error === "offline" ? COLLAB_TEXT.offline
            : r.error === "name-taken" ? tr("This project name is already taken, pick another.")
              : r.error === "lan-failed" ? tr("The local port is in use. Close the other PromptCut window using it, or restart the app and try again.")
                : COLLAB_TEXT.unreachable;
          setStatus({ text, tone: "err" });
          return true;
        }
        setInvite(r.invite);
        setStatus({ text: COLLAB_TEXT.enabled, tone: "ok" });
        return true;
      }
      if (!checked && isOn) {
        if (!iAmCreator) {
          setChecked(true);
          return false;
        }
        const pw = local?.creatorPassword || cancelPw;
        if (!pw) {
          setStatus({ text: tr("The creator password is required to cancel."), tone: "err" });
          return true;
        }
        if (!window.confirm(COLLAB_TEXT.cancelConfirm)) {
          setChecked(true);
          return true;
        }
        setBusy(true);
        setStatus({ text: COLLAB_TEXT.cancelling, tone: "info" });
        const r = await disableCollab(pw, (done, total) => setStatus({ text: tr("{0} (original-size media {1}/{2})", COLLAB_TEXT.cancelling, done, total), tone: "info" }));
        setBusy(false);
        if (!r.ok) {
          setChecked(true);
          setStatus({ text: r.error === "forbidden" ? tr("Wrong password.") : r.error === "rate-limited" ? tr("Too many attempts, try again in 60 seconds.") : COLLAB_TEXT.cancelFailed, tone: "err" });
          return true;
        }
        setStatus({ text: COLLAB_TEXT.cancelled, tone: "ok" });
        return true;
      }
      return false;
    },
  }), [busy, checked, isOn, creator, creatorPw, projectPw, mode, where, lanOk, hostedUrl, list, iAmCreator, local, cancelPw, acct, movePw, shared]);

  /** The account method's move to the cloud: check login → (collaboration room) confirm → do it step by step, with the status line following along; on failure, say clearly what state this machine is in now */
  const startAccountMove = async (c: AccountCloud, name: string) => {
    if (busy) return;
    const room = !!shared;
    setBusy(true); setMoveLink(null);
    setStatus({ text: ACCOUNT_MOVE_TEXT.stage.check, tone: "info" });
    let user: Account | null;
    try { user = await accountCloudLogin(c); }
    catch (e) { setBusy(false); setStatus({ text: e instanceof Error ? e.message : tr("Failed to connect to the cloud. Check the network and try again."), tone: "err" }); return; }
    setAcctUser(user);
    if (!user) { setBusy(false); setLoginFor({ name }); setStatus({ text: ACCOUNT_MOVE_TEXT.needLogin, tone: "info" }); return; }
    setLoginFor(null);
    if (room && !window.confirm(ACCOUNT_MOVE_TEXT.roomConfirm(user.name))) { setBusy(false); setStatus(null); return; }
    const r = await moveCurrentToAccountCloud(c, { name, creatorPassword: movePw, onStage: (stage) => setStatus({ text: ACCOUNT_MOVE_TEXT.stage[stage], tone: "info" }) });
    setBusy(false);
    if (r.ok) {
      setChecked(true); setAskCloudName(false); setAskMovePw(false); setMovePw("");
      setMoveLink(r.link);
      setStatus({ text: r.kind === "room" ? ACCOUNT_MOVE_TEXT.doneRoom : ACCOUNT_MOVE_TEXT.doneLocal, tone: "ok" });
      return;
    }
    console.warn("[collab] move to cloud failed:", r.error, r.stage, r.detail ?? "", r.localClosed ? "(local collaboration closed)" : "");
    if (r.error === "login-required") { setAcctUser(null); setLoginFor({ name }); }
    if (r.error === "name-taken" || r.error === "invalid-name") setAskCloudName(true);
    if (r.error === "creator-password" || r.error === "bad-password") setAskMovePw(true);
    if (r.cloud && (r.localClosed || r.error === "enter-failed")) setMoveLink(projectLink(c.origin, r.cloud.projectId));
    // It failed only after local collaboration was already shut down: what is open now is the local project, the form stays on "Cloud", and clicking "OK" again continues
    if (r.localClosed) setWhere("hosted");
    setStatus({ text: moveFailureText(r, r.kind), tone: r.error === "login-required" || r.error === "creator-password" ? "info" : "err" });
  };
  /** Abandon this move: called only after confirmation; the status line follows along, and on failure say clearly what state the cloud and this machine are in now */
  const abandon = async () => {
    if (!acct || busy) return;
    setAbandonAsk(false); setBusy(true); setMoveLink(null);
    const name = acctUser ? pendingMove(acctUser.id)?.name ?? "" : "";
    setStatus({ text: ACCOUNT_MOVE_TEXT.abandoning(name), tone: "info" });
    const r = await abandonPendingMove(acct);
    setBusy(false);
    if (r.ok) { setStatus({ text: r.already ? ACCOUNT_MOVE_TEXT.abandonedAlready(r.name) : ACCOUNT_MOVE_TEXT.abandoned(r.name), tone: "ok" }); return; }
    console.warn("[collab] abandoning the move failed:", r.error, r.detail ?? "");
    if (r.error === "login-required") { setAcctUser(null); setLoginFor(null); }
    setStatus({ text: abandonFailureText(r), tone: r.error === "login-required" ? "info" : "err" });
  };
  const signIn = async () => {
    if (!acct || loginBusy || !loginName.trim() || !loginPw) return;
    setLoginBusy(true); setStatus({ text: ACCOUNT_MOVE_TEXT.loginBusy, tone: "info" });
    try {
      const user = await accountCloudSignIn(acct, loginName.trim(), loginPw);
      setLoginPw(""); setAcctUser(user); setStatus(null);
      const resume = loginFor; setLoginFor(null); setLoginBusy(false);
      if (resume) void startAccountMove(acct, resume.name);
    } catch (e) {
      setLoginBusy(false);
      setStatus({ text: e instanceof Error ? e.message : tr("Login failed, please try again."), tone: "err" });
    }
  };

  const regen = async () => {
    if (regenPw === null) {
      if (!window.confirm(COLLAB_TEXT.regenConfirm)) return;
      setRegenPw("");
      return;
    }
    if (!regenPw) return;
    setBusy(true);
    const r = await createInvite(regenPw);
    setBusy(false);
    if (!r.ok) {
      setStatus({ text: r.error === "forbidden" ? tr("Wrong password.") : r.error === "rate-limited" ? tr("Too many attempts, try again in 60 seconds.") : COLLAB_TEXT.unreachable, tone: "err" });
      return;
    }
    setRegenPw(null);
    setInvite(r.invite);
    setInviteStatus({ active: true, expiresAt: r.invite.expiresAt, maxUses: r.invite.maxUses, used: 0, revokedAt: null });
    setStatus({ text: COLLAB_TEXT.regenDone, tone: "ok" });
  };
  const regenLink = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await regenAccountProjectLink();
      if (r.ok) {
        setMoveLink(r.link);
        pushToast(tr("The project link was regenerated, and the old link is no longer valid."), "info", 5000);
      } else {
        setStatus({ text: r.error || tr("Failed to regenerate the project link."), tone: "err" });
      }
    } catch (e) {
      setStatus({ text: (e as Error).message || tr("Failed to regenerate the project link."), tone: "err" });
    } finally {
      setBusy(false);
    }
  };
  const submitSecondaryPw = async () => {
    setSecondaryBusy(true);
    try {
      const r = await setAccountSecondaryPassword(secondaryPw || null);
      if (r.ok) {
        pushToast(secondaryPw ? tr("Project secondary password set.") : tr("Project secondary password cleared."), "info", 4000);
        setSecondaryModalOpen(false);
        setSecondaryPw("");
      } else {
        setStatus({ text: r.error || tr("Failed to set the project secondary password."), tone: "err" });
      }
    } catch (e) {
      setStatus({ text: (e as Error).message || tr("Failed to set the project secondary password."), tone: "err" });
    } finally {
      setSecondaryBusy(false);
    }
  };
  const moveHosted = async () => {
    // The cloud registered for the room is the account cloud: use the account method (create an account project in the cloud, close local collaboration after the move); other nodes use the old method
    const c = acct ?? await accountCloud();
    if (shared && oldShellBlocksAccountMove(association?.service)) { setStatus({ text: OLD_SHELL_ACCOUNT_TEXT, tone: "info" }); return; }
    if (shared && targetsAccountCloud(association?.service, c)) {
      if (!iAmCreator) { setStatus({ text: moveFailureText({ ok: false, error: "not-creator", stage: "check", localClosed: false, cloud: null }, "room"), tone: "err" }); return; }
      void startAccountMove(c!, (askCloudName ? cloudName.trim() : "") || shared.name);
      return;
    }
    setMovingHosted(true); setBusy(true); setStatus({ text: tr("Moving to the cloud, will reconnect to the original room when done…"), tone: "info" });
    const result = await moveSharedToHosted(); setBusy(false);
    if (!result.ok) { setMovingHosted(false); setStatus({ text: result.error === "not-original-host" ? tr("Run the move to the cloud on the current actual host.")
      : result.error === "relocation-materials-missing" ? tr("Some media referenced by the project is not yet in the library. Fill in the gaps and retry; the original room and identity are kept.")
        : tr("The move did not finish, and the original room info is kept. Check the connection or storage and try again."), tone: "err" }); }
  };
  const moveLan = async () => {
    setMovingLan(true); setBusy(true); setStatus({ text: tr("Moving back to this machine, will reconnect to the original room when done…"), tone: "info" });
    const result = await moveSharedToLan(); setBusy(false);
    if (!result.ok) { setMovingLan(false); setStatus({ text: tr("The move did not finish, and the room and local recovery info are kept. Check the connection, identity or storage and try again."), tone: "err" }); }
  };

  const copied$ = (key: string) => (copied === key ? <span className="pc-sync-hint">{COLLAB_TEXT.copied}</span> : null);
  const copyBtn = (key: string, text: string) => (
    <button type="button" className="pc-sync-link-btn" onClick={() => copy(text, () => setCopied(key))}>{tr("Copy")}</button>
  );

  const on = checked;
  // Whether "Cloud" means the account cloud (if so: show login state, no creator username and password)
  const accountTarget = where === "hosted" && targetsAccountCloud(hostedUrl, acct);
  /** The move from last time that was not finished and whose cloud project is already created (clicking "OK" again continues) */
  const resumable = accountTarget && acctUser && !isOn ? pendingMove(acctUser.id) : null;
  /** The cloud project left behind by an unfinished move to the cloud ("Abandon this move" only appears when it exists; while a cloud project is open, `pendingMove` is null) */
  const pending = acct && acctUser ? pendingMove(acctUser.id) : null;
  /** The login state line; if not logged in, it is the login form (fields are the same as the login on the start page's "Cloud project") */
  const accountRow = !acct ? null : acctUser === undefined ? (
    <div className="pc-sync-hint" data-pc="collab-account-user">{ACCOUNT_MOVE_TEXT.checkingLogin}</div>
  ) : acctUser ? (
    <div className="pc-collab-row" data-pc="collab-account-user"><span>{ACCOUNT_MOVE_TEXT.loggedIn(acctUser.name)}</span></div>
  ) : (
    <div data-pc="collab-account-login">
      <div className="pc-sync-field">
        <label htmlFor="pc-collab-acct-name">{tr("Account name")}</label>
        <input id="pc-collab-acct-name" className="pc-dialog-input" data-pc="collab-account-name" autoComplete="username" value={loginName} onChange={(e) => setLoginName(e.target.value)} />
      </div>
      <div className="pc-sync-field">
        <label htmlFor="pc-collab-acct-pw">{tr("Password")}</label>
        <input id="pc-collab-acct-pw" type="password" className="pc-dialog-input" data-pc="collab-account-password" autoComplete="current-password" value={loginPw}
          onChange={(e) => setLoginPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void signIn(); }} />
      </div>
      <div className="pc-collab-actions">
        <button type="button" className="pc-dialog-opt" data-pc="collab-account-submit" disabled={loginBusy || busy || !loginName.trim() || !loginPw} onClick={() => void signIn()}>{ACCOUNT_MOVE_TEXT.loginButton}</button>
        <a className="pc-sync-hint" href={`${acct.origin}/account`} target="_blank" rel="noopener noreferrer">{tr("Sign up / forgot password")}</a>
      </div>
    </div>
  );
  return (
    <div className="pc-collab" data-pc="collab-section">
      <label className="pc-collab-head">
        <input type="checkbox" data-pc="collab-toggle" checked={on} disabled={busy || (isOn && !iAmCreator) || (isOn && ONLINE)}
          onChange={(e) => {
            setChecked(e.target.checked); setStatus(null);
            // After cancelling we stay in the same settings window: explicitly creating again also keeps the ability to generate default passwords.
            if (e.target.checked && !isOn) {
              if (!creatorPw) setCreatorPw(generatePassword());
              if (!projectPw) setProjectPw(generatePassword());
            }
          }} />
        {tr("Multi-user collaboration")}
      </label>

      {on && !isOn ? (
        <>
          {hostedTarget ? (
            <div className="pc-collab-row">
              <span className="pc-collab-key">{tr("Keep on")}</span>
              <button type="button" className={`pc-dialog-opt${where === "lan" ? " pc-dialog-opt--on" : ""}`} data-pc="collab-where-lan" disabled={ONLINE} onClick={() => setWhere("lan")}>{tr("This machine")}</button>
              <button type="button" className={`pc-dialog-opt${where === "hosted" ? " pc-dialog-opt--on" : ""}`} data-pc="collab-where-hosted" onClick={() => setWhere("hosted")}>{tr("Cloud")}</button>
            </div>
          ) : null}
          {where === "lan" ? (
            <>
              <div className="pc-sync-warn">{COLLAB_TEXT.localNote}</div>
              <div className="pc-sync-hint">{COLLAB_TEXT.localLimit}</div>
              {!device?.lanHost && !ONLINE ? <LanRestartHint /> : null}
            </>
          ) : (
            <div className="pc-sync-field">
              <label htmlFor="pc-collab-hosted">{tr("Cloud address")}</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input id="pc-collab-hosted" className="pc-dialog-input" data-pc="collab-hosted-url" value={hostedUrl} onChange={(e) => setHostedUrl(e.target.value)} />
                <button type="button" className="pc-dialog-opt" style={{ height: 30 }} onClick={() => setHostedUrl(hosted.DEFAULT_HOSTED_URL)}>{tr("Restore default")}</button>
              </div>
            </div>
          )}
          {where === "hosted" && shellOld && oldShellBlocksAccountMove(hostedUrl) ? (
            <div className="pc-sync-warn" data-pc="collab-shell-old">{OLD_SHELL_ACCOUNT_TEXT}</div>
          ) : accountTarget ? (
            <>
              <div className="pc-sync-hint" data-pc="collab-account-intro">{ACCOUNT_MOVE_TEXT.intro}</div>
              {accountRow}
              {resumable ? <div className="pc-sync-hint" data-pc="collab-move-pending">{ACCOUNT_MOVE_TEXT.pending(resumable.name)}</div> : null}
            </>
          ) : (
          <>
          <div className="pc-collab-row">
            <span className="pc-collab-key">{tr("Access mode")}</span>
            <button type="button" className={`pc-dialog-opt${mode === "free" ? " pc-dialog-opt--on" : ""}`} onClick={() => setMode("free")}>{tr("Open access")}</button>
            <button type="button" className={`pc-dialog-opt${mode === "restricted" ? " pc-dialog-opt--on" : ""}`} onClick={() => setMode("restricted")}>{tr("Restricted access")}</button>
          </div>
          <div className="pc-sync-field">
            <label htmlFor="pc-collab-creator">{tr("Creator username")}</label>
            <input id="pc-collab-creator" className="pc-dialog-input" value={creator} maxLength={64} onChange={(e) => setCreator(e.target.value)} />
          </div>
          <div className="pc-sync-field">
            <label htmlFor="pc-collab-cpw">{tr("Creator password (auto-generated, stored on this machine)")}</label>
            <input id="pc-collab-cpw" className="pc-dialog-input" value={creatorPw} onChange={(e) => setCreatorPw(e.target.value)} />
          </div>
          {mode === "free" ? (
            <div className="pc-sync-field">
              <label htmlFor="pc-collab-ppw">{tr("Project password (auto-generated, stored on this machine)")}</label>
              <input id="pc-collab-ppw" className="pc-dialog-input" value={projectPw} onChange={(e) => setProjectPw(e.target.value)} />
            </div>
          ) : (
            <ListEditor
              creatorName={creator.trim() || tr("Your name")}
              list={list}
              onRemove={(u) => setList(list.filter((r) => r.username !== u))}
              rowName={rowName}
              rowPw={rowPw}
              setRowName={(v) => { setRowName(v); setRowErr(""); }}
              setRowPw={(v) => { setRowPw(v); setRowErr(""); }}
              onAdd={addRow}
              rowErr={rowErr}
              hint={tr("If you have a standalone render host, remember to add it to the allowlist here too.")}
            />
          )}
          </>
          )}
          <div className="pc-sync-hint">{tr("Click \"OK\" to start setup.")}</div>
        </>
      ) : null}

      {isOn && shared ? (
        <>
          <div className="pc-collab-row">
            <span className="pc-collab-key">{tr("Keep on")}</span>
            {/* Account cloud projects only display "Cloud": "open entry / restricted entry" is terminology for
                local projects; mode for account projects is always free. Previously this always said "open entry",
                which clashed after unchecking "Anyone with the link can join" below; entry type is indicated solely
                by that checkbox ([ruling] lead session 2026-10-22, report AGENT-claude-join-requests.md) */}
            <span data-pc="collab-where-text">{isAccount ? tr("Cloud") : <>{shared.where === "hosted" ? tr("Cloud") : tr("Local")} · {shared.mode === "free" ? tr("Open entry") : tr("Restricted entry")}</>}</span>
          </div>
          {/* A cloud project from the account method has no "Move back to this machine" (clicking it is bound to fail; user decision, 2026-10-13, to hide it for now); rooms from the old method are shown as before */}
          {shared.where === "hosted" && !ONLINE && !shared.accountId ? <button type="button" className="pc-dialog-opt" data-pc="collab-move-lan" disabled={busy} onClick={() => void moveLan()}>{tr("Move back to this machine")}</button> : null}
          <div className="pc-collab-row" data-pc="collab-project-name">
            <span className="pc-collab-key">{tr("Project name")}</span>
            <code>{shared.name}</code>
            {copyBtn("name", shared.name)}
            {copied$("name")}
          </div>
          <div className="pc-collab-row" data-pc="collab-project-rev">
            <span className="pc-collab-key">{tr("History sequence number")}</span>
            <code>{rev ?? 1}</code>
          </div>
          {shared.mode === "free" && local?.projectPassword ? (
            <div className="pc-collab-row" data-pc="collab-project-password">
              <span className="pc-collab-key">{tr("Project password")}</span>
              <code>{local.projectPassword}</code>
              {copyBtn("pw", local.projectPassword)}
              {copied$("pw")}
            </div>
          ) : null}
          {/* The host's service (render node): shown only when hosted in the cloud and this hosted side has it; the creator can change it (after verifying the creator's identity), other members read-only */}
          <HostedServiceRows where={shared.where} hosted={hostedServices} creator={iAmCreator} busy={busy}
            onToggle={(service, enabled) => setFlow({ kind: "hosted-service", service, enabled })}
            onToggleOption={(service, option, enabled) => setFlow({ kind: "hosted-option", service, option, enabled })} />
          {shared.where === "lan" ? (
            <>
              <div className="pc-sync-warn">{COLLAB_TEXT.localNote}</div>
              <div className="pc-sync-hint" data-pc="host-registration" data-state={hostRegistration ?? "member"}>{hostRegistration === "online" ? tr("The original room is registered online and relay access is ready.") : hostRegistration === "host-conflict" ? tr("Host slot conflict, not taken over automatically.") : COLLAB_TEXT.localLimit}</div>
              {!ONLINE && hostedTarget ? <button type="button" className="pc-dialog-opt" data-pc="collab-move-hosted" disabled={busy} onClick={() => void moveHosted()}>{tr("Move to cloud")}</button> : null}
              {askCloudName ? (
                <div className="pc-sync-field">
                  <label htmlFor="pc-collab-cloud-name">{ACCOUNT_MOVE_TEXT.nameLabel}</label>
                  <input id="pc-collab-cloud-name" className="pc-dialog-input" data-pc="collab-cloud-name" maxLength={200} value={cloudName} placeholder={shared.name} onChange={(e) => setCloudName(e.target.value)} />
                </div>
              ) : null}
              {askMovePw ? (
                <div className="pc-sync-field">
                  <label htmlFor="pc-collab-move-pw">{tr("Creator password")}</label>
                  <input id="pc-collab-move-pw" type="password" className="pc-dialog-input" data-pc="collab-move-password" value={movePw} onChange={(e) => setMovePw(e.target.value)} />
                </div>
              ) : null}
              {loginFor ? accountRow : null}
            </>
          ) : null}
          {/* Invite link and QR code: given for both cloud hosting and local hosting (for local hosting it is for phones and tablets on the LAN to scan) */}
          {(shared.where === "hosted" || shared.where === "lan") && iAmCreator ? (
            <>
              {isAccount ? (
                <div className="pc-collab-actions">
                  <button type="button" className="pc-dialog-opt" data-pc="collab-regen-link" disabled={busy} onClick={() => void regenLink()}>{tr("Revoke and regenerate project link")}</button>
                  <button type="button" className="pc-dialog-opt" data-pc="collab-secondary-password" disabled={busy} onClick={() => setSecondaryModalOpen(true)}>{tr("Project secondary password")}</button>
                </div>
              ) : (
                <>
                  {invite ? (
                    <div className="pc-collab-qr">
                      <div className="pc-collab-qr-img" data-pc="collab-qr" aria-label={tr("Invite QR code")} dangerouslySetInnerHTML={{ __html: qrSvg(invite.link, { ec: "M", quiet: 4, scale: 8 }) }} />
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, flex: 1 }}>
                        <code data-pc="collab-invite-link" style={{ fontSize: 11.5, wordBreak: "break-all" }}>{invite.link}</code>
                        <div className="pc-collab-actions">
                          <button type="button" className="pc-dialog-opt" data-pc="collab-copy-link" onClick={() => copy(invite.link, () => setCopied("link"))}>{tr("Copy invite link")}</button>
                          {copied$("link")}
                        </div>
                        <div className="pc-sync-hint" data-pc="collab-invite-status">
                          {inviteStatus && !inviteStatus.active ? COLLAB_TEXT.inviteDead
                            : tr("Valid until {0}{1}{2}", when(inviteStatus?.expiresAt ?? invite.expiresAt), inviteStatus ? tr(" · used {0} times", inviteStatus.used) : "", (inviteStatus?.maxUses ?? invite.maxUses) ? tr(" / limit {0} uses", inviteStatus?.maxUses ?? invite.maxUses) : "")}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="pc-sync-hint">{tr("There is no invite link on this device (the link exists only on the device that issued it).")}</div>
                  )}
                  <div className="pc-collab-actions">
                    <button type="button" className="pc-dialog-opt" data-pc="collab-regen" disabled={busy} onClick={() => void regen()}>{tr("Revoke and regenerate invite code")}</button>
                  </div>
                  {regenPw !== null ? (
                    <div className="pc-sync-field">
                      <label htmlFor="pc-collab-regen-pw">{tr("Creator password")}</label>
                      <div style={{ display: "flex", gap: 8 }}>
                        <input id="pc-collab-regen-pw" type="password" autoFocus className="pc-dialog-input" data-pc="collab-regen-password" value={regenPw}
                          onChange={(e) => setRegenPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void regen(); }} />
                        <button type="button" className="pc-dialog-opt" data-pc="collab-regen-confirm" style={{ height: 30 }} disabled={!regenPw || busy} onClick={() => void regen()}>{tr("Confirm")}</button>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
              {secondaryModalOpen ? (
                <div className="pc-sync-field" data-pc="secondary-password-modal" style={{ marginTop: 12, padding: 8, border: "1px solid var(--border, #ccc)", borderRadius: 6 }}>
                  <label htmlFor="pc-secondary-pw">{tr("Project secondary password (leave empty to clear it)")}</label>
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <input id="pc-secondary-pw" type="password" className="pc-dialog-input" data-pc="collab-secondary-pw-input" placeholder={tr("Enter a new password, or leave empty to clear")}
                      value={secondaryPw} onChange={(e) => setSecondaryPw(e.target.value)} />
                    <button type="button" className="pc-dialog-opt" data-pc="collab-secondary-pw-confirm" disabled={secondaryBusy || busy} onClick={() => void submitSecondaryPw()}>
                      {tr("OK")}
                    </button>
                    <button type="button" className="pc-dialog-opt" onClick={() => { setSecondaryModalOpen(false); setSecondaryPw(""); }}>
                      {tr("Cancel")}
                    </button>
                  </div>
                </div>
              ) : null}
              {/* "Anyone with the link can join": below the two buttons above, only the creator can change it (user decision, 2026-10-22; `src/account/AccountEntryOption.tsx`) */}
              {isAccount ? <AccountEntryOption disabled={busy} /> : null}
            </>
          ) : null}
          {iAmCreator ? (
            <div className="pc-collab-actions">
              {!isAccount && (shared.mode === "free"
                ? <button type="button" className="pc-dialog-opt" onClick={() => setFlow({ kind: "password" })}>{tr("Change project password")}</button>
                : <button type="button" className="pc-dialog-opt" onClick={() => setFlow({ kind: "list" })}>{tr("Edit allowlist")}</button>)}
              {!isAccount && <button type="button" className="pc-dialog-opt" onClick={() => setFlow({ kind: "creator-password" })}>{tr("Change creator password")}</button>}
              {!isAccount && <button type="button" className="pc-dialog-opt" onClick={() => setFlow({ kind: "bans" })}>{tr("Banned devices")}</button>}
              <button type="button" className="pc-dialog-opt" onClick={() => setFlow({ kind: "delete" })}>{tr("Delete project")}</button>
            </div>
          ) : null}
          {iAmCreator ? <div className="pc-sync-hint">{tr("Kick a member: in the member list in the top bar, hover over that person's row and click \"Kick\".")}</div> : null}
          {!checked && iAmCreator && !local?.creatorPassword ? (
            <div className="pc-sync-field">
              <label htmlFor="pc-collab-cancel-pw">{tr("Creator password")}</label>
              <input id="pc-collab-cancel-pw" type="password" className="pc-dialog-input" value={cancelPw} onChange={(e) => setCancelPw(e.target.value)} />
            </div>
          ) : null}
          {!checked && iAmCreator ? <div className="pc-sync-hint">{tr("Click \"OK\" to cancel multi-user collaboration.")}</div> : null}
        </>
      ) : null}

      {/* Not shown while moving or deleting (the status line is reporting progress); once the move succeeds the record is deleted, so naturally it is not shown either */}
      {pending && !busy ? (
        <div className="pc-collab-abandon" data-pc="collab-move-abandon-block">
          {resumable ? null : <div className="pc-sync-hint" data-pc="collab-move-pending-idle">{ACCOUNT_MOVE_TEXT.pendingIdle(pending.name, !!shared)}</div>}
          {abandonAsk ? (
            <div data-pc="collab-abandon-confirm">
              <div className="pc-sync-warn">{ACCOUNT_MOVE_TEXT.abandonConfirm(pending.name)}</div>
              <div className="pc-collab-actions">
                <button type="button" className="pc-dialog-opt pc-sync-danger-btn" data-pc="collab-abandon-yes" disabled={busy} onClick={() => void abandon()}>{ACCOUNT_MOVE_TEXT.abandonConfirmButton}</button>
                <button type="button" className="pc-dialog-opt" data-pc="collab-abandon-no" disabled={busy} onClick={() => setAbandonAsk(false)}>{ACCOUNT_MOVE_TEXT.abandonCancel}</button>
              </div>
            </div>
          ) : (
            <div className="pc-collab-actions">
              <button type="button" className="pc-dialog-opt" data-pc="collab-move-abandon" disabled={busy} onClick={() => { setAbandonAsk(true); setStatus(null); }}>{ACCOUNT_MOVE_TEXT.abandonButton}</button>
            </div>
          )}
        </div>
      ) : null}
      {status ? (
        <div className={`pc-sync-status-line${status.tone === "err" ? " is-err" : status.tone === "ok" ? " is-ok" : ""}`} data-pc="collab-status">{status.text}</div>
      ) : null}
      {moveLink ? (
        <div className="pc-collab-actions">
          <button type="button" className="pc-dialog-opt" data-pc="collab-move-link" onClick={() => copy(moveLink, () => setCopied("move-link"))}>{ACCOUNT_MOVE_TEXT.copyLink}</button>
          {copied$("move-link")}
        </div>
      ) : null}
      {flow ? <CreatorFlow flow={flow} onClose={() => setFlow(null)} /> : null}
    </div>
  );
});

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "../ProjectSettingsDialog.css";
import { authenticateRecovery, chooseRecoveryIdentity, recoveryIdentities, useSync } from "./syncManager";
import { tr } from "../../i18n/index.ts";

export function RecoveryActions({ state }: { state: string }) {
  const association = useSync(v => v.association);
  const [open, setOpen] = useState(false);
  const [identities, setIdentities] = useState<{ as: "creator" | "member"; username: string; profile?: string }[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [creator, setCreator] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (open && state === "choose-identity") void recoveryIdentities().then(setIdentities, () => setError(tr("Identity records can't be read right now. Please try again."))); }, [open, state]);
  if (state !== "needs-auth" && state !== "choose-identity") return null;
  return <>
    <button className="pc-sync-chip" data-pc="recovery-auth-open" onClick={() => setOpen(true)}>{state === "choose-identity" ? tr("Choose identity") : tr("Re-authenticate")}</button>
    {open && createPortal(<div className="pc-dialog-mask" role="presentation"><form className="pc-dialog pc-sync-dialog" role="dialog" aria-modal="true" aria-label={tr("Restore original collaboration identity")} onSubmit={async e => {
      e.preventDefault(); if (busy) return; setBusy(true); setError("");
      try { const r = await authenticateRecovery(username, password, creator ? "creator" : "member"); if (r.ok) { setPassword(""); setOpen(false); } else setError(r.error === "auth" ? tr("The original username or password is incorrect. Please enter them again.") : tr("Not restored yet. Check the collaboration status and try again.")); }
      catch { setError(tr("Can't restore this identity. Check the service address, the original room and permissions.")); }
      finally { setBusy(false); }
    }}>
      <div className="pc-dialog-title">{tr("Restore original collaboration identity")}</div>
      <div className="pc-dialog-body">
      <p className="pc-sync-hint" style={{ overflowWrap: "anywhere" }}>{tr("Service: {0}", association?.service)}<br />{tr("Room: {0}", association?.roomId)}</p>
      {state === "choose-identity" ? identities.map(r => <button key={`${r.profile}:${r.as}:${r.username}`} type="button" disabled={busy} onClick={async () => {
        setBusy(true); try { await chooseRecoveryIdentity(r.as, r.username, r.profile); setOpen(false); } catch { setError(tr("The selected identity could not be restored. Please try again.")); } finally { setBusy(false); }
      }}>{r.username} · {r.as === "creator" ? tr("creator") : tr("Members")} · {r.profile}</button>) : <>
        <div className="pc-sync-field"><label htmlFor="pc-recovery-username">{tr("Original username")}</label><input id="pc-recovery-username" className="pc-dialog-input" value={username} required maxLength={64} onChange={e => setUsername(e.target.value)} autoComplete="username" autoFocus placeholder={tr("Enter original username")} /></div>
        <div className="pc-sync-field"><label htmlFor="pc-recovery-password">{tr("Original password")}</label><input id="pc-recovery-password" className="pc-dialog-input" value={password} required type="password" onChange={e => setPassword(e.target.value)} autoComplete="current-password" placeholder={tr("Enter original password")} /></div>
        <label className="pc-sync-hint"><input type="checkbox" checked={creator} onChange={e => setCreator(e.target.checked)} />{tr("Enter as creator")}</label>
      </>}
      {error && <p className="pc-sync-err" role="alert">{error}</p>}</div>
      <div className="pc-dialog-foot"><button className="pc-btn" type="button" disabled={busy} onClick={() => { setPassword(""); setOpen(false); }}>{tr("Close")}</button>
      {state !== "choose-identity" && <button className="pc-btn pc-btn--primary" type="submit" disabled={busy}>{busy ? tr("Authenticating…") : tr("Authenticate and restore")}</button>}</div>
    </form></div>, document.body)}
  </>;
}

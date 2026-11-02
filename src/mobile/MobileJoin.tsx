/**
 * Mobile app "join a project via invite link" (semantics `workflow/editing.md` "The second screen on the LAN").
 *
 * The page reached by scanning the code was issued by the host, and the link carries the invite code and the document service path (`#invite=…&doc=…` in `src/online/invite.ts`),
 * so this screen **does not ask for a server address and needs no account**: it looks up which project this code belongs to, you enter a username (and a password if entry is restricted), and you are in.
 *
 * The logic is the same as the invite-link path of the desktop `editor/sync/JoinForm.tsx` (`resolveInvite` → `redeemInvite` → `enterShared`),
 * sharing its wording and candidate assembly instead of creating a second copy; only the rendering is changed to a single phone screen. The path of typing the project name plus a passphrase by hand is not offered on the phone for now
 * (scanning the code is the main scenario; typing by hand is left to the computer).
 */
import { useEffect, useRef, useState } from "react";
import { docBaseOf } from "../online/invite";
import { newProject } from "../editor/io/proc";
import { setActiveDraftId } from "../editor/io/drafts";
import { ensureDevice, enterShared } from "../editor/sync/syncManager";
import { client, errorStatus, type SharedMode } from "../editor/sync/sharedApi";
import { JOIN_TEXT, hostedCandidate } from "../editor/sync/JoinForm";
import { LogoMark } from "../ui/Logo";
import { tr } from "../i18n/index.ts";

type Phase =
  | { kind: "checking" }
  | { kind: "ok"; projectId: string; name: string; mode: SharedMode }
  | { kind: "dead"; text: string };

/** The username shape is the same rule as on desktop (1~64 characters, no control characters, no leading or trailing spaces) */
const usernameOk = (v: string) => v.length >= 1 && v.length <= 64 && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v);

export function MobileJoin({ invite, onJoined }: { invite: { code: string; doc: string }; onJoined: () => void }) {
  const base = docBaseOf(location.origin, invite.doc);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const started = useRef(false);

  // Look up which project this code belongs to (does not use up a redemption). Look up only once
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void ensureDevice();
    client.resolveInvite({ base, code: invite.code }).then(
      (p) => setPhase({ kind: "ok", projectId: p.projectId, name: p.name, mode: p.mode }),
      (e: unknown) => {
        const { status } = errorStatus(e);
        setPhase({ kind: "dead", text: status === 404 ? JOIN_TEXT.inviteInvalid : JOIN_TEXT.unreachable });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const needPassword = phase.kind === "ok" && phase.mode === "restricted";

  const submit = async () => {
    if (busy || phase.kind !== "ok") return;
    const user = username.trim();
    if (!user) return setMsg(JOIN_TEXT.needUsername);
    if (!usernameOk(user)) return setMsg(JOIN_TEXT.badUsername);
    if (needPassword && !password) return setMsg(JOIN_TEXT.needPassword);
    setBusy(true);
    setMsg(JOIN_TEXT.joining);
    try {
      const device = await ensureDevice();
      if (!device) return setMsg(JOIN_TEXT.unreachable);
      let red: Awaited<ReturnType<typeof client.redeemInvite>>;
      try {
        red = await client.redeemInvite({ base, code: invite.code, username: user, deviceId: device.deviceId });
      } catch (e) {
        const { status } = errorStatus(e);
        if (status === 404) { setPhase({ kind: "dead", text: JOIN_TEXT.inviteInvalid }); return; }
        setMsg(status === 401 ? JOIN_TEXT.kicked : JOIN_TEXT.unreachable);
        return;
      }
      // Before entering, swap in an empty project as the starting point: the content is whatever the document service has (same as desktop)
      newProject(tr("Untitled"));
      const candidate = hostedCandidate(base, red);
      const cred = red.mode === "free" && red.key
        ? { as: "member" as const, username: user, password: "", key: red.key }
        : { as: "member" as const, username: user, password };
      const r = await enterShared(candidate, cred);
      if (r.ok) { setActiveDraftId(null); onJoined(); return; }
      const text: Record<string, string> = {
        auth: JOIN_TEXT.auth,
        kicked: JOIN_TEXT.kicked,
        "no-project": JOIN_TEXT.noProject,
        unreachable: JOIN_TEXT.unreachable,
        "not-ready": JOIN_TEXT.unreachable,
      };
      setMsg(text[r.error] ?? JOIN_TEXT.unreachable);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor" data-pcm="join-invite">
      <div className="topbar">
        <div className="logo"><LogoMark size={18} /><span>Prompt<b>Cut</b></span></div>
      </div>
      <div className="home-body">
        <form className="ps-m-login-form" data-pcm="join-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="ps-m-login-head">
            <b>{tr("Join project")}</b>
            <span className="ps-m-login-sub" data-pcm="join-project">
              {phase.kind === "checking" ? tr("Checking this invite code…") : phase.kind === "ok" ? tr("\"{0}\"", phase.name) : tr("This invite code can't be used")}
            </span>
          </div>

          {phase.kind === "dead" && <div className="hint err" data-pcm="join-dead">{phase.text}</div>}

          {phase.kind === "ok" && (
            <>
              <div className="field">
                <label>{tr("Your name")}</label>
                <input className="text-in" name="username" autoComplete="nickname" autoFocus value={username}
                  data-pcm="join-username" onChange={(e) => { setUsername(e.target.value); setMsg(""); }} />
              </div>
              {needPassword && (
                <div className="field">
                  <label>{tr("Password")}</label>
                  <input className="text-in" name="password" type="password" autoComplete="current-password" value={password}
                    data-pcm="join-password" onChange={(e) => { setPassword(e.target.value); setMsg(""); }} />
                </div>
              )}
              {msg && <div className="hint" data-pcm="join-msg">{msg}</div>}
              <button type="submit" className="btn primary" data-pcm="join-submit" disabled={busy || !username.trim()}>
                {busy ? tr("Joining…") : tr("Join")}
              </button>
              <div className="ps-m-login-alt">{tr("This is the same project as on the computer. Changes sync in real time on both sides.")}</div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}

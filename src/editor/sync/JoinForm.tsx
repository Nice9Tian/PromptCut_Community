/**
 * Start page "Join someone else's project" (C10a contract `docs/plan/c10a-contract.md` section 4;
 * semantics `workflow/project.md` "Multi-user collaboration").
 * The desktop app and the online browser mode use the same component; they differ only in the
 * server address:
 * - Online page: this page's origin; the document service is at `<origin>/hosted/`;
 * - Desktop app: when typed by hand, use the built-in hosted address (the C6.5 default, editable),
 *   and, as in C6.5, also look for a same-named project on the LAN (a project hosted on this machine);
 * - Pasted invite link: take the link's origin.
 *
 * Three paths:
 * 1. Typed by hand, open entry: project name, project password, your own username;
 * 2. Typed by hand, restricted entry: project name, username and password from the list (same form
 *    as 1: the password box takes the project password for open entry, and the password from the
 *    list for restricted entry);
 * 3. By invite link: the page reads the invite code and first calls `resolve`, showing the project
 *    name; open entry needs only a username (`redeem` returns K of the project passphrase, then the
 *    handshake proceeds as usual), restricted entry needs the username and password from the list.
 *    If `resolve` fails, the full form is shown with the hint from table A.
 * There is also "I am the creator": the username is prefilled with the creator's name and greyed
 * out (if this device remembers it), only the creator password is entered, and entry is with
 * `as: 'creator'`.
 *
 * Text follows table A in section 14 of the contract. The invite code does not go into the query
 * string, is not written to localStorage, and does not enter logs (`src/online/invite.ts`).
 */
import { useEffect, useRef, useState } from "react";
import { ONLINE } from "../../online/mode";
import { docBaseOf, hostedDocBaseOf, hostedWsUrlOf, parseInviteLink, takeCapturedInvite } from "../../online/invite";
import { newProject } from "../io/proc";
import { setActiveDraftId } from "../io/drafts";
import { enterShared, ensureDevice, knownCreator, type EnterResult } from "./syncManager";
import { client, errorStatus, hosted, hostedTarget, route, type Candidate, type FindResult, type SharedMode } from "./sharedApi";
import { discoverViaEditor, readHostedUrl, uiHostedUrl, writeHostedUrl } from "./SharedDialogs";
import "./sync.css";
import { tr } from "../../i18n/index.ts";

/** Table A (contract section 14): copied verbatim */
export const JOIN_TEXT = {
  needName: tr("Enter a project name"),
  needPassword: tr("Enter a password"),
  needUsername: tr("Enter a username"),
  badUsername: tr("Invalid username format (1-64 characters, no control characters, no leading or trailing spaces)"),
  noProject: tr("Project not found. Check the project name."),
  auth: tr("Wrong username or password. If you've forgotten them, ask the creator."),
  kicked: tr("You were removed from this project by the creator. To come back, ask the creator to revoke it."),
  inviteInvalid: tr("This invite link is no longer valid. Ask the creator for a new one, or enter the project details manually."),
  oldLink: tr("This is an old-style invite link. Ask the creator for a new one (\"Revoke and regenerate invite code\" in settings), or enter the project details manually."),
  rateLimited: (sec: number | null) => (sec ? tr("Too many attempts. Try again in {0} seconds.", sec) : tr("Too many attempts. Please try again later.")),
  offline: tr("No network connection at the moment."),
  unreachable: tr("Can't reach the server. Please try again later."),
  joining: tr("Joining…"),
  badLink: tr("This is not a valid invite link."),
} as const;

/** Server-side username rule (`isUsername` in `server/auth/protocol.mjs`): the UI only runs the same pre-check */
export function usernameOk(v: string): boolean {
  return v.length > 0 && Array.from(v).length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(v) && v.trim() === v;
}

type InviteState =
  | { phase: "checking"; code: string; base: string }
  | { phase: "ok"; code: string; base: string; projectId: string; name: string; mode: SharedMode }
  | null;

/** Document service of the online page: `/hosted/` under this page's origin */
function onlineBase(): string {
  return hostedDocBaseOf(location.origin);
}

/**
 * Candidates built from origin and path: the WebSocket URL keeps its trailing slash (nginx, see `hostedWsUrlOf`).
 * The mobile app screen for joining via invite link (`src/mobile/MobileJoin.tsx`) shares this one.
 */
export function hostedCandidate(base: string, p: { projectId: string; name: string; mode: SharedMode }): Candidate {
  return { where: "hosted", base, ws: hostedWsUrlOf(base), projectId: p.projectId, name: p.name, mode: p.mode };
}

const candidateLabel = (c: Candidate) => (c.where === "hosted" ? tr("[Cloud] {0}", new URL(c.base).host) : tr("[Local · LAN] Host: {0}", c.hostDeviceName ?? new URL(c.base).host));

export function JoinForm({ onJoined }: { onJoined: () => void }) {
  const [invite, setInvite] = useState<InviteState>(null);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [asCreator, setAsCreator] = useState(false);
  const [paste, setPaste] = useState("");
  const [hostedUrl, setHostedUrl] = useState(() => (ONLINE ? "" : readHostedUrl()));
  const [showServer, setShowServer] = useState(false);
  const [choices, setChoices] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "err" | "info" } | null>(null);
  const [lockUntil, setLockUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const started = useRef(false);

  const locked = Math.max(0, Math.ceil((lockUntil - now) / 1000));
  useEffect(() => {
    if (lockUntil <= now) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [lockUntil, now]);

  const fail = (text: string) => setMsg({ text, tone: "err" });
  const rateLimited = (sec: number | null) => {
    fail(JOIN_TEXT.rateLimited(sec));
    setLockUntil(Date.now() + (sec ?? 60) * 1000);
    setNow(Date.now());
  };

  /** Look up the invite code (does not use up an attempt): on success show the project name and a compact form; on failure show the full form plus the Table A message */
  const checkInvite = async (code: string, base: string) => {
    setInvite({ phase: "checking", code, base });
    setMsg(null);
    try {
      const p = await client.resolveInvite({ base, code });
      setInvite({ phase: "ok", code, base, ...p });
      setAsCreator(false);
      setPassword("");
    } catch (e) {
      setInvite(null);
      const { status, retryAfter } = errorStatus(e);
      if (status === 404) fail(JOIN_TEXT.inviteInvalid);
      else if (status === 429) rateLimited(retryAfter);
      else fail(navigator.onLine === false ? JOIN_TEXT.offline : JOIN_TEXT.unreachable);
    }
  };

  // Invite code read at startup (`main.tsx` already cleared the fragment after reading `#invite=`): take it only once
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void ensureDevice();
    const got = takeCapturedInvite();
    if (!got) return;
    if (!("code" in got)) return fail(JOIN_TEXT.badLink);
    /*
     * The link itself says where the document service is (`doc=` in `online/invite.ts`): `/hosted/` for the hosted side,
     * `/docservice` for a LAN host. The origin is this page's own origin: a page opened by scanning a QR code
     * was served by that very host. A link without `doc=` is an old link and counts as expired.
     */
    if (!got.doc) return fail(JOIN_TEXT.oldLink);
    void checkInvite(got.code, docBaseOf(location.origin, got.doc));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const usePasted = () => {
    const parsed = parseInviteLink(paste);
    if (!parsed) return fail(JOIN_TEXT.badLink);
    // A pasted link carries its own origin and path, so follow it on both (a link without `doc=` is an old link and counts as expired)
    if (!parsed.doc) return fail(JOIN_TEXT.oldLink);
    setPaste("");
    void checkInvite(parsed.code, docBaseOf(parsed.origin, parsed.doc));
  };

  const creatorName = invite?.phase === "ok" ? knownCreator(invite.projectId) : null;

  /** Enter: start from a new empty project (the project content is whatever the document service has), then go into the editor once inside */
  const enter = async (candidate: Candidate, cred: { as: "member" | "creator"; username: string; password: string; key?: string }) => {
    newProject(tr("Untitled"));
    const r: EnterResult = await enterShared(candidate, cred);
    if (r.ok) {
      setActiveDraftId(null);
      onJoined();
      return true;
    }
    const text: Record<string, string> = {
      auth: JOIN_TEXT.auth,
      kicked: JOIN_TEXT.kicked,
      "no-project": JOIN_TEXT.noProject,
      unreachable: JOIN_TEXT.unreachable,
      "not-ready": JOIN_TEXT.unreachable,
    };
    if (r.error === "rate-limited") rateLimited(r.retryAfter ?? null);
    else fail(navigator.onLine === false ? JOIN_TEXT.offline : text[r.error] ?? JOIN_TEXT.unreachable);
    return false;
  };

  const submit = async () => {
    if (busy || locked > 0) return;
    const user = (asCreator && creatorName ? creatorName : username).trim();
    const viaInvite = invite?.phase === "ok" ? invite : null;
    const needPassword = asCreator || !viaInvite || viaInvite.mode === "restricted";
    if (!viaInvite && !name.trim()) return fail(JOIN_TEXT.needName);
    if (!user) return fail(JOIN_TEXT.needUsername);
    if (!usernameOk(user)) return fail(JOIN_TEXT.badUsername);
    if (needPassword && !password) return fail(JOIN_TEXT.needPassword);
    if (navigator.onLine === false) return fail(JOIN_TEXT.offline);
    setBusy(true);
    setMsg({ text: JOIN_TEXT.joining, tone: "info" });
    try {
      if (viaInvite) {
        const candidate = hostedCandidate(viaInvite.base, viaInvite);
        if (asCreator) {
          await enter(candidate, { as: "creator", username: user, password });
          return;
        }
        const device = await ensureDevice();
        if (!device) return fail(JOIN_TEXT.unreachable);
        let red: Awaited<ReturnType<typeof client.redeemInvite>>;
        try {
          red = await client.redeemInvite({ base: viaInvite.base, code: viaInvite.code, username: user, deviceId: device.deviceId });
        } catch (e) {
          const { status, retryAfter } = errorStatus(e);
          if (status === 404) {
            setInvite(null);
            return fail(JOIN_TEXT.inviteInvalid);
          }
          if (status === 401) return fail(JOIN_TEXT.kicked);
          if (status === 429) return rateLimited(retryAfter);
          return fail(JOIN_TEXT.unreachable);
        }
        const c = hostedCandidate(viaInvite.base, red);
        if (red.mode === "free" && red.key) await enter(c, { as: "member", username: user, password: "", key: red.key });
        else await enter(c, { as: "member", username: user, password });
        return;
      }
      // Manual entry: the online page only asks for this page's origin; the desktop app asks for the hosted address and also searches the LAN (the lookup in C6.5)
      let candidates: Candidate[];
      if (ONLINE) {
        const base = onlineBase();
        try {
          const p = await client.lookupProject({ base, name: name.trim() });
          candidates = [hostedCandidate(base, p)];
        } catch (e) {
          const { status } = errorStatus(e);
          return fail(status === 404 ? JOIN_TEXT.noProject : JOIN_TEXT.unreachable);
        }
      } else {
        let hostedChoice: string | null;
        try {
          hostedChoice = hostedUrl.trim() && hostedUrl.trim() !== hosted.DEFAULT_HOSTED_URL ? hosted.resolveHostedUrl({ ui: hostedUrl }) : null;
        } catch {
          return fail(JOIN_TEXT.unreachable);
        }
        writeHostedUrl(hostedUrl);
        const device = await ensureDevice();
        let r: FindResult;
        try {
          r = await route.findSharedProject({
            name: name.trim(),
            uiHostedUrl: hostedChoice ?? uiHostedUrl(),
            lan: device?.localEditor ? { discover: discoverViaEditor } : {},
          });
        } catch {
          r = { candidates: [], errors: [{ where: "hosted", reason: "unreachable" }] };
        }
        if (!r.candidates.length) {
          const hostedErr = r.errors.some((e) => e.where === "hosted");
          return fail(hostedErr ? JOIN_TEXT.unreachable : JOIN_TEXT.noProject);
        }
        candidates = r.candidates;
      }
      if (candidates.length > 1) {
        setChoices(candidates);
        setMsg(null);
        return;
      }
      await enter(candidates[0], { as: asCreator ? "creator" : "member", username: user, password });
    } finally {
      setBusy(false);
    }
  };

  const pick = async (c: Candidate) => {
    setChoices(null);
    setBusy(true);
    setMsg({ text: JOIN_TEXT.joining, tone: "info" });
    try {
      await enter(c, { as: asCreator ? "creator" : "member", username: (asCreator && creatorName ? creatorName : username).trim(), password });
    } finally {
      setBusy(false);
    }
  };

  const viaInvite = invite?.phase === "ok" ? invite : null;
  const fields = (() => {
    const onEnter = (e: React.KeyboardEvent) => {
      if (e.key === "Enter") void submit();
    };
    const userField = (label: string, placeholder: string, locked = false) => (
      <div className="pc-sync-field">
        <label htmlFor="pc-join-user">{label}</label>
        <input id="pc-join-user" className="pc-dialog-input" data-pc="join-username" value={locked && creatorName ? creatorName : username} disabled={locked && !!creatorName}
          placeholder={placeholder} maxLength={64} onChange={(e) => setUsername(e.target.value)} onKeyDown={onEnter} />
      </div>
    );
    const pwField = (label: string, placeholder: string) => (
      <div className="pc-sync-field">
        <label htmlFor="pc-join-pw">{label}</label>
        <input id="pc-join-pw" type="password" className="pc-dialog-input" data-pc="join-password" value={password} placeholder={placeholder}
          onChange={(e) => setPassword(e.target.value)} onKeyDown={onEnter} />
      </div>
    );
    if (viaInvite) {
      if (asCreator) return <>{userField(tr("Creator username"), tr("Creator's username"), true)}{pwField(tr("Creator password"), tr("Enter the creator password"))}</>;
      return viaInvite.mode === "free"
        ? userField(tr("Your username"), tr("Tell us your name"))
        : <>{userField(tr("Username"), tr("Enter a username from the list"))}{pwField(tr("Password"), tr("The matching password"))}</>;
    }
    return (
      <>
        <div className="pc-sync-field">
          <label htmlFor="pc-join-name">{tr("Project name")}</label>
          <input id="pc-join-name" className="pc-dialog-input" data-pc="join-name" value={name} placeholder={tr("The project name the creator gave you")} maxLength={64}
            onChange={(e) => setName(e.target.value)} onKeyDown={onEnter} />
        </div>
        {asCreator
          ? <>{userField(tr("Creator username"), tr("Creator's username"))}{pwField(tr("Creator password"), tr("Enter the creator password"))}</>
          : <>{userField(tr("Your username"), tr("Open entry: tell us your name; restricted entry: enter a username from the list"))}{pwField(tr("Password"), tr("Open entry: enter the project password; restricted entry: enter your password from the list"))}</>}
      </>
    );
  })();

  return (
    <div className="pc-join" data-pc="join-form">
      {invite?.phase === "checking" ? <div className="pc-sync-hint">{tr("Checking invite link…")}</div> : null}
      {viaInvite ? (
        <div className="pc-join-project" data-pc="join-invite-project">
          {tr("Project: ")}<b>{viaInvite.name}</b>
          <span className="pc-sync-hint">{viaInvite.mode === "free" ? tr("(open entry: just enter a username to join)") : tr("(restricted entry: enter your username and password from the list)")}</span>
        </div>
      ) : null}
      {choices ? (
        <div className="pc-sync-choices-v" data-pc="join-candidates">
          <div className="pc-sync-hint">{tr("Found several projects with the same name. Pick one:")}</div>
          {choices.map((c) => (
            <button key={c.base + c.projectId} type="button" className="pc-sync-choice" onClick={() => void pick(c)}>
              <span className="pc-sync-choice-dot" />
              <span className="pc-sync-choice-text">
                <b>{candidateLabel(c)}</b>
                <small>{c.name}</small>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="pc-join-fields">{fields}</div>
      )}
      <div className="pc-join-actions">
        <button type="button" className="pc-btn pc-btn--primary" data-pc="join-submit" disabled={busy || locked > 0 || invite?.phase === "checking"} onClick={() => void submit()}>
          {locked > 0 ? tr("Join ({0}s)", locked) : tr("Join")}
        </button>
        <button type="button" className="pc-sync-link-btn" data-pc="join-as-creator" onClick={() => { setAsCreator(!asCreator); setPassword(""); setMsg(null); setChoices(null); }}>
          {asCreator ? tr("Back") : tr("I'm the creator")}
        </button>
        {viaInvite ? (
          <button type="button" className="pc-sync-link-btn" onClick={() => { setInvite(null); setMsg(null); setAsCreator(false); }}>
            {tr("Enter project info manually")}
          </button>
        ) : null}
        {!ONLINE && !viaInvite && hostedTarget ? (
          <button type="button" className="pc-sync-link-btn" onClick={() => setShowServer(!showServer)}>
            {tr("Server address")}
          </button>
        ) : null}
      </div>
      {showServer && !ONLINE && !viaInvite && hostedTarget ? (
        <div className="pc-sync-field">
          <label htmlFor="pc-join-server">{tr("Hosted address")}</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input id="pc-join-server" className="pc-dialog-input" value={hostedUrl} onChange={(e) => setHostedUrl(e.target.value)} />
            <button type="button" className="pc-dialog-opt" style={{ height: 30 }} onClick={() => setHostedUrl(hosted.DEFAULT_HOSTED_URL)}>
              {tr("Restore default")}
            </button>
          </div>
        </div>
      ) : null}
      {msg ? <div className={`pc-sync-status-line${msg.tone === "err" ? " is-err" : ""}`} data-pc="join-message" role={msg.tone === "err" ? "alert" : undefined}>{msg.text}</div> : null}
      <div className="pc-join-paste">
        <label htmlFor="pc-join-link" className="pc-sync-hint">{tr("Have an invite link? Paste it here:")}</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="pc-join-link" className="pc-dialog-input" data-pc="join-link" value={paste} placeholder="https://…/editor#invite=…"
            onChange={(e) => setPaste(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") usePasted(); }} />
          <button type="button" className="pc-dialog-opt" data-pc="join-link-submit" style={{ height: 30, whiteSpace: "nowrap" }} disabled={!paste.trim() || busy} onClick={usePasted}>
            {tr("Join with link")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The login dialog of the online browser (issue #2, user 2026-11-03).
 *
 * Logged-out visitors land straight on the Vibe mode start page (`OnlineStart.tsx`); "Sign in" in the
 * top bar, and every action that needs an identity (say a sentence, new project, open a project,
 * expand the sidebar), open this dialog over the page. The website's homepage (VisuHive repo) shows
 * the same dialog with the same structure and copy, so keep the two in step.
 *
 * One dialog, several pages, flipped like a page turn (forward from the right edge, back from the
 * left; no animation under reduced motion):
 *   choose   — logo, "Sign in to VisuHive", Account login ›, the Google button (when the account
 *              service turns it on), Sign up with email › (when the client can register), terms line,
 *              then the low-key "Continue as guest" and "join with a project link".
 *   login    — account name + password + "Remember login state" (the old login page's behaviour).
 *   register — email sign-up. The account service has no email-only registration, so this runs its
 *              existing steps: `register(name,password)` (signs in) → `startEmail(email,password)`
 *              (sends a code) → page verify.
 *   verify   — the code → `confirmEmail(code)`. If sending failed the account is still made and signed
 *              in: say so, show the error, and offer to send again; "link it later" closes the dialog.
 *   pick     — first Google sign-in: Google gives no account name, so the user picks one.
 * Esc, the backdrop and × close it; focus stays inside and goes back to the opener.
 *
 * The old full-page login (`OnlineLogin.tsx` + `VibeLogin.tsx`) is archived, not deleted: it is
 * still reached with `?login=page` (see `OnlineStart.tsx`).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent, ReactNode } from "react";
import { LogoMark } from "../ui/Logo";
import { createAccountClient, type CloudAccountClient } from "../editor/sync/accountExtensions";
import { ensureDevice } from "../editor/sync/syncManager";
import { getLocale, tr } from "../i18n/index.ts";
import { accountErrorText } from "./accountErrors";
import "./loginDialog.css";

export type LoginDialogPage = "choose" | "login" | "register" | "verify" | "pick";

/** How deep a page sits: going deeper turns forward, going shallower turns back */
const DEPTH: Record<LoginDialogPage, number> = { choose: 0, login: 1, register: 1, pick: 1, verify: 2 };

export interface LoginDialogProps {
  onClose: () => void;
  /** Signed in now: the dialog closes by itself, except in the middle of email sign-up (verify page still to come) */
  signedIn: boolean;
  /** The business layer is working (`useAccountProjects().busy`) */
  busy: boolean;
  /** The business layer's error (`useAccountProjects().error`), shown on the login page */
  error: string;
  clearError: () => void;
  onLogin: (name: string, password: string, remember: boolean, link: string) => void;
  onGuest: (link: string) => void;
  /** The website session is already made (Google, email sign-up): have the business layer adopt it */
  onAdopt: (link: string) => Promise<unknown>;
  /** Probes and screenshots: open on this page */
  initialPage?: LoginDialogPage;
  /** Probes and screenshots: the verify page's state when opened on it */
  initialVerify?: VerifyState;
}

interface VerifyState {
  email: string;
  sent: boolean;
  error: string;
}

/* ---------------- Google's own script (same approach as the archived `OnlineLogin.tsx`) ---------------- */

/** `hl` pins the language of Google's own text; without it it follows the browser, not this page */
const gsiSrc = () => `https://accounts.google.com/gsi/client?hl=${encodeURIComponent(getLocale())}`;
/** The button still not drawn after this long counts as unavailable */
const BUTTON_WAIT_MS = 2500;

type GsiApi = {
  initialize(config: Record<string, unknown>): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
};

function loadGsi(): Promise<void> {
  const w = window as unknown as { google?: { accounts?: { id?: GsiApi } } };
  if (w.google?.accounts?.id) return Promise.resolve();
  if (document.querySelector('script[src^="https://accounts.google.com/gsi/client"]')) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = gsiSrc(); el.async = true; el.defer = true;
    el.addEventListener("load", () => resolve());
    el.addEventListener("error", () => reject(new Error("gsi")));
    document.head.append(el);
  });
}

/** The globals appear a little after the load event, so poll for them */
async function gsiApi(timeoutMs = 4000): Promise<GsiApi | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const api = (window as unknown as { google?: { accounts?: { id?: GsiApi } } }).google?.accounts?.id;
    if (api) return api;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => { window.setTimeout(r, 100); });
  }
}

type GoogleState = { kind: "loading" } | { kind: "off" } | { kind: "ready" } | { kind: "unavailable" };

/** Puts nodes into the `{0}`, `{1}` holes of a translated sentence */
function fill(text: string, nodes: ReactNode[]): ReactNode[] {
  return text.split(/(\{\d+\})/).map((part, i) => {
    const m = /^\{(\d+)\}$/.exec(part);
    return m ? <span key={i}>{nodes[Number(m[1])]}</span> : part;
  });
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function LoginDialog(props: LoginDialogProps): JSX.Element {
  const origin = typeof location !== "undefined" ? location.origin : "";
  const [page, setPage] = useState<LoginDialogPage>(props.initialPage ?? "choose");
  /** The page turning away, and which way: only while the animation runs */
  const [leaving, setLeaving] = useState<{ page: LoginDialogPage; dir: "fwd" | "back" } | null>(null);
  const [dir, setDir] = useState<"fwd" | "back" | null>(null);
  const [localError, setLocalError] = useState("");
  const [localBusy, setLocalBusy] = useState(false);

  // Fields
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [email, setEmail] = useState("");
  const [regName, setRegName] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regPassword2, setRegPassword2] = useState("");
  const [code, setCode] = useState("");
  const [pickName, setPickName] = useState("");
  const [link, setLink] = useState("");
  const [byLink, setByLink] = useState(false);
  const [verify, setVerify] = useState<VerifyState>(props.initialVerify ?? { email: "", sent: true, error: "" });
  const [resendEmail, setResendEmail] = useState(props.initialVerify?.email ?? "");
  const [needName, setNeedName] = useState<{ ticket: string; email: string | null } | null>(null);

  const [client, setClient] = useState<CloudAccountClient | null>(null);
  const [google, setGoogle] = useState<GoogleState>({ kind: "loading" });

  const card = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  /** Email sign-up in progress: being signed in must not close the dialog yet */
  const hold = useRef(false);
  /** The password of the account just made, kept only to send the code again */
  const regPasswordRef = useRef("");
  const rememberRef = useRef(remember); rememberRef.current = remember;
  const linkRef = useRef(link); linkRef.current = link;
  const adoptRef = useRef(props.onAdopt); adoptRef.current = props.onAdopt;
  const busy = props.busy || localBusy;

  /* ---------------- Open and close: focus in, focus back ---------------- */
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, []);

  // Each page takes the focus on its first field (or its first button)
  useLayoutEffect(() => {
    const here = card.current?.querySelector<HTMLElement>(`[data-ld-page="${page}"]`);
    const first = here?.querySelector<HTMLElement>("input:not([disabled]), button.ps-ld-choice, button.ps-primary-btn") ?? here?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus({ preventScroll: true });
  }, [page]);

  const closeRef = useRef(props.onClose); closeRef.current = props.onClose;
  useEffect(() => {
    if (props.signedIn && !hold.current) closeRef.current();
  }, [props.signedIn]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); props.onClose(); return; }
    if (e.key !== "Tab" || !card.current) return;
    const here = card.current.querySelector<HTMLElement>(`[data-ld-page="${page}"]`);
    const list = [
      ...card.current.querySelectorAll<HTMLElement>(".ps-ld-close"),
      ...(here ? here.querySelectorAll<HTMLElement>(FOCUSABLE) : []),
    ].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  /* ---------------- Page turn ---------------- */
  const go = (to: LoginDialogPage) => {
    if (to === page) return;
    setLocalError("");
    props.clearError();
    const d = DEPTH[to] >= DEPTH[page] ? "fwd" : "back";
    setDir(d);
    setLeaving({ page, dir: d });
    setPage(to);
  };
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setLeaving(null), 360);
    return () => window.clearTimeout(t);
  }, [leaving]);

  /* ---------------- Account client and Google ---------------- */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const device = await ensureDevice();
      if (!alive) return;
      if (!device) { setGoogle({ kind: "off" }); return; }
      const c = createAccountClient({ online: true, origin: location.origin, device });
      setClient(c);
      const providers = await c.thirdPartyProviders().catch(() => []);
      if (!alive) return;
      const g = providers.find((p) => p.provider === "google");
      if (!g) { setGoogle({ kind: "off" }); return; }
      try { await loadGsi(); } catch { if (alive) setGoogle({ kind: "unavailable" }); return; }
      const api = await gsiApi();
      if (!alive) return;
      if (!api || !slot.current) { setGoogle({ kind: "unavailable" }); return; }
      api.initialize({
        client_id: g.clientId,
        ux_mode: "popup",
        callback: async (response: { credential?: string }) => {
          if (!response?.credential) return;
          setLocalError(""); setLocalBusy(true);
          try {
            const result = await c.loginWithThirdParty("google", response.credential, rememberRef.current);
            if (!alive) return;
            if (result.kind === "need-name") { setNeedName({ ticket: result.ticket, email: result.email }); go("pick"); return; }
            await adoptRef.current(linkRef.current);
          } catch (e) {
            if (alive) setLocalError(accountErrorText(e, tr("Google sign-in failed. Please try again.")));
          } finally { if (alive) setLocalBusy(false); }
        },
      });
      const dark = document.documentElement.dataset.skinMode !== "light";
      api.renderButton(slot.current, {
        theme: dark ? "filled_black" : "outline", size: "large", shape: "pill", text: "continue_with",
        locale: getLocale(), width: 320, logo_alignment: "left",
      });
      setGoogle({ kind: "ready" });
      window.setTimeout(() => {
        if (alive && (slot.current?.getBoundingClientRect().height ?? 0) < 20) setGoogle({ kind: "unavailable" });
      }, BUTTON_WAIT_MS);
    })().catch(() => { if (alive) setGoogle({ kind: "off" }); });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const canRegister = !!client?.register;

  /* ---------------- Actions ---------------- */
  const submitLogin = () => {
    if (!name.trim() || !password || busy) return;
    props.onLogin(name.trim(), password, remember, link.trim());
  };

  const submitRegister = async () => {
    if (!client?.register || busy) return;
    if (regPassword !== regPassword2) { setLocalError(tr("The two passwords don’t match.")); return; }
    setLocalError(""); setLocalBusy(true);
    hold.current = true;
    const addr = email.trim();
    try {
      await client.register(regName.trim(), regPassword);
    } catch (e) {
      hold.current = false;
      setLocalError(accountErrorText(e, tr("Sign-up failed. Please try again.")));
      setLocalBusy(false);
      return;
    }
    regPasswordRef.current = regPassword;
    setResendEmail(addr);
    try { await props.onAdopt(link.trim()); } catch { /* the business layer shows its own error */ }
    let next: VerifyState = { email: addr, sent: false, error: "" };
    if (client.startEmail) {
      try { await client.startEmail(addr, regPassword); next = { email: addr, sent: true, error: "" }; }
      catch (e) { next = { email: addr, sent: false, error: accountErrorText(e, tr("Couldn’t send the code. Please try again.")) }; }
    }
    setVerify(next);
    setLocalBusy(false);
    go("verify");
  };

  const resend = async () => {
    if (!client?.startEmail || busy || !resendEmail.trim()) return;
    setLocalError(""); setLocalBusy(true);
    const addr = resendEmail.trim();
    try {
      await client.startEmail(addr, regPasswordRef.current);
      setVerify({ email: addr, sent: true, error: "" });
    } catch (e) {
      setVerify({ email: addr, sent: false, error: accountErrorText(e, tr("Couldn’t send the code. Please try again.")) });
    } finally { setLocalBusy(false); }
  };

  const confirm = async () => {
    if (!client?.confirmEmail || busy || !code.trim()) return;
    setLocalError(""); setLocalBusy(true);
    try {
      await client.confirmEmail(code.trim());
      hold.current = false;
      props.onClose();
    } catch (e) {
      setLocalError(accountErrorText(e, tr("The code is wrong or has expired.")));
    } finally { setLocalBusy(false); }
  };

  const createWithGoogle = async () => {
    if (!needName || !client || busy || !pickName.trim()) return;
    setLocalError(""); setLocalBusy(true);
    try {
      await client.registerWithThirdParty(needName.ticket, pickName.trim(), rememberRef.current);
      await props.onAdopt(link.trim());
    } catch (e) {
      setLocalError(accountErrorText(e, tr("Failed to create the account. Please try again.")));
    } finally { setLocalBusy(false); }
  };

  const finishLater = () => { hold.current = false; props.onClose(); };

  /* ---------------- Pieces ---------------- */
  const errorLine = (text: string) => text
    ? <p className="ps-ld-error" role="alert" data-pc="start-login-error">{text}</p>
    : null;
  /** `back` false: the verify page, where the account is already made and there is nothing to go back to */
  const head = (title: string, lead?: ReactNode, back = true) => (
    <div className="ps-ld-head">
      {back ? (
        <button type="button" className="ps-ld-back" data-pc="start-login-back" onClick={() => go("choose")} aria-label={tr("Back")} title={tr("Back")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
          <span>{tr("Back")}</span>
        </button>
      ) : null}
      <h2 className="ps-ld-title" id={`ps-ld-title-${page}`}>{title}</h2>
      {lead ? <p className="ps-ld-lead">{lead}</p> : null}
    </div>
  );
  const chevron = <svg className="ps-ld-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>;
  const pageClass = (p: LoginDialogPage) => {
    if (p === page) return `ps-ld-page is-current${dir ? ` is-in-${dir}` : ""}`;
    if (leaving?.page === p) return `ps-ld-page is-out-${leaving.dir}`;
    return "ps-ld-page";
  };
  const pageProps = (p: LoginDialogPage) => ({
    className: pageClass(p),
    "data-ld-page": p,
    hidden: p !== page && leaving?.page !== p,
    "aria-hidden": p !== page || undefined,
    inert: p !== page ? true : undefined,
  });

  return (
    <div className="ps-ld-mask" data-pc="start-login-dialog-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div
        ref={card}
        className="ps-ld"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`ps-ld-title-${page}`}
        data-pc="start-login-dialog"
        data-page={page}
        data-busy={busy || undefined}
        onKeyDown={onKeyDown}
      >
        <button type="button" className="ps-ld-close" data-pc="start-login-close" aria-label={tr("Close")} title={tr("Close")} onClick={props.onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>

        <div className="ps-ld-stage">
          {/* ── choose ── */}
          <section {...pageProps("choose")}>
            <div className="ps-ld-brand">
              <LogoMark size={36} />
              <h2 className="ps-ld-title" id="ps-ld-title-choose">{tr("Sign in to VisuHive")}</h2>
              <p className="ps-ld-lead">{tr("One account for the website, web app and desktop app")}</p>
            </div>
            <div className="ps-ld-choices">
              <button type="button" className="ps-ld-choice" data-pc="start-login-account" onClick={() => go("login")}>
                <svg className="ps-ld-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6" /><path d="M4.8 19.5c1.2-3.3 4-5 7.2-5s6 1.7 7.2 5" /></svg>
                <span>{tr("Account login")}</span>
                {chevron}
              </button>
              {/* Google draws this button itself (brand rules); the slot stays mounted so the effect can draw into it */}
              <div className="ps-ld-google" data-pc="start-login-google" data-state={google.kind} ref={slot} aria-busy={localBusy && page === "choose"} />
              {google.kind === "unavailable" ? <p className="ps-ld-note" data-pc="start-login-google-off">{tr("Can’t reach Google right now. Use account login or sign up with email instead.")}</p> : null}
              {canRegister ? (
                <button type="button" className="ps-ld-choice" data-pc="start-login-register" onClick={() => go("register")}>
                  <svg className="ps-ld-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="M4.5 7l7.5 6 7.5-6" /></svg>
                  <span>{tr("Sign up with email")}</span>
                  {chevron}
                </button>
              ) : null}
            </div>
            {page === "choose" ? errorLine(localError) : null}
            <p className="ps-ld-terms">
              {fill(tr("By continuing you accept the {0} and have read the {1}."), [
                <a key="t" className="ps-link" href={`${origin}/terms`} target="_blank" rel="noopener noreferrer">{tr("Terms of Service")}</a>,
                <a key="p" className="ps-link" href={`${origin}/privacy`} target="_blank" rel="noopener noreferrer">{tr("Privacy Policy")}</a>,
              ])}
            </p>
            <div className="ps-ld-alt">
              <button type="button" className="ps-ld-quiet" data-pc="start-login-guest" disabled={busy} onClick={() => props.onGuest(link.trim())}>
                {tr("Continue as guest")}
              </button>
              {byLink ? (
                <label className="ps-field ps-ld-link">
                  {tr("Project link")}
                  <input type="text" placeholder={tr("Paste the cloud project link someone gave you")} value={link} data-pc="start-login-link" onChange={(e) => setLink(e.target.value)} />
                </label>
              ) : (
                <button type="button" className="ps-ld-quiet" data-pc="start-login-by-link" onClick={() => setByLink(true)}>
                  {tr("Join someone else's project with a project link")}
                </button>
              )}
            </div>
          </section>

          {/* ── login ── */}
          <section {...pageProps("login")}>
            {head(tr("Account login"))}
            <form className="ps-ld-form" data-pc="start-login-form" onSubmit={(e) => { e.preventDefault(); submitLogin(); }}>
              <label className="ps-field">
                {tr("Account name")}
                <input name="username" autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="ps-field">
                {tr("Password")}
                <input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              <label className="ps-check">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                {tr("Remember login state")}
              </label>
              {page === "login" ? errorLine(localError || props.error) : null}
              <button className="ps-primary-btn ps-ld-submit" data-pc="start-login-submit" disabled={!name.trim() || !password || busy}>
                {busy ? tr("Signing in…") : tr("Sign in")}
              </button>
            </form>
            <div className="ps-ld-foot">
              <a className="ps-link" href={`${origin}/reset`} target="_blank" rel="noopener noreferrer">{tr("Forgot password")}</a>
              {canRegister ? <button type="button" className="ps-link" data-pc="start-login-to-register" onClick={() => go("register")}>{tr("No account? Sign up with email")}</button> : null}
            </div>
          </section>

          {/* ── register (email sign-up) ── */}
          <section {...pageProps("register")}>
            {head(tr("Sign up with email"))}
            <form className="ps-ld-form" data-pc="start-register-form" onSubmit={(e) => { e.preventDefault(); void submitRegister(); }}>
              <label className="ps-field">
                {tr("Email")}
                <input name="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <label className="ps-field">
                {tr("Account name")}
                <input name="new-username" autoComplete="username" value={regName} onChange={(e) => setRegName(e.target.value)} aria-describedby="ps-ld-name-hint" />
                <span className="ps-ld-hint" id="ps-ld-name-hint">{tr("3–24 characters: letters, digits, _ or -. Unique across the site and can’t be changed later.")}</span>
              </label>
              <label className="ps-field">
                {tr("Password")}
                <input name="new-password" type="password" autoComplete="new-password" value={regPassword} onChange={(e) => setRegPassword(e.target.value)} />
              </label>
              <label className="ps-field">
                {tr("Re-enter password")}
                <input name="new-password-2" type="password" autoComplete="new-password" value={regPassword2} onChange={(e) => setRegPassword2(e.target.value)} />
              </label>
              {page === "register" ? errorLine(localError) : null}
              <button className="ps-primary-btn ps-ld-submit" data-pc="start-register-submit" disabled={!email.trim() || !regName.trim() || !regPassword || !regPassword2 || busy}>
                {busy ? tr("Signing up…") : tr("Sign up and send code")}
              </button>
            </form>
            <div className="ps-ld-foot ps-ld-foot-center">
              <button type="button" className="ps-link" data-pc="start-register-to-login" onClick={() => go("login")}>{tr("Already have an account? Sign in")}</button>
            </div>
          </section>

          {/* ── verify ── */}
          <section {...pageProps("verify")}>
            {head(tr("Verify your email"), verify.sent ? tr("We sent a code to {0}. It’s valid for 10 minutes.", verify.email) : tr("Your account is ready and you’re signed in."), false)}
            {verify.sent ? (
              <form className="ps-ld-form" data-pc="start-verify-form" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
                <label className="ps-field">
                  {tr("Verification code")}
                  <input name="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
                </label>
                {page === "verify" ? errorLine(localError) : null}
                <button className="ps-primary-btn ps-ld-submit" data-pc="start-verify-submit" disabled={!code.trim() || busy}>
                  {busy ? tr("Checking…") : tr("Done")}
                </button>
              </form>
            ) : (
              <form className="ps-ld-form" data-pc="start-verify-resend" onSubmit={(e) => { e.preventDefault(); void resend(); }}>
                {verify.error ? errorLine(verify.error) : null}
                <label className="ps-field">
                  {tr("Email")}
                  <input name="email" type="email" autoComplete="email" value={resendEmail} onChange={(e) => setResendEmail(e.target.value)} />
                </label>
                {page === "verify" ? errorLine(localError) : null}
                <button className="ps-primary-btn ps-ld-submit" data-pc="start-verify-send" disabled={!resendEmail.trim() || busy || !client?.startEmail}>
                  {busy ? tr("Sending…") : tr("Send code")}
                </button>
              </form>
            )}
            <div className="ps-ld-foot ps-ld-foot-center">
              <button type="button" className="ps-link" data-pc="start-verify-later" onClick={finishLater}>{tr("Link it later on your account page")}</button>
            </div>
          </section>

          {/* ── pick (first Google sign-in) ── */}
          <section {...pageProps("pick")}>
            {head(tr("Choose an account name"), tr("Signing in with {0}. Account names are unique and can’t be changed for now.", needName?.email ?? "Google"))}
            <form className="ps-ld-form" data-pc="start-login-google-name" onSubmit={(e) => { e.preventDefault(); void createWithGoogle(); }}>
              <label className="ps-field">
                {tr("Account name")}
                <input name="pick-username" autoComplete="username" value={pickName} onChange={(e) => setPickName(e.target.value)} />
              </label>
              {page === "pick" ? errorLine(localError) : null}
              <button className="ps-primary-btn ps-ld-submit" data-pc="start-login-google-create" disabled={!pickName.trim() || busy || !needName}>
                {busy ? tr("Creating account…") : tr("Create account")}
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}

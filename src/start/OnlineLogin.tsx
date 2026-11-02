/**
 * Login page of the online browser (desktop identity).
 *
 * Login used to be a small form on the start page (`src/account/AccountProjects.tsx`), crowded in
 * with "New cloud project" and "Join by link". Here it is split into its own page: users see it
 * first when not logged in, and only reach the start page after a successful login. In the online
 * browser, projects are always cloud multi-user collaboration projects (`product/platforms.md`,
 * "Projects that can be created in the cloud"), so an account is the precondition for getting in.
 *
 * **Only "Continue with Google" is real** (wired up 2026-10-23): it really sends requests to the
 * account service, really establishes a session, and really exchanges for an editor token. The
 * account name + password path, the guest path and the project link path still only run the UI;
 * submitting sends no request.
 * This is the result of splitting work between two sessions: this page's UI and the other paths
 * belong to someone else, while the third-party login path belongs to `claude/editor-google-login`,
 * which changes only the Google part of this page and leaves the rest alone.
 *
 * The second half of the Google path is the same as password login: first establish the website
 * session (cookie), then `client.ensureLogin()` exchanges for an editor token
 * (`/api/account/editor/session`). So the account service has no separate endpoint for the editor.
 *
 * TODO (business layer):
 * - Hook up `login` of `src/account/useAccountProjects.ts` (the account service is in the VisuHive
 *   repo, see the role table in `architecture.md`);
 * - "Remember login state" is the checkbox that only online pages have (`workflow/project.md`,
 *   "Online browser and website share login");
 * - When the website is already logged in, this page should be skipped directly instead of asking
 *   again;
 * - The entry for guest identity (a random ID and avatar are assigned on entry) sits in the "or"
 *   section below (user requested on 2026-10-23 that both login pages have it). **The button is
 *   only the entry; the random ID and avatar logic still belongs to another session**
 *   (`random guest identity assignment`); until that is hooked up, this button, like the rest of
 *   this page, goes through `onDone()`: the whole page is currently a UI stub, and login sends no
 *   request.
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Logo } from "../ui/Logo";
import { BrandLoop } from "./BrandLoop";
import { createAccountClient, type CloudAccountClient } from "../editor/sync/accountExtensions";
import { ensureDevice } from "../editor/sync/syncManager";
import { tr } from "../i18n/index.ts";

/**
 * Google's own script. `hl` must be passed: without it, the button text follows the browser
 * language, and Japanese shows up on a Chinese UI (observed on the website side on 2026-10-23).
 * The button is drawn by Google itself, not hand-made, to avoid violating its brand guidelines.
 */
const GSI_SRC = "https://accounts.google.com/gsi/client?hl=zh-CN";
/**
 * If the button still hasn't been drawn after this long, treat the Google part as unavailable and
 * show a note.
 *
 * **What it catches is "the button wasn't drawn at all"** (script blocked, GIS internal error), not
 * "origin not authorized": in the 2026-10-23 test, when the origin was not authorized, `gsi/button`
 * returned 403 but GIS still drew the button itself, and only when the user clicked did Google
 * itself pop up a dialog saying "Access blocked: authorization error ... Error 400:
 * origin_mismatch". We can neither block nor detect that case on our side; the only way is to get
 * the origins configured correctly at deploy time (see docs/third-party-login.md in VisuHive).
 */
const BUTTON_WAIT_MS = 2500;

declare global {
  interface Window { google?: { accounts?: { id?: {
    initialize(config: Record<string, unknown>): void;
    renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  } } } }
}

/**
 * Put Google's script into the page. If it is already loading, don't add it again: in that case
 * **don't wait for its load event**: the event may have passed before we attached the listener, and
 * waiting would hang forever. Once it is installed, hand over to the `gsiApi()` polling below.
 */
function loadGsi(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = GSI_SRC; el.async = true; el.defer = true;
    el.addEventListener("load", () => resolve());
    el.addEventListener("error", () => reject(new Error("gsi")));
    document.head.append(el);
  });
}

/**
 * Wait until `window.google.accounts.id` really appears.
 * There is a gap between the script's load event and the moment it installs its globals; checking
 * only once would misjudge it as "not loaded" (hit during a real run on 2026-10-23).
 */
async function gsiApi(timeoutMs = 4000): Promise<NonNullable<NonNullable<NonNullable<Window["google"]>["accounts"]>["id"]> | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const api = window.google?.accounts?.id;
    if (api) return api;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => { window.setTimeout(r, 100); });
  }
}

/** State of the Google part: if the backend is off, hide the whole part; if it can't connect or the origin isn't authorized, show a note */
type GoogleState =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "ready" }
  | { kind: "unavailable"; message: string };

/**
 * `onThirdPartyDone` is an exit **dedicated** to the Google path: it is not the same thing as
 * `onDone()`. `onDone()` is used by the outer layer (`VibeLogin.tsx`) to ask "which button was just
 * pressed, and what was filled in the form", while Google's button is drawn by Google itself in a
 * cross-origin iframe, so the outer layer never receives that click. So going through `onDone()`
 * after a successful third-party login would be dropped by the outer layer as "no exit":
 * the "nothing happens after authorizing" reported by the user on 2026-10-24 was exactly this. Give
 * it its own exit, and the outer layer recognizes the session through it.
 * When this prop is not passed, fall back to `onDone()` (desktop and elsewhere stay as they were).
 */
export function OnlineLogin(props: { onDone: () => void; onThirdPartyDone?: () => void }): JSX.Element {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [link, setLink] = useState("");
  const [byLink, setByLink] = useState(false);
  const origin = typeof location !== "undefined" ? location.origin : "";

  // -- Google login --
  const [google, setGoogle] = useState<GoogleState>({ kind: "loading" });
  /** First time using this Google account: Google doesn't give an account name, so the user has to pick one */
  const [needName, setNeedName] = useState<{ ticket: string; email: string | null } | null>(null);
  const [googleName, setGoogleName] = useState("");
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState("");
  const slot = useRef<HTMLDivElement>(null);
  const client = useRef<CloudAccountClient | null>(null);
  // The callback is registered with Google inside an effect, and the closure pins these two to the first render's values, so read the current ones through a ref
  const rememberRef = useRef(remember); rememberRef.current = remember;
  const onDoneRef = useRef(props.onDone); onDoneRef.current = props.onDone;
  const thirdPartyRef = useRef(props.onThirdPartyDone); thirdPartyRef.current = props.onThirdPartyDone;
  /** Where to go after a successful third-party login: use the dedicated exit if there is one, otherwise fall back to `onDone()` */
  const thirdPartyDone = () => { (thirdPartyRef.current ?? onDoneRef.current)(); };

  useEffect(() => {
    let alive = true;
    void (async () => {
      const device = await ensureDevice();
      if (!alive) return;
      if (!device) return setGoogle({ kind: "off" });
      const c = createAccountClient({ online: true, origin: location.origin, device });
      client.current = c;
      // Backend off (no client ID configured), or backend is an old version without this endpoint: both return an empty array, and the whole part is hidden
      const providers = await c.thirdPartyProviders();
      if (!alive) return;
      const google = providers.find((p) => p.provider === "google");
      if (!google) return setGoogle({ kind: "off" });

      try { await loadGsi(); } catch {
        // Being unable to reach Google (offline, blocked, script blocked) must not trap people on this page: show a note, and account/password and guest still work as usual
        if (alive) setGoogle({ kind: "unavailable", message: tr("Can't reach Google. Use an account name and password, or enter as a guest.") });
        return;
      }
      const api = await gsiApi();
      if (!alive) return;
      if (!api || !slot.current) return setGoogle({ kind: "unavailable", message: tr("Google sign-in failed to load. Use an account name and password.") });

      api.initialize({
        client_id: google.clientId,
        ux_mode: "popup",
        callback: async (response: { credential?: string }) => {
          if (!response?.credential || !client.current) return;
          setGoogleError(""); setGoogleBusy(true);
          try {
            const result = await client.current.loginWithThirdParty("google", response.credential, rememberRef.current);
            if (!alive) return;
            if (result.kind === "need-name") { setNeedName({ ticket: result.ticket, email: result.email }); return; }
            thirdPartyDone();
          } catch (e) {
            if (alive) setGoogleError(e instanceof Error ? e.message : tr("Google sign-in failed. Please try again."));
          } finally { if (alive) setGoogleBusy(false); }
        },
      });
      api.renderButton(slot.current, {
        theme: "filled_black", size: "large", shape: "rectangular", text: "continue_with",
        locale: document.documentElement.lang || "zh-CN", width: 320,
      });
      setGoogle({ kind: "ready" });
      // When the button isn't drawn (script blocked, GIS internal error), don't leave just a blank block that can't be clicked
      window.setTimeout(() => {
        if (!alive) return;
        if ((slot.current?.getBoundingClientRect().height ?? 0) < 20) {
          setGoogle({ kind: "unavailable", message: tr("Google sign-in failed to display. Use an account name and password, or enter as a guest.") });
        }
      }, BUTTON_WAIT_MS);
    })().catch(() => { if (alive) setGoogle({ kind: "off" }); });
    return () => { alive = false; };
  }, []);

  async function createWithGoogle() {
    if (!needName || !client.current || !googleName.trim()) return;
    setGoogleError(""); setGoogleBusy(true);
    try {
      await client.current.registerWithThirdParty(needName.ticket, googleName.trim(), rememberRef.current);
      thirdPartyDone();
    } catch (e) {
      setGoogleError(e instanceof Error ? e.message : tr("Failed to create the account. Please try again."));
    } finally { setGoogleBusy(false); }
  }

  return (
    <div className="ps-login" data-pc="start-login">
      <section className="ps-login-art">
        <BrandLoop />
        <div>
          <Logo size={26} />
          <h1 className="ps-login-art-title">{tr("Edit videos right in your browser")}</h1>
          <p className="ps-login-art-sub">
            {tr("Your projects, media and prerender output all live in the cloud. Sign in to the same account on another device and pick up the edit where you left off.")}
          </p>
        </div>
        <span className="ps-login-art-foot">{tr("PromptCut · Online edition")}</span>
      </section>

      <section className="ps-login-panel">
        <form
          className="ps-login-form"
          data-pc="start-login-form"
          onSubmit={(e) => {
            e.preventDefault();
            // TODO: call the account service here. For now only the UI runs; filling it in counts as passing
            props.onDone();
          }}
        >
          <div className="ps-login-head">
            <h2 className="ps-login-title">{tr("Sign in")}</h2>
            <span className="ps-muted">{tr("Your website account works here too.")}</span>
          </div>

          <label className="ps-field">
            {tr("Account name")}
            <input name="username" autoComplete="username" required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="ps-field">
            {tr("Password")}
            <input name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>

          <label className="ps-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {tr("Remember login state")}
          </label>

          <button className="ps-primary-btn" data-pc="start-login-submit" disabled={!name || !password}>
            {tr("Sign in")}
          </button>

          <div className="ps-login-alt">
            <a className="ps-link" href={`${origin}/account`} target="_blank" rel="noopener noreferrer">{tr("Sign up")}</a>
            <a className="ps-link" href={`${origin}/account`} target="_blank" rel="noopener noreferrer">{tr("Forgot password")}</a>
          </div>

          <div className="ps-login-sep">{tr("or")}</div>

          {/*
            Third-party login. The semantics conflict has been resolved: `product/document-service.md` line 66
            was updated on 2026-10-23 to "In addition to username and password, cloud website accounts also
            support signing in with a Google account" (ef68582b on main).

            The button is rendered into the slot below by Google's own script; we do not build our own: its
            brand guidelines dictate graphics, copy, and color scheme. When the backend has not enabled this,
            the entire section is hidden (`thirdPartyProviders()` returns empty); when unreachable or origin
            is unauthorized, an explanation is displayed: no blank state and no silent failure, with neither
            username/password nor guest paths affected.

            Backend is in the VisuHive repository: `/third-party/*` in `account/app.mjs`, and token signature
            verification is in its `identity/` service.
          */}
          <div className="ps-login-oauth" data-pc="start-login-oauth">
            {needName ? (
              // First time using this Google account: Google doesn't give an account name, and website account names are unique site-wide, so the user has to pick one
              <div className="ps-field" data-pc="start-login-google-name">
                <span className="ps-muted">
                  {tr("{0}Pick an account name. It must be unique across the site and cannot be changed later.", needName.email ? tr("Signing in with {0}.", needName.email) : tr("Almost done."))}
                </span>
                <input
                  autoComplete="username"
                  placeholder={tr("Account name")}
                  value={googleName}
                  disabled={googleBusy}
                  onChange={(e) => setGoogleName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createWithGoogle(); } }}
                />
                <button
                  type="button"
                  className="ps-primary-btn"
                  data-pc="start-login-google-create"
                  disabled={googleBusy || !googleName.trim()}
                  onClick={() => void createWithGoogle()}
                >
                  {googleBusy ? tr("Creating account…") : tr("Create account with this name")}
                </button>
              </div>
            ) : (
              <>
                {/*
                  Google renders the button here. **This slot must remain mounted**: the effect renders into
                  `slot.current`; removing it based on state creates a chicken-and-egg problem: removed before the
                  result is returned, then when it's time to render, the slot is gone (encountered during a real run
                  on 2026-10-23: hot reload preserved the `off` state, and subsequent effect runs could not render
                  into it). When the backend has it disabled, it is a zero-height empty div, invisible; likewise
                  when the origin is unauthorized, covered by the explanation below.
                */}
                <div ref={slot} data-pc="start-login-google" aria-busy={googleBusy} />
                {google.kind === "unavailable" ? (
                  <span className="ps-muted" data-pc="start-login-google-off">{google.message}</span>
                ) : null}
              </>
            )}
            {googleError ? (
              <span className="ps-muted" role="alert" data-pc="start-login-google-error">{googleError}</span>
            ) : null}
          </div>

          {/* Entry for guest identity (user, 2026-10-23). Uses the same look as the button above, so the two rows line up */}
          <button type="button" className="ps-oauth-btn" data-pc="start-login-guest" onClick={props.onDone}>
            <span className="ps-oauth-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
                <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 1.8c-4 0-7 2-7 4.4V20h14v-1.8c0-2.4-3-4.4-7-4.4Z" />
              </svg>
            </span>
            {tr("Enter as a guest")}
          </button>

          {byLink ? (
            <label className="ps-field">
              {tr("Project link")}
              <input
                type="text"
                placeholder={tr("Paste the cloud project link someone gave you")}
                value={link}
                data-pc="start-login-link"
                onChange={(e) => setLink(e.target.value)}
              />
            </label>
          ) : (
            <button type="button" className="ps-ghost-btn" data-pc="start-login-by-link" onClick={() => setByLink(true)}>
              {tr("Join someone else's project with a project link")}
            </button>
          )}

        </form>
      </section>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./CollectLoginDialog.css";
import { showAgentWebview, hideAgentWebview, rectOf } from "../../ai/shellBrowser";
import {
  closeCollectLogin, useCollectLoginState, type LoginMethod,
} from "../../ai/collectLoginStore";
import {
  qrStart, qrPoll, collectLogin, collectLoginCheck, collectLogout, cookieStatus,
  type QrPollResult, type SiteCookieStatus,
} from "../../ai/collect";
import { tr } from "../../i18n/index.ts";

const SITE_NAMES: Record<string, string> = { bilibili: tr("Bilibili") };

/**
 * Site login dialog. Two paths with the same result (the login state is stored as cookies.txt, and media
 * collection picks it up automatically afterwards):
 *
 *   - QR code: the server calls the site's QR code login interface, and the QR code is drawn right in this
 *     dialog, without opening a browser. Fastest, but only supports scanning.
 *   - Browser: opens the site's real login page (the Chrome the agent uses); account and password, SMS and
 *     QR scan all work, and CAPTCHAs can be passed too: that page belongs to the site itself, and we never
 *     touch anything the user types. Once the login is done, the dialog polls the login state and closes
 *     the window.
 *
 * Mounted on body (portal), because overflow:hidden on the right rail would clip it.
 */
export function CollectLoginDialog() {
  const st = useCollectLoginState();
  if (!st.open) return null;
  // key uses seq: every open is a brand-new instance, which does not carry over the last QR code or state
  return <Dialog key={st.seq} site={st.site} initialMethod={st.method} onClose={closeCollectLogin} />;
}

function Dialog(props: { site: string; initialMethod: LoginMethod; onClose: () => void }) {
  const { site, initialMethod, onClose } = props;
  const [method, setMethod] = useState<LoginMethod>(initialMethod);
  const [saved, setSaved] = useState<SiteCookieStatus | null>(null);
  const name = SITE_NAMES[site] ?? site;

  const refreshSaved = useCallback(async () => {
    try { setSaved((await cookieStatus())[site] ?? null); } catch { /* If it cannot be found, show nothing */ }
  }, [site]);
  useEffect(() => { void refreshSaved(); }, [refreshSaved]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loggedIn = !!saved?.loggedIn;

  return createPortal(
    <div className="cl-backdrop" onClick={onClose}>
      <div className="cl-dialog" role="dialog" aria-modal="true" aria-label={tr("Log in to {0}", name)} onClick={(e) => e.stopPropagation()}>
        <div className="cl-head">
          <div className="cl-title">{tr("Log in to {0}", name)}</div>
          <button className="cl-x" onClick={onClose} aria-label={tr("Close")}>×</button>
        </div>
        <div className="cl-hint">
          {tr("Logging in unlocks the resolutions that require a login ({0}). The login state is stored only on this machine; delete it to log out.", name === tr("Bilibili") ? tr("1080p60 / 4K etc., premium membership required") : tr("those the site specifies"))}
        </div>

        {loggedIn ? (
          <LoggedIn saved={saved!} site={site} onChanged={refreshSaved} />
        ) : (
          <>
            <div className="cl-tabs" role="tablist">
              <button role="tab" aria-selected={method === "qr"} className={method === "qr" ? "is-active" : ""} onClick={() => setMethod("qr")}>{tr("Log in with QR code")}</button>
              <button role="tab" aria-selected={method === "browser"} className={method === "browser" ? "is-active" : ""} onClick={() => setMethod("browser")}>{tr("Password / SMS")}</button>
            </div>
            {method === "qr"
              ? <QrPane site={site} onLoggedIn={refreshSaved} />
              : <BrowserPane site={site} onLoggedIn={refreshSaved} />}
          </>
        )}

        <div className="cl-actions">
          <button className="cl-btn" onClick={onClose}>{loggedIn ? tr("Done") : tr("Cancel")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Logged in: show the account and expiry time, and offer a logout */
function LoggedIn(props: { saved: SiteCookieStatus; site: string; onChanged: () => void }) {
  const { saved, site, onChanged } = props;
  const [busy, setBusy] = useState(false);
  return (
    <div className="cl-done">
      <div className="cl-check" aria-hidden="true">✓</div>
      <div>
        <div className="cl-done-line">{tr("Logged in, user {0}", saved.userId ?? "?")}</div>
        <div className="cl-done-sub">{tr("{0}. Later probes and downloads will include it automatically.", saved.expiresAt ? tr("Login state expires on {0}", new Date(saved.expiresAt).toLocaleDateString()) : tr("Session valid"))}</div>
      </div>
      <button className="cl-btn" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await collectLogout(site); } finally { setBusy(false); onChanged(); }
      }}>{tr("Log out")}</button>
    </div>
  );
}

/** QR code: start fetches one, polled every 2 seconds; when it expires, offer "Get a new one" */
function QrPane(props: { site: string; onLoggedIn: () => void }) {
  const { site, onLoggedIn } = props;
  const [svgUrl, setSvgUrl] = useState<string | null>(null);
  const [state, setState] = useState<QrPollResult["state"] | "loading" | "error">("loading");
  const [message, setMessage] = useState("");
  const keyRef = useRef<string | null>(null);
  const timer = useRef<number | null>(null);

  const stop = () => { if (timer.current) { window.clearInterval(timer.current); timer.current = null; } };

  const start = useCallback(async () => {
    stop();
    setState("loading");
    setMessage("");
    setSvgUrl(null);
    try {
      const r = await qrStart(site);
      keyRef.current = r.key;
      setSvgUrl(`${r.svgUrl}&t=${Date.now()}`);
      setState("waiting");
      // When the server is down / offline the polling keeps failing, and it must not spin forever: stop after
      // several failures in a row and let the user click "Get a new one"
      let failures = 0;
      timer.current = window.setInterval(async () => {
        const key = keyRef.current;
        if (!key) return;
        try {
          const p = await qrPoll(key);
          failures = 0;
          setState(p.state);
          setMessage(p.message ?? "");
          if (p.state === "ok" || p.state === "expired") stop();
          if (p.state === "ok") onLoggedIn();
        } catch (e) {
          failures += 1;
          setMessage(e instanceof Error ? e.message : String(e));
          if (failures >= 5) { stop(); setState("error"); }
        }
      }, 2000);
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }, [site, onLoggedIn]);

  useEffect(() => { void start(); return stop; }, [start]);

  const label = {
    loading: tr("Generating QR code…"),
    waiting: tr("Scan with the mobile app"),
    scanned: tr("Scanned, confirm on your phone"),
    expired: tr("QR code expired{0}", message ? tr(": {0}", message) : ""),
    ok: tr("Login successful"),
    error: tr("Couldn't get a QR code: {0}", message),
  }[state];

  return (
    <div className="cl-qr">
      <div className={`cl-qr-box${state === "expired" || state === "error" ? " is-dim" : ""}`}>
        {svgUrl ? <img src={svgUrl} alt={tr("Login QR code")} /> : <span className="cl-qr-ph">…</span>}
        {(state === "expired" || state === "error") && (
          <button className="cl-btn is-primary cl-qr-retry" onClick={() => void start()}>{tr("Get a new one")}</button>
        )}
      </div>
      <div className={`cl-status is-${state}`}>{label}</div>
    </div>
  );
}

/** Browser: open the site login page and poll the login state every 3 seconds; once logged in the server closes the window */
function BrowserPane(props: { site: string; onLoggedIn: () => void }) {
  const { site, onLoggedIn } = props;
  const [phase, setPhase] = useState<"idle" | "opening" | "waiting" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");
  /** Shell mode: the login page is a child webview in the main window, placed into the empty area below */
  const [shell, setShell] = useState(false);
  const hole = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const stop = () => { if (timer.current) { window.clearInterval(timer.current); timer.current = null; } };

  const open = useCallback(async () => {
    stop();
    setPhase("opening");
    setMessage("");
    try {
      const r = await collectLogin(site, true);
      if (!r.ok) throw new Error(r.error || tr("Can't open the login page"));
      setShell(!!r.shell);
      setPhase("waiting");
      timer.current = window.setInterval(async () => {
        try {
          const c = await collectLoginCheck(site, true);
          if (c.ok && c.loggedIn) { stop(); setPhase("ok"); onLoggedIn(); }
          else if (!c.ok && c.error) setMessage(c.error);
        } catch (e) {
          setMessage(e instanceof Error ? e.message : String(e));
        }
      }, 3000);
    } catch (e) {
      setPhase("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }, [site, onLoggedIn]);

  useEffect(() => stop, []);

  // Shell mode: while waiting for login, place the child webview over the empty spot; when login finishes /
  // it is closed, move it back
  const showing = shell && phase === "waiting";
  useEffect(() => {
    if (!showing) return;
    const place = () => { if (hole.current) void showAgentWebview(rectOf(hole.current)); };
    const raf = requestAnimationFrame(place);
    const ro = new ResizeObserver(place);
    if (hole.current) ro.observe(hole.current);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", place);
      void hideAgentWebview();
    };
  }, [showing]);

  return (
    <div className="cl-browser">
      <div className="cl-hint">
        {shell
          ? <>{tr("Below is the site's own login page: account and password, SMS, or QR code all work, and the CAPTCHA is handled here too.")}<b>{tr("Enter your account and password only in that page")}</b>{tr(", PromptCut never handles them.")}</>
          : <>{tr("This opens the site's own login page: account and password, SMS, or QR code all work, and the CAPTCHA is handled there too.")}<b>{tr("Enter your account and password only in that page")}</b>{tr(", PromptCut never handles them. It closes automatically after you log in.")}</>}
      </div>
      {phase === "idle" || phase === "error" ? (
        <button className="cl-btn is-primary" onClick={() => void open()}>{phase === "error" ? tr("Retry") : tr("Open login page")}</button>
      ) : null}
      {showing && <div className="cl-shell-hole" ref={hole} aria-hidden="true" />}
      <div className={`cl-status is-${phase}`}>
        {phase === "opening" && tr("Opening login page…")}
        {phase === "waiting" && (shell ? tr("Log in on the page above; this updates automatically when you are done") : tr("Log in in the pop-up window; this updates automatically when you are done"))}
        {phase === "ok" && tr("Login successful")}
        {phase === "error" && tr("Failed: {0}", message)}
        {phase === "waiting" && message && <div className="cl-sub">{message}</div>}
      </div>
    </div>
  );
}

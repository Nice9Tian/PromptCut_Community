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
 * 站点登录弹窗。两条路,结果一样(登录态存成 cookies.txt,之后素材收集自动带上):
 *
 *   - 扫码:服务端调站点的二维码登录接口,二维码就画在这个弹窗里,不开浏览器。
 *     最快,但只能扫码。
 *   - 浏览器:打开站点真正的登录页(agent 用的那个 Chrome),账号密码、短信、
 *     扫码都行,验证码也能过 —— 那页是站点自己的,我们不碰用户输入的任何东西。
 *     登录完弹窗轮询到登录态就把窗口收回去。
 *
 * 挂在 body 上(portal),右栏 overflow:hidden 会裁。
 */
export function CollectLoginDialog() {
  const st = useCollectLoginState();
  if (!st.open) return null;
  // key 用 seq:每次打开都是一个全新的实例,不会带着上次的二维码或状态
  return <Dialog key={st.seq} site={st.site} initialMethod={st.method} onClose={closeCollectLogin} />;
}

function Dialog(props: { site: string; initialMethod: LoginMethod; onClose: () => void }) {
  const { site, initialMethod, onClose } = props;
  const [method, setMethod] = useState<LoginMethod>(initialMethod);
  const [saved, setSaved] = useState<SiteCookieStatus | null>(null);
  const name = SITE_NAMES[site] ?? site;

  const refreshSaved = useCallback(async () => {
    try { setSaved((await cookieStatus())[site] ?? null); } catch { /* 查不到就不显示 */ }
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

/** 已登录:显示账号和过期时间,给个退出 */
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

/** 扫码:start 拿一张,2 秒轮询一次;过期了给「换一张」 */
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
      // 服务端挂了 / 断网时轮询会一直失败,不能无限转下去:连着失败几次就停,让用户点「换一张」
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

/** 浏览器:打开站点登录页,3 秒轮询一次登录态;登录完服务端会把窗口收回去 */
function BrowserPane(props: { site: string; onLoggedIn: () => void }) {
  const { site, onLoggedIn } = props;
  const [phase, setPhase] = useState<"idle" | "opening" | "waiting" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");
  /** 桌面壳模式:登录页是主窗口里的子 webview,摆进下面那块空里 */
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

  // 壳模式:等待登录期间把子 webview 摆到空位上;登录完 / 关掉就挪回去
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

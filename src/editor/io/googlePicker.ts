import type { PickedFile, StorageProviderConfig } from "./storageImport";
import { tr } from "../../i18n/index.ts";

/**
 * Google authorization and file picking (task brief `docs/plan/drive-connector-task.md`, section 5).
 *
 * This does only two things: **get a one-hour access token**, and **let the user pick files**. The token and the
 * file id are handed to the editor process (`/api/media/storage/import`), which fetches the bytes: the page never
 * touches bytes.
 *
 * # Why only `drive.file`
 *
 * This scope can only touch files the user has just picked in the Picker, and cannot search their whole cloud drive.
 * It is a **non-sensitive** scope and does not trigger Google's yearly third-party security assessment;
 * `drive.readonly` is a restricted scope and needs the assessment. The D1 probe on 2026-10-23 verified that
 * "picking authorizes" holds (task brief, section 6.1). **Do not add scopes here.**
 *
 * # This is the A3 "short-lived ticket" route
 *
 * This token expires in an hour, is discarded after use, and is not stored. An upload left unfinished by closing the
 * page is resumed next time by authorizing again.
 * A2 (handing long-term authorization to the cloud for safekeeping) is a different route and does not go through here.
 *
 * # Two scripts
 *
 * `accounts.google.com/gsi/client` handles authorization, `apis.google.com/js/api.js` handles the Picker. Both are
 * injected on demand and only once.
 */

/**
 * Google's global objects have no type declarations; take them locally here and use `any` throughout.
 *
 * **Do not extend `Window` with `declare global`**: the login page (`src/start/OnlineLogin.tsx`) also declares
 * `window.google`, and its declaration has a concrete shape (the two methods of `accounts.id`). When the same
 * property is declared by two `declare global` blocks, TypeScript requires the types to be identical, otherwise it
 * reports TS2717. Each side manages its own, so there is no need to unify a type that suits neither.
 * (Hit when merging into main on 2026-10-24.)
 */
const G = () => window as unknown as { google?: any; gapi?: any };

const GIS_SRC = "https://accounts.google.com/gsi/client";
const GAPI_SRC = "https://apis.google.com/js/api.js";
/** Upper limits for script loading and user actions. The user is the one clicking in the authorization window, so be generous */
const SCRIPT_TIMEOUT_MS = 20_000;

const loading = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  const existing = loading.get(src);
  if (existing) return existing;
  const p = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.defer = true;
    const timer = setTimeout(() => reject(new Error(tr("Loading {0} timed out, check your network", src))), SCRIPT_TIMEOUT_MS);
    el.onload = () => { clearTimeout(timer); resolve(); };
    el.onerror = () => { clearTimeout(timer); reject(new Error(tr("Loading {0} failed, check your network", src))); };
    document.head.appendChild(el);
  });
  loading.set(src, p);
  return p;
}

/** Wait for a global object to appear (it is attached only after the script's onload) */
function waitFor<T>(get: () => T | undefined, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = get();
      if (v) return resolve(v);
      if (Date.now() - started > SCRIPT_TIMEOUT_MS) return reject(new Error(tr("{0} is not ready", what)));
      setTimeout(tick, 60);
    };
    tick();
  });
}

async function ensureGis(): Promise<any> {
  await loadScript(GIS_SRC);
  return waitFor(() => G().google?.accounts?.oauth2, tr("Google authorization script"));
}

async function ensurePicker(): Promise<any> {
  await loadScript(GAPI_SRC);
  const gapi = await waitFor(() => G().gapi, tr("Google API script"));
  if (!G().google?.picker) {
    await new Promise<void>((resolve, reject) => {
      try { gapi.load("picker", { callback: () => resolve(), onerror: () => reject(new Error(tr("Picker module failed to load"))) }); }
      catch (e) { reject(e); }
    });
  }
  return waitFor(() => G().google?.picker, "Google Picker");
}

/** A short-lived ticket. `expiresAt` is a millisecond timestamp on the local clock, used only to decide whether to request a new one */
export interface DriveToken {
  token: string;
  expiresAt: number;
  /** The scopes Google actually granted. When only drive.file is requested, it also throws in a few non-sensitive basic OIDC scopes */
  scope: string;
}

let cached: DriveToken | null = null;
/** Treat it as expired this long in advance, so it doesn't expire while in use */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** Request an access token. If the one in hand is still good, return it directly without another popup */
export async function getDriveToken(cfg: StorageProviderConfig, { force = false } = {}): Promise<DriveToken> {
  if (!force && cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached;
  if (!cfg.clientId) throw new Error(tr("No OAuth client ID, the server is not configured yet"));
  const oauth2 = await ensureGis();
  const scope = cfg.scope || "https://www.googleapis.com/auth/drive.file";

  const got = await new Promise<DriveToken>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope,
      callback: (resp: any) => {
        if (resp?.error) return reject(authError(tr("Authorization failed: {0}", resp.error_description || resp.error)));
        if (!resp?.access_token) return reject(authError(tr("No access token in the authorization response")));
        resolve({
          token: String(resp.access_token),
          expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000,
          scope: String(resp.scope || scope),
        });
      },
      error_callback: (err: any) => reject(Object.assign(new Error(tr("Authorization window closed or blocked: {0}", err?.type || tr("unknown reason"))), { closed: true })),
    });
    client.requestAccessToken();
  });

  cached = got;
  return got;
}

/** An error the caller should answer by dropping the token (StorageImportButton.tsx) */
function authError(message: string): Error {
  return Object.assign(new Error(message), { authFailed: true });
}

/** Manually invalidate the ticket in hand (after switching accounts or revoking authorization) */
export function forgetDriveToken(): void {
  cached = null;
}

// ───────────────────────── A2: authorization code flow ─────────────────────────

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomB64url(bytes = 48): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Run one authorization code flow and get back the **authorization code** and the PKCE verifier. Returns `null` on cancel.
 *
 * The page **does not exchange** this code itself: the exchange needs the client secret, which lives only on the
 * editor process side. Pass `access_type=offline` and `prompt=consent`: without both, Google does not issue a
 * refresh token, and "keep uploading after closing the page" is out of the question.
 */
export async function requestDriveAuthCode(cfg: StorageProviderConfig): Promise<{ code: string; codeVerifier: string } | null> {
  if (!cfg.clientId) throw new Error(tr("No OAuth client ID, the server is not configured yet"));
  if (!cfg.redirectUri) throw new Error(tr("No redirect URI, the server has not configured hosted credentials yet"));

  const codeVerifier = randomB64url(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
  const state = randomB64url(16);

  const url = `${AUTH_URL}?${new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: cfg.scope || "https://www.googleapis.com/auth/drive.file",
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state,
  })}`;

  const popup = window.open(url, "promptcut-oauth", "width=520,height=640");
  if (!popup) throw new Error(tr("The authorization window was blocked by the browser, allow pop-ups for this site and try again"));

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      clearInterval(watch);
      try { popup.close(); } catch { /* Already closed */ }
      fn();
    };

    function onMessage(e: MessageEvent) {
      // Accept only messages sent by the same-origin landing page; the authorization code never comes in from another origin
      if (e.origin !== window.location.origin) return;
      const d = e.data;
      if (!d || d.source !== "promptcut-oauth" || d.state !== state) return;
      if (d.error) return finish(() => reject(authError(tr("Authorization failed: {0}", d.error))));
      if (typeof d.code !== "string" || !d.code) return finish(() => reject(authError(tr("No authorization code in the authorization callback"))));
      const code = d.code;
      finish(() => resolve({ code, codeVerifier }));
    }
    window.addEventListener("message", onMessage);

    // The user closed the window themselves: treat it as cancel, no error
    const watch = setInterval(() => {
      if (popup.closed) finish(() => resolve(null));
    }, 500);
  });
}

/**
 * Open the Picker for the user to choose. Returns `null` on cancel (not an error).
 *
 * `setAppId` (the Cloud project number) is required: the per-file authorization of `drive.file` is recorded under
 * this app, and without it the chosen files cannot be read.
 */
export async function pickDriveFiles(cfg: StorageProviderConfig, token: string): Promise<PickedFile[] | null> {
  if (!cfg.apiKey) throw new Error(tr("No API key, the server is not configured yet"));
  if (!cfg.appId) throw new Error(tr("No Cloud project number, Picker's per-file authorization cannot be recorded"));
  const picker = await ensurePicker();

  return new Promise<PickedFile[] | null>((resolve, reject) => {
    let settled = false;
    let watch: ReturnType<typeof setInterval> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      fn();
    };

    try {
      const views = [
        new picker.DocsView(picker.ViewId.DOCS_VIDEOS).setIncludeFolders(true),
        new picker.DocsView(picker.ViewId.DOCS_IMAGES).setIncludeFolders(true),
        new picker.DocsView(picker.ViewId.DOCS).setIncludeFolders(true),
      ];
      const builder = new picker.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(cfg.apiKey)
        .setAppId(cfg.appId)
        .enableFeature(picker.Feature.MULTISELECT_ENABLED)
        .setCallback((data: any) => {
          if (data.action === picker.Action.CANCELLED) return finish(() => resolve(null));
          if (data.action !== picker.Action.PICKED) return;
          const docs = Array.isArray(data.docs) ? data.docs : [];
          finish(() => resolve(docs.map((d: any): PickedFile => ({
            id: String(d.id),
            name: String(d.name || d.id),
            mimeType: d.mimeType ? String(d.mimeType) : undefined,
            sizeBytes: Number(d.sizeBytes) || undefined,
          }))));
        });
      for (const v of views) builder.addView(v);

      const dialog = builder.build();
      dialog.setVisible(true);

      // Fallback: if the dialog is gone, treat it as cancel.
      //
      // We can't rely on the callback alone: the Picker only guarantees to send CANCELLED when the "Cancel" button is
      // clicked; if it is closed with the × in the top right, with Esc, or by clicking outside the dialog, the callback
      // may never come. Then this Promise never settles, the caller's `finally` never gets its turn, and the button
      // stays stuck on "Importing from cloud drive…".
      // (Reported by a user on 2026-10-24: nothing imported, clicked cancel, stuck waiting for the import.)
      // After `setVisible(true)` the dialog is not visible immediately, so first see it open, and only then treat
      // "not visible" as cancel; otherwise the first poll might take a dialog that hasn't opened yet as a user cancel.
      let sawOpen = false;
      watch = setInterval(() => {
        let visible: boolean;
        try {
          visible = !!dialog.isVisible();
        } catch {
          // The dialog has been destroyed and even isVisible can't be called; likewise treat it as cancel
          return finish(() => resolve(null));
        }
        if (visible) sawOpen = true;
        else if (sawOpen) finish(() => resolve(null));
      }, 400);
    } catch (e) {
      finish(() => reject(e instanceof Error ? e : new Error(String(e))));
    }
  });
}

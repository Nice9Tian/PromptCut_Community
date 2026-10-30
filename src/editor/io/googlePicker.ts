import type { PickedFile, StorageProviderConfig } from "./storageImport";

/**
 * Google 的授权与选文件(任务书 `docs/plan/drive-connector-task.md` 第 5 节)。
 *
 * 这里只做两件事:**拿一张一小时的 access token**,和**让用户选文件**。拿到的 token 和文件 id 交给
 * 编辑器进程(`/api/media/storage/import`),字节由它去拉 —— 页面不碰字节。
 *
 * # 为什么只要 `drive.file`
 *
 * 这个范围只能碰用户当场在 Picker 里选中的文件,搜不了他整个网盘。它是**非敏感**范围,不触发 Google
 * 每年一次的第三方安全评估;`drive.readonly` 是受限范围,要评估。2026-10-23 的 D1 探针实测过
 * 「选中即授权」成立(任务书第 6.1 节)。**不要往这里加范围。**
 *
 * # 这是 A3「短命票」那条路
 *
 * 这张 token 一小时就过期,用完即弃,不保存。关掉页面没传完的,下次打开重新授权再续。
 * A2(把长期授权交给云端保管)是另一条路,不走这里。
 *
 * # 两个脚本
 *
 * `accounts.google.com/gsi/client` 管授权,`apis.google.com/js/api.js` 管 Picker。两个都按需注入、只注入一次。
 */

/**
 * Google 的全局对象没有类型声明,这里局部取、统一用 any 接。
 *
 * **不要用 `declare global` 扩 `Window`**:登录页(`src/start/OnlineLogin.tsx`)也声明了 `window.google`,
 * 而且它那份是具体形状(`accounts.id` 的两个方法)。同一个属性被两处 `declare global` 声明时,
 * TypeScript 要求类型一字不差,否则报 TS2717。各管各的,就不用去统一一个谁都不合适的类型。
 * (2026-10-24 合 main 时撞上过。)
 */
const G = () => window as unknown as { google?: any; gapi?: any };

const GIS_SRC = "https://accounts.google.com/gsi/client";
const GAPI_SRC = "https://apis.google.com/js/api.js";
/** 脚本加载与用户操作的上限。授权窗口是用户在点,给宽一点 */
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
    const timer = setTimeout(() => reject(new Error(`加载 ${src} 超时,检查网络`)), SCRIPT_TIMEOUT_MS);
    el.onload = () => { clearTimeout(timer); resolve(); };
    el.onerror = () => { clearTimeout(timer); reject(new Error(`加载 ${src} 失败,检查网络`)); };
    document.head.appendChild(el);
  });
  loading.set(src, p);
  return p;
}

/** 等某个全局对象出现(脚本 onload 之后它才挂上去) */
function waitFor<T>(get: () => T | undefined, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = get();
      if (v) return resolve(v);
      if (Date.now() - started > SCRIPT_TIMEOUT_MS) return reject(new Error(`${what} 没有就绪`));
      setTimeout(tick, 60);
    };
    tick();
  });
}

async function ensureGis(): Promise<any> {
  await loadScript(GIS_SRC);
  return waitFor(() => G().google?.accounts?.oauth2, "Google 授权脚本");
}

async function ensurePicker(): Promise<any> {
  await loadScript(GAPI_SRC);
  const gapi = await waitFor(() => G().gapi, "Google API 脚本");
  if (!G().google?.picker) {
    await new Promise<void>((resolve, reject) => {
      try { gapi.load("picker", { callback: () => resolve(), onerror: () => reject(new Error("Picker 模块没载入")) }); }
      catch (e) { reject(e); }
    });
  }
  return waitFor(() => G().google?.picker, "Google Picker");
}

/** 一张短命票。`expiresAt` 是本地时钟的毫秒时间戳,只用来判断要不要重新要一张 */
export interface DriveToken {
  token: string;
  expiresAt: number;
  /** Google 实际给到的范围。只申请 drive.file 时它还会附送几个非敏感的 OIDC 基本范围 */
  scope: string;
}

let cached: DriveToken | null = null;
/** 提前这么久就当它过期,免得正用着过期 */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** 要一张 access token。手里那张还够用就直接给,不再弹窗 */
export async function getDriveToken(cfg: StorageProviderConfig, { force = false } = {}): Promise<DriveToken> {
  if (!force && cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached;
  if (!cfg.clientId) throw new Error("没有 OAuth 客户端 ID,服务端还没配好");
  const oauth2 = await ensureGis();
  const scope = cfg.scope || "https://www.googleapis.com/auth/drive.file";

  const got = await new Promise<DriveToken>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope,
      callback: (resp: any) => {
        if (resp?.error) return reject(new Error(`授权没通过:${resp.error_description || resp.error}`));
        if (!resp?.access_token) return reject(new Error("授权回包里没有 access token"));
        resolve({
          token: String(resp.access_token),
          expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000,
          scope: String(resp.scope || scope),
        });
      },
      error_callback: (err: any) => reject(new Error(`授权窗口关闭或被拦:${err?.type || "未知原因"}`)),
    });
    client.requestAccessToken();
  });

  cached = got;
  return got;
}

/** 手动把手里那张票作废(换账号、撤销授权之后) */
export function forgetDriveToken(): void {
  cached = null;
}

// ───────────────────────── A2:授权码流程 ─────────────────────────

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
 * 走一次授权码流程,拿回**授权码**和 PKCE 的 verifier。取消返回 `null`。
 *
 * 页面**不自己兑换**这个码 —— 兑换要客户端密钥,那东西只在编辑器进程那一侧。
 * 带 `access_type=offline` 与 `prompt=consent`:不带这两样 Google 不给 refresh token,
 * 也就谈不上「关掉页面还能继续传」。
 */
export async function requestDriveAuthCode(cfg: StorageProviderConfig): Promise<{ code: string; codeVerifier: string } | null> {
  if (!cfg.clientId) throw new Error("没有 OAuth 客户端 ID,服务端还没配好");
  if (!cfg.redirectUri) throw new Error("没有重定向地址,服务端还没配好凭据托管");

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
  if (!popup) throw new Error("授权窗口被浏览器拦住了,请允许本站弹窗后重试");

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      clearInterval(watch);
      try { popup.close(); } catch { /* 已经关了 */ }
      fn();
    };

    function onMessage(e: MessageEvent) {
      // 只认同源的落地页发来的,授权码不会从别的源进来
      if (e.origin !== window.location.origin) return;
      const d = e.data;
      if (!d || d.source !== "promptcut-oauth" || d.state !== state) return;
      if (d.error) return finish(() => reject(new Error(`授权没通过:${d.error}`)));
      if (typeof d.code !== "string" || !d.code) return finish(() => reject(new Error("授权回调里没有授权码")));
      const code = d.code;
      finish(() => resolve({ code, codeVerifier }));
    }
    window.addEventListener("message", onMessage);

    // 用户自己把窗口关了:当取消,不报错
    const watch = setInterval(() => {
      if (popup.closed) finish(() => resolve(null));
    }, 500);
  });
}

/**
 * 打开 Picker 让用户选。取消返回 `null`(不是错误)。
 *
 * 必须带 `setAppId`(Cloud 项目编号):`drive.file` 的「按文件授权」是记在这个应用名下的,不给就选了也读不到。
 */
export async function pickDriveFiles(cfg: StorageProviderConfig, token: string): Promise<PickedFile[] | null> {
  if (!cfg.apiKey) throw new Error("没有 API 密钥,服务端还没配好");
  if (!cfg.appId) throw new Error("没有 Cloud 项目编号,Picker 的按文件授权记不上账");
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

      // 兜底:对话框没了就当取消。
      //
      // 不能只靠回调 —— Picker 只在点「取消」按钮时才保证发 CANCELLED;用右上角的 × 关掉、
      // 按 Esc、或者点到对话框外面,回调都可能不来。那样这个 Promise 永远不落地,调用方的
      // `finally` 也就轮不到,按钮就一直卡在「从网盘导入中…」。
      // (2026-10-24 用户报:什么都没导入、点取消,卡在等待导入。)
      // `setVisible(true)` 之后对话框不是立刻就可见的,所以要先看见它开过,再把「不可见」当取消 ——
      // 否则第一次轮询就可能把还没开出来的对话框当成用户取消了。
      let sawOpen = false;
      watch = setInterval(() => {
        let visible: boolean;
        try {
          visible = !!dialog.isVisible();
        } catch {
          // 对话框已经被销毁,isVisible 都调不动了,同样当取消
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

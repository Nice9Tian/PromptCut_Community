/**
 * 在线浏览器(电脑身份)的登录页。
 *
 * 原来登录就是开始页上那一小块表单(`src/account/AccountProjects.tsx`),和「新建云端项目」「凭链接加入」
 * 挤在一起。这里把它拆成独立的一页:没登录先看到它,登录成功才进开始页 —— 在线浏览器里项目一律是
 * 放云端的多用户协作项目(`product/platforms.md`「能新建放云端的项目」),所以账号是进门的前提。
 *
 * **只有「用 Google 继续」这一条是真的**(2026-10-23 接上):它真向账号服务发请求、真建立会话、
 * 真换到编辑器令牌。账号名加密码那条、游客那条、项目链接那条仍然只跑界面,提交不发请求。
 * 这是两个会话分工的结果 —— 这一页的界面和其余几条路归别人,第三方登录这一条归
 * `claude/editor-google-login`,它只改这一页里 Google 那一块,不动其余部分。
 *
 * Google 这条路后半段和密码登录是同一套:先建立网站会话(cookie),再由 `client.ensureLogin()`
 * 去换编辑器令牌(`/api/account/editor/session`)。所以账号服务没为编辑器另开接口。
 *
 * 待办(业务层):
 * - 接 `src/account/useAccountProjects.ts` 的 `login`(账号服务在 VisuHive 仓库,见 `architecture.md` 的角色表);
 * - 「记住登录状态」是在线页面才有的那个勾(`workflow/project.md`「在线浏览器和官网共用登录」);
 * - 官网已登录时这一页应该直接跳过,不再问一遍;
 * - 游客身份(进入时随机分配 ID 和头像)的入口摆在下面「或」那一段(用户 2026-10-23 要求两个登录页
 *   都摆上)。**按钮只是入口,随机 ID 和头像那套逻辑仍归另一个会话**(`游客身份随机分配`);
 *   在它接上之前,这颗键和这一页的其余部分一样走 `onDone()` —— 这一页现在整体是界面桩,登录也不发请求。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Logo } from "../ui/Logo";
import { BrandLoop } from "./BrandLoop";
import { createAccountClient, type CloudAccountClient } from "../editor/sync/accountExtensions";
import { ensureDevice } from "../editor/sync/syncManager";

/**
 * Google 自己的脚本。`hl` 要带上：不带的话按钮文案跟浏览器语言走，中文界面上会冒出日文
 * （2026-10-23 在官网那边实测到）。按钮由它自己画，不自制，免得违反它的品牌规范。
 */
const GSI_SRC = "https://accounts.google.com/gsi/client?hl=zh-CN";
/**
 * 等这么久按钮还没画出来，就当 Google 这一块不可用，显示一句说明。
 *
 * **它抓的是「按钮根本没画出来」**（脚本被拦、GIS 内部出错），不是「来源没授权」：
 * 2026-10-23 实测，来源没授权时 `gsi/button` 虽然回 403，GIS 仍然自己把按钮画了出来，
 * 要到用户点下去才由 Google 自己弹窗说「禁止访问：发生了授权错误 … 错误 400：origin_mismatch」。
 * 那种情况我们这边拦不住也测不出，只能靠部署时把来源配对（见 VisuHive 的 docs/third-party-login.md）。
 */
const BUTTON_WAIT_MS = 2500;

declare global {
  interface Window { google?: { accounts?: { id?: {
    initialize(config: Record<string, unknown>): void;
    renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
  } } } }
}

/**
 * 把 Google 的脚本放进页面。已经在加载了就不再加一遍 —— 这时**不等它的 load 事件**：
 * 事件可能在我们挂监听之前就过去了，等下去会一直挂着。等它装好交给下面的 `gsiApi()` 轮询。
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
 * 等 `window.google.accounts.id` 真的出现。
 * 脚本的 load 事件和它把全局装好之间有一道缝，只查一次会误判成「没装载」（2026-10-23 真跑时撞到）。
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

/** Google 这一块的状态：后端没开就整块不显示，连不上或来源没授权就显示一句说明 */
type GoogleState =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "ready" }
  | { kind: "unavailable"; message: string };

/**
 * `onThirdPartyDone` 是 Google 这条路**专用**的出口：它和 `onDone()` 走的不是同一件事。
 * `onDone()` 由外层（`VibeLogin.tsx`）拿去问「刚才按的是哪一颗键、表单里填了什么」，
 * 而 Google 的按钮是 Google 自己在跨源 iframe 里画的，外层根本收不到那次点击，
 * 于是第三方登录成功后走 `onDone()` 会被外层当成「没有出口」丢掉 ——
 * 用户 2026-10-24 报的「授权以后没有反应」就是这个。给它一条自己的出口，外层据此去认会话。
 * 没传这个属性时退回 `onDone()`（桌面与别处原样）。
 */
export function OnlineLogin(props: { onDone: () => void; onThirdPartyDone?: () => void }): JSX.Element {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [link, setLink] = useState("");
  const [byLink, setByLink] = useState(false);
  const origin = typeof location !== "undefined" ? location.origin : "";

  // —— Google 登录 ——
  const [google, setGoogle] = useState<GoogleState>({ kind: "loading" });
  /** 第一次用这个 Google 账号：Google 不给账号名，要用户自己起一个 */
  const [needName, setNeedName] = useState<{ ticket: string; email: string | null } | null>(null);
  const [googleName, setGoogleName] = useState("");
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState("");
  const slot = useRef<HTMLDivElement>(null);
  const client = useRef<CloudAccountClient | null>(null);
  // 回调是在 effect 里注册给 Google 的，闭包会把这两样钉死在首次渲染的值上，所以用 ref 取当下的
  const rememberRef = useRef(remember); rememberRef.current = remember;
  const onDoneRef = useRef(props.onDone); onDoneRef.current = props.onDone;
  const thirdPartyRef = useRef(props.onThirdPartyDone); thirdPartyRef.current = props.onThirdPartyDone;
  /** 第三方登录成功后往哪儿走：有专用出口就走它，没有就退回 `onDone()` */
  const thirdPartyDone = () => { (thirdPartyRef.current ?? onDoneRef.current)(); };

  useEffect(() => {
    let alive = true;
    void (async () => {
      const device = await ensureDevice();
      if (!alive) return;
      if (!device) return setGoogle({ kind: "off" });
      const c = createAccountClient({ online: true, origin: location.origin, device });
      client.current = c;
      // 后端没开（没配客户端 ID），或者后端还是旧版没有这条接口，都回空数组 —— 整块不显示
      const providers = await c.thirdPartyProviders();
      if (!alive) return;
      const google = providers.find((p) => p.provider === "google");
      if (!google) return setGoogle({ kind: "off" });

      try { await loadGsi(); } catch {
        // 连不上 Google（断网、被挡、脚本被拦）不该把人堵在这一页：说一句，账号密码和游客照常可用
        if (alive) setGoogle({ kind: "unavailable", message: "连不上 Google，请用账号名和密码，或以游客身份进入。" });
        return;
      }
      const api = await gsiApi();
      if (!alive) return;
      if (!api || !slot.current) return setGoogle({ kind: "unavailable", message: "Google 登录没能装载，请用账号名和密码。" });

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
            if (alive) setGoogleError(e instanceof Error ? e.message : "Google 登录失败，请再试一次。");
          } finally { if (alive) setGoogleBusy(false); }
        },
      });
      api.renderButton(slot.current, {
        theme: "filled_black", size: "large", shape: "rectangular", text: "continue_with",
        locale: document.documentElement.lang || "zh-CN", width: 320,
      });
      setGoogle({ kind: "ready" });
      // 按钮没画出来(脚本被拦、GIS 内部出错)时,不能只留一块点不动的空白
      window.setTimeout(() => {
        if (!alive) return;
        if ((slot.current?.getBoundingClientRect().height ?? 0) < 20) {
          setGoogle({ kind: "unavailable", message: "Google 登录没能显示出来，请用账号名和密码，或以游客身份进入。" });
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
      setGoogleError(e instanceof Error ? e.message : "建账号失败，请再试一次。");
    } finally { setGoogleBusy(false); }
  }

  return (
    <div className="ps-login" data-pc="start-login">
      <section className="ps-login-art">
        <BrandLoop />
        <div>
          <Logo size={26} />
          <h1 className="ps-login-art-title">打开浏览器就能剪片子</h1>
          <p className="ps-login-art-sub">
            项目、素材和预渲染结果都在云端，换一台设备登录同一个账号，接着上次的地方往下剪。
          </p>
        </div>
        <span className="ps-login-art-foot">PromptCut · 在线版</span>
      </section>

      <section className="ps-login-panel">
        <form
          className="ps-login-form"
          data-pc="start-login-form"
          onSubmit={(e) => {
            e.preventDefault();
            // 待办:这里要调账号服务。现在只跑界面,填了就算过
            props.onDone();
          }}
        >
          <div className="ps-login-head">
            <h2 className="ps-login-title">登录账号</h2>
            <span className="ps-muted">网站账号和官网通用。</span>
          </div>

          <label className="ps-field">
            账号名
            <input name="username" autoComplete="username" required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="ps-field">
            密码
            <input name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>

          <label className="ps-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            记住登录状态
          </label>

          <button className="ps-primary-btn" data-pc="start-login-submit" disabled={!name || !password}>
            登录账号
          </button>

          <div className="ps-login-alt">
            <a className="ps-link" href={`${origin}/account`} target="_blank" rel="noopener noreferrer">注册账号</a>
            <a className="ps-link" href={`${origin}/account`} target="_blank" rel="noopener noreferrer">忘记密码</a>
          </div>

          <div className="ps-login-sep">或</div>

          {/*
            第三方登录。语义那条冲突已经解了:`product/document-service.md` 第 66 行 2026-10-23 改成
            「云端网站账号除账号名加密码外,还支持用 Google 账号登录」(main 的 ef68582b)。

            按钮由 Google 自己的脚本画进下面这个槽,我们不自制:它的品牌规范对图形、文案、配色都有规定。
            后端没开这一块时整段不显示(`thirdPartyProviders()` 回空),连不上或来源没授权时显示一句说明 ——
            不留白、也不静默失败,账号密码和游客那两条路都不受影响。

            后端在 VisuHive 仓库:`account/app.mjs` 的 `/third-party/*`,令牌的验签在它的 `identity/` 服务里。
          */}
          <div className="ps-login-oauth" data-pc="start-login-oauth">
            {needName ? (
              // 第一次用这个 Google 账号:Google 不给账号名,网站账号名又全站唯一,所以要用户自己起一个
              <div className="ps-field" data-pc="start-login-google-name">
                <span className="ps-muted">
                  {needName.email ? `用 ${needName.email} 登录。` : "就快好了。"}起一个账号名，全站唯一，之后不能改。
                </span>
                <input
                  autoComplete="username"
                  placeholder="账号名"
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
                  {googleBusy ? "正在建账号…" : "用这个名字建账号"}
                </button>
              </div>
            ) : (
              <>
                {/*
                  Google 把按钮画进这里。**这个槽要一直在**:effect 是往 `slot.current` 里画的,
                  按状态把它摘掉就成了鸡生蛋 —— 还没问出结果时摘掉,等问出来要画了,槽已经不在了
                  (2026-10-23 真跑时撞到:热更新保留住 `off` 状态,再跑 effect 就画不进去)。
                  后端没开时它是个零高度的空 div,看不见;来源没授权时也一样,靠下面那句说明顶上。
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

          {/* 游客身份的入口(用户 2026-10-23)。和上面那颗用同一套长相,两行对齐 */}
          <button type="button" className="ps-oauth-btn" data-pc="start-login-guest" onClick={props.onDone}>
            <span className="ps-oauth-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
                <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 1.8c-4 0-7 2-7 4.4V20h14v-1.8c0-2.4-3-4.4-7-4.4Z" />
              </svg>
            </span>
            以游客身份进入
          </button>

          {byLink ? (
            <label className="ps-field">
              项目链接
              <input
                type="text"
                placeholder="粘贴别人给你的云端项目链接"
                value={link}
                data-pc="start-login-link"
                onChange={(e) => setLink(e.target.value)}
              />
            </label>
          ) : (
            <button type="button" className="ps-ghost-btn" data-pc="start-login-by-link" onClick={() => setByLink(true)}>
              用项目链接加入别人的项目
            </button>
          )}

        </form>
      </section>
    </div>
  );
}

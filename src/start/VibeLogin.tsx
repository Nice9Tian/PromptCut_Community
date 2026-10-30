/**
 * 登录页接业务层的那一层外壳:登录页本身(`OnlineLogin.tsx`,布局、左边那块动画)原样不动,这里把它的几个出口接到真账号上。
 *
 * 为什么是外壳而不是改 `OnlineLogin.tsx`:那个文件另一条线(接通 Google 登录的会话)正在改,本分支不碰它(主会话 2026-10-23 的边界)。
 * `OnlineLogin` 只给一个 `onDone()`(登录表单提交、游客键、「直接跳过」都走它),不带账号密码,所以这里在外面一层用捕获阶段
 * 认出是哪一个出口、读出表单里填的账号名、密码、「记住登录状态」,再在 `onDone()` 里真的去做:
 *   - 表单提交 → `useAccountProjects` 的 `login`(VisuHive 账号服务,和官网共用登录);
 *   - 「以游客身份进入」(`data-pc="start-login-guest"`)→ `enterAsGuest`(本机记着的游客令牌交回去续期,没有就领一个新的);
 *   - 「或者直接跳过」→ 不登录,进开始页看空态(列表处写明要先登录);
 *   - 「用 Google 继续」的后半段由 `OnlineLogin.tsx` 自己做完(建网站会话、换编辑器令牌),做完走它那条专用出口
 *     `onThirdPartyDone`,这里译成 `third-party` 这个出口交给上层去**认**这条会话。
 *     **为什么要专用一条**:Google 的按钮是 Google 自己在跨源 iframe 里画的,下面那个 `onClickCapture` 收不到那次点击,
 *     于是它要是和别人一样走 `onDone()`,`intent` 还是 null,会被当成「没有出口」丢掉 —— 用户 2026-10-24 报的
 *     「授权以后没有反应」就是这个(2026-10-24 修)。
 * 做不成(密码错、账号服务不可用、游客入口关着)时在页面顶上出一条错误,不进开始页。
 *
 * 原型里那行「界面预览阶段:登录不会真的发请求……」连同它里面的「直接跳过」已经在 `OnlineLogin.tsx` 里删掉了
 * (2026-10-23 接业务层之后那句话不再成立);下面 `start-login-skip` 那条分支留着不碍事,真有这颗键时照样认。
 * 「用项目链接加入」那一栏在登录页上没有提交键,填了的链接这里在登录成功后带进开始页的「用链接加入」那一处。
 */
import { useRef } from "react";
import type { JSX } from "react";
import { OnlineLogin } from "./OnlineLogin";

export type LoginIntent =
  | { kind: "login"; name: string; password: string; remember: boolean; link: string }
  | { kind: "guest"; link: string }
  /** 第三方(Google)那一段已经登成功了,上层只要把这条会话认下来 */
  | { kind: "third-party"; link: string }
  | { kind: "skip"; link: string };

export function VibeLogin(props: { busy: boolean; error: string; onIntent: (intent: LoginIntent) => void }): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const intent = useRef<LoginIntent | null>(null);
  const linkNow = () => box.current?.querySelector<HTMLInputElement>('[data-pc="start-login-link"]')?.value.trim() ?? "";

  return (
    <div
      ref={box}
      className="ps-vibe-login"
      data-pc="start-vibe-login"
      data-busy={props.busy || undefined}
      onSubmitCapture={(e) => {
        const form = e.target as HTMLFormElement;
        const name = form.querySelector<HTMLInputElement>('input[name="username"]')?.value.trim() ?? "";
        const password = form.querySelector<HTMLInputElement>('input[name="password"]')?.value ?? "";
        const remember = form.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ?? true;
        intent.current = { kind: "login", name, password, remember, link: linkNow() };
      }}
      onClickCapture={(e) => {
        const el = e.target as HTMLElement;
        if (el.closest('[data-pc="start-login-guest"]')) intent.current = { kind: "guest", link: linkNow() };
        else if (el.closest('[data-pc="start-login-skip"]')) intent.current = { kind: "skip", link: linkNow() };
      }}
    >
      {props.error && <div className="ps-vibe-login-error" role="alert" data-pc="start-login-error">{props.error}</div>}
      {props.busy && <div className="ps-vibe-login-busy" role="status" data-pc="start-login-busy">正在连接账号服务…</div>}
      <OnlineLogin
        onThirdPartyDone={() => { intent.current = null; props.onIntent({ kind: "third-party", link: linkNow() }); }}
        onDone={() => {
          const it = intent.current;
          intent.current = null;
          if (!it || props.busy) return;
          props.onIntent(it);
        }}
      />
    </div>
  );
}

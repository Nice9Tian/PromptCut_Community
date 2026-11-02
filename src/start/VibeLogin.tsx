/**
 * The shell layer where the login page connects to the business layer: the login page itself
 * (`OnlineLogin.tsx`, the layout and the animation on the left) is left as is, and here its several
 * exits are wired to real accounts.
 *
 * Why a shell rather than changing `OnlineLogin.tsx`: another line of work (the session that wires up
 * Google login) is editing that file, and this branch does not touch it (boundary set by the lead
 * session on 2026-10-23). `OnlineLogin` gives only one `onDone()` (the login form submit, the guest
 * button and "Skip directly" all go through it) and carries no username or password, so here an outer
 * layer uses the capture phase to recognize which exit it is, reads the account name, password and
 * "Remember login state" filled in on the form, and then actually does the work inside `onDone()`:
 *   - Form submit → `login` of `useAccountProjects` (the VisuHive account service, sharing login with
 *     the official website);
 *   - "Enter as a guest" (`data-pc="start-login-guest"`) → `enterAsGuest` (the guest token remembered
 *     locally is handed back for renewal, and a new one is obtained if there is none);
 *   - "Or skip directly" → no login, go to the start page and see the empty state (the list area says
 *     that you must log in first);
 *   - The second half of "Continue with Google" is finished by `OnlineLogin.tsx` itself (it creates the
 *     website session and exchanges the editor token), and then goes through its dedicated exit
 *     `onThirdPartyDone`, which is translated here into the exit `third-party` for the upper layer to
 *     **adopt** the session.
 *     **Why a dedicated one**: the Google button is drawn by Google itself in a cross-origin iframe, so
 *     the `onClickCapture` below cannot receive that click; if it went through `onDone()` like the
 *     others, `intent` would still be null and would be dropped as "no exit": this is exactly the "no
 *     reaction after authorization" that the user reported on 2026-10-24 (fixed on 2026-10-24).
 * When it cannot be done (wrong password, account service unavailable, guest entry closed), an error is
 * shown at the top of the page and the start page is not entered.
 *
 * The line in the prototype "UI preview stage: login will not really send a request..." together with
 * the "Skip directly" inside it has already been deleted in `OnlineLogin.tsx` (after the business layer
 * was wired on 2026-10-23 that sentence no longer holds); the `start-login-skip` branch below is kept
 * since it does no harm, and is still recognized if such a button really exists.
 * The "Join with a project link" field has no submit button on the login page, and the link filled in
 * is carried here, after a successful login, to the "Join with a link" spot on the start page.
 */
import { useRef } from "react";
import type { JSX } from "react";
import { OnlineLogin } from "./OnlineLogin";
import { tr } from "../i18n/index.ts";

export type LoginIntent =
  | { kind: "login"; name: string; password: string; remember: boolean; link: string }
  | { kind: "guest"; link: string }
  /** The third-party (Google) part has already logged in successfully, and the upper layer only has to adopt this session */
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
      {props.busy && <div className="ps-vibe-login-busy" role="status" data-pc="start-login-busy">{tr("Connecting to the account service…")}</div>}
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

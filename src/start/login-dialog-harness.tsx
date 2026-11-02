/**
 * Page used by `scripts/probes/login-dialog-probe.mjs` (issue #2 login dialog), not part of any build.
 *
 * The community edition has no account business layer (`useAccountProjects` lives in the closed repo's
 * `cloud/`), so the real `OnlineStart` would show only the join form here. This page registers a fake
 * business layer and a fake account client through the same extension slots
 * (`registerAccountExtensions`), then mounts the real `OnlineStart`: the top bar, the logged-out start
 * page, the login dialog and its flows are the real code; only the network answers are made up.
 *
 * Address switches (all optional):
 *   google=on|off|unreachable  the account service's Google setting (unreachable: the probe also blocks Google's script)
 *   gnew=1                     Google sign-in comes back as "first time, pick a name"
 *   register=0                 the client has no `register` (the dialog must hide "Sign up with email")
 *   addr=project               pretend the page was opened at a project's direct address (pushState to /editor/p/demo)
 * Fake answers: password `right-password` signs in; name `taken` → name-taken; an email starting with
 * `taken` → email-taken on sending the code; code `000000` → bad-code.
 * What happened is recorded on `window.__loginHarness.log` for the probe.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import "../skins/skins.css";
import "../skins/useSkin";
import "./start.css";
import {
  projectLink,
  registerAccountExtensions,
  type AccountProjectsHookResult,
  type CloudAccountClient,
  type GuestLogin,
  type Account,
} from "../editor/sync/accountExtensions";
import { OnlineStart } from "./OnlineStart";

const q = new URLSearchParams(location.search);
const GOOGLE = q.get("google") ?? "on";
const log: string[] = [];
const state = { lastName: "mei" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const refuse = (code: string, message: string) => Object.assign(new Error(message), { code });

if (q.get("addr") === "project") history.replaceState(null, "", `/editor/p/demo${location.search}`);

if (GOOGLE === "on") {
  // Stand-in for Google's script: a plain button that "signs in" when clicked
  let cb: ((r: { credential?: string }) => void) | null = null;
  (window as unknown as { google: unknown }).google = { accounts: { id: {
    initialize: (c: { callback: (r: { credential?: string }) => void }) => { cb = c.callback; },
    renderButton: (parent: HTMLElement, o: Record<string, unknown>) => {
      parent.innerHTML = "";
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.pc = "harness-google-button";
      b.textContent = `G  Continue with Google (${String(o.locale)}, ${String(o.theme)})`;
      Object.assign(b.style, { width: `${String(o.width)}px`, height: "40px", borderRadius: "20px", border: "1px solid #dadce0", background: o.theme === "outline" ? "#fff" : "#131314", color: o.theme === "outline" ? "#1f1f1f" : "#e3e3e3", font: "500 14px sans-serif", cursor: "pointer" });
      b.onclick = () => { log.push("google-click"); cb?.({ credential: "fake-credential" }); };
      parent.append(b);
    },
  } } };
}

const fakeClient = (): CloudAccountClient => {
  const c: Partial<CloudAccountClient> = {
    thirdPartyProviders: async () => (GOOGLE === "off" ? [] : [{ provider: "google", clientId: "harness" }]),
    loginWithThirdParty: async () => {
      await sleep(200);
      log.push("google-login");
      return q.get("gnew") === "1" ? { kind: "need-name", ticket: "t1", email: "mei@example.com" } : { kind: "signed-in", account: { id: "g1", name: "mei" } };
    },
    registerWithThirdParty: async (_ticket, name) => { await sleep(200); log.push(`google-register:${name}`); state.lastName = name; return { id: "g1", name }; },
  };
  if (q.get("register") !== "0") {
    c.register = async (name) => {
      await sleep(250);
      // i18n-allow: the account service's own message, which arrives in Chinese
      if (name === "taken") throw refuse("name-taken", "这个账号名已经有人用了。");
      log.push(`register:${name}`);
      state.lastName = name;
      return { id: "r1", name };
    };
    c.startEmail = async (email) => {
      await sleep(250);
      // i18n-allow: the account service's own message, which arrives in Chinese
      if (email.startsWith("taken")) throw refuse("email-taken", "这个邮箱已经绑定了别的账号。");
      log.push(`email-start:${email}`);
    };
    c.confirmEmail = async (code) => {
      await sleep(250);
      // i18n-allow: the account service's own message, which arrives in Chinese
      if (code === "000000") throw refuse("bad-code", "验证码不对或已经过期。");
      log.push(`email-confirm:${code}`);
    };
  }
  return c as CloudAccountClient;
};

function useFakeAccountProjects(): AccountProjectsHookResult {
  const [account, setAccount] = useState<Account | null>(null);
  const [guest, setGuest] = useState<GuestLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [link, setLink] = useState("");
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const nothing = async () => {};
  return {
    origin: location.origin, account, orgApi: null, busy, error, setError, shellOld: false, link, setLink,
    lists: account ? { owned: [], joined: [] } : null, listError: "", refreshLists: nothing, perform,
    enter: nothing, open: async () => { log.push("open"); return "failed"; },
    login: async (name, password) => {
      await sleep(300);
      // i18n-allow: the account service's own message, which arrives in Chinese
      if (password !== "right-password") throw new Error("账号名或密码不对。");
      log.push(`login:${name}`);
      setAccount({ id: "a1", name });
    },
    adoptSession: async () => { log.push("adopt"); setAccount({ id: "a2", name: state.lastName }); return true; },
    logout: async () => setAccount(null),
    create: async (name) => { log.push(`create:${name}`); },
    join: async () => "ok",
    guest, guestProject: null,
    enterAsGuest: async () => { log.push("guest"); setGuest({ id: "g", name: "Guest-3944", token: "t", expiresAt: Date.now() + 3600_000 }); return true; },
    newGuest: async () => true, leaveGuest: () => setGuest(null), openGuestProject: nothing,
    request: null, sendRequest: nothing, clearRequest: () => {},
    directSecondary: null, clearDirectSecondary: () => {},
    peekSession: async () => { throw new Error("harness"); },
    projectLink,
  };
}

registerAccountExtensions({ createAccountClient: fakeClient, useAccountProjects: useFakeAccountProjects });
(window as unknown as { __loginHarness: unknown }).__loginHarness = { log };
createRoot(document.getElementById("root")!).render(<OnlineStart onEnterEditor={() => { log.push("enter-editor"); }} />);

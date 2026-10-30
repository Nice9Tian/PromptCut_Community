/**
 * 手机版「凭邀请链接加入项目」(语义 `workflow/editing.md`「局域网里的第二块屏」)。
 *
 * 扫码进来的页面是主机发的,链接里带着邀请码和文档服务的路径(`src/online/invite.ts` 的 `#invite=…&doc=…`),
 * 所以这一屏**不问服务器地址、不要账号**:查一下这张码对应哪个项目,填个用户名(限定进入的再填密码),就进去了。
 *
 * 业务和桌面的 `editor/sync/JoinForm.tsx` 凭邀请链接那一路是同一套(`resolveInvite` → `redeemInvite` → `enterShared`),
 * 共用它的文案与候选拼法,不另造一份;只是画法换成手机的一屏。手填项目名加口令那条路手机上暂不放
 * (扫码是主场景,手填留给电脑)。
 */
import { useEffect, useRef, useState } from "react";
import { docBaseOf } from "../online/invite";
import { newProject } from "../editor/io/proc";
import { setActiveDraftId } from "../editor/io/drafts";
import { ensureDevice, enterShared } from "../editor/sync/syncManager";
import { client, errorStatus, type SharedMode } from "../editor/sync/sharedApi";
import { JOIN_TEXT, hostedCandidate } from "../editor/sync/JoinForm";
import { LogoMark } from "../ui/Logo";

type Phase =
  | { kind: "checking" }
  | { kind: "ok"; projectId: string; name: string; mode: SharedMode }
  | { kind: "dead"; text: string };

/** 用户名的形状和桌面同一条(1～64 个字符、无控制字符、首尾非空格) */
const usernameOk = (v: string) => v.length >= 1 && v.length <= 64 && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v);

export function MobileJoin({ invite, onJoined }: { invite: { code: string; doc: string }; onJoined: () => void }) {
  const base = docBaseOf(location.origin, invite.doc);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const started = useRef(false);

  // 查这张码对应哪个项目(不扣次数)。只查一次
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void ensureDevice();
    client.resolveInvite({ base, code: invite.code }).then(
      (p) => setPhase({ kind: "ok", projectId: p.projectId, name: p.name, mode: p.mode }),
      (e: unknown) => {
        const { status } = errorStatus(e);
        setPhase({ kind: "dead", text: status === 404 ? JOIN_TEXT.inviteInvalid : JOIN_TEXT.unreachable });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const needPassword = phase.kind === "ok" && phase.mode === "restricted";

  const submit = async () => {
    if (busy || phase.kind !== "ok") return;
    const user = username.trim();
    if (!user) return setMsg(JOIN_TEXT.needUsername);
    if (!usernameOk(user)) return setMsg(JOIN_TEXT.badUsername);
    if (needPassword && !password) return setMsg(JOIN_TEXT.needPassword);
    setBusy(true);
    setMsg(JOIN_TEXT.joining);
    try {
      const device = await ensureDevice();
      if (!device) return setMsg(JOIN_TEXT.unreachable);
      let red: Awaited<ReturnType<typeof client.redeemInvite>>;
      try {
        red = await client.redeemInvite({ base, code: invite.code, username: user, deviceId: device.deviceId });
      } catch (e) {
        const { status } = errorStatus(e);
        if (status === 404) { setPhase({ kind: "dead", text: JOIN_TEXT.inviteInvalid }); return; }
        setMsg(status === 401 ? JOIN_TEXT.kicked : JOIN_TEXT.unreachable);
        return;
      }
      // 进去之前先换一份空项目当起点:内容以文档服务为准(同桌面)
      newProject("未命名");
      const candidate = hostedCandidate(base, red);
      const cred = red.mode === "free" && red.key
        ? { as: "member" as const, username: user, password: "", key: red.key }
        : { as: "member" as const, username: user, password };
      const r = await enterShared(candidate, cred);
      if (r.ok) { setActiveDraftId(null); onJoined(); return; }
      const text: Record<string, string> = {
        auth: JOIN_TEXT.auth,
        kicked: JOIN_TEXT.kicked,
        "no-project": JOIN_TEXT.noProject,
        unreachable: JOIN_TEXT.unreachable,
        "not-ready": JOIN_TEXT.unreachable,
      };
      setMsg(text[r.error] ?? JOIN_TEXT.unreachable);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor" data-pcm="join-invite">
      <div className="topbar">
        <div className="logo"><LogoMark size={18} /><span>Prompt<b>Cut</b></span></div>
      </div>
      <div className="home-body">
        <form className="ps-m-login-form" data-pcm="join-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="ps-m-login-head">
            <b>加入项目</b>
            <span className="ps-m-login-sub" data-pcm="join-project">
              {phase.kind === "checking" ? "正在查这张邀请码…" : phase.kind === "ok" ? `「${phase.name}」` : "这张邀请码用不了"}
            </span>
          </div>

          {phase.kind === "dead" && <div className="hint err" data-pcm="join-dead">{phase.text}</div>}

          {phase.kind === "ok" && (
            <>
              <div className="field">
                <label>你的名字</label>
                <input className="text-in" name="username" autoComplete="nickname" autoFocus value={username}
                  data-pcm="join-username" onChange={(e) => { setUsername(e.target.value); setMsg(""); }} />
              </div>
              {needPassword && (
                <div className="field">
                  <label>密码</label>
                  <input className="text-in" name="password" type="password" autoComplete="current-password" value={password}
                    data-pcm="join-password" onChange={(e) => { setPassword(e.target.value); setMsg(""); }} />
                </div>
              )}
              {msg && <div className="hint" data-pcm="join-msg">{msg}</div>}
              <button type="submit" className="btn primary" data-pcm="join-submit" disabled={busy || !username.trim()}>
                {busy ? "正在加入…" : "加入"}
              </button>
              <div className="ps-m-login-alt">和电脑上是同一个项目，改动两边实时同步。</div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}

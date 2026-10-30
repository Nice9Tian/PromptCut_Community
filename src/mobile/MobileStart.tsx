/**
 * 手机版开始页：
 * - 扫码进来的局域网邀请链接（`#invite=…&doc=…`）直接进 `MobileJoin`；
 * - 云端扩展已注册（`cloud/account/ui-manifest.tsx`）时走 `MobileAccountStart`（网站账号登录、游客与云端项目列表）；
 * - 社区版移走 `cloud/` 时，提供粘贴局域网邀请链接加入共享项目的入口。
 */
import { useState, useSyncExternalStore } from "react";
import { getAccountExtensions, subscribeAccountExtensions } from "../editor/sync/accountExtensions";
import { LAN_JOIN_TEXT } from "../editor/sync/lanMemberSource";
import { parseInviteLink, takeCapturedInvite } from "../online/invite";
import { GlowLoop } from "../start/GlowLoop";
import { LogoMark } from "../ui/Logo";
import { MobileJoin } from "./MobileJoin";
import "./mobileLogin.css";

export function MobileStart({ onEnterEditor }: { onEnterEditor: () => void }) {
  /*
   * 扫码进来的(`#invite=…&doc=…`,`src/online/invite.ts` 启动时读走):直接进「加入项目」那一屏,不问账号 ——
   * 局域网里的共享项目凭项目凭证加入,和网站账号没关系(`workflow/editing.md`「局域网里的第二块屏」)。
   * 只取一次:`takeCapturedInvite` 给过就没了,所以记在 state 里。
   */
  const [captured] = useState(() => {
    const got = takeCapturedInvite();
    return got && "code" in got && got.doc ? { code: got.code, doc: got.doc } : null;
  });
  const [manualInvite, setManualInvite] = useState<{ code: string; doc: string } | null>(null);
  const [rawLink, setRawLink] = useState("");
  const [err, setErr] = useState("");
  const ext = useSyncExternalStore(subscribeAccountExtensions, getAccountExtensions, getAccountExtensions);

  if (captured) return <MobileJoin invite={captured} onJoined={onEnterEditor} />;
  if (manualInvite) return <MobileJoin invite={manualInvite} onJoined={onEnterEditor} />;
  if (ext.MobileAccountStart) {
    const MobileAccountStart = ext.MobileAccountStart;
    return <MobileAccountStart onEnterEditor={onEnterEditor} />;
  }

  const submitLanLink = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseInviteLink(rawLink.trim());
    if (!parsed) {
      setErr(LAN_JOIN_TEXT.badLink);
      return;
    }
    if (!parsed.doc) {
      setErr(LAN_JOIN_TEXT.oldLink);
      return;
    }
    setErr("");
    setManualInvite({ code: parsed.code, doc: parsed.doc });
  };

  return (
    <div className="editor" data-pcm="home">
      <div className="ps-m-login-bg" aria-hidden="true"><GlowLoop /></div>
      <div className="topbar">
        <div className="logo"><LogoMark size={18} /><span>Prompt<b>Cut</b></span></div>
      </div>
      <div className="home-body">
        {err && <div className="err" role="alert" data-pcm="home-error">{err}</div>}
        <form data-pcm="lan-join-form" className="ps-m-login-form" onSubmit={submitLanLink}>
          <div className="ps-m-login-head">
            <h2 className="sec">加入局域网共享项目</h2>
            <span className="ps-m-login-sub">扫描电脑端协作面板里的二维码，或粘贴局域网邀请链接进入。</span>
          </div>
          <div className="field">
            <label>邀请链接</label>
            <input
              className="text-in"
              data-pcm="join-link"
              placeholder="粘贴 #invite=… 局域网邀请链接"
              required
              value={rawLink}
              onChange={(e) => {
                setRawLink(e.target.value);
                setErr("");
              }}
            />
          </div>
          <button type="submit" className="btn primary" data-pcm="join-submit" disabled={!rawLink.trim()}>
            下一步
          </button>
        </form>
        <div className="note-mobile">手机端是“看与改”：对话、预览、微调、审阅 Agent 的改动。重型制作（导入大素材、写卡片代码）留给桌面端。</div>
      </div>
    </div>
  );
}

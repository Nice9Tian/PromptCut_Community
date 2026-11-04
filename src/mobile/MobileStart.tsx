/**
 * Mobile app start page:
 * - a LAN invite link reached by scanning the code (`#invite=…&doc=…`) goes straight to `MobileJoin`;
 * - when the cloud extension is registered (`cloud/account/ui-manifest.tsx`), it goes to `MobileAccountStart` (website account login, guest and cloud project list);
 * - when the community edition has `cloud/` moved out, it offers an entry to paste a LAN invite link and join a shared project.
 */
import { useState, useSyncExternalStore } from "react";
import { getAccountExtensions, subscribeAccountExtensions } from "../editor/sync/accountExtensions";
import { LAN_JOIN_TEXT } from "../editor/sync/lanMemberSource";
import { parseInviteLink, takeCapturedInvite } from "../online/invite";
import { GlowLoop } from "../start/GlowLoop";
import { LogoMark } from "../ui/Logo";
import { LanguageMenu } from "../ui/LanguageMenu";
import { MobileJoin } from "./MobileJoin";
import "./mobileLogin.css";
import { tr } from "../i18n/index.ts";

export function MobileStart({ onEnterEditor }: { onEnterEditor: () => void }) {
  /*
   * Arrived by scanning the code (`#invite=…&doc=…`, read away at startup by `src/online/invite.ts`): go straight to the "Join project" screen without asking for an account,
   * since a shared project on the LAN is joined with the project credential and has nothing to do with the website account (`workflow/editing.md` "The second screen on the LAN").
   * Take it only once: `takeCapturedInvite` is gone once it has been given out, so it is kept in state.
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
        <LanguageMenu />
      </div>
      <div className="home-body">
        {err && <div className="err" role="alert" data-pcm="home-error">{err}</div>}
        <form data-pcm="lan-join-form" className="ps-m-login-form" onSubmit={submitLanLink}>
          <div className="ps-m-login-head">
            <h2 className="sec">{tr("Join a LAN shared project")}</h2>
            <span className="ps-m-login-sub">{tr("Scan the QR code in the collaboration panel on the computer, or paste a LAN invite link to join.")}</span>
          </div>
          <div className="field">
            <label>{tr("Invite link")}</label>
            <input
              className="text-in"
              data-pcm="join-link"
              placeholder={tr("Paste a #invite=… LAN invite link")}
              required
              value={rawLink}
              onChange={(e) => {
                setRawLink(e.target.value);
                setErr("");
              }}
            />
          </div>
          <button type="submit" className="btn primary" data-pcm="join-submit" disabled={!rawLink.trim()}>
            {tr("Next")}
          </button>
        </form>
        <div className="note-mobile">{tr("The mobile app is for viewing and tweaking: chat, preview, fine adjustments, and reviewing the Agent's changes. Heavy production (importing large media, writing card code) is left to the desktop app.")}</div>
      </div>
    </div>
  );
}

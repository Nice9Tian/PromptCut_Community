/**
 * 「用链接加入项目」：开始页顶栏右边那颗键点出来的一小块。
 *
 * 接缝形状（替换型接缝 `JoinSource` + 云端账号适配器 `AccountProjectsHookResult`）：
 * - 当链接是局域网邀请链接（`#invite=<43位>&doc=<路径>`）或未提供云端账号上下文（社区版）时，
 *   走公开侧默认实现的局域网加入源（`getJoinSource().resolveLanInvite` + `joinLanByInvite`），
 *   凭用户名与项目口令/邀请码直接握手进入共享项目，不依赖网站账号；
 * - 当链接是云端账号项目链接且已安装云端账号扩展时，走 `ap.join`（支持二级密码与申请加入）。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  getJoinSource,
  type AccountProjectsHookResult,
  type LanInviteResolution,
} from "../editor/sync/accountExtensions";
import { client as sharedClient, errorStatus } from "../editor/sync/sharedApi";
import { JOIN_REQUEST_TEXT, autoJoinKey, joinRequestNotice } from "../editor/sync/joinRequestText";
import { ensureDevice, enterShared } from "../editor/sync/syncManager";
import { parseInviteLink } from "../online/invite";
import { tr } from "../i18n/index.ts";


type Ap = AccountProjectsHookResult;

export function JoinPanel(props: { ap?: Ap | null; askPassword: boolean; onClose: () => void; onJoined: () => void }): JSX.Element {
  const { ap } = props;
  const [localLink, setLocalLink] = useState("");
  const link = ap ? ap.link : localLink;
  const setLink = (v: string) => {
    if (ap) ap.setLink(v);
    else setLocalLink(v);
  };
  const [secondary, setSecondary] = useState("");
  const [askSecondary, setAskSecondary] = useState(props.askPassword);
  const [msg, setMsg] = useState(props.askPassword ? JOIN_REQUEST_TEXT.secondaryRequired : "");
  const [lanResolved, setLanResolved] = useState<LanInviteResolution | null>(null);
  const [lanUsername, setLanUsername] = useState("");
  const [lanPassword, setLanPassword] = useState("");
  const [lanBusy, setLanBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (props.askPassword) {
      setAskSecondary(true);
      setMsg(JOIN_REQUEST_TEXT.secondaryRequired);
    }
  }, [props.askPassword]);

  const isLanLink = Boolean(parseInviteLink(link.trim()));

  const submitLan = async () => {
    const raw = link.trim();
    if (!raw || lanBusy) return;
    setLanBusy(true);
    setMsg("");
    try {
      const joinSource = getJoinSource();
      let resolved = lanResolved;
      if (!resolved) {
        const r = await joinSource.resolveLanInvite(raw);
        if (!r.ok) {
          setMsg(r.error);
          return;
        }
        resolved = r;
        setLanResolved(r);
        if (!lanUsername.trim()) return;
      }
      const joined = await joinSource.joinLanByInvite({
        base: resolved.base,
        code: resolved.code,
        username: lanUsername,
        password: resolved.mode === "restricted" ? lanPassword : undefined,
      });
      if (!joined.ok) {
        setMsg(joined.error);
        return;
      }
      props.onJoined();
    } finally {
      setLanBusy(false);
    }
  };

  const submit = (pass: string | undefined) => {
    if (isLanLink || !ap) {
      void submitLan();
      return;
    }
    void ap.perform(async () => {
      setMsg("");
      const outcome = await ap.join(ap.link, pass);
      if (outcome === "secondary-required" || outcome === "bad-secondary") {
        setAskSecondary(true);
        setMsg(outcome === "bad-secondary" ? tr("Incorrect project secondary password.") : JOIN_REQUEST_TEXT.secondaryRequired);
        return;
      }
      if (outcome === "expired") {
        setMsg(tr("This project link has expired. Contact the creator for the latest link."));
        return;
      }
      if (outcome === "not-listed") return;
      setAskSecondary(false);
      setSecondary("");
      props.onJoined();
    });
  };

  // 申请被通过、或项目改回「知道链接就能进」:自动再走一次加入(同 AccountProjects.tsx)
  const autoJoin = autoJoinKey(ap?.request ?? null);
  useEffect(() => {
    if (autoJoin && ap) void submit(undefined);
  }, [autoJoin]); // eslint-disable-line react-hooks/exhaustive-deps

  // 按 Esc 关
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props]);

  const notice = ap?.request && (ap.account || ap.guest) ? joinRequestNotice(ap.request) : null;
  const signedIn = isLanLink || !ap ? true : !!(ap.account || ap.guest);
  const busy = lanBusy || Boolean(ap?.busy);

  return (
    <div ref={box} className="ps-menu ps-join" role="dialog" aria-label={tr("Join with a project link")} data-pc="start-join">
      <div className="ps-menu-head">{tr("Join with a project link")}</div>
      <form
        className="ps-join-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(askSecondary ? secondary : secondary || undefined);
        }}
      >
        <label className="ps-field">
          {tr("Project link")}
          <input
            data-pc="start-join-link"
            type="text"
            required
            placeholder={tr("Paste the cloud or LAN project link someone gave you")}
            value={link}
            autoFocus
            onChange={(e) => {
              setLink(e.target.value);
              setAskSecondary(false);
              setLanResolved(null);
              setMsg("");
              ap?.clearRequest();
            }}
          />
        </label>
        {lanResolved && (
          <>
            <label className="ps-field">
              {tr("Your username (shown in the project)")}
              <input
                data-pc="start-join-lan-username"
                type="text"
                required
                placeholder={tr("e.g. Alex")}
                value={lanUsername}
                onChange={(e) => {
                  setLanUsername(e.target.value);
                  setMsg("");
                }}
              />
            </label>
            {lanResolved.mode === "restricted" && (
              <label className="ps-field">
                {tr("Project password")}
                <input
                  data-pc="start-join-lan-password"
                  type="password"
                  required
                  placeholder={tr("Enter the project password")}
                  value={lanPassword}
                  onChange={(e) => {
                    setLanPassword(e.target.value);
                    setMsg("");
                  }}
                />
              </label>
            )}
          </>
        )}
        {askSecondary && !lanResolved && (
          <label className="ps-field">
            {tr("Project secondary password")}
            <input
              data-pc="start-join-secondary"
              type="password"
              required
              placeholder={tr("Enter the project secondary password")}
              value={secondary}
              onChange={(e) => setSecondary(e.target.value)}
            />
          </label>
        )}
        {msg && <p className="ps-join-msg" role="alert" data-pc="start-join-msg">{msg}</p>}
        {!signedIn && <p className="ps-join-msg">{tr("Sign in to an account or enter as a guest to join someone else's project.")}</p>}
        {notice && ap?.request && (
          <div className="ps-join-msg" role="status" data-pc="start-join-request" data-state={ap.request.state}>
            <span>{notice.text}</span>
            {notice.canSend && (
              <button
                type="button"
                className="ps-ghost-btn"
                data-pc="start-join-request-send"
                disabled={busy}
                onClick={() => void ap.perform(ap.sendRequest)}
              >
                {JOIN_REQUEST_TEXT.send}
              </button>
            )}
            {notice.hint && <span className="ps-muted">{notice.hint}</span>}
          </div>
        )}
        <div className="ps-join-actions">
          <button type="button" className="ps-ghost-btn" onClick={props.onClose}>{tr("Cancel")}</button>
          <button className="ps-primary-btn" data-pc="start-join-submit" disabled={busy || !signedIn || !link.trim()}>
            {askSecondary ? tr("Verify secondary password and join") : tr("Join and open project")}
          </button>
        </div>
      </form>
    </div>
  );
}

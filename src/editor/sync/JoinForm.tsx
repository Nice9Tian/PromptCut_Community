/**
 * 开始页「加入别人的项目」（C10a 契约 `docs/plan/c10a-contract.md` 第 4 节；语义 `workflow/project.md`「多用户协作」）。
 * 桌面版与在线浏览器模式用同一个组件，差别只在服务器地址：
 * - 在线页面：本页的源，文档服务在 `<源>/hosted/`；
 * - 桌面版：手填时用内置的托管地址（C6.5 的缺省值，可改），同时像 C6.5 那样在局域网里找同名项目（本机托管的项目）；
 * - 粘贴邀请链接：取链接的源。
 *
 * 三条路径：
 * 1. 手填，自由进入：项目名、项目密码、自己的用户名；
 * 2. 手填，限定进入：项目名、名单里的用户名和密码（与 1 同一张表：密码框自由进入填项目密码，限定进入填名单里的密码）；
 * 3. 凭邀请链接：页面读到邀请码先 `resolve`，显示项目名；自由进入只填用户名（`redeem` 回项目口令的 K，照常握手），
 *    限定进入填名单里的用户名和密码。`resolve` 失败给完整表单加表 A 的提示。
 * 另有「我是创建者」：用户名预填创建者名并置灰（这台设备记得的话），只填创建者密码，以 `as: 'creator'` 进入。
 *
 * 文案照契约第 14 节表 A。邀请码不进查询串、不写 localStorage、不进日志（`src/online/invite.ts`）。
 */
import { useEffect, useRef, useState } from "react";
import { ONLINE } from "../../online/mode";
import { docBaseOf, hostedDocBaseOf, hostedWsUrlOf, parseInviteLink, takeCapturedInvite } from "../../online/invite";
import { newProject } from "../io/proc";
import { setActiveDraftId } from "../io/drafts";
import { enterShared, ensureDevice, knownCreator, type EnterResult } from "./syncManager";
import { client, errorStatus, hosted, hostedTarget, route, type Candidate, type FindResult, type SharedMode } from "./sharedApi";
import { discoverViaEditor, readHostedUrl, uiHostedUrl, writeHostedUrl } from "./SharedDialogs";
import "./sync.css";

/** 表 A（契约第 14 节）：原文照抄 */
export const JOIN_TEXT = {
  needName: "请输入项目名",
  needPassword: "请输入密码",
  needUsername: "请输入用户名",
  badUsername: "用户名格式不对（1～64 个字符，不能有控制字符，首尾不能是空格）",
  noProject: "找不到这个项目，检查一下项目名。",
  auth: "用户名或密码不对。忘了的话找创建者问一下。",
  kicked: "你被创建者踢出了这个项目。想回来，找创建者撤销。",
  inviteInvalid: "这个邀请链接已失效，向创建者要一个新的，或手动填写项目信息。",
  oldLink: "这是旧版邀请链接，向创建者要一张新的（设置里「作废并重新生成邀请码」），或手动填写项目信息。",
  rateLimited: (sec: number | null) => (sec ? `尝试次数太多，请 ${sec} 秒后再试。` : "尝试次数太多，请稍后再试。"),
  offline: "当前没有网络连接。",
  unreachable: "连不上服务器，请稍后再试。",
  joining: "正在加入…",
  badLink: "这不是有效的邀请链接。",
} as const;

/** 服务端的用户名规则（`server/auth/protocol.mjs` 的 `isUsername`）：界面只做同样的前置检查 */
export function usernameOk(v: string): boolean {
  return v.length > 0 && Array.from(v).length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(v) && v.trim() === v;
}

type InviteState =
  | { phase: "checking"; code: string; base: string }
  | { phase: "ok"; code: string; base: string; projectId: string; name: string; mode: SharedMode }
  | null;

/** 在线页面的文档服务：本页的源下 `/hosted/` */
function onlineBase(): string {
  return hostedDocBaseOf(location.origin);
}

/**
 * 凭源与路径走的候选：WebSocket 地址保留末尾斜杠（nginx，见 `hostedWsUrlOf`）。
 * 手机版凭邀请链接加入那一屏（`src/mobile/MobileJoin.tsx`）共用这一份。
 */
export function hostedCandidate(base: string, p: { projectId: string; name: string; mode: SharedMode }): Candidate {
  return { where: "hosted", base, ws: hostedWsUrlOf(base), projectId: p.projectId, name: p.name, mode: p.mode };
}

const candidateLabel = (c: Candidate) => (c.where === "hosted" ? `[云端] ${new URL(c.base).host}` : `[本机 · 局域网] 主机：${c.hostDeviceName ?? new URL(c.base).host}`);

export function JoinForm({ onJoined }: { onJoined: () => void }) {
  const [invite, setInvite] = useState<InviteState>(null);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [asCreator, setAsCreator] = useState(false);
  const [paste, setPaste] = useState("");
  const [hostedUrl, setHostedUrl] = useState(() => (ONLINE ? "" : readHostedUrl()));
  const [showServer, setShowServer] = useState(false);
  const [choices, setChoices] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "err" | "info" } | null>(null);
  const [lockUntil, setLockUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const started = useRef(false);

  const locked = Math.max(0, Math.ceil((lockUntil - now) / 1000));
  useEffect(() => {
    if (lockUntil <= now) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [lockUntil, now]);

  const fail = (text: string) => setMsg({ text, tone: "err" });
  const rateLimited = (sec: number | null) => {
    fail(JOIN_TEXT.rateLimited(sec));
    setLockUntil(Date.now() + (sec ?? 60) * 1000);
    setNow(Date.now());
  };

  /** 查邀请码（不扣次数）：成功显示项目名与精简表单，失败给完整表单加表 A 的提示 */
  const checkInvite = async (code: string, base: string) => {
    setInvite({ phase: "checking", code, base });
    setMsg(null);
    try {
      const p = await client.resolveInvite({ base, code });
      setInvite({ phase: "ok", code, base, ...p });
      setAsCreator(false);
      setPassword("");
    } catch (e) {
      setInvite(null);
      const { status, retryAfter } = errorStatus(e);
      if (status === 404) fail(JOIN_TEXT.inviteInvalid);
      else if (status === 429) rateLimited(retryAfter);
      else fail(navigator.onLine === false ? JOIN_TEXT.offline : JOIN_TEXT.unreachable);
    }
  };

  // 启动时读到的邀请码（`main.tsx` 读 `#invite=` 后已清掉片段）：只取一次
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void ensureDevice();
    const got = takeCapturedInvite();
    if (!got) return;
    if (!("code" in got)) return fail(JOIN_TEXT.badLink);
    /*
     * 文档服务在哪由链接自己说（`online/invite.ts` 的 `doc=`）：托管端是 `/hosted/`、局域网主机是 `/docservice`，
     * 源是这张页面自己的源 —— 扫码进来的页面本来就是那台主机发的。不带 `doc=` 的是旧链接，当失效。
     */
    if (!got.doc) return fail(JOIN_TEXT.oldLink);
    void checkInvite(got.code, docBaseOf(location.origin, got.doc));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const usePasted = () => {
    const parsed = parseInviteLink(paste);
    if (!parsed) return fail(JOIN_TEXT.badLink);
    // 粘来的链接自己带着源和路径,两样都照它的（不带 `doc=` 的是旧链接,当失效）
    if (!parsed.doc) return fail(JOIN_TEXT.oldLink);
    setPaste("");
    void checkInvite(parsed.code, docBaseOf(parsed.origin, parsed.doc));
  };

  const creatorName = invite?.phase === "ok" ? knownCreator(invite.projectId) : null;

  /** 进入：新开一个空项目当起点（项目内容以文档服务为准），进去了就进编辑器 */
  const enter = async (candidate: Candidate, cred: { as: "member" | "creator"; username: string; password: string; key?: string }) => {
    newProject("未命名");
    const r: EnterResult = await enterShared(candidate, cred);
    if (r.ok) {
      setActiveDraftId(null);
      onJoined();
      return true;
    }
    const text: Record<string, string> = {
      auth: JOIN_TEXT.auth,
      kicked: JOIN_TEXT.kicked,
      "no-project": JOIN_TEXT.noProject,
      unreachable: JOIN_TEXT.unreachable,
      "not-ready": JOIN_TEXT.unreachable,
    };
    if (r.error === "rate-limited") rateLimited(r.retryAfter ?? null);
    else fail(navigator.onLine === false ? JOIN_TEXT.offline : text[r.error] ?? JOIN_TEXT.unreachable);
    return false;
  };

  const submit = async () => {
    if (busy || locked > 0) return;
    const user = (asCreator && creatorName ? creatorName : username).trim();
    const viaInvite = invite?.phase === "ok" ? invite : null;
    const needPassword = asCreator || !viaInvite || viaInvite.mode === "restricted";
    if (!viaInvite && !name.trim()) return fail(JOIN_TEXT.needName);
    if (!user) return fail(JOIN_TEXT.needUsername);
    if (!usernameOk(user)) return fail(JOIN_TEXT.badUsername);
    if (needPassword && !password) return fail(JOIN_TEXT.needPassword);
    if (navigator.onLine === false) return fail(JOIN_TEXT.offline);
    setBusy(true);
    setMsg({ text: JOIN_TEXT.joining, tone: "info" });
    try {
      if (viaInvite) {
        const candidate = hostedCandidate(viaInvite.base, viaInvite);
        if (asCreator) {
          await enter(candidate, { as: "creator", username: user, password });
          return;
        }
        const device = await ensureDevice();
        if (!device) return fail(JOIN_TEXT.unreachable);
        let red: Awaited<ReturnType<typeof client.redeemInvite>>;
        try {
          red = await client.redeemInvite({ base: viaInvite.base, code: viaInvite.code, username: user, deviceId: device.deviceId });
        } catch (e) {
          const { status, retryAfter } = errorStatus(e);
          if (status === 404) {
            setInvite(null);
            return fail(JOIN_TEXT.inviteInvalid);
          }
          if (status === 401) return fail(JOIN_TEXT.kicked);
          if (status === 429) return rateLimited(retryAfter);
          return fail(JOIN_TEXT.unreachable);
        }
        const c = hostedCandidate(viaInvite.base, red);
        if (red.mode === "free" && red.key) await enter(c, { as: "member", username: user, password: "", key: red.key });
        else await enter(c, { as: "member", username: user, password });
        return;
      }
      // 手填：在线页面只问本页的源；桌面版问托管地址，并在局域网里找（C6.5 的查找）
      let candidates: Candidate[];
      if (ONLINE) {
        const base = onlineBase();
        try {
          const p = await client.lookupProject({ base, name: name.trim() });
          candidates = [hostedCandidate(base, p)];
        } catch (e) {
          const { status } = errorStatus(e);
          return fail(status === 404 ? JOIN_TEXT.noProject : JOIN_TEXT.unreachable);
        }
      } else {
        let hostedChoice: string | null;
        try {
          hostedChoice = hostedUrl.trim() && hostedUrl.trim() !== hosted.DEFAULT_HOSTED_URL ? hosted.resolveHostedUrl({ ui: hostedUrl }) : null;
        } catch {
          return fail(JOIN_TEXT.unreachable);
        }
        writeHostedUrl(hostedUrl);
        const device = await ensureDevice();
        let r: FindResult;
        try {
          r = await route.findSharedProject({
            name: name.trim(),
            uiHostedUrl: hostedChoice ?? uiHostedUrl(),
            lan: device?.localEditor ? { discover: discoverViaEditor } : {},
          });
        } catch {
          r = { candidates: [], errors: [{ where: "hosted", reason: "unreachable" }] };
        }
        if (!r.candidates.length) {
          const hostedErr = r.errors.some((e) => e.where === "hosted");
          return fail(hostedErr ? JOIN_TEXT.unreachable : JOIN_TEXT.noProject);
        }
        candidates = r.candidates;
      }
      if (candidates.length > 1) {
        setChoices(candidates);
        setMsg(null);
        return;
      }
      await enter(candidates[0], { as: asCreator ? "creator" : "member", username: user, password });
    } finally {
      setBusy(false);
    }
  };

  const pick = async (c: Candidate) => {
    setChoices(null);
    setBusy(true);
    setMsg({ text: JOIN_TEXT.joining, tone: "info" });
    try {
      await enter(c, { as: asCreator ? "creator" : "member", username: (asCreator && creatorName ? creatorName : username).trim(), password });
    } finally {
      setBusy(false);
    }
  };

  const viaInvite = invite?.phase === "ok" ? invite : null;
  const fields = (() => {
    const onEnter = (e: React.KeyboardEvent) => {
      if (e.key === "Enter") void submit();
    };
    const userField = (label: string, placeholder: string, locked = false) => (
      <div className="pc-sync-field">
        <label htmlFor="pc-join-user">{label}</label>
        <input id="pc-join-user" className="pc-dialog-input" data-pc="join-username" value={locked && creatorName ? creatorName : username} disabled={locked && !!creatorName}
          placeholder={placeholder} maxLength={64} onChange={(e) => setUsername(e.target.value)} onKeyDown={onEnter} />
      </div>
    );
    const pwField = (label: string, placeholder: string) => (
      <div className="pc-sync-field">
        <label htmlFor="pc-join-pw">{label}</label>
        <input id="pc-join-pw" type="password" className="pc-dialog-input" data-pc="join-password" value={password} placeholder={placeholder}
          onChange={(e) => setPassword(e.target.value)} onKeyDown={onEnter} />
      </div>
    );
    if (viaInvite) {
      if (asCreator) return <>{userField("创建者用户名", "创建者的用户名", true)}{pwField("创建者密码", "输入创建者密码")}</>;
      return viaInvite.mode === "free"
        ? userField("你的用户名", "报上你的名字")
        : <>{userField("用户名", "输入名单里的用户名")}{pwField("密码", "对应的密码")}</>;
    }
    return (
      <>
        <div className="pc-sync-field">
          <label htmlFor="pc-join-name">项目名</label>
          <input id="pc-join-name" className="pc-dialog-input" data-pc="join-name" value={name} placeholder="创建者告诉你的项目名" maxLength={64}
            onChange={(e) => setName(e.target.value)} onKeyDown={onEnter} />
        </div>
        {asCreator
          ? <>{userField("创建者用户名", "创建者的用户名")}{pwField("创建者密码", "输入创建者密码")}</>
          : <>{userField("你的用户名", "自由进入报上你的名字；限定进入填名单里的用户名")}{pwField("密码", "自由进入填项目密码；限定进入填你在名单里的密码")}</>}
      </>
    );
  })();

  return (
    <div className="pc-join" data-pc="join-form">
      {invite?.phase === "checking" ? <div className="pc-sync-hint">正在核对邀请链接…</div> : null}
      {viaInvite ? (
        <div className="pc-join-project" data-pc="join-invite-project">
          项目：<b>{viaInvite.name}</b>
          <span className="pc-sync-hint">{viaInvite.mode === "free" ? "（自由进入，填个用户名就能进）" : "（限定进入，填名单里的用户名和密码）"}</span>
        </div>
      ) : null}
      {choices ? (
        <div className="pc-sync-choices-v" data-pc="join-candidates">
          <div className="pc-sync-hint">找到几个同名项目，选一个：</div>
          {choices.map((c) => (
            <button key={c.base + c.projectId} type="button" className="pc-sync-choice" onClick={() => void pick(c)}>
              <span className="pc-sync-choice-dot" />
              <span className="pc-sync-choice-text">
                <b>{candidateLabel(c)}</b>
                <small>{c.name}</small>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="pc-join-fields">{fields}</div>
      )}
      <div className="pc-join-actions">
        <button type="button" className="pc-btn pc-btn--primary" data-pc="join-submit" disabled={busy || locked > 0 || invite?.phase === "checking"} onClick={() => void submit()}>
          {locked > 0 ? `加入 (${locked}s)` : "加入"}
        </button>
        <button type="button" className="pc-sync-link-btn" data-pc="join-as-creator" onClick={() => { setAsCreator(!asCreator); setPassword(""); setMsg(null); setChoices(null); }}>
          {asCreator ? "返回" : "我是创建者"}
        </button>
        {viaInvite ? (
          <button type="button" className="pc-sync-link-btn" onClick={() => { setInvite(null); setMsg(null); setAsCreator(false); }}>
            手动填写项目信息
          </button>
        ) : null}
        {!ONLINE && !viaInvite && hostedTarget ? (
          <button type="button" className="pc-sync-link-btn" onClick={() => setShowServer(!showServer)}>
            服务器地址
          </button>
        ) : null}
      </div>
      {showServer && !ONLINE && !viaInvite && hostedTarget ? (
        <div className="pc-sync-field">
          <label htmlFor="pc-join-server">托管地址</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input id="pc-join-server" className="pc-dialog-input" value={hostedUrl} onChange={(e) => setHostedUrl(e.target.value)} />
            <button type="button" className="pc-dialog-opt" style={{ height: 30 }} onClick={() => setHostedUrl(hosted.DEFAULT_HOSTED_URL)}>
              恢复默认
            </button>
          </div>
        </div>
      ) : null}
      {msg ? <div className={`pc-sync-status-line${msg.tone === "err" ? " is-err" : ""}`} data-pc="join-message" role={msg.tone === "err" ? "alert" : undefined}>{msg.text}</div> : null}
      <div className="pc-join-paste">
        <label htmlFor="pc-join-link" className="pc-sync-hint">有邀请链接？粘贴在这里：</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="pc-join-link" className="pc-dialog-input" data-pc="join-link" value={paste} placeholder="https://…/editor#invite=…"
            onChange={(e) => setPaste(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") usePasted(); }} />
          <button type="button" className="pc-dialog-opt" data-pc="join-link-submit" style={{ height: 30, whiteSpace: "nowrap" }} disabled={!paste.trim() || busy} onClick={usePasted}>
            用链接加入
          </button>
        </div>
      </div>
    </div>
  );
}

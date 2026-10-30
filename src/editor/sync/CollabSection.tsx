/**
 * 项目设置里的「多用户协作」一段（C10a 契约 `docs/plan/c10a-contract.md` 第 6、7 节；文案照第 14 节表 B）。
 *
 * - 没开启：勾选框。勾上后给出缺省（放本机、自由进入、创建者用户名取设备名、两样密码自动生成并存在本机），都能改；
 *   点对话框的「确定」才开始设置（语义「勾上并保存」），对话框留着显示进度与结果。
 * - 已开启（当前连着共享项目）：项目名与项目密码（自由进入，带复制）、邀请链接与二维码（放云端，只有创建者本机有）、
 *   邀请码状态、创建者操作（作废并重新生成邀请码，每次当场输入创建者密码；以及 C6.5 的改项目密码、改名单、踢人、删项目）。
 * - 取消勾选再「确定」：确认后放云端的先拉回本机再删云端项目，放本机的停本机托管；中途失败恢复为开启。
 *
 * - 「放弃这次搬迁」（〔裁〕H04）：上一次搬到云端没做完、云端项目已经建好时出现（判据见 `accountMove.ts` 的 `pendingAttempt`）；
 *   点了先在这一段里给一次确认（删的是哪一个云端项目、删了不能恢复、本机项目不受影响），确认后删云端那个项目并清掉本机的搬迁记录。
 * - 「搬到云端」（桌面版）：目标是这台桌面版配置的账号云端时走账号办法（`accountMoveFlow.ts`）——云端新建一个属于登录账号的项目、
 *   内容与本机一致，编辑器接着就在云端项目里；本机协作房间搬完即关闭、旧邀请码作废。两个入口：没开协作时勾上并选「云端」点「确定」；
 *   已开本机协作时点「搬到云端」。没登录先在这里登录。目标是别的节点（用户自己填的地址）时照旧办法。
 *
 * 房间关联写进普通项目文件，凭证只在设备保护存储中；连接状态取自同步管理（`syncManager.ts`）与本机记录（`collab.ts`）。
 */
import { forwardRef, useEffect, useImperativeHandle, useState, useSyncExternalStore } from "react";
import { qrSvg } from "../../../server/qr.mjs";
import { ONLINE } from "../../online/mode";
import { hosted, hostedTarget, type SharedMode, type Where } from "./sharedApi";
import { ListEditor, LanRestartHint, readHostedUrl, writeHostedUrl } from "./SharedDialogs";
import { CreatorFlow, type Flow } from "./MembersPanel";
import { HostedServiceRows } from "./HostedServiceRows";
import { useSync, moveSharedToHosted, moveSharedToLan, pushToast, regenAccountProjectLink, setAccountSecondaryPassword } from "./syncManager";
import { ACCOUNT_MOVE_TEXT, abandonFailureText, moveFailureText } from "./accountMove";
import { abandonPendingMove, accountCloud, accountCloudLogin, accountCloudSignIn, accountShellTooOld, moveCurrentToAccountCloud, oldShellBlocksAccountMove, pendingMove, targetsAccountCloud, type AccountCloud } from "./accountMoveFlow";
import { OLD_SHELL_ACCOUNT_TEXT } from "./desktopShellBridge";
import { getAccountExtensions, projectLink, subscribeAccountExtensions, type Account } from "./accountExtensions";
function AccountEntryOption(props: { disabled?: boolean }) {
  const ext = useSyncExternalStore(subscribeAccountExtensions, getAccountExtensions, getAccountExtensions);
  return ext.AccountEntryOption ? <ext.AccountEntryOption disabled={props.disabled} /> : null;
}
import {
  createInvite, defaultCreatorName, disableCollab, enableCollab, fetchInviteStatus, generatePassword, localCollab,
  type InviteInfo, type InviteStatus,
} from "./collab";
import "./sync.css";

/** 表 B（契约第 14 节）：原文照抄 */
export const COLLAB_TEXT = {
  enabling: "正在设置多用户协作…",
  enabled: "多用户协作已开启。",
  offline: "当前离线，不能放到云端。联网后再试。",
  unreachable: "连不上云端，设置没有完成。",
  copied: "已复制",
  regenConfirm: "作废后，旧链接和旧二维码立刻失效（项目密码不受影响）。确认作废并重新生成？",
  regenDone: "已生成新的邀请链接与二维码。",
  inviteDead: "邀请码已失效，可以重新生成。",
  cancelConfirm: "取消后其他成员不能再进入。会先把项目内容和素材原尺寸拉回本机，确认取消？",
  cancelling: "正在把项目内容拉回本机…",
  cancelled: "多用户协作已关闭，内容已拉回本机。",
  cancelFailed: "拉回本机没有完成，已恢复为开启状态。检查网络后重试。",
  localNote: "你的电脑关机后其他人打不开，可在设置里搬到云端",
  localLimit: "放本机时，主机在线且云端登记成功后，其他成员可通过中继加入；临时网络故障会自动重试登记。",
} as const;

export interface CollabHandle {
  /** 对话框「确定」时调：回 true 表示这一段有动作在做（对话框留着），false 表示没有要做的 */
  apply(projectName: string): Promise<boolean>;
}

function copy(text: string, done: () => void) {
  void navigator.clipboard?.writeText(text).then(done, () => undefined);
}

function when(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const CollabSection = forwardRef<CollabHandle, { open: boolean }>(function CollabSection({ open }, ref) {
  const shared = useSync((v) => v.shared);
  const rev = useSync((v) => v.rev);
  const device = useSync((v) => v.device);
  const association = useSync((v) => v.association);
  const hostRegistration = useSync((v) => v.hostRegistration);
  const hostedServices = useSync((v) => v.hosted);
  const isOn = !!shared || !!association;
  const isAccount = !!shared?.accountId;
  const [checked, setChecked] = useState(isOn);
  const [where, setWhere] = useState<Where>("lan");
  const [mode, setMode] = useState<SharedMode>("free");
  const [creator, setCreator] = useState("");
  const [creatorPw, setCreatorPw] = useState("");
  const [projectPw, setProjectPw] = useState("");
  const [list, setList] = useState<{ username: string; password: string }[]>([]);
  const [rowName, setRowName] = useState("");
  const [rowPw, setRowPw] = useState("");
  const [rowErr, setRowErr] = useState("");
  const [hostedUrl, setHostedUrl] = useState(readHostedUrl());
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "err" | "info" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [movingHosted, setMovingHosted] = useState(false);
  const [movingLan, setMovingLan] = useState(false);
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [inviteStatus, setInviteStatus] = useState<InviteStatus | null>(null);
  const [regenPw, setRegenPw] = useState<string | null>(null);
  const [cancelPw, setCancelPw] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [secondaryModalOpen, setSecondaryModalOpen] = useState(false);
  const [secondaryPw, setSecondaryPw] = useState("");
  const [secondaryBusy, setSecondaryBusy] = useState(false);
  // 账号办法的「搬到云端」：这台桌面版配置的账号云端（没有账号桥是 null）、登录的账号（undefined = 还在查）
  const [acct, setAcct] = useState<AccountCloud | null>(null);
  const [acctUser, setAcctUser] = useState<Account | null | undefined>(undefined);
  /** 桌面外壳太老（0.2.8 以前打了补丁）没有账号桥：缺省云端的「搬到云端」说明要装完整安装包，不往下走 */
  const [shellOld, setShellOld] = useState(false);
  /** 要先登录：登录成功后接着搬（`name` 是那一次要用的云端项目名） */
  const [loginFor, setLoginFor] = useState<{ name: string } | null>(null);
  const [loginName, setLoginName] = useState("");
  const [loginPw, setLoginPw] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  /** 协作房间搬到云端：云端项目名（重名时改）、创建者密码（本机没存时填） */
  const [cloudName, setCloudName] = useState("");
  const [askCloudName, setAskCloudName] = useState(false);
  const [movePw, setMovePw] = useState("");
  const [askMovePw, setAskMovePw] = useState(false);
  /** 搬完（或云端项目已建好但没做完）时给的项目链接 */
  const [moveLink, setMoveLink] = useState<string | null>(null);
  /** 放弃这次搬迁：点了按钮、正在等确认 */
  const [abandonAsk, setAbandonAsk] = useState(false);

  const local = shared ? localCollab(shared.projectId) : null;
  const iAmCreator = !!shared?.creator;
  const lanOk = !ONLINE && !!device?.localEditor;
  useEffect(() => {
    if (movingHosted && shared?.where === "hosted") {
      setMovingHosted(false); setStatus({ text: "已搬到云端，仍是原房间。", tone: "ok" });
    }
  }, [movingHosted, shared?.where]);
  useEffect(() => {
    if (movingLan && shared?.where === "lan") {
      setMovingLan(false); setStatus({ text: "已搬回本机，仍是原房间。", tone: "ok" });
    }
  }, [movingLan, shared?.where]);

  // 打开对话框时按当前状态重置；只有尚未开启协作的创建表单生成缺省密码，恢复原房间不生成新密码。
  useEffect(() => {
    if (!open) return;
    setChecked(isOn);
    setStatus(null);
    setBusy(false);
    setRegenPw(null);
    setCancelPw("");
    setCopied(null);
    setWhere(ONLINE ? "hosted" : "lan");
    setMode("free");
    setCreatorPw(isOn ? "" : generatePassword());
    setProjectPw(isOn ? "" : generatePassword());
    setList([]);
    setHostedUrl(readHostedUrl());
    void defaultCreatorName().then(setCreator);
    setLoginFor(null); setLoginPw(""); setLoginBusy(false);
    setCloudName(""); setAskCloudName(false); setMovePw(""); setAskMovePw(false); setMoveLink(null); setAbandonAsk(false);
    // 账号云端与登录状态：打开设置时查一次（没有账号桥就没有这一套，「云端」照旧办法）
    let live = true;
    setAcctUser(undefined); setShellOld(false);
    void accountCloud().then(async (c) => {
      if (!live) return;
      setAcct(c); setShellOld(accountShellTooOld());
      if (!c) { setAcctUser(null); return; }
      try { const user = await accountCloudLogin(c); if (live) setAcctUser(user); }
      catch { if (live) setAcctUser(null); }
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 已开启：邀请链接取本机记下的；状态用本机记下的创建者密码现查（只读，没有就不查）
  useEffect(() => {
    if (!open || !shared) {
      setInvite(null);
      setInviteStatus(null);
      return;
    }
    const rec = localCollab(shared.projectId);
    setInvite(rec?.invite ?? null);
    setInviteStatus(null);
    if (shared.where === "hosted" && shared.creator && rec?.creatorPassword) {
      void fetchInviteStatus(rec.creatorPassword).then((r) => { if (r.ok) setInviteStatus(r.status); });
    }
  }, [open, shared]);

  const addRow = () => {
    const u = rowName.trim();
    if (!u) return setRowErr("用户名不能为空。");
    if (!rowPw) return setRowErr("密码不能为空。");
    if (u === creator.trim() || list.some((r) => r.username === u)) return setRowErr("名单里已有这个名字，换一个区分一下。");
    setList([...list, { username: u, password: rowPw }]);
    setRowName("");
    setRowPw("");
    setRowErr("");
  };

  useImperativeHandle(ref, () => ({
    async apply(projectName: string) {
      if (busy) return true;
      if (checked && !isOn) {
        // 放云端、目标是账号云端：把当前项目搬成账号的云端项目（不用创建者用户名和密码）
        if (where === "hosted") {
          const c = acct ?? await accountCloud();
          if (targetsAccountCloud(hostedUrl, c)) {
            void startAccountMove(c!, projectName);
            return true;
          }
          if (oldShellBlocksAccountMove(hostedUrl)) { setStatus({ text: OLD_SHELL_ACCOUNT_TEXT, tone: "info" }); return true; }
        }
        if (!creator.trim() || !creatorPw || (mode === "free" && !projectPw)) {
          setStatus({ text: "创建者用户名和密码不能为空。", tone: "err" });
          return true;
        }
        if (where === "lan" && !lanOk) return true;
        setBusy(true);
        setStatus({ text: COLLAB_TEXT.enabling, tone: "info" });
        if (where === "hosted") writeHostedUrl(hostedUrl);
        const r = await enableCollab({
          where,
          mode,
          name: projectName,
          creator: { username: creator.trim(), password: creatorPw },
          ...(mode === "free" ? { projectPassword: projectPw } : { list }),
          hostedUrl: where === "hosted" && hostedUrl.trim() !== hosted.DEFAULT_HOSTED_URL ? hostedUrl.trim() : null,
        });
        setBusy(false);
        if (!r.ok) {
          const text = r.error === "offline" ? COLLAB_TEXT.offline
            : r.error === "name-taken" ? "这个项目名已被占用，换一个吧。"
              : r.error === "lan-failed" ? "本机端口被占用，先关掉占用的另一个 PromptCut 窗口，或重启软件试试。"
                : COLLAB_TEXT.unreachable;
          setStatus({ text, tone: "err" });
          return true;
        }
        setInvite(r.invite);
        setStatus({ text: COLLAB_TEXT.enabled, tone: "ok" });
        return true;
      }
      if (!checked && isOn) {
        if (!iAmCreator) {
          setChecked(true);
          return false;
        }
        const pw = local?.creatorPassword || cancelPw;
        if (!pw) {
          setStatus({ text: "要创建者密码才能取消。", tone: "err" });
          return true;
        }
        if (!window.confirm(COLLAB_TEXT.cancelConfirm)) {
          setChecked(true);
          return true;
        }
        setBusy(true);
        setStatus({ text: COLLAB_TEXT.cancelling, tone: "info" });
        const r = await disableCollab(pw, (done, total) => setStatus({ text: `${COLLAB_TEXT.cancelling}（素材原尺寸 ${done}/${total}）`, tone: "info" }));
        setBusy(false);
        if (!r.ok) {
          setChecked(true);
          setStatus({ text: r.error === "forbidden" ? "密码错误。" : r.error === "rate-limited" ? "尝试太多次，等 60 秒后再试。" : COLLAB_TEXT.cancelFailed, tone: "err" });
          return true;
        }
        setStatus({ text: COLLAB_TEXT.cancelled, tone: "ok" });
        return true;
      }
      return false;
    },
  }), [busy, checked, isOn, creator, creatorPw, projectPw, mode, where, lanOk, hostedUrl, list, iAmCreator, local, cancelPw, acct, movePw, shared]);

  /** 账号办法的搬到云端：查登录 → （协作房间）确认 → 逐步做，状态行跟着走；失败说清本机现在是什么样 */
  const startAccountMove = async (c: AccountCloud, name: string) => {
    if (busy) return;
    const room = !!shared;
    setBusy(true); setMoveLink(null);
    setStatus({ text: ACCOUNT_MOVE_TEXT.stage.check, tone: "info" });
    let user: Account | null;
    try { user = await accountCloudLogin(c); }
    catch (e) { setBusy(false); setStatus({ text: e instanceof Error ? e.message : "连接云端失败，请检查网络后重试。", tone: "err" }); return; }
    setAcctUser(user);
    if (!user) { setBusy(false); setLoginFor({ name }); setStatus({ text: ACCOUNT_MOVE_TEXT.needLogin, tone: "info" }); return; }
    setLoginFor(null);
    if (room && !window.confirm(ACCOUNT_MOVE_TEXT.roomConfirm(user.name))) { setBusy(false); setStatus(null); return; }
    const r = await moveCurrentToAccountCloud(c, { name, creatorPassword: movePw, onStage: (stage) => setStatus({ text: ACCOUNT_MOVE_TEXT.stage[stage], tone: "info" }) });
    setBusy(false);
    if (r.ok) {
      setChecked(true); setAskCloudName(false); setAskMovePw(false); setMovePw("");
      setMoveLink(r.link);
      setStatus({ text: r.kind === "room" ? ACCOUNT_MOVE_TEXT.doneRoom : ACCOUNT_MOVE_TEXT.doneLocal, tone: "ok" });
      return;
    }
    console.warn("[collab] 搬到云端没成:", r.error, r.stage, r.detail ?? "", r.localClosed ? "(本机协作已关)" : "");
    if (r.error === "login-required") { setAcctUser(null); setLoginFor({ name }); }
    if (r.error === "name-taken" || r.error === "invalid-name") setAskCloudName(true);
    if (r.error === "creator-password" || r.error === "bad-password") setAskMovePw(true);
    if (r.cloud && (r.localClosed || r.error === "enter-failed")) setMoveLink(projectLink(c.origin, r.cloud.projectId));
    // 本机协作已经关掉才失败的:现在打开的是本地项目,表单直接停在「云端」上,再点「确定」就接着做
    if (r.localClosed) setWhere("hosted");
    setStatus({ text: moveFailureText(r, r.kind), tone: r.error === "login-required" || r.error === "creator-password" ? "info" : "err" });
  };
  /** 放弃这次搬迁：确认过才调；状态行跟着走，失败说清云端和本机现在是什么样 */
  const abandon = async () => {
    if (!acct || busy) return;
    setAbandonAsk(false); setBusy(true); setMoveLink(null);
    const name = acctUser ? pendingMove(acctUser.id)?.name ?? "" : "";
    setStatus({ text: ACCOUNT_MOVE_TEXT.abandoning(name), tone: "info" });
    const r = await abandonPendingMove(acct);
    setBusy(false);
    if (r.ok) { setStatus({ text: r.already ? ACCOUNT_MOVE_TEXT.abandonedAlready(r.name) : ACCOUNT_MOVE_TEXT.abandoned(r.name), tone: "ok" }); return; }
    console.warn("[collab] 放弃这次搬迁没成:", r.error, r.detail ?? "");
    if (r.error === "login-required") { setAcctUser(null); setLoginFor(null); }
    setStatus({ text: abandonFailureText(r), tone: r.error === "login-required" ? "info" : "err" });
  };
  const signIn = async () => {
    if (!acct || loginBusy || !loginName.trim() || !loginPw) return;
    setLoginBusy(true); setStatus({ text: ACCOUNT_MOVE_TEXT.loginBusy, tone: "info" });
    try {
      const user = await accountCloudSignIn(acct, loginName.trim(), loginPw);
      setLoginPw(""); setAcctUser(user); setStatus(null);
      const resume = loginFor; setLoginFor(null); setLoginBusy(false);
      if (resume) void startAccountMove(acct, resume.name);
    } catch (e) {
      setLoginBusy(false);
      setStatus({ text: e instanceof Error ? e.message : "登录失败，请重试。", tone: "err" });
    }
  };

  const regen = async () => {
    if (regenPw === null) {
      if (!window.confirm(COLLAB_TEXT.regenConfirm)) return;
      setRegenPw("");
      return;
    }
    if (!regenPw) return;
    setBusy(true);
    const r = await createInvite(regenPw);
    setBusy(false);
    if (!r.ok) {
      setStatus({ text: r.error === "forbidden" ? "密码错误。" : r.error === "rate-limited" ? "尝试太多次，等 60 秒后再试。" : COLLAB_TEXT.unreachable, tone: "err" });
      return;
    }
    setRegenPw(null);
    setInvite(r.invite);
    setInviteStatus({ active: true, expiresAt: r.invite.expiresAt, maxUses: r.invite.maxUses, used: 0, revokedAt: null });
    setStatus({ text: COLLAB_TEXT.regenDone, tone: "ok" });
  };
  const regenLink = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await regenAccountProjectLink();
      if (r.ok) {
        setMoveLink(r.link);
        pushToast("项目链接已重新生成，旧链接已失效。", "info", 5000);
      } else {
        setStatus({ text: r.error || "重新生成项目链接失败。", tone: "err" });
      }
    } catch (e) {
      setStatus({ text: (e as Error).message || "重新生成项目链接失败。", tone: "err" });
    } finally {
      setBusy(false);
    }
  };
  const submitSecondaryPw = async () => {
    setSecondaryBusy(true);
    try {
      const r = await setAccountSecondaryPassword(secondaryPw || null);
      if (r.ok) {
        pushToast(secondaryPw ? "项目二级密码已设置。" : "项目二级密码已清除。", "info", 4000);
        setSecondaryModalOpen(false);
        setSecondaryPw("");
      } else {
        setStatus({ text: r.error || "设置项目二级密码失败。", tone: "err" });
      }
    } catch (e) {
      setStatus({ text: (e as Error).message || "设置项目二级密码失败。", tone: "err" });
    } finally {
      setSecondaryBusy(false);
    }
  };
  const moveHosted = async () => {
    // 房间登记的云端就是账号云端：走账号办法（云端新建账号项目、搬完关本机协作）；别的节点照旧办法
    const c = acct ?? await accountCloud();
    if (shared && oldShellBlocksAccountMove(association?.service)) { setStatus({ text: OLD_SHELL_ACCOUNT_TEXT, tone: "info" }); return; }
    if (shared && targetsAccountCloud(association?.service, c)) {
      if (!iAmCreator) { setStatus({ text: moveFailureText({ ok: false, error: "not-creator", stage: "check", localClosed: false, cloud: null }, "room"), tone: "err" }); return; }
      void startAccountMove(c!, (askCloudName ? cloudName.trim() : "") || shared.name);
      return;
    }
    setMovingHosted(true); setBusy(true); setStatus({ text: "正在搬到云端，完成后自动连接原房间…", tone: "info" });
    const result = await moveSharedToHosted(); setBusy(false);
    if (!result.ok) { setMovingHosted(false); setStatus({ text: result.error === "not-original-host" ? "请在当前实际主机上执行搬到云端。"
      : result.error === "relocation-materials-missing" ? "有项目引用的素材尚未入库，补齐后重试；原房间和身份已保留。"
        : "搬迁暂未完成，原房间信息已保留。检查连接或存储后重试。", tone: "err" }); }
  };
  const moveLan = async () => {
    setMovingLan(true); setBusy(true); setStatus({ text: "正在搬回本机，完成后自动连接原房间…", tone: "info" });
    const result = await moveSharedToLan(); setBusy(false);
    if (!result.ok) { setMovingLan(false); setStatus({ text: "搬迁暂未完成，房间和本机恢复信息已保留。请检查连接、身份或存储后重试。", tone: "err" }); }
  };

  const copied$ = (key: string) => (copied === key ? <span className="pc-sync-hint">{COLLAB_TEXT.copied}</span> : null);
  const copyBtn = (key: string, text: string) => (
    <button type="button" className="pc-sync-link-btn" onClick={() => copy(text, () => setCopied(key))}>复制</button>
  );

  const on = checked;
  // 「云端」指的是不是账号云端（是：显示登录状态，不要创建者用户名和密码）
  const accountTarget = where === "hosted" && targetsAccountCloud(hostedUrl, acct);
  /** 上一次没做完、云端项目已经建好的那次搬迁（再点「确定」接着做） */
  const resumable = accountTarget && acctUser && !isOn ? pendingMove(acctUser.id) : null;
  /** 搬到云端没做完留下的云端项目（「放弃这次搬迁」只在有它时出现；正在打开云端项目时 `pendingMove` 是 null） */
  const pending = acct && acctUser ? pendingMove(acctUser.id) : null;
  /** 登录状态一行；没登录是登录表单（字段与开始页「云端项目」的登录相同） */
  const accountRow = !acct ? null : acctUser === undefined ? (
    <div className="pc-sync-hint" data-pc="collab-account-user">{ACCOUNT_MOVE_TEXT.checkingLogin}</div>
  ) : acctUser ? (
    <div className="pc-collab-row" data-pc="collab-account-user"><span>{ACCOUNT_MOVE_TEXT.loggedIn(acctUser.name)}</span></div>
  ) : (
    <div data-pc="collab-account-login">
      <div className="pc-sync-field">
        <label htmlFor="pc-collab-acct-name">账号名</label>
        <input id="pc-collab-acct-name" className="pc-dialog-input" data-pc="collab-account-name" autoComplete="username" value={loginName} onChange={(e) => setLoginName(e.target.value)} />
      </div>
      <div className="pc-sync-field">
        <label htmlFor="pc-collab-acct-pw">密码</label>
        <input id="pc-collab-acct-pw" type="password" className="pc-dialog-input" data-pc="collab-account-password" autoComplete="current-password" value={loginPw}
          onChange={(e) => setLoginPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void signIn(); }} />
      </div>
      <div className="pc-collab-actions">
        <button type="button" className="pc-dialog-opt" data-pc="collab-account-submit" disabled={loginBusy || busy || !loginName.trim() || !loginPw} onClick={() => void signIn()}>{ACCOUNT_MOVE_TEXT.loginButton}</button>
        <a className="pc-sync-hint" href={`${acct.origin}/account`} target="_blank" rel="noopener noreferrer">注册账号 / 忘记密码</a>
      </div>
    </div>
  );
  return (
    <div className="pc-collab" data-pc="collab-section">
      <label className="pc-collab-head">
        <input type="checkbox" data-pc="collab-toggle" checked={on} disabled={busy || (isOn && !iAmCreator) || (isOn && ONLINE)}
          onChange={(e) => {
            setChecked(e.target.checked); setStatus(null);
            // 取消后仍留在同一设置窗口：再次明确创建时也保留默认密码生成能力。
            if (e.target.checked && !isOn) {
              if (!creatorPw) setCreatorPw(generatePassword());
              if (!projectPw) setProjectPw(generatePassword());
            }
          }} />
        多用户协作
      </label>

      {on && !isOn ? (
        <>
          {hostedTarget ? (
            <div className="pc-collab-row">
              <span className="pc-collab-key">放在</span>
              <button type="button" className={`pc-dialog-opt${where === "lan" ? " pc-dialog-opt--on" : ""}`} data-pc="collab-where-lan" disabled={ONLINE} onClick={() => setWhere("lan")}>本机</button>
              <button type="button" className={`pc-dialog-opt${where === "hosted" ? " pc-dialog-opt--on" : ""}`} data-pc="collab-where-hosted" onClick={() => setWhere("hosted")}>云端</button>
            </div>
          ) : null}
          {where === "lan" ? (
            <>
              <div className="pc-sync-warn">{COLLAB_TEXT.localNote}</div>
              <div className="pc-sync-hint">{COLLAB_TEXT.localLimit}</div>
              {!device?.lanHost && !ONLINE ? <LanRestartHint /> : null}
            </>
          ) : (
            <div className="pc-sync-field">
              <label htmlFor="pc-collab-hosted">云端地址</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input id="pc-collab-hosted" className="pc-dialog-input" data-pc="collab-hosted-url" value={hostedUrl} onChange={(e) => setHostedUrl(e.target.value)} />
                <button type="button" className="pc-dialog-opt" style={{ height: 30 }} onClick={() => setHostedUrl(hosted.DEFAULT_HOSTED_URL)}>恢复默认</button>
              </div>
            </div>
          )}
          {where === "hosted" && shellOld && oldShellBlocksAccountMove(hostedUrl) ? (
            <div className="pc-sync-warn" data-pc="collab-shell-old">{OLD_SHELL_ACCOUNT_TEXT}</div>
          ) : accountTarget ? (
            <>
              <div className="pc-sync-hint" data-pc="collab-account-intro">{ACCOUNT_MOVE_TEXT.intro}</div>
              {accountRow}
              {resumable ? <div className="pc-sync-hint" data-pc="collab-move-pending">{ACCOUNT_MOVE_TEXT.pending(resumable.name)}</div> : null}
            </>
          ) : (
          <>
          <div className="pc-collab-row">
            <span className="pc-collab-key">进入方式</span>
            <button type="button" className={`pc-dialog-opt${mode === "free" ? " pc-dialog-opt--on" : ""}`} onClick={() => setMode("free")}>自由进入</button>
            <button type="button" className={`pc-dialog-opt${mode === "restricted" ? " pc-dialog-opt--on" : ""}`} onClick={() => setMode("restricted")}>限定进入</button>
          </div>
          <div className="pc-sync-field">
            <label htmlFor="pc-collab-creator">创建者用户名</label>
            <input id="pc-collab-creator" className="pc-dialog-input" value={creator} maxLength={64} onChange={(e) => setCreator(e.target.value)} />
          </div>
          <div className="pc-sync-field">
            <label htmlFor="pc-collab-cpw">创建者密码（已自动生成，存在本机）</label>
            <input id="pc-collab-cpw" className="pc-dialog-input" value={creatorPw} onChange={(e) => setCreatorPw(e.target.value)} />
          </div>
          {mode === "free" ? (
            <div className="pc-sync-field">
              <label htmlFor="pc-collab-ppw">项目密码（已自动生成，存在本机）</label>
              <input id="pc-collab-ppw" className="pc-dialog-input" value={projectPw} onChange={(e) => setProjectPw(e.target.value)} />
            </div>
          ) : (
            <ListEditor
              creatorName={creator.trim() || "你的名字"}
              list={list}
              onRemove={(u) => setList(list.filter((r) => r.username !== u))}
              rowName={rowName}
              rowPw={rowPw}
              setRowName={(v) => { setRowName(v); setRowErr(""); }}
              setRowPw={(v) => { setRowPw(v); setRowErr(""); }}
              onAdd={addRow}
              rowErr={rowErr}
              hint="如果有独立渲染主机，记得在这里给它也加一条名单。"
            />
          )}
          </>
          )}
          <div className="pc-sync-hint">点「确定」开始设置。</div>
        </>
      ) : null}

      {isOn && shared ? (
        <>
          <div className="pc-collab-row">
            <span className="pc-collab-key">放在</span>
            {/* 账号云端项目只写「云端」:「自由进入 / 限定进入」是本地项目的说法,账号项目的 mode 恒为 free,原来这里总写「自由进入」,
                取消下面「任何知道链接的人都可加入」后两处打架;进入方式只由那个勾选说明(〔裁〕主会话 2026-10-22,报告 AGENT-claude-join-requests.md) */}
            <span data-pc="collab-where-text">{isAccount ? "云端" : <>{shared.where === "hosted" ? "云端" : "本机"} · {shared.mode === "free" ? "自由进入" : "限定进入"}</>}</span>
          </div>
          {/* 账号办法的云端项目没有「搬回本机」（点了必然失败，用户 2026-10-13 定先收起来）；旧办法的房间照旧显示 */}
          {shared.where === "hosted" && !ONLINE && !shared.accountId ? <button type="button" className="pc-dialog-opt" data-pc="collab-move-lan" disabled={busy} onClick={() => void moveLan()}>搬回本机</button> : null}
          <div className="pc-collab-row" data-pc="collab-project-name">
            <span className="pc-collab-key">项目名</span>
            <code>{shared.name}</code>
            {copyBtn("name", shared.name)}
            {copied$("name")}
          </div>
          <div className="pc-collab-row" data-pc="collab-project-rev">
            <span className="pc-collab-key">历史序号</span>
            <code>{rev ?? 1}</code>
          </div>
          {shared.mode === "free" && local?.projectPassword ? (
            <div className="pc-collab-row" data-pc="collab-project-password">
              <span className="pc-collab-key">项目密码</span>
              <code>{local.projectPassword}</code>
              {copyBtn("pw", local.projectPassword)}
              {copied$("pw")}
            </div>
          ) : null}
          {/* 托管方的服务(渲染节点):放云端且这台托管端有它才出现;创建者能改(先验证创建者身份),其他成员只读 */}
          <HostedServiceRows where={shared.where} hosted={hostedServices} creator={iAmCreator} busy={busy}
            onToggle={(service, enabled) => setFlow({ kind: "hosted-service", service, enabled })}
            onToggleOption={(service, option, enabled) => setFlow({ kind: "hosted-option", service, option, enabled })} />
          {shared.where === "lan" ? (
            <>
              <div className="pc-sync-warn">{COLLAB_TEXT.localNote}</div>
              <div className="pc-sync-hint" data-pc="host-registration" data-state={hostRegistration ?? "member"}>{hostRegistration === "online" ? "原房间已登记上线，中继接入已就绪。" : hostRegistration === "host-conflict" ? "主机占用冲突，未自动接管。" : COLLAB_TEXT.localLimit}</div>
              {!ONLINE && hostedTarget ? <button type="button" className="pc-dialog-opt" data-pc="collab-move-hosted" disabled={busy} onClick={() => void moveHosted()}>搬到云端</button> : null}
              {askCloudName ? (
                <div className="pc-sync-field">
                  <label htmlFor="pc-collab-cloud-name">{ACCOUNT_MOVE_TEXT.nameLabel}</label>
                  <input id="pc-collab-cloud-name" className="pc-dialog-input" data-pc="collab-cloud-name" maxLength={200} value={cloudName} placeholder={shared.name} onChange={(e) => setCloudName(e.target.value)} />
                </div>
              ) : null}
              {askMovePw ? (
                <div className="pc-sync-field">
                  <label htmlFor="pc-collab-move-pw">创建者密码</label>
                  <input id="pc-collab-move-pw" type="password" className="pc-dialog-input" data-pc="collab-move-password" value={movePw} onChange={(e) => setMovePw(e.target.value)} />
                </div>
              ) : null}
              {loginFor ? accountRow : null}
            </>
          ) : null}
          {/* 邀请链接与二维码:放云端、放本机都给(放本机是给局域网里的手机、平板扫的) */}
          {(shared.where === "hosted" || shared.where === "lan") && iAmCreator ? (
            <>
              {isAccount ? (
                <div className="pc-collab-actions">
                  <button type="button" className="pc-dialog-opt" data-pc="collab-regen-link" disabled={busy} onClick={() => void regenLink()}>作废并重新生成项目链接</button>
                  <button type="button" className="pc-dialog-opt" data-pc="collab-secondary-password" disabled={busy} onClick={() => setSecondaryModalOpen(true)}>项目二级密码</button>
                </div>
              ) : (
                <>
                  {invite ? (
                    <div className="pc-collab-qr">
                      <div className="pc-collab-qr-img" data-pc="collab-qr" aria-label="邀请二维码" dangerouslySetInnerHTML={{ __html: qrSvg(invite.link, { ec: "M", quiet: 4, scale: 8 }) }} />
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, flex: 1 }}>
                        <code data-pc="collab-invite-link" style={{ fontSize: 11.5, wordBreak: "break-all" }}>{invite.link}</code>
                        <div className="pc-collab-actions">
                          <button type="button" className="pc-dialog-opt" data-pc="collab-copy-link" onClick={() => copy(invite.link, () => setCopied("link"))}>复制邀请链接</button>
                          {copied$("link")}
                        </div>
                        <div className="pc-sync-hint" data-pc="collab-invite-status">
                          {inviteStatus && !inviteStatus.active ? COLLAB_TEXT.inviteDead
                            : `有效期至 ${when(inviteStatus?.expiresAt ?? invite.expiresAt)}${inviteStatus ? ` · 已用 ${inviteStatus.used} 次` : ""}${(inviteStatus?.maxUses ?? invite.maxUses) ? ` / 限 ${inviteStatus?.maxUses ?? invite.maxUses} 次` : ""}`}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="pc-sync-hint">这台设备上没有邀请链接（链接只存在签发它的那台设备上）。</div>
                  )}
                  <div className="pc-collab-actions">
                    <button type="button" className="pc-dialog-opt" data-pc="collab-regen" disabled={busy} onClick={() => void regen()}>作废并重新生成邀请码</button>
                  </div>
                  {regenPw !== null ? (
                    <div className="pc-sync-field">
                      <label htmlFor="pc-collab-regen-pw">创建者密码</label>
                      <div style={{ display: "flex", gap: 8 }}>
                        <input id="pc-collab-regen-pw" type="password" autoFocus className="pc-dialog-input" data-pc="collab-regen-password" value={regenPw}
                          onChange={(e) => setRegenPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void regen(); }} />
                        <button type="button" className="pc-dialog-opt" data-pc="collab-regen-confirm" style={{ height: 30 }} disabled={!regenPw || busy} onClick={() => void regen()}>确认</button>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
              {secondaryModalOpen ? (
                <div className="pc-sync-field" data-pc="secondary-password-modal" style={{ marginTop: 12, padding: 8, border: "1px solid var(--border, #ccc)", borderRadius: 6 }}>
                  <label htmlFor="pc-secondary-pw">项目二级密码（留空表示清除二级密码）</label>
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <input id="pc-secondary-pw" type="password" className="pc-dialog-input" data-pc="collab-secondary-pw-input" placeholder="输入新密码或留空清除"
                      value={secondaryPw} onChange={(e) => setSecondaryPw(e.target.value)} />
                    <button type="button" className="pc-dialog-opt" data-pc="collab-secondary-pw-confirm" disabled={secondaryBusy || busy} onClick={() => void submitSecondaryPw()}>
                      确定
                    </button>
                    <button type="button" className="pc-dialog-opt" onClick={() => { setSecondaryModalOpen(false); setSecondaryPw(""); }}>
                      取消
                    </button>
                  </div>
                </div>
              ) : null}
              {/* 「任何知道链接的人都可加入」:在上面两个按钮下面,只有创建者能改(2026-10-22 用户定;`src/account/AccountEntryOption.tsx`) */}
              {isAccount ? <AccountEntryOption disabled={busy} /> : null}
            </>
          ) : null}
          {iAmCreator ? (
            <div className="pc-collab-actions">
              {!isAccount && (shared.mode === "free"
                ? <button type="button" className="pc-dialog-opt" onClick={() => setFlow({ kind: "password" })}>改项目密码</button>
                : <button type="button" className="pc-dialog-opt" onClick={() => setFlow({ kind: "list" })}>改名单</button>)}
              {!isAccount && <button type="button" className="pc-dialog-opt" onClick={() => setFlow({ kind: "creator-password" })}>改创建者密码</button>}
              {!isAccount && <button type="button" className="pc-dialog-opt" onClick={() => setFlow({ kind: "bans" })}>已禁入的设备</button>}
              <button type="button" className="pc-dialog-opt" onClick={() => setFlow({ kind: "delete" })}>删除项目</button>
            </div>
          ) : null}
          {iAmCreator ? <div className="pc-sync-hint">踢人：在顶栏的成员列表里，悬停到那个人那一行点「踢出」。</div> : null}
          {!checked && iAmCreator && !local?.creatorPassword ? (
            <div className="pc-sync-field">
              <label htmlFor="pc-collab-cancel-pw">创建者密码</label>
              <input id="pc-collab-cancel-pw" type="password" className="pc-dialog-input" value={cancelPw} onChange={(e) => setCancelPw(e.target.value)} />
            </div>
          ) : null}
          {!checked && iAmCreator ? <div className="pc-sync-hint">点「确定」取消多用户协作。</div> : null}
        </>
      ) : null}

      {/* 正在搬或正在删的时候不显示（状态行在说进度）；搬成了记录就删了，自然也不显示 */}
      {pending && !busy ? (
        <div className="pc-collab-abandon" data-pc="collab-move-abandon-block">
          {resumable ? null : <div className="pc-sync-hint" data-pc="collab-move-pending-idle">{ACCOUNT_MOVE_TEXT.pendingIdle(pending.name, !!shared)}</div>}
          {abandonAsk ? (
            <div data-pc="collab-abandon-confirm">
              <div className="pc-sync-warn">{ACCOUNT_MOVE_TEXT.abandonConfirm(pending.name)}</div>
              <div className="pc-collab-actions">
                <button type="button" className="pc-dialog-opt pc-sync-danger-btn" data-pc="collab-abandon-yes" disabled={busy} onClick={() => void abandon()}>{ACCOUNT_MOVE_TEXT.abandonConfirmButton}</button>
                <button type="button" className="pc-dialog-opt" data-pc="collab-abandon-no" disabled={busy} onClick={() => setAbandonAsk(false)}>{ACCOUNT_MOVE_TEXT.abandonCancel}</button>
              </div>
            </div>
          ) : (
            <div className="pc-collab-actions">
              <button type="button" className="pc-dialog-opt" data-pc="collab-move-abandon" disabled={busy} onClick={() => { setAbandonAsk(true); setStatus(null); }}>{ACCOUNT_MOVE_TEXT.abandonButton}</button>
            </div>
          )}
        </div>
      ) : null}
      {status ? (
        <div className={`pc-sync-status-line${status.tone === "err" ? " is-err" : status.tone === "ok" ? " is-ok" : ""}`} data-pc="collab-status">{status.text}</div>
      ) : null}
      {moveLink ? (
        <div className="pc-collab-actions">
          <button type="button" className="pc-dialog-opt" data-pc="collab-move-link" onClick={() => copy(moveLink, () => setCopied("move-link"))}>{ACCOUNT_MOVE_TEXT.copyLink}</button>
          {copied$("move-link")}
        </div>
      ) : null}
      {flow ? <CreatorFlow flow={flow} onClose={() => setFlow(null)} /> : null}
    </div>
  );
});

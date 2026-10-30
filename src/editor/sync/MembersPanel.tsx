/**
 * 顶栏的成员按钮、成员浮层与创建者操作(c65-ux-draft.md 第 3、4 节;契约 `auth-contract.md` 第 7 节)。
 *
 * - 按设备一行;重名带设备名(服务端给的 displayName);自己那行加粗、后缀「(自己)」;创建者带「[创建者]」;
 *   标签 [编辑中] [渲染中] [Agent ×n];点行展开 Agent:「用户名 · Agent · 第 n 个对话」。
 * - 我是创建者时:别人那行悬停出「踢出」;浮层底部「项目管理（仅创建者可见）」:改项目密码 / 改名单、改创建者密码、
 *   已禁入的设备、删除项目。每次都先「验证创建者身份」(当场输密码,用 `list-bans` 做一次无副作用的证明核对),
 *   验证过的 K 只用于这一次操作流程,关掉就丢。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { adminOp, getSyncView, leaveBlocked, makeCredential, pushToast, setHostedOption, setHostedService, useSync, type MemberRow } from "./syncManager";
import { ListEditor } from "./SharedDialogs";
import { createInvite, localCollab, rememberPasswords } from "./collab";
import { HOSTED_SERVICE_TEXT, cloudAgentConns, cloudAgentLabel, hostedFailText, hostedFlowNeedsPassword, hostedOptionText, isCloudAgentOnly, isCloudAgentRunning, memberCountLabel, serviceRowLabel, splitMembers, visibleMembers, type HostedOptionName, type HostedServiceName } from "./hostedServices";
import { useCloudRunning } from "./presence";
import "./sync.css";
// 局域网缺省成员源的注册已挪到入口（`src/main.tsx` → `./lanBoot.ts`）：
// 原来写在本文件顶层，等于「谁 import 到这个面板就顺带注册」，手机端那条路上它不在闭包里
import { getMemberSource, subscribeAccountExtensions } from "./accountExtensions";

export type Flow =
  | { kind: "password" }
  | { kind: "creator-password" }
  | { kind: "list" }
  | { kind: "bans" }
  | { kind: "delete" }
  | { kind: "kick"; row: MemberRow }
  | { kind: "hosted-service"; service: HostedServiceName; enabled: boolean }
  | { kind: "hosted-option"; service: HostedServiceName; option: HostedOptionName; enabled: boolean };

export function MembersButton() {
  const account = useSync(v => !!v.shared?.accountId);
  const source = useSyncExternalStore(subscribeAccountExtensions, getMemberSource, getMemberSource);
  const DesktopAccountPanel = source.DesktopAccountPanel;
  return account && DesktopAccountPanel ? <DesktopAccountPanel /> : <LegacyMembersButton />;
}

function LegacyMembersButton() {
  const shared = useSync((v) => v.shared);
  const members = useSync((v) => v.members);
  const device = useSync((v) => v.device);
  /** 哪些成员的云端 Agent 此刻有一轮在跑(在场状态里的 `cloud-run`):表变了(开始、结束、过期)要重画 */
  const running = useCloudRunning();
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!shared) return null;
  const isMe = (r: MemberRow) => r.username === shared.username && r.deviceId === device?.deviceId;
  // 托管方的服务(渲染节点)不是成员:排在成员之后,不计入成员数,没有踢人按钮
  const split = splitMembers(members);
  const services = split.services;
  // 本人不在线、只剩闲置的云端 Agent 连接的行不显示、不计数(云端 Agent 的连接在一轮结束后还会连着一阵)
  const people = visibleMembers(split.people, running);
  const others = people.filter((r) => !isMe(r));
  const mine = people.find(isMe);
  const iAmCreator = shared.creator || !!mine?.creator;
  const startFlow = (f: Flow) => {
    setOpen(false);
    setFlow(f);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="pc-sync-chip"
        data-pc="members-button"
        title="成员"
        onClick={() => {
          if (!open && btnRef.current) setRect(btnRef.current.getBoundingClientRect());
          setOpen(!open);
        }}
      >
        <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
          <circle cx="5.5" cy="4" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M1 13c0-2.6 2-4.3 4.5-4.3S10 10.4 10 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="11" cy="4.6" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M11.5 8.8c2 .2 3.5 1.8 3.5 4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        <span data-pc="members-count">{memberCountLabel(people, running)}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="pc-members-pop"
            data-pc="members-pop"
            style={{ top: (rect?.bottom ?? 40) + 6, left: Math.max(8, Math.min((rect?.right ?? 340) - 330, window.innerWidth - 338)) }}
          >
            {[...(mine ? [mine] : []), ...others].map((row) => {
              const key = `${row.username}@${row.deviceId}`;
              const allAgents = row.conns.filter((c) => c.role === "agent");
              // 代这位成员进项目的云端 Agent 连接:归在他这一行里,不另起一行(契约 cloud-agent-contract.md 第 5 节)
              // 闲置的云端 Agent 连接不算:有一轮在跑才显示标记与子行
              const cloud = isCloudAgentRunning(row, running) ? cloudAgentConns(row.conns) : [];
              const local = allAgents.filter((c) => c.service !== "agent");
              const agents = [...local, ...cloud];
              const me = isMe(row);
              return (
                <div className="pc-members-row" key={key}>
                  <div
                    className={`pc-members-row-main${agents.length ? " is-expandable" : ""}`}
                    onClick={() => agents.length && setExpanded(expanded === key ? null : key)}
                  >
                    <span className={`pc-members-name${me ? " is-me" : ""}`}>
                      {row.displayName}
                      {me ? " (自己)" : ""}
                    </span>
                    {row.creator ? <span className="pc-sync-tag pc-sync-tag--creator">[创建者]</span> : null}
                    {isCloudAgentOnly(row, running) ? <span className="pc-sync-tag" data-pc="members-offline-agent" title="这位成员不在线，他的云端 Agent 还在跑；不计入成员人数，计入 Agent 个数">[离线，Agent 在跑]</span> : null}
                    {row.tags.editing ? <span className="pc-sync-tag pc-sync-tag--editing">[编辑中]</span> : null}
                    {row.tags.rendering ? <span className="pc-sync-tag pc-sync-tag--rendering">[渲染中]</span> : null}
                    {local.length > 0 ? <span className="pc-sync-tag">[Agent ×{local.length}]</span> : null}
                    {cloud.length > 0 ? <span className="pc-sync-tag" data-pc="members-cloud-agent" title={cloudAgentLabel(row.username)}>[云端 Agent]</span> : null}
                    {iAmCreator && !me && row.deviceId ? (
                      <button
                        type="button"
                        className="pc-members-kick"
                        onClick={(e) => {
                          e.stopPropagation();
                          startFlow({ kind: "kick", row });
                        }}
                      >
                        踢出
                      </button>
                    ) : null}
                  </div>
                  {expanded === key && agents.length ? (
                    <div className="pc-members-sub">
                      {local.map((a, i) => (
                        <span key={i}>
                          {row.username} · Agent · 第 {a.conversation ?? i + 1} 个对话
                        </span>
                      ))}
                      {cloud.length > 0 ? <span data-pc="members-cloud-agent-row">{cloudAgentLabel(row.username)}</span> : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {others.length === 0 ? <div className="pc-members-empty">只有你自己在线。</div> : null}
            {services.length ? <div className="pc-members-sep" data-pc="members-services-sep" /> : null}
            {services.map((row) => (
              <div className="pc-members-row" key={`service:${row.service}@${row.deviceId}`} data-pc={`members-service-${row.service}`}>
                <div className="pc-members-row-main">
                  <span className="pc-members-name">{serviceRowLabel(row.service)}</span>
                  {row.tags.rendering ? <span className="pc-sync-tag pc-sync-tag--rendering">[渲染中]</span> : null}
                </div>
              </div>
            ))}
            {iAmCreator ? (
              <>
                <div className="pc-members-sep" />
                <div className="pc-members-admin-title">项目管理（仅创建者可见）</div>
                {shared.mode === "free" ? (
                  <button type="button" className="pc-members-admin-item" onClick={() => startFlow({ kind: "password" })}>
                    改项目密码
                  </button>
                ) : (
                  <button type="button" className="pc-members-admin-item" onClick={() => startFlow({ kind: "list" })}>
                    改名单
                  </button>
                )}
                <button type="button" className="pc-members-admin-item" onClick={() => startFlow({ kind: "creator-password" })}>
                  改创建者密码
                </button>
                <button type="button" className="pc-members-admin-item" onClick={() => startFlow({ kind: "bans" })}>
                  已禁入的设备
                </button>
                <button type="button" className="pc-members-admin-item is-danger" onClick={() => startFlow({ kind: "delete" })}>
                  删除项目
                </button>
              </>
            ) : null}
          </div>,
          document.body,
        )}
      {flow ? <CreatorFlow flow={flow} onClose={() => setFlow(null)} /> : null}
    </>
  );
}

/* ---------------- 创建者操作 ---------------- */

type Verified = { key: string; bans: { username: string; deviceId: string }[]; list: string[] };

export function CreatorFlow({ flow, onClose }: { flow: Flow; onClose: () => void }) {
  const account = useSync((v) => !!v.shared?.accountId);
  const [checked, setVerified] = useState<Verified | null>(null);
  // 账号项目改托管方服务的开关:没有创建者密码这一步(凭账号的登录态,服务端按创建者身份把关),直接到确认
  const direct = (flow.kind === "hosted-service" || flow.kind === "hosted-option") && !hostedFlowNeedsPassword(account);
  const verified: Verified | null = checked ?? (direct ? { key: "", bans: [], list: [] } : null);
  if (!verified) return <VerifyDialog onClose={onClose} onOk={setVerified} />;
  switch (flow.kind) {
    case "password":
    case "creator-password":
      return <PasswordDialog creator={flow.kind === "creator-password"} v={verified} onClose={onClose} />;
    case "list":
      return <ListDialog v={verified} onClose={onClose} />;
    case "bans":
      return <BansDialog v={verified} onClose={onClose} />;
    case "delete":
      return <DeleteDialog v={verified} onClose={onClose} />;
    case "kick":
      return <KickDialog row={flow.row} v={verified} onClose={onClose} />;
    case "hosted-service":
      return <HostedServiceDialog service={flow.service} enabled={flow.enabled} v={verified} onClose={onClose} />;
    case "hosted-option":
      return <HostedOptionDialog service={flow.service} option={flow.option} enabled={flow.enabled} v={verified} onClose={onClose} />;
  }
}

function Dialog({ title, children, foot, pc }: { title?: string; children: React.ReactNode; foot: React.ReactNode; pc: string }) {
  return createPortal(
    <div className="pc-dialog-mask">
      <div className="pc-dialog pc-sync-dialog" role="dialog" aria-modal="true" data-pc={pc}>
        {title ? <div className="pc-dialog-title">{title}</div> : null}
        <div className="pc-dialog-body">{children}</div>
        <div className="pc-dialog-foot">{foot}</div>
      </div>
    </div>,
    document.body,
  );
}

const LOCK_MS = 60_000;

function VerifyDialog({ onClose, onOk }: { onClose: () => void; onOk: (v: Verified) => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [lockUntil, setLockUntil] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!lockUntil) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [lockUntil]);
  const locked = lockUntil > Date.now();
  const verify = async () => {
    if (!pw || busy || locked) return;
    setBusy(true);
    const r = await adminOp("list-bans", { password: pw });
    setBusy(false);
    if (r.ok) {
      onOk({ key: r.key, bans: (r.reply.bans as Verified["bans"]) ?? [], list: (r.reply.list as string[]) ?? [] });
      return;
    }
    if (r.error === "rate-limited") {
      setLockUntil(Date.now() + LOCK_MS);
      setErr("尝试太多次，等 60 秒后再试。");
    } else setErr("密码错误。");
  };
  return (
    <Dialog
      title="验证创建者身份"
      pc="creator-verify"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="pc-btn pc-btn--primary" disabled={!pw || busy || locked} onClick={() => void verify()}>
            验证
          </button>
        </>
      }
    >
      <div className="pc-sync-field">
        <label htmlFor="pc-cv-pw">创建者密码</label>
        <input id="pc-cv-pw" type="password" autoFocus className={`pc-dialog-input${err ? " is-invalid" : ""}`} placeholder="输入创建者密码" value={pw} disabled={locked}
          onChange={(e) => { setPw(e.target.value); setErr(""); }} onKeyDown={(e) => { if (e.key === "Enter") void verify(); }} />
        {err ? <div className="pc-sync-err">{err}</div> : null}
      </div>
    </Dialog>
  );
}

function failText(error: string): string {
  if (error === "rate-limited") return "尝试太多次，等 60 秒后再试。";
  if (error === "forbidden") return "密码错误。";
  if (error === "offline") return "没连上文档服务，稍后再试。";
  return "没做成，稍后再试。";
}

function PasswordDialog({ creator, v, onClose }: { creator: boolean; v: Verified; onClose: () => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!a || a !== b) {
      setErr(a !== b ? "两次输入不一致。" : "");
      return;
    }
    setBusy(true);
    const cred = await makeCredential(a);
    const r = creator ? await adminOp("set-creator-password", { key: v.key }, { creator: cred }) : await adminOp("set-password", { key: v.key }, { project: cred });
    setBusy(false);
    if (!r.ok) return setErr(failText(r.error));
    // 项目设置「多用户协作」里显示的是本机记下的密码(C10a):改了就跟着换
    const pid = getSyncView().shared?.projectId;
    if (pid) await rememberPasswords(pid, creator ? { creatorPassword: a } : { projectPassword: a });
    pushToast(creator ? "创建者密码已修改，之后的项目管理要用新密码。" : "项目密码已修改。在线的人不受影响，下次进入要用新密码。", "info");
    onClose();
  };
  return (
    <Dialog
      title={creator ? "改创建者密码" : "改项目密码"}
      pc={creator ? "creator-password" : "project-password"}
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="pc-btn pc-btn--primary" disabled={busy || !a || !b} onClick={() => void submit()}>
            确认修改
          </button>
        </>
      }
    >
      <div className="pc-sync-field">
        <label htmlFor="pc-pw-a">新密码</label>
        <input id="pc-pw-a" type="password" autoFocus className="pc-dialog-input" value={a} onChange={(e) => { setA(e.target.value); setErr(""); }} />
      </div>
      <div className="pc-sync-field">
        <label htmlFor="pc-pw-b">确认新密码</label>
        <input id="pc-pw-b" type="password" className={`pc-dialog-input${err ? " is-invalid" : ""}`} value={b} onChange={(e) => { setB(e.target.value); setErr(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
        {err ? <div className="pc-sync-err">{err}</div> : null}
      </div>
      <div className="pc-sync-hint">{creator ? "在线的人不受影响，之后的项目管理要用新的创建者密码。" : "在线的人不受影响，下次进入要用新密码。"}</div>
    </Dialog>
  );
}

function ListDialog({ v, onClose }: { v: Verified; onClose: () => void }) {
  const shared = useSync((s) => s.shared);
  const [rows, setRows] = useState<{ username: string; password?: string; kept?: boolean }[]>(v.list.map((u) => ({ username: u, kept: true })));
  const [rowName, setRowName] = useState("");
  const [rowPw, setRowPw] = useState("");
  const [rowErr, setRowErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const add = () => {
    const u = rowName.trim();
    if (!u) return setRowErr("用户名不能为空。");
    if (!rowPw) return setRowErr("密码不能为空。");
    if (u === shared?.username || rows.some((r) => r.username === u)) return setRowErr("名单里已有这个名字，换一个区分一下。");
    setRows([...rows, { username: u, password: rowPw }]);
    setRowName("");
    setRowPw("");
  };
  const changePassword = (u: string) => {
    const pw = window.prompt(`给 ${u} 设一个新密码`);
    if (pw) setRows(rows.map((r) => (r.username === u ? { username: u, password: pw } : r)));
  };
  const submit = async () => {
    setBusy(true);
    const list = [];
    for (const r of rows) list.push(r.password ? { username: r.username, ...(await makeCredential(r.password)) } : { username: r.username, keep: true });
    const res = await adminOp("set-list", { key: v.key }, { list });
    setBusy(false);
    if (!res.ok) return setErr(failText(res.error));
    pushToast("名单已修改。", "info", 4000);
    onClose();
  };
  return (
    <Dialog
      title="改名单"
      pc="list-dialog"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="pc-btn pc-btn--primary" disabled={busy} onClick={() => void submit()}>
            确认修改
          </button>
        </>
      }
    >
      <ListEditor
        creatorName={shared?.username ?? ""}
        list={rows}
        onRemove={(u) => setRows(rows.filter((r) => r.username !== u))}
        onChangePassword={changePassword}
        rowName={rowName}
        rowPw={rowPw}
        setRowName={(x) => { setRowName(x); setRowErr(""); }}
        setRowPw={(x) => { setRowPw(x); setRowErr(""); }}
        onAdd={add}
        rowErr={rowErr}
        hint="独立渲染主机是在另一台机器上帮你跑后台预渲染的 PromptCut 实例。如果有，在这里给它加一条专属名单，并在那边凭该用户名密码登录。"
      />
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}

function BansDialog({ v, onClose }: { v: Verified; onClose: () => void }) {
  const [bans, setBans] = useState(v.bans);
  const [err, setErr] = useState("");
  const unban = async (b: { username: string; deviceId: string }) => {
    const r = await adminOp("unban", { key: v.key }, b);
    if (!r.ok) return setErr(failText(r.error));
    setBans(bans.filter((x) => !(x.username === b.username && x.deviceId === b.deviceId)));
  };
  return (
    <Dialog
      title="已禁入的设备"
      pc="bans-dialog"
      foot={
        <button type="button" className="pc-btn" onClick={onClose}>
          返回
        </button>
      }
    >
      {bans.length ? (
        <div className="pc-backups">
          {bans.map((b) => (
            <div className="pc-backup-row" key={`${b.username}@${b.deviceId}`}>
              <span>{b.username}</span>
              <small>{b.deviceId}</small>
              <button type="button" className="pc-dialog-opt" onClick={() => void unban(b)}>
                撤销
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="pc-sync-hint">（没有被禁入的设备）</div>
      )}
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}

function KickDialog({ row, v, onClose }: { row: MemberRow; v: Verified; onClose: () => void }) {
  const shared = useSync((s) => s.shared);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const kick = async () => {
    setBusy(true);
    const r = await adminOp("kick", { key: v.key }, { username: row.username, deviceId: row.deviceId });
    setBusy(false);
    if (!r.ok) return setErr(failText(r.error));
    if (shared?.mode === "free") pushToast("已踢出。自由进入模式下，想彻底挡住，要改项目密码。", "info", 8000);
    else pushToast("已踢出。", "info", 4000);
    onClose();
  };
  return (
    <Dialog
      pc="kick-dialog"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="pc-btn pc-sync-danger-btn" disabled={busy} onClick={() => void kick()}>
            踢出
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
        确定要把 {row.username} ({row.deviceName ?? row.deviceId}) 踢出项目吗？
      </div>
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}

/** 创建者开关托管方的服务(项目设置里的勾选;验证创建者身份之后到这一步确认) */
function HostedServiceDialog({ service, enabled, v, onClose }: { service: HostedServiceName; enabled: boolean; v: Verified; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const label = HOSTED_SERVICE_TEXT[service]?.label ?? serviceRowLabel(service);
  const apply = async () => {
    setBusy(true);
    const r = await setHostedService(service, enabled, v.key);
    setBusy(false);
    if (!r.ok) return setErr(hostedFailText(r, "这台云节点现在没有这个服务。", failText));
    pushToast(enabled ? `已打开${label}。` : `已关闭${label}。`, "info", 4000);
    onClose();
  };
  return (
    <Dialog
      title={label}
      pc="hosted-service-dialog"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="pc-btn pc-btn--primary" data-pc="hosted-service-confirm" disabled={busy} onClick={() => void apply()}>
            {enabled ? "打开" : "关闭"}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
        {HOSTED_SERVICE_TEXT[service]?.confirm(enabled) ?? (enabled ? `打开${label}。` : `关闭${label}。`)}
      </div>
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}

/** 创建者改托管方服务下面的子选项(项目设置里「生成轨道流」的勾选;验证创建者身份之后到这一步确认) */
function HostedOptionDialog({ service, option, enabled, v, onClose }: { service: HostedServiceName; option: HostedOptionName; enabled: boolean; v: Verified; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const text = hostedOptionText(service, option);
  const label = text?.label ?? option;
  const apply = async () => {
    setBusy(true);
    const r = await setHostedOption(service, option, enabled, v.key);
    setBusy(false);
    if (!r.ok) return setErr(hostedFailText(r, "这台云节点现在没有这个选项。", failText));
    pushToast(enabled ? `已打开${label}。` : `已关闭${label}。`, "info", 4000);
    onClose();
  };
  return (
    <Dialog
      title={label}
      pc="hosted-option-dialog"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="pc-btn pc-btn--primary" data-pc="hosted-option-confirm" disabled={busy} onClick={() => void apply()}>
            {enabled ? "打开" : "关闭"}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>{text?.confirm(enabled) ?? (enabled ? `打开${label}。` : `关闭${label}。`)}</div>
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}

function DeleteDialog({ v, onClose }: { v: Verified; onClose: () => void }) {
  const shared = useSync((s) => s.shared);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!shared) return null;
  const del = async () => {
    setBusy(true);
    const r = await adminOp("delete", { key: v.key });
    setBusy(false);
    if (!r.ok) return setErr(failText(r.error));
    onClose();
    // 自己删的:不弹「项目已被创建者删除」,直接回开始页
    leaveBlocked();
  };
  return (
    <Dialog
      title="删除项目"
      pc="delete-dialog"
      foot={
        <>
          <button type="button" className="pc-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="pc-btn pc-sync-danger-btn" disabled={busy || typed !== shared.name} onClick={() => void del()}>
            永久删除项目
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
        {shared.where === "hosted"
          ? "确定要删除这个项目吗？托管在阿里云的项目文档和素材将被永久销毁，所有成员立刻断开。此操作无法恢复。"
          : "确定要删除这个项目吗？本机作为主机的项目数据将被永久销毁，所有成员立刻断开。此操作无法恢复。"}
      </div>
      <input className="pc-dialog-input" style={{ marginLeft: 0 }} placeholder="输入项目名确认" value={typed} onChange={(e) => setTyped(e.target.value)} />
      {err ? <div className="pc-sync-err">{err}</div> : null}
    </Dialog>
  );
}

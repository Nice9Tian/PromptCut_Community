/**
 * 申请加入与进入方式在界面上说的话(2026-10-22 用户定,`docs/semantics/workflow/project.md`「多用户协作」第 26、27 条、
 * 「过期云端项目转本地」第 44 行)。桌面开始页(`AccountProjects.tsx`)、手机开始页(`src/mobile/MobileStart.tsx`)、
 * 重开文件的提示(`src/editor/sync/recoveryAssociation.ts`)、成员浮层(`AccountMembersPanel.tsx`、手机的成员面板)和
 * 项目设置里的勾选(`AccountEntryOption.tsx`)共用这一份,各处说法一致。带引号的几句是语义原文。
 * 标点:被挡住那一块的几句状态(被挡住、已发送、被拒、已通过)与「通过 / 拒绝」之后的气泡照语义原文,句末不加句号;
 * 两句以上的说明(勾选下面的说明、重开文件发出后那句)照常用句号。
 */

export interface JoinRequestStatus {
  projectId: string;
  state: "none" | "pending" | "rejected" | "member";
  entry: "link" | "list";
  canApply: boolean;
  requestedAt?: number;
  decidedAt?: number;
  retryAt?: number;
}

export const JOIN_REQUEST_TEXT = {
  /** 被账号名单挡住(语义原文「你不在这个项目的成员名单中」) */
  notListed: '你不在这个项目的成员名单中',
  /** 按钮(语义原文) */
  send: '发送申请',
  /** 发出之后(语义原文) */
  sent: '已发送，等创建者通过',
  /** 被拒(语义原文) */
  rejected: '创建者没有通过你的申请',
  /** 被通过、正在进(或接着要输二级密码) */
  approved: '创建者已通过你的申请',
  /** 重开文件:登录的账号不是成员(语义原文「这个账号不是这个云端项目的成员」) */
  reopenNotMember: '这个账号不是这个云端项目的成员',
  /** 从项目直达地址打开、登录的账号还不是成员:链接已填好,由用户自己点加入(`product/platforms.md`「项目直达地址」) */
  directNotMember: '你还不是这个项目的成员，点「加入并打开项目」加入。',
  /** 重开文件时点了「发送申请」之后:通过以后怎么连回去 */
  reopenSent: '已发送，等创建者通过。通过以后重新打开这个文件，就能连回云端项目。',
  /** 项目设置里的勾选(语义原文「任何知道链接的人都可加入」) */
  entryLabel: '任何知道链接的人都可加入',
  /** 取消勾选后勾选下面那一句:名单就是现在的成员,新人只能申请 */
  entryListHint: (members: number) => `只允许账号名单（现在的 ${members} 位成员）。新人要发申请，由你在顶栏「成员」里通过。`,
  /** 勾着时那一句 */
  entryLinkHint: '知道项目链接的人登录网站账号后就能加入。',
  /** 成员浮层里申请那一段的标题 */
  requestsTitle: (n: number) => `申请加入（${n}）`,
  approve: '通过',
  reject: '拒绝',
  /** 创建者点了「通过」「拒绝」之后的气泡(桌面、手机同一句) */
  approvedToast: (name: string) => `已通过 ${name} 的申请`,
  rejectedToast: (name: string) => `已拒绝 ${name} 的申请`,
  /** 从「我的项目」列表点进一个设了二级密码、还没输过当前这一版的项目(与凭链接加入时那一句相同) */
  secondaryRequired: '该项目设置了项目二级密码，请输入二级密码。',
} as const;

/** 按本机时区写到分钟:「10月22日 14:05」 */
function minuteText(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${two(d.getHours())}:${two(d.getMinutes())}`;
}
/** 「几点之后可以再申请」(次数用完时,由服务端回的 `retryAt` 算出) */
export function retryAtText(retryAt: number): string {
  return `${minuteText(retryAt)} 之后可以再申请。`;
}
/** 成员浮层里每条申请下面那一行的时间 */
export function requestedAtText(createdAt: number): string {
  return `${minuteText(createdAt)} 申请`;
}

/**
 * 重开文件、登录的账号不是成员时那条提示(语义 `workflow/project.md` 第 44 行):项目只放账号名单时另有「发送申请」按钮。
 * 已经发过在等的、被拒且次数用完的,不给按钮,把现状接在后面说清楚。项目知道链接就能进(`entry: 'link'`)、读到已是成员时回 null,
 * 用原来那一句、不带按钮。
 */
export function reopenNotice(status: JoinRequestStatus): { text: string; canSend: boolean } | null {
  if (status.entry !== 'list' || status.state === 'member') return null;
  const base = JOIN_REQUEST_TEXT.reopenNotMember;
  if (status.state === 'pending') return { text: `${base}。${JOIN_REQUEST_TEXT.sent}`, canSend: false };
  const notice = joinRequestNotice(status);
  const tail = status.state === 'rejected' ? `。${JOIN_REQUEST_TEXT.rejected}` : '';
  if (notice?.canSend) return { text: `${base}${tail}`, canSend: true };
  return { text: `${base}${tail}${notice?.hint ? `，${notice.hint}` : ''}`, canSend: false };
}

/**
 * 被挡住的人那一块该说什么、给不给「发送申请」按钮。`member`(刚被通过)只说一句,接着由页面去进项目(设了二级密码的接着问密码)。
 * 项目已经改回「知道链接就能进」(`entry: 'link'`,还不是成员)时回 null、这一块整个不显示:页面直接再试一次加入,
 * 不能一边弹着二级密码框、一边还说「已发送，等创建者通过」或「你不在这个项目的成员名单中」(与 `reopenNotice` 一致)。
 */
export function joinRequestNotice(status: JoinRequestStatus): { text: string; canSend: boolean; hint?: string } | null {
  if (status.state === 'member') return { text: JOIN_REQUEST_TEXT.approved, canSend: false };
  if (status.entry === 'link') return null;
  if (status.state === 'pending') return { text: JOIN_REQUEST_TEXT.sent, canSend: false };
  const text = status.state === 'rejected' ? JOIN_REQUEST_TEXT.rejected : JOIN_REQUEST_TEXT.notListed;
  return { text, canSend: status.canApply, ...(!status.canApply && status.retryAt ? { hint: retryAtText(status.retryAt) } : {}) };
}

/**
 * 申请被通过(`member`)或项目改回「知道链接就能进」(`entry: 'link'`)时,页面该自动再走一次加入:回一个随状态变的键,
 * 页面在键变了的时候调一次加入(设了二级密码的接着问密码)。其余时候回 null
 */
export function autoJoinKey(request: JoinRequestStatus | null): string | null {
  return request && (request.state === 'member' || request.entry === 'link') ? `${request.projectId}:${request.state}:${request.entry}` : null;
}

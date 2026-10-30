/**
 * 公开侧（社区版）默认实现的局域网「成员源」与「加入源」（见 `docs/plan/community-boundary.md`）。
 *
 * 社区版没有网站账号，但局域网共享项目有一整套完整的凭证、成员与邀请码机制：
 * - `server/auth/`：项目口令、创建者口令、连接票据、邀请码签发与兑换、`kick` / `unban` / `add-member` / `remove-member` 管理指令；
 * - `server/lan/`：局域网主机发现与广播；
 * - `src/editor/sync/`：实时同步连接上的在线成员列表（`getSyncView().members`）与管理操作（`adminOp`）。
 *
 * 本模块提供不依赖 React 的纯逻辑构造器（方便 Node 单测直接注入验证），供 `MembersPanel.tsx`、`useMembers.ts`、`JoinPanel.tsx` 挂载为默认实现。
 */
import { docBaseOf, hostedWsUrlOf, parseInviteLink } from "../../online/invite.ts";
import type {
  AccountMemberOperation,
  AccountMemberResult,
  AccountMembersSnapshot,
  JoinSource,
  LanInviteResolution,
  MemberSource,
} from "./accountExtensions.ts";

export interface LanMemberInput {
  username: string;
  displayName?: string;
  role?: "creator" | "member";
  creator?: boolean;
  online?: boolean;
  deviceId?: string | null;
  deviceName?: string | null;
  conns?: { role: string; service?: string; conversation?: string | number }[];
}

export interface LanMemberView {
  username: string;
  displayName: string;
  role: "creator" | "member";
  online: boolean;
  deviceId: string | null;
  deviceName: string;
  conns: { role: "page" | "agent" | "render"; service?: "agent" | "render"; conversation?: string | number }[];
}

export interface LanSharedView {
  where: "lan" | "hosted";
  base: string;
  projectId: string;
  name: string;
  mode: "free" | "restricted";
  creator?: boolean;
  as?: "creator" | "member";
  username: string;
  accountId?: string;
}

export interface LanSyncSnapshot {
  shared: LanSharedView | null;
  members: readonly LanMemberInput[];
}

export type LanAdminError = string;

export interface LanMemberSourceDeps {
  getSyncView(): LanSyncSnapshot;
  adminOp(
    op: string,
    auth: { password?: string; key?: string },
    fields?: Record<string, unknown>,
  ): Promise<{ ok: true; reply?: Record<string, unknown>; key: string } | { ok: false; error: LanAdminError; retryAfter?: number | null }>;
  localCollab?(projectId: string): {
    creatorPassword?: string;
    projectPassword?: string;
    invite?: { link: string; expiresAt: number; maxUses: number | null } | null;
  } | null;
  createInvite?(
    creatorPassword: string,
  ): Promise<{ ok: true; invite: { link: string; expiresAt: number; maxUses: number | null } } | { ok: false; error: LanAdminError }>;
}

/**
 * 整理局域网共享项目的成员列表：
 * - 同名多连接合并（只要有一条在线就算在线，创建者身份保留）；
 * - 自己的连接尚未出现在回包里时，把自己按在线补进列表；
 * - 创建者排第一，其余按用户名排序，拆成「在线」与「离线」两组。
 */
export function splitLanMembers(
  members: readonly LanMemberInput[],
  selfUsername: string,
  selfAsCreator = false,
): { online: LanMemberView[]; offline: LanMemberView[] } {
  const seen = new Map<string, LanMemberView>();
  for (const raw of members) {
    const isCreator = raw.creator === true || raw.role === "creator";
    const role: "creator" | "member" = isCreator ? "creator" : "member";
    const online = raw.online !== false;
    const normalizedConns: LanMemberView["conns"] = (raw.conns ?? [{ role: "page" }])
      .filter((c) => c.role === "page" || c.role === "agent" || c.role === "render")
      .map((c) => ({
        role: c.role as "page" | "agent" | "render",
        ...(c.service === "agent" || c.service === "render" ? { service: c.service } : {}),
        ...(c.conversation !== undefined ? { conversation: c.conversation } : {}),
      }));
    const item: LanMemberView = {
      username: raw.username,
      displayName: raw.displayName || raw.username,
      role,
      online,
      deviceId: raw.deviceId ?? null,
      deviceName: raw.deviceName || raw.username,
      conns: normalizedConns.length > 0 ? normalizedConns : [{ role: "page" }],
    };
    const prev = seen.get(raw.username);
    if (!prev || (item.online && !prev.online) || (item.role === "creator" && prev.role !== "creator")) {
      seen.set(raw.username, item);
    }
  }
  if (selfUsername && !seen.has(selfUsername)) {
    seen.set(selfUsername, {
      username: selfUsername,
      displayName: selfUsername,
      role: selfAsCreator ? "creator" : "member",
      online: true,
      deviceId: null,
      deviceName: selfUsername,
      conns: [{ role: "page" }],
    });
  }
  const order = (a: LanMemberView, b: LanMemberView) =>
    (a.role === "creator" ? -1 : b.role === "creator" ? 1 : 0) || a.username.localeCompare(b.username, "zh-CN");
  const all = [...seen.values()].sort(order);
  return {
    online: all.filter((m) => m.online),
    offline: all.filter((m) => !m.online),
  };
}

/** 构造公开侧默认局域网成员源 */
export function createLanMemberSource(deps: LanMemberSourceDeps): MemberSource {
  return {
    kind: "lan",
    async fetchMembers(): Promise<AccountMembersSnapshot | null> {
      const sync = deps.getSyncView();
      const shared = sync.shared;
      if (!shared) return null;
      const isCreator = shared.creator === true || shared.as === "creator";
      const { online, offline } = splitLanMembers(sync.members, shared.username, isCreator);
      const all = [...online, ...offline];
      const creatorName =
        all.find((m) => m.role === "creator")?.username ?? (isCreator ? shared.username : "");
      return {
        v: 2,
        authorityId: `lan:${shared.projectId}`,
        projectId: shared.projectId,
        accessRevision: 1,
        creatorAccountId: creatorName,
        self: {
          accountId: shared.username,
          creator: isCreator,
          access: "rw",
        },
        allowLinkJoin: shared.mode === "free",
        members: all.map((m, idx) => ({
          accountId: m.username,
          accountName: m.displayName,
          access: "rw" as const,
          joinedAt: idx + 1,
        })),
        devices: online.map((m) => ({
          accountId: m.username,
          accountName: m.displayName,
          deviceId: m.deviceId ?? `lan:${m.username}`,
          deviceName: m.deviceName,
          creator: m.role === "creator",
          conns: m.conns,
        })),
      };
    },

    async memberAdmin(operation: AccountMemberOperation): Promise<AccountMemberResult> {
      const sync = deps.getSyncView();
      const shared = sync.shared;
      if (!shared) throw new Error("当前未连接共享项目");
      const isCreator = shared.creator === true || shared.as === "creator";
      if (!isCreator) throw new Error("只有项目创建者可以管理成员。");
      const password = deps.localCollab?.(shared.projectId)?.creatorPassword ?? "";
      if (operation.op === "kick") {
        const username = operation.accountId.trim();
        if (!username || username === shared.username) throw new Error("无法移除该成员");
        const r = await deps.adminOp("kick", { password }, { username, deviceId: null });
        if (!r.ok) throw new Error(r.error);
        return {
          eventId: operation.requestId,
          accessRevision: (operation.expectedAccessRevision ?? 1) + 1,
          completed: false,
          state: "pending-services",
        };
      }
      if (operation.op === "unban") {
        const r = await deps.adminOp("unban", { password }, { deviceId: operation.accountId });
        if (!r.ok) throw new Error(r.error);
        return {
          eventId: operation.requestId,
          accessRevision: (operation.expectedAccessRevision ?? 1) + 1,
          completed: false,
          state: "pending-services",
        };
      }
      throw new Error("局域网共享项目不支持此操作");
    },

    async kickLanMember(
      row: { username: string; deviceId: string | null },
      auth: { password?: string; key?: string },
    ): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
      const sync = deps.getSyncView();
      const shared = sync.shared;
      if (!shared) return { ok: false, error: "offline" };
      const isCreator = shared.creator === true || shared.as === "creator";
      if (!isCreator) return { ok: false, error: "forbidden" };
      const r = await deps.adminOp("kick", auth, { username: row.username, deviceId: row.deviceId });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, key: r.key };
    },

    async createInvite(creatorPassword: string) {
      if (!deps.createInvite) return { ok: false as const, error: "offline" };
      const r = await deps.createInvite(creatorPassword);
      if (!r.ok) return { ok: false as const, error: r.error };
      return {
        ok: true as const,
        link: r.invite.link,
        expiresAt: r.invite.expiresAt,
        maxUses: r.invite.maxUses,
      };
    },
  };
}

/* ---------------- 公开侧局域网加入源 ---------------- */

export const LAN_JOIN_TEXT = Object.freeze({
  badLink: "这不是有效的邀请链接。",
  oldLink: "这是旧版邀请链接，向创建者要一张新的（设置里「作废并重新生成邀请码」），或手动填写项目信息。",
  inviteInvalid: "这个邀请链接已失效，向创建者要一个新的，或手动填写项目信息。",
  needUsername: "请输入用户名",
  badUsername: "用户名格式不对（1～64 个字符，不能有控制字符，首尾不能是空格）",
  needPassword: "请输入密码",
  auth: "用户名或密码不对。忘了的话找创建者问一下。",
  kicked: "你被创建者踢出了这个项目。想回来，找创建者撤销。",
  noProject: "找不到这个项目，检查一下项目名。",
  unreachable: "连不上服务器，请稍后再试。",
});

export function lanUsernameOk(v: string): boolean {
  return v.length > 0 && Array.from(v).length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(v) && v.trim() === v;
}

export interface LanJoinSourceDeps {
  resolveInvite(params: {
    base: string;
    code: string;
  }): Promise<{ projectId: string; name: string; mode: "free" | "restricted" }>;
  redeemInvite(params: {
    base: string;
    code: string;
    username: string;
    deviceId: string;
  }): Promise<{ projectId: string; name: string; mode: "free" | "restricted"; key?: string }>;
  ensureDevice(): Promise<{ deviceId: string; deviceName?: string } | null>;
  enterShared(
    candidate: { where: "hosted" | "lan"; base: string; ws: string; projectId: string; name: string; mode: "free" | "restricted" },
    cred: { as: "member" | "creator"; username: string; password: string; key?: string },
  ): Promise<{ ok: true } | { ok: false; error: string; retryAfter?: number | null }>;
  errorStatus?(err: unknown): { status: number | null; retryAfter: number | null };
  onBeforeEnter?(): void;
  onEntered?(): void;
}

export function createLanJoinSource(deps: LanJoinSourceDeps): JoinSource {
  const statusOf = (e: unknown): number | null => {
    if (deps.errorStatus) return deps.errorStatus(e).status;
    const s = (e as { status?: unknown } | null)?.status;
    return typeof s === "number" ? s : null;
  };

  return {
    kind: "lan",
    async resolveLanInvite(rawLink: string): Promise<LanInviteResolution | { ok: false; error: string }> {
      const parsed = parseInviteLink(rawLink);
      if (!parsed) return { ok: false, error: LAN_JOIN_TEXT.badLink };
      if (!parsed.doc) return { ok: false, error: LAN_JOIN_TEXT.oldLink };
      const base = docBaseOf(parsed.origin, parsed.doc);
      try {
        const p = await deps.resolveInvite({ base, code: parsed.code });
        return {
          ok: true,
          base,
          code: parsed.code,
          projectId: p.projectId,
          name: p.name,
          mode: p.mode,
        };
      } catch (e) {
        const status = statusOf(e);
        return {
          ok: false,
          error: status === 404 ? LAN_JOIN_TEXT.inviteInvalid : LAN_JOIN_TEXT.unreachable,
        };
      }
    },

    async joinLanByInvite(params: {
      base: string;
      code: string;
      username: string;
      password?: string;
    }): Promise<{ ok: true; projectId: string } | { ok: false; error: string }> {
      const user = params.username.trim();
      if (!user) return { ok: false, error: LAN_JOIN_TEXT.needUsername };
      if (!lanUsernameOk(user)) return { ok: false, error: LAN_JOIN_TEXT.badUsername };
      const device = await deps.ensureDevice();
      if (!device) return { ok: false, error: LAN_JOIN_TEXT.unreachable };
      let red: Awaited<ReturnType<LanJoinSourceDeps["redeemInvite"]>>;
      try {
        red = await deps.redeemInvite({
          base: params.base,
          code: params.code,
          username: user,
          deviceId: device.deviceId,
        });
      } catch (e) {
        const status = statusOf(e);
        if (status === 404) return { ok: false, error: LAN_JOIN_TEXT.inviteInvalid };
        if (status === 401) return { ok: false, error: LAN_JOIN_TEXT.kicked };
        return { ok: false, error: LAN_JOIN_TEXT.unreachable };
      }
      if (red.mode === "restricted" && !params.password) {
        return { ok: false, error: LAN_JOIN_TEXT.needPassword };
      }
      deps.onBeforeEnter?.();
      const candidate = {
        where: "hosted" as const,
        base: params.base,
        ws: hostedWsUrlOf(params.base),
        projectId: red.projectId,
        name: red.name,
        mode: red.mode,
      };
      const cred =
        red.mode === "free" && red.key
          ? { as: "member" as const, username: user, password: "", key: red.key }
          : { as: "member" as const, username: user, password: params.password ?? "" };
      const entered = await deps.enterShared(candidate, cred);
      if (entered.ok) {
        deps.onEntered?.();
        return { ok: true, projectId: red.projectId };
      }
      const text: Record<string, string> = {
        auth: LAN_JOIN_TEXT.auth,
        kicked: LAN_JOIN_TEXT.kicked,
        "no-project": LAN_JOIN_TEXT.noProject,
        unreachable: LAN_JOIN_TEXT.unreachable,
        "not-ready": LAN_JOIN_TEXT.unreachable,
      };
      return { ok: false, error: text[entered.error] ?? LAN_JOIN_TEXT.unreachable };
    },
  };
}

/**
 * 成员与 Agent 的数目和名单,给预览右上角的成员按钮和成员面板用。数据和桌面的成员按钮同源:
 * 账号项目取 `accountProjectMembers()`(展开时每 3 秒、收着时每 15 秒,页签在后台不取,同 `AccountMembersPanel`);
 * 凭口令的共享项目取同步状态里的成员行(`MembersPanel` 的同一套过滤)。
 */
import { useCallback, useEffect, useState } from "react";
import { MEMBERS_POLL_CLOSED_MS, MEMBERS_POLL_OPEN_MS, getMemberSource, type AccountJoinRequestRow, type AccountMembersSnapshot } from "../editor/sync/accountExtensions";
import { useSync } from "../editor/sync/syncManager";
import { accountMemberCounts, accountMemberState, cloudAgentConns, cloudAgentLabel, isCloudAgentOnly, isCloudAgentRunning, splitMembers, visibleMembers } from "../editor/sync/hostedServices";
import { useCloudRunning } from "../editor/sync/presence";

export interface MemberLine {
  key: string;
  name: string;
  sub: string;
  me: boolean;
  creator: boolean;
  online: boolean;
  agent: boolean;
}

export interface MembersInfo {
  /** 读不到名单(账号项目的成员服务暂时不可用) */
  unavailable: boolean;
  people: number;
  agents: number;
  lines: MemberLine[];
  /** 挂着的申请加入(只有创建者看得到;别人和凭口令的共享项目都是空的)。成员按钮上的数字角标就是它的条数 */
  requests: AccountJoinRequestRow[];
  /** 马上重取一次(创建者通过、拒绝之后) */
  refresh: () => void;
}

export function useMembers(open: boolean): MembersInfo {
  const shared = useSync((v) => v.shared);
  const rows = useSync((v) => v.members);
  const device = useSync((v) => v.device);
  const running = useCloudRunning();
  const account = !!shared?.accountId;
  const [snap, setSnap] = useState<AccountMembersSnapshot | null>(null);
  const refresh = useCallback(() => {
    if (!account) return;
    getMemberSource().fetchMembers().then(setSnap, () => setSnap(null));
  }, [account]);
  useEffect(() => { setSnap(null); refresh(); }, [refresh, shared?.projectId, shared?.accountId]);
  useEffect(() => {
    if (!account) return;
    const id = window.setInterval(() => { if (document.visibilityState !== "hidden") refresh(); }, open ? MEMBERS_POLL_OPEN_MS : MEMBERS_POLL_CLOSED_MS);
    return () => window.clearInterval(id);
  }, [account, open, refresh]);

  if (!shared) return { unavailable: true, people: 0, agents: 0, lines: [], requests: [], refresh };
  if (account) {
    if (!snap) return { unavailable: true, people: 0, agents: 0, lines: [], requests: [], refresh };
    // 口径同桌面版 `AccountMembersPanel`(`accountMemberState`;语义 `product/agent.md`「成员列表怎么数」)
    const lines: MemberLine[] = [];
    for (const m of snap.members) {
      const s = accountMemberState(m.accountId, snap.devices);
      const name = m.accountName ?? m.accountId;
      const me = m.accountId === shared.accountId;
      lines.push({ key: m.accountId, name: `${name}${me ? "（自己）" : ""}`, sub: s.offlineAgent ? "离线，Agent 在跑" : s.online ? "编辑中" : "离线", me, creator: m.accountId === snap.creatorAccountId, online: s.online, agent: false });
      s.localAgents.forEach((c, i) => lines.push({ key: `${m.accountId}:a${i}`, name: `${name} · Agent${c.conversation !== undefined ? ` · 对话 ${c.conversation}` : ""}`, sub: "本机", me: false, creator: false, online: true, agent: true }));
      if (s.cloudRunning) lines.push({ key: `${m.accountId}:cloud`, name: cloudAgentLabel(name), sub: "云端", me: false, creator: false, online: true, agent: true });
    }
    const counts = accountMemberCounts(snap);
    return { unavailable: false, people: counts.people, agents: counts.agents, lines, requests: snap.self.creator ? snap.requests ?? [] : [], refresh };
  }
  const people = visibleMembers(splitMembers(rows).people, running);
  const lines: MemberLine[] = [];
  let agents = 0;
  for (const r of people) {
    const me = r.username === shared.username && r.deviceId === device?.deviceId;
    const cloudOnly = isCloudAgentOnly(r, running);
    lines.push({ key: `${r.username}@${r.deviceId}`, name: `${r.displayName || r.username}${me ? "（自己）" : ""}`, sub: cloudOnly ? "离线，Agent 在跑" : r.tags.editing ? "编辑中" : "在看", me, creator: r.creator, online: !cloudOnly, agent: false });
    const local = r.conns.filter((c) => c.role === "agent" && c.service !== "agent");
    const cloud = isCloudAgentRunning(r, running) ? cloudAgentConns(r.conns) : [];
    local.forEach((c, i) => { agents++; lines.push({ key: `${r.username}@${r.deviceId}:a${i}`, name: `${r.displayName || r.username} · Agent${c.conversation !== undefined ? ` · 第 ${c.conversation} 个对话` : ""}`, sub: "本机", me: false, creator: false, online: true, agent: true }); });
    cloud.forEach((_c, i) => { agents++; lines.push({ key: `${r.username}@${r.deviceId}:c${i}`, name: cloudAgentLabel(r.displayName || r.username), sub: "云端", me: false, creator: false, online: true, agent: true }); });
  }
  return { unavailable: false, people: Math.max(1, lines.filter((l) => !l.agent && l.online).length), agents, lines, requests: [], refresh };
}

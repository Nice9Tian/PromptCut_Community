/**
 * The count and list of members and Agents, for the member button at the top right of the preview and the member panel. The data has the same source as the desktop app's member button:
 * for an account project, take `accountProjectMembers()` (every 3 seconds when expanded, every 15 seconds when collapsed, not fetched while the tab is in the background, same as `AccountMembersPanel`);
 * for a shared project joined by passphrase, take the member rows in the sync state (the same filtering as `MembersPanel`).
 */
import { useCallback, useEffect, useState } from "react";
import { MEMBERS_POLL_CLOSED_MS, MEMBERS_POLL_OPEN_MS, getMemberSource, type AccountJoinRequestRow, type AccountMembersSnapshot } from "../editor/sync/accountExtensions";
import { useSync } from "../editor/sync/syncManager";
import { accountMemberCounts, accountMemberState, cloudAgentConns, cloudAgentLabel, isCloudAgentOnly, isCloudAgentRunning, splitMembers, visibleMembers } from "../editor/sync/hostedServices";
import { useCloudRunning } from "../editor/sync/presence";
import { tr } from "../i18n/index.ts";

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
  /** The list cannot be read (the member service of the account project is temporarily unavailable) */
  unavailable: boolean;
  people: number;
  agents: number;
  lines: MemberLine[];
  /** Pending join requests (only the creator can see them; for others and for passphrase-based shared projects it is empty). The number badge on the member button is its count */
  requests: AccountJoinRequestRow[];
  /** Refetch immediately (after the creator approves or rejects) */
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
    // Same counting as the desktop app's `AccountMembersPanel` (`accountMemberState`; semantics `product/agent.md`, "How to count the member list")
    const lines: MemberLine[] = [];
    for (const m of snap.members) {
      const s = accountMemberState(m.accountId, snap.devices);
      const name = m.accountName ?? m.accountId;
      const me = m.accountId === shared.accountId;
      lines.push({ key: m.accountId, name: `${name}${me ? tr(" (you)") : ""}`, sub: s.offlineAgent ? tr("Offline, Agent running") : s.online ? tr("Editing") : tr("offline"), me, creator: m.accountId === snap.creatorAccountId, online: s.online, agent: false });
      s.localAgents.forEach((c, i) => lines.push({ key: `${m.accountId}:a${i}`, name: `${name} · Agent${c.conversation !== undefined ? tr(" · chat {0}", c.conversation) : ""}`, sub: tr("Local"), me: false, creator: false, online: true, agent: true }));
      if (s.cloudRunning) lines.push({ key: `${m.accountId}:cloud`, name: cloudAgentLabel(name), sub: tr("Cloud"), me: false, creator: false, online: true, agent: true });
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
    lines.push({ key: `${r.username}@${r.deviceId}`, name: `${r.displayName || r.username}${me ? tr(" (you)") : ""}`, sub: cloudOnly ? tr("Offline, Agent running") : r.tags.editing ? tr("Editing") : tr("Viewing"), me, creator: r.creator, online: !cloudOnly, agent: false });
    const local = r.conns.filter((c) => c.role === "agent" && c.service !== "agent");
    const cloud = isCloudAgentRunning(r, running) ? cloudAgentConns(r.conns) : [];
    local.forEach((c, i) => { agents++; lines.push({ key: `${r.username}@${r.deviceId}:a${i}`, name: `${r.displayName || r.username} · Agent${c.conversation !== undefined ? tr(" · chat {0}", c.conversation) : ""}`, sub: tr("Local"), me: false, creator: false, online: true, agent: true }); });
    cloud.forEach((_c, i) => { agents++; lines.push({ key: `${r.username}@${r.deviceId}:c${i}`, name: cloudAgentLabel(r.displayName || r.username), sub: tr("Cloud"), me: false, creator: false, online: true, agent: true }); });
  }
  return { unavailable: false, people: Math.max(1, lines.filter((l) => !l.agent && l.online).length), agents, lines, requests: [], refresh };
}

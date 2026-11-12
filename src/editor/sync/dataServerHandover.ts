/**
 * Live desktop server-role workspace store and wiring for Data Server handover (Issue #8).
 */
import { useSyncExternalStore } from "react";
import { ONLINE } from "../../online/mode";
import { getState } from "../../store/project";
import { tr } from "../../i18n/index.ts";
import { cacheCollabSecrets } from "./collabSecrets";
import { defaultCreatorName, enableCollab, generatePassword, localCollab } from "./collab";
import { memberOf, sendPresenceMessage, subscribePresenceMessages } from "./presence";
import {
  ensureDevice,
  enterShared,
  expectSharedClose,
  getSyncView,
  leaveSharedToLocal,
  moveSharedToLan,
  pageSession,
  pushToast,
  recoveryRequest,
} from "./syncManager";
import {
  canBecomeDataServer,
  createHandoverCoordinator,
  type HandoverRoomAuth,
  type IncomingHandoverState,
  type OutgoingHandoverState,
} from "./dataServerHandoverCore";

export {
  HANDOVER_KIND,
  canBecomeDataServer,
  createHandoverCoordinator,
  generatePairingCode,
  pairingCommitment,
  sha256Hex,
  type CreatorGateInput,
  type HandoverCoordinatorDeps,
  type HandoverRoomAuth,
  type IncomingHandoverState,
  type OutgoingHandoverState,
} from "./dataServerHandoverCore";

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export type ActiveServerPanel = "render" | "data" | null;

export interface ServerRoleSnapshot {
  activePanel: ActiveServerPanel;
  renderRoleEnabled: boolean;
  dataServerProjectIds: ReadonlyArray<string>;
  outgoing: OutgoingHandoverState;
  incoming: IncomingHandoverState;
}

let activePanel: ActiveServerPanel = null;
let renderRoleEnabled = false;
const claimedDataServerProjects = new Set<string>();
const storeListeners = new Set<() => void>();
let cachedSnapshot: ServerRoleSnapshot | null = null;

function emitStore() {
  cachedSnapshot = null;
  for (const fn of [...storeListeners]) fn();
}

async function fetchLocalDataServerStatus(projectId: string): Promise<{ isLocalHost: boolean; localDeviceId: string | null } | null> {
  if (ONLINE_BUILD) return null;
  try {
    const r = await fetch(`/api/data-server/status?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { ok?: boolean; isLocalHost?: boolean; localDeviceId?: string | null };
    return j?.ok ? { isLocalHost: j.isLocalHost === true, localDeviceId: j.localDeviceId ?? null } : null;
  } catch {
    return null;
  }
}

const liveCoordinator = createHandoverCoordinator({
  getSessionId: () => pageSession(),
  getDevice: async () => {
    const d = await ensureDevice();
    return d ? { deviceId: d.deviceId, deviceName: d.deviceName } : null;
  },
  getProjectContext: () => {
    const v = getSyncView();
    const proj = getState().project;
    return {
      projectId: v.shared?.projectId ?? null,
      projectName: v.shared?.name || proj.name || tr("Untitled"),
      isCreator: canBecomeDataServer({ online: ONLINE, kind: v.kind, shared: v.shared, association: v.association }),
      where: v.shared?.where ?? null,
    };
  },
  isCurrentHostForProject: async (projectId: string, fromDeviceId?: string) => {
    if (ONLINE_BUILD) return { isHost: false, sameServer: false };
    const st = await fetchLocalDataServerStatus(projectId);
    if (!st?.isLocalHost) {
      return { isHost: claimedDataServerProjects.has(projectId) || localCollab(projectId) !== null, sameServer: false };
    }
    if (fromDeviceId && st.localDeviceId && fromDeviceId !== st.localDeviceId) {
      return { isHost: true, sameServer: false };
    }
    const ownsInThisContext = claimedDataServerProjects.has(projectId) || localCollab(projectId) !== null;
    return { isHost: ownsInThisContext, sameServer: true };
  },
  sendSignal: (data) => sendPresenceMessage(data, pageSession()),
  exportHandover: async (projectId: string) => {
    if (ONLINE_BUILD) return null;
    const v = getSyncView();
    if (v.shared?.where === "hosted") return null;
    const r = await fetch("/api/data-server/export-handover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    const j = (await r.json()) as { ok?: boolean; roomAuth?: HandoverRoomAuth; error?: string };
    if (!r.ok || !j?.ok || !j.roomAuth) {
      throw new Error(j?.error || tr("Could not export room credentials from original host."));
    }
    return j.roomAuth;
  },
  relinquishHost: async (projectId: string, sameServer: boolean) => {
    claimedDataServerProjects.delete(projectId);
    if (activePanel === "data") activePanel = null;
    emitStore();
    if (sameServer) {
      cacheCollabSecrets(projectId, null);
      pushToast(tr("Data server role transferred to the verified creator window."), "info", 6000);
      return;
    }
    if (!ONLINE_BUILD) {
      const snapshot = structuredClone(getState().project);
      expectSharedClose(true);
      leaveSharedToLocal(snapshot);
      await fetch("/api/data-server/relinquish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      }).catch(() => {});
      pushToast(tr("Data server handover completed. This machine is no longer hosting the room."), "info", 6000);
    }
  },
  adoptHost: async ({ projectId, roomAuth, sameServer }) => {
    if (ONLINE_BUILD) throw new Error("Not supported in online build");
    const v = getSyncView();
    if (sameServer) {
      claimedDataServerProjects.add(projectId);
      if (v.shared) {
        cacheCollabSecrets(projectId, {
          projectId,
          where: v.shared.where,
          mode: v.shared.mode,
          name: v.shared.name,
          creatorUsername: v.shared.username,
        });
      }
      return projectId;
    }
    if (v.shared?.where === "hosted" && !roomAuth) {
      await moveSharedToLan();
      const nextId = getSyncView().shared?.projectId ?? projectId;
      claimedDataServerProjects.add(nextId);
      return nextId;
    }
    if (!roomAuth) throw new Error(tr("Missing handover package from original host."));

    const snapshot = structuredClone(getState().project);
    const r = await fetch("/api/data-server/adopt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomAuth }),
    });
    const adopted = (await r.json()) as {
      ok?: boolean;
      projectId?: string;
      name?: string;
      mode?: "free" | "restricted";
      creatorUsername?: string;
      creatorKey?: string;
      base?: string;
      hostDeviceName?: string;
      error?: string;
    };
    if (!r.ok || !adopted.ok || !adopted.projectId || !adopted.base || !adopted.creatorUsername || !adopted.creatorKey) {
      throw new Error(adopted?.error || tr("Failed to provision local data server."));
    }

    expectSharedClose(true);
    leaveSharedToLocal(snapshot);

    const entered = await enterShared(
      {
        where: "lan",
        base: adopted.base,
        projectId: adopted.projectId,
        name: adopted.name || roomAuth.name,
        mode: adopted.mode || roomAuth.mode,
        service: adopted.base,
        hostDeviceName: adopted.hostDeviceName,
      },
      {
        as: "creator",
        username: adopted.creatorUsername,
        password: "",
        key: adopted.creatorKey,
      },
      { initialize: true },
    );
    if (!entered.ok) {
      throw new Error(tr("Local data server was provisioned, but joining as creator failed ({0}).", entered.error));
    }
    const descriptor = getSyncView().association;
    if (descriptor) {
      await recoveryRequest("activate-host", descriptor).catch(() => {});
    }
    cacheCollabSecrets(adopted.projectId, {
      projectId: adopted.projectId,
      where: "lan",
      mode: adopted.mode || roomAuth.mode,
      name: adopted.name || roomAuth.name,
      creatorUsername: adopted.creatorUsername,
    });
    claimedDataServerProjects.add(adopted.projectId);
    pushToast(tr("This machine is now the active data server for \"{0}\".", adopted.name || roomAuth.name), "info", 6000);
    return adopted.projectId;
  },
});

let wired = false;
export function ensureDataServerHandoverWired(): void {
  if (wired || ONLINE_BUILD || ONLINE) return;
  wired = true;
  liveCoordinator.subscribe(emitStore);
  subscribePresenceMessages((env) => {
    const v = getSyncView();
    const senderUsername = env.from?.username || memberOf(env.from?.userId) || undefined;
    const matchedMember = v.members.find(
      (m) =>
        (senderUsername && m.username === senderUsername && (!env.from?.deviceId || !m.deviceId || m.deviceId === env.from.deviceId)) ||
        (env.from?.userId && m.deviceId && env.from.userId === `${m.username}@${m.deviceId}`),
    );
    const senderAccountId = (env.from as { accountId?: string } | undefined)?.accountId;
    const isSenderCreator =
      env.from?.creator === true ||
      matchedMember?.creator === true ||
      Boolean(
        v.shared?.creator &&
          ((senderUsername && v.shared.username === senderUsername) ||
            (v.shared.accountId && (env.from?.userId === v.shared.accountId || senderAccountId === v.shared.accountId))),
      );
    const enriched = {
      ...env,
      from: {
        ...env.from,
        ...(senderUsername ? { username: senderUsername } : {}),
        ...(matchedMember?.deviceName && !env.from?.deviceName ? { deviceName: matchedMember.deviceName } : {}),
        creator: isSenderCreator,
      },
    };
    void liveCoordinator.receiveMessage(enriched, (adoptedProjectId) => {
      claimedDataServerProjects.add(adoptedProjectId);
      activePanel = "data";
      emitStore();
    });
  });
}

export function getServerRoleSnapshot(): ServerRoleSnapshot {
  ensureDataServerHandoverWired();
  if (!cachedSnapshot) {
    const hs = liveCoordinator.getState();
    cachedSnapshot = {
      activePanel,
      renderRoleEnabled,
      dataServerProjectIds: [...claimedDataServerProjects],
      outgoing: hs.outgoing,
      incoming: hs.incoming,
    };
  }
  return cachedSnapshot;
}

export function subscribeServerRole(fn: () => void): () => void {
  ensureDataServerHandoverWired();
  storeListeners.add(fn);
  return () => {
    storeListeners.delete(fn);
  };
}

export function useServerRole<T>(selector: (snap: ServerRoleSnapshot) => T): T {
  return useSyncExternalStore(
    subscribeServerRole,
    () => selector(getServerRoleSnapshot()),
    () => selector(getServerRoleSnapshot()),
  );
}

export function setActiveServerPanel(panel: ActiveServerPanel): void {
  activePanel = panel;
  if (panel === "render") renderRoleEnabled = true;
  emitStore();
}

export function markProjectAsLocalDataServer(projectId: string): void {
  if (!projectId) return;
  claimedDataServerProjects.add(projectId);
  emitStore();
}

export function isActiveDataServerForCurrentProject(projectId: string | null | undefined): boolean {
  if (!projectId) return false;
  return claimedDataServerProjects.has(projectId);
}

export async function activateRenderServerMode(): Promise<void> {
  if (ONLINE_BUILD || ONLINE) return;
  renderRoleEnabled = true;
  activePanel = "render";
  emitStore();
}

export async function initiateBecomeDataServer(): Promise<{ immediate: boolean; error?: string }> {
  if (ONLINE_BUILD || ONLINE) return { immediate: false, error: "Unsupported in online build" };
  ensureDataServerHandoverWired();
  const v = getSyncView();
  if (!canBecomeDataServer({ online: ONLINE, kind: v.kind, shared: v.shared, association: v.association })) {
    return { immediate: false, error: tr("Only the project creator can become the data server.") };
  }

  if (!v.shared) {
    const projName = (getState().project.name || tr("Untitled")).trim() || tr("Untitled");
    const creatorUsername = await defaultCreatorName();
    const creatorPassword = generatePassword();
    let targetName = projName;
    let res = await enableCollab({
      where: "lan",
      mode: "restricted",
      name: targetName,
      creator: { username: creatorUsername, password: creatorPassword },
      list: [],
    });
    if (!res.ok && res.error === "name-taken") {
      targetName = `${projName} (${Date.now().toString(36).slice(-4)})`;
      res = await enableCollab({
        where: "lan",
        mode: "restricted",
        name: targetName,
        creator: { username: creatorUsername, password: creatorPassword },
        list: [],
      });
    }
    if (!res.ok) {
      return { immediate: false, error: tr("Could not start local data server ({0}).", res.error) };
    }
    const newId = getSyncView().shared?.projectId;
    if (newId) claimedDataServerProjects.add(newId);
    activePanel = "data";
    emitStore();
    return { immediate: true };
  }

  const status = await fetchLocalDataServerStatus(v.shared.projectId);
  const otherCreatorsOnline = v.members.filter((m) => m.creator).length > 1;
  const ownsHere = Boolean(
    status?.isLocalHost &&
    (claimedDataServerProjects.has(v.shared.projectId) || localCollab(v.shared.projectId) !== null || !otherCreatorsOnline),
  );
  if (ownsHere) {
    claimedDataServerProjects.add(v.shared.projectId);
    activePanel = "data";
    emitStore();
    return { immediate: true };
  }

  const started = await liveCoordinator.requestHandover();
  return { immediate: false, error: started.error };
}

export const handoverActions = {
  cancelOutgoing: () => liveCoordinator.cancelOutgoing(),
  submitPairingCode: (code: string) => liveCoordinator.submitPairingCode(code),
  agreeIncoming: () => liveCoordinator.agreeIncoming(),
  declineIncoming: () => liveCoordinator.declineIncoming(),
  confirmHostPairing: () => liveCoordinator.confirmHostPairing(),
};

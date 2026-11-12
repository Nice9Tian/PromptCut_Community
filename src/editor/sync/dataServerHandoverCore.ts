/**
 * Pure, framework-free core for the Desktop Data Server creator visibility gate and mutual
 * 6-digit pairing-code handover coordinator (Issue #8).
 *
 * Kept free of `online/mode.ts` and `syncManager.ts` so Node unit tests can import and verify
 * every state transition directly.
 */
import { tr } from "../../i18n/index.ts";
import type { PresenceMessageEnvelope } from "./presence";

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export const HANDOVER_KIND = "pc:data-server-handover";

export interface CreatorGateInput {
  online?: boolean;
  kind: string;
  shared: { creator: boolean } | null;
  association: unknown;
}

/**
 * Visibility gate for "Become data server (member accounts & project document)" (Issue #8):
 *   - Hidden in online browser builds (`ONLINE_BUILD`).
 *   - In a shared or cloud project (`shared !== null`): visible ONLY when `shared.creator === true`.
 *   - In an unshared local project (`!shared && !association && kind === "local"`): visible (this
 *     desktop user owns the local project).
 */
export function canBecomeDataServer(input: CreatorGateInput): boolean {
  if (input.online || ONLINE_BUILD) return false;
  if (input.shared) return input.shared.creator === true;
  return !input.association && input.kind === "local";
}

/** Pure SHA-256 hex digest using WebCrypto (available in browsers and Node 22+). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Cryptographically unbiased 6-digit pairing code (`000000`–`999999`). */
export function generatePairingCode(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4_294_000_000) {
      return String(buf[0] % 1_000_000).padStart(6, "0");
    }
  }
}

export async function pairingCommitment(requestId: string, code: string): Promise<string> {
  return sha256Hex(`pc-handover-v1:${requestId}:${code.trim()}`);
}

export interface HandoverRoomAuth {
  sourceProjectId?: string;
  name: string;
  mode: "free" | "restricted";
  kdf: Record<string, unknown>;
  creator: { username: string; salt: string; key: string };
  project?: { salt: string; key: string };
  list?: Array<{ username: string; salt: string; key: string; access?: "r" | "rw" }>;
  bans?: Array<{ deviceId: string; username?: string | null; displayName?: string | null; at?: number | null }>;
}

export type OutgoingHandoverState =
  | null
  | { phase: "waiting-approval"; requestId: string; projectId: string; projectName: string }
  | {
      phase: "enter-code";
      requestId: string;
      projectId: string;
      projectName: string;
      hostDeviceName: string;
      codeHash: string;
      submittedCode: string | null;
      error: string | null;
    }
  | { phase: "adopting"; requestId: string; projectId: string; projectName: string }
  | { phase: "declined"; requestId: string; hostDeviceName: string }
  | { phase: "error"; message: string };

export type IncomingHandoverState =
  | null
  | {
      phase: "prompt";
      requestId: string;
      projectId: string;
      projectName: string;
      fromDeviceId: string;
      fromDeviceName: string;
      fromSession: string;
    }
  | {
      phase: "verify-code";
      requestId: string;
      projectId: string;
      projectName: string;
      fromDeviceId: string;
      fromDeviceName: string;
      fromSession: string;
      code: string;
      requesterVerified: boolean;
      hostConfirmed: boolean;
      completing: boolean;
      error: string | null;
    };

export interface HandoverCoordinatorDeps {
  getSessionId: () => string;
  getDevice: () => Promise<{ deviceId: string; deviceName: string } | null>;
  getProjectContext: () => {
    projectId: string | null;
    projectName: string;
    isCreator: boolean;
    where: "lan" | "hosted" | null;
  };
  isCurrentHostForProject: (projectId: string, fromDeviceId?: string) => Promise<{ isHost: boolean; sameServer: boolean }>;
  sendSignal: (data: Record<string, unknown>) => Promise<boolean>;
  exportHandover: (projectId: string) => Promise<HandoverRoomAuth | null>;
  relinquishHost: (projectId: string, sameServer: boolean) => Promise<void>;
  adoptHost: (payload: { projectId: string; roomAuth: HandoverRoomAuth | null; sameServer: boolean }) => Promise<string>;
  newCode?: () => string;
  newRequestId?: () => string;
}

export function createHandoverCoordinator(deps: HandoverCoordinatorDeps) {
  let outgoing: OutgoingHandoverState = null;
  let incoming: IncomingHandoverState = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const fn of [...listeners]) fn();
  };

  async function requestHandover(): Promise<{ started: boolean; error?: string }> {
    const ctx = deps.getProjectContext();
    if (!ctx.isCreator || !ctx.projectId) {
      return { started: false, error: tr("Only the project creator can become the data server.") };
    }
    const device = await deps.getDevice();
    if (!device) {
      return { started: false, error: tr("Device information is not ready yet") };
    }
    const requestId = deps.newRequestId ? deps.newRequestId() : `ho-${crypto.randomUUID()}`;
    outgoing = {
      phase: "waiting-approval",
      requestId,
      projectId: ctx.projectId,
      projectName: ctx.projectName,
    };
    notify();

    const sent = await deps.sendSignal({
      kind: HANDOVER_KIND,
      step: "request",
      requestId,
      projectId: ctx.projectId,
      projectName: ctx.projectName,
      fromDeviceId: device.deviceId,
      fromDeviceName: device.deviceName,
      fromSession: deps.getSessionId(),
    });
    if (!sent) {
      outgoing = {
        phase: "error",
        message: tr("Could not reach the original creator machine. Ensure the original creator project window is online."),
      };
      notify();
      return { started: false, error: outgoing.message };
    }
    return { started: true };
  }

  function cancelOutgoing() {
    if (outgoing && (outgoing.phase === "waiting-approval" || outgoing.phase === "enter-code")) {
      void deps.sendSignal({
        kind: HANDOVER_KIND,
        step: "cancel",
        requestId: outgoing.requestId,
        fromSession: deps.getSessionId(),
      });
    }
    outgoing = null;
    notify();
  }

  async function submitPairingCode(rawCode: string): Promise<boolean> {
    if (!outgoing || outgoing.phase !== "enter-code") return false;
    const clean = String(rawCode || "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(clean)) {
      outgoing = { ...outgoing, error: tr("Enter the 6-digit pairing code.") };
      notify();
      return false;
    }
    const expected = await pairingCommitment(outgoing.requestId, clean);
    if (expected !== outgoing.codeHash) {
      outgoing = { ...outgoing, error: tr("Pairing code does not match. Check the 6-digit code on the original machine.") };
      notify();
      return false;
    }
    outgoing = { ...outgoing, submittedCode: clean, error: null };
    notify();
    await deps.sendSignal({
      kind: HANDOVER_KIND,
      step: "verify",
      requestId: outgoing.requestId,
      code: clean,
      fromSession: deps.getSessionId(),
    });
    return true;
  }

  async function declineIncoming(): Promise<void> {
    if (!incoming) return;
    const reqId = incoming.requestId;
    const device = await deps.getDevice();
    incoming = null;
    notify();
    await deps.sendSignal({
      kind: HANDOVER_KIND,
      step: "declined",
      requestId: reqId,
      hostDeviceName: device?.deviceName || tr("Original creator machine"),
      fromSession: deps.getSessionId(),
    });
  }

  async function agreeIncoming(): Promise<string | null> {
    if (!incoming || incoming.phase !== "prompt") return null;
    const device = await deps.getDevice();
    const code = deps.newCode ? deps.newCode() : generatePairingCode();
    const codeHash = await pairingCommitment(incoming.requestId, code);
    incoming = {
      phase: "verify-code",
      requestId: incoming.requestId,
      projectId: incoming.projectId,
      projectName: incoming.projectName,
      fromDeviceId: incoming.fromDeviceId,
      fromDeviceName: incoming.fromDeviceName,
      fromSession: incoming.fromSession,
      code,
      requesterVerified: false,
      hostConfirmed: false,
      completing: false,
      error: null,
    };
    notify();
    await deps.sendSignal({
      kind: HANDOVER_KIND,
      step: "approved",
      requestId: incoming.requestId,
      targetSession: incoming.fromSession,
      hostDeviceId: device?.deviceId || "",
      hostDeviceName: device?.deviceName || tr("Original creator machine"),
      codeHash,
      fromSession: deps.getSessionId(),
    });
    return code;
  }

  async function finalizeHostHandover(): Promise<void> {
    if (!incoming || incoming.phase !== "verify-code" || incoming.completing) return;
    if (!incoming.requesterVerified || !incoming.hostConfirmed) return;
    const snap = incoming;
    incoming = { ...snap, completing: true, error: null };
    notify();
    try {
      const device = await deps.getDevice();
      const sameServer = Boolean(device && snap.fromDeviceId && device.deviceId === snap.fromDeviceId);
      const roomAuth = sameServer ? null : await deps.exportHandover(snap.projectId);
      await deps.sendSignal({
        kind: HANDOVER_KIND,
        step: "verified",
        requestId: snap.requestId,
        targetSession: snap.fromSession,
        sameServer,
        roomAuth,
        fromSession: deps.getSessionId(),
      });
      await deps.relinquishHost(snap.projectId, sameServer);
      incoming = null;
      notify();
    } catch (err) {
      incoming = {
        ...snap,
        completing: false,
        error: err instanceof Error ? err.message : tr("Handover could not be completed."),
      };
      notify();
    }
  }

  async function confirmHostPairing(): Promise<void> {
    if (!incoming || incoming.phase !== "verify-code") return;
    incoming = { ...incoming, hostConfirmed: true, error: null };
    notify();
    if (incoming.requesterVerified) {
      await finalizeHostHandover();
    }
  }

  async function receiveMessage(env: PresenceMessageEnvelope, onAdopted?: (newProjectId: string) => void): Promise<void> {
    if (env.from?.creator !== true) return;
    const data = env.data;
    if (!data || data.kind !== HANDOVER_KIND) return;
    const mySession = deps.getSessionId();
    if (typeof data.fromSession === "string" && data.fromSession === mySession) return;

    const step = String(data.step || "");
    const requestId = String(data.requestId || "");
    if (!requestId) return;

    if (step === "request") {
      const ctx = deps.getProjectContext();
      if (!ctx.isCreator || !ctx.projectId || ctx.projectId !== env.projectId) return;
      const fromDev = String(data.fromDeviceId || env.from.deviceId || "");
      const hostInfo = await deps.isCurrentHostForProject(ctx.projectId, fromDev);
      if (!hostInfo.isHost) return;
      incoming = {
        phase: "prompt",
        requestId,
        projectId: ctx.projectId,
        projectName: String(data.projectName || ctx.projectName || ctx.projectId),
        fromDeviceId: String(data.fromDeviceId || env.from.deviceId || ""),
        fromDeviceName: String(data.fromDeviceName || env.from.deviceName || env.from.username || tr("Another creator device")),
        fromSession: String(data.fromSession || ""),
      };
      notify();
      return;
    }

    if (step === "cancel") {
      if (incoming && incoming.requestId === requestId) {
        incoming = null;
        notify();
      }
      return;
    }

    if (step === "declined") {
      if (outgoing && (outgoing.phase === "waiting-approval" || outgoing.phase === "enter-code") && outgoing.requestId === requestId) {
        outgoing = {
          phase: "declined",
          requestId,
          hostDeviceName: String(data.hostDeviceName || tr("Original creator machine")),
        };
        notify();
      }
      return;
    }

    if (step === "approved") {
      if (!outgoing || outgoing.phase !== "waiting-approval" || outgoing.requestId !== requestId) return;
      if (typeof data.targetSession === "string" && data.targetSession && data.targetSession !== mySession) return;
      outgoing = {
        phase: "enter-code",
        requestId,
        projectId: outgoing.projectId,
        projectName: outgoing.projectName,
        hostDeviceName: String(data.hostDeviceName || tr("Original creator machine")),
        codeHash: String(data.codeHash || ""),
        submittedCode: null,
        error: null,
      };
      notify();
      return;
    }

    if (step === "verify") {
      if (!incoming || incoming.requestId !== requestId || incoming.phase !== "verify-code") return;
      const code = String(data.code || "").trim();
      if (code !== incoming.code) return;
      incoming = { ...incoming, requesterVerified: true, error: null };
      notify();
      if (incoming.hostConfirmed) {
        await finalizeHostHandover();
      }
      return;
    }

    if (step === "verified") {
      if (!outgoing || (outgoing.phase !== "enter-code" && outgoing.phase !== "waiting-approval") || outgoing.requestId !== requestId) return;
      if (typeof data.targetSession === "string" && data.targetSession && data.targetSession !== mySession) return;
      const targetProjectId = outgoing.projectId;
      const targetProjectName = outgoing.projectName;
      outgoing = { phase: "adopting", requestId, projectId: targetProjectId, projectName: targetProjectName };
      notify();
      try {
        const adoptedId = await deps.adoptHost({
          projectId: targetProjectId,
          roomAuth: (data.roomAuth as HandoverRoomAuth | null) ?? null,
          sameServer: data.sameServer === true,
        });
        outgoing = null;
        notify();
        onAdopted?.(adoptedId);
      } catch (err) {
        outgoing = {
          phase: "error",
          message: err instanceof Error ? err.message : tr("Failed to activate local data server."),
        };
        notify();
      }
    }
  }

  return {
    getState: () => ({ outgoing, incoming }),
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    requestHandover,
    cancelOutgoing,
    submitPairingCode,
    agreeIncoming,
    declineIncoming,
    confirmHostPairing,
    receiveMessage,
  };
}

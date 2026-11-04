/**
 * Types for `server/lan-open.mjs` (imported directly by the page side to check whether the invite
 * link falls on a local network interface: `src/editor/LanOpenDialog.tsx`).
 */

export const LAN_OPEN_PATH: string;
export const LAN_HOST_ENV: string;
export const LAN_HOST_COMMAND: string;

export interface LanAddress {
  name: string;
  address: string;
}

export interface LanOpenInfo {
  /** Whether the editor is currently bound to the LAN (determined by actual listening address) */
  lanHost: boolean;
  port: number | null;
  /** Tells the user how to start when not bound to the LAN */
  command: string;
  addresses: LanAddress[];
}

/** Whether this listening address is reachable from the LAN; treated as unreachable if undetermined */
export function boundToLan(address: unknown): boolean;

export function lanOpenInfo(o?: {
  bound?: unknown;
  port?: unknown;
  nics?: readonly { name?: string; address?: string }[];
}): LanOpenInfo;

/** Whether a link (or just a hostname) falls on these network interfaces */
export function linkOnLan(link: unknown, addresses?: readonly { address?: string }[]): boolean;

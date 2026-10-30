/**
 * `server/lan-open.mjs` 的类型（页面一侧直接 import 它判邀请链接落不落在本机网卡上：`src/editor/LanOpenDialog.tsx`）。
 */

export const LAN_OPEN_PATH: string;
export const LAN_HOST_ENV: string;
export const LAN_HOST_COMMAND: string;

export interface LanAddress {
  name: string;
  address: string;
}

export interface LanOpenInfo {
  /** 编辑器现在绑在局域网上没有（按实际监听地址判） */
  lanHost: boolean;
  port: number | null;
  /** 没绑局域网时告诉用户怎么起 */
  command: string;
  addresses: LanAddress[];
}

/** 这个监听地址对局域网可达吗；判不出来按不可达算 */
export function boundToLan(address: unknown): boolean;

export function lanOpenInfo(o?: {
  bound?: unknown;
  port?: unknown;
  nics?: readonly { name?: string; address?: string }[];
}): LanOpenInfo;

/** 一条链接（或只给主机名）落在这几块网卡上吗 */
export function linkOnLan(link: unknown, addresses?: readonly { address?: string }[]): boolean;

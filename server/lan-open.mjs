/**
 * Information needed by "Open on phone" (semantics in `docs/semantics/mechanism/platforms.md`
 * "Second screen on LAN").
 *
 * Accessing the same project across devices follows the **shared project** route: the host sets
 * the project to "multi-user collaboration + local", and devices on the LAN join via an **invite
 * link** (`<host LAN origin>/editor#invite=<code>`) or project name plus passphrase (contract
 * `docs/plan/c10a-contract.md` section 5; invite code rules are in `server/auth/invite.mjs`). The
 * invite link and QR code are assembled by the page itself (`src/editor/LanOpenDialog.tsx`; the
 * link's origin comes from the document service base, which is the host's LAN address), so this
 * module **does not touch projects or sign any codes**.
 *
 * This module answers only one thing: **whether this machine's editor is currently bound to the
 * LAN, and which LAN addresses it has**. If not bound to the LAN, phones cannot connect even if the
 * invite link is shared, and the UI needs to clarify this first.
 *
 * Whether it is bound is determined by the **actual listening address**, not environment variables:
 * where the editor binds is determined jointly by the `--host` CLI flag (the desktop shell passes
 * `127.0.0.1`, while `npm run dev` passes `0.0.0.0`) and `PROMPTCUT_LAN_HOST` (`lanHostPlugin` in
 * `vite.config.ts`), and the two may even conflict. What the UI needs to state is "whether phones
 * can connect right now", and only the real listening address can accurately tell.
 *
 * Pure function: the NIC list is provided by the caller (`selectInterfaces` in `lan/discovery.mjs`,
 * which has already excluded loopback, link-local, and disabled interfaces), and the listening
 * address is obtained by the caller from `server.httpServer.address()`. Does not read the
 * environment or touch the network; unit tests can use it directly
 * (`server/test/lan-open.test.mjs`).
 */

/** Address where the page requests this info; answers only loopback requests (`vite-plugin-lan-open.ts`) */
export const LAN_OPEN_PATH = '/api/lan-open';

/** Switch for binding editor to LAN (`lanHostPlugin` in `vite.config.ts`); used here only for prompt text */
export const LAN_HOST_ENV = 'PROMPTCUT_LAN_HOST';

/** Tells the user how to start when not bound to LAN (`dev:lan` in `package.json`) */
export const LAN_HOST_COMMAND = 'npm run dev:lan';

const isPort = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;

/**
 * Whether this listening address is reachable from the LAN.
 *
 * - `0.0.0.0`, `::`, empty string: bound to all network interfaces, reachable;
 * - `127.0.0.1`, `::1`, `localhost`, `::ffff:127.*`: bound only to loopback, unreachable;
 * - Other (bound to a specific network interface): reachable.
 *
 * If undetermined (not a string), treated as **unreachable**: better to have the UI give an extra
 * explanation than let the user try an unreachable link.
 *
 * @param {unknown} address
 */
export function boundToLan(address) {
  if (typeof address !== 'string') return false;
  const a = address.trim().toLowerCase();
  if (a === '' || a === '0.0.0.0' || a === '::' || a === '[::]') return true;
  const v4 = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a;
  if (v4 === 'localhost' || v4 === '::1' || v4 === '[::1]') return false;
  return !v4.startsWith('127.');
}

/**
 * Response for a query.
 *
 * - When bound only to loopback, `addresses` is empty: phones cannot connect, so listing addresses
 *   is meaningless; the UI explains how to start according to `command`.
 * - Provides an entry for each NIC: the user selects the subnet that their phone is connected to, as
 *   the software cannot guess; the UI uses it to verify whether the address in the invite link is on
 *   the LAN (the origin of the link is determined by the document service base, which may not be the
 *   one the user wants when the host has multiple NICs).
 *
 * @param {{ bound?: unknown, port?: unknown, nics?: Array<{ name?: string, address?: string }> }} o
 */
export function lanOpenInfo({ bound, port, nics = [] } = {}) {
  const info = {
    lanHost: boundToLan(bound),
    port: isPort(port) ? port : null,
    command: LAN_HOST_COMMAND,
    addresses: [],
  };
  if (!info.lanHost || info.port === null) return info;
  for (const nic of Array.isArray(nics) ? nics : []) {
    if (typeof nic?.address !== 'string' || nic.address === '') continue;
    info.addresses.push({ name: String(nic.name ?? ''), address: nic.address });
  }
  return info;
}

/**
 * Whether an address (can be a full link or just a hostname) falls on these network interfaces.
 * The UI uses this to determine whether the invite link is accessible on the LAN; returns false for
 * anything that cannot be parsed.
 *
 * @param {unknown} link Full link or hostname
 * @param {Array<{ address?: string }>} addresses
 */
export function linkOnLan(link, addresses = []) {
  if (typeof link !== 'string' || link === '') return false;
  let host = link;
  try {
    host = new URL(link).hostname;
  } catch {
    host = link;
  }
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return (Array.isArray(addresses) ? addresses : []).some((a) => String(a?.address ?? '').toLowerCase() === h);
}

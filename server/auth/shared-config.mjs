/**
 * How Node processes obtain credentials for shared projects (contract `docs/plan/auth-contract.md`
 * Section 11).
 *
 * Prerender process, standalone host, and probe read environment variable
 * `PROMPTCUT_SHARED_CONFIG`, which points to a JSON file:
 *   `{ url, projectId, username, deviceId, deviceName, as, password | key, role }`,
 * or an array of such objects (when a standalone host joins multiple projects).
 * - `url`: document service address (`ws://host:8787`, `ws://host:5190/docservice`);
 * - `projectId` can be replaced with `name` (queried once via `shared/lookup` by name);
 * - `deviceId` / `deviceName`: when omitted, uses local device info (`device.mjs`); `as` defaults
 *   to `member`; `role` defaults to `render`;
 * - Provide either `password` or `key` (derived `K`). When `password` is given, derive `K` on first
 *   connection and only cache `K`.
 * - `contentId` (optional): project document id for this shared project (`id` in project JSON).
 *   The push queue and plan publishing of prerender process only accept outputs for this project;
 *   frames of other projects on this machine stay local (`server/push-scope.mjs`); omitting it means
 *   unrestricted (original behavior).
 *
 * If this variable is set, use it to construct proof, connect to document service, and fetch asset
 * tickets via `auth.ticket`; if unset, keep the original behavior: connecting to loopback address
 * uses local identity, falling back to local if connection fails.
 * File contents (passphrase, `K`) are never written to logs or error messages.
 */
import fs from 'node:fs';
import { buildAuthProtocols, lookupProject } from './client.mjs';
import { isProjectId, isUsername, isDeviceId, isDeviceName, isRole, isB64Bytes, KEY_BYTES } from './protocol.mjs';
import { localDeviceInfo } from './device.mjs';
import { migrateHostedText } from './hosted-default.mjs';

export const SHARED_CONFIG_ENV = 'PROMPTCUT_SHARED_CONFIG';

function bad(detail) {
  const err = new Error(`${SHARED_CONFIG_ENV}: ${detail}`);
  err.code = 'bad-shared-config';
  return err;
}

/** Normalizes a config entry; throws if invalid (error messages do not contain passphrase or K) */
export function normalizeEntry(raw, device = localDeviceInfo()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('Each entry must be an object');
  let url;
  try {
    url = new URL(migrateHostedText(raw.url)); // Replace the retired hosted host name with the new one (hosted-default.mjs)
  } catch {
    throw bad('url is not a valid address');
  }
  if (!['ws:', 'wss:'].includes(url.protocol)) throw bad('url must be ws:// or wss://');
  const out = {
    url: raw.url,
    projectId: raw.projectId ?? null,
    name: raw.name ?? null,
    username: raw.username,
    deviceId: raw.deviceId ?? device.deviceId,
    deviceName: raw.deviceName ?? device.deviceName,
    as: raw.as ?? 'member',
    role: raw.role ?? 'render',
    password: raw.password ?? null,
    key: raw.key ?? null,
    conversation: raw.conversation ?? null,
    contentId: raw.contentId ?? null,
    owner: raw.owner ?? null,
  };
  if (out.projectId !== null && !isProjectId(out.projectId)) throw bad('projectId is invalid');
  if (out.projectId === null && (typeof out.name !== 'string' || out.name === '')) throw bad('Needs projectId or name');
  if (!isUsername(out.username)) throw bad('username is invalid');
  if (!isDeviceId(out.deviceId)) throw bad('deviceId must be 16-64 characters of [A-Za-z0-9_-]');
  if (!isDeviceName(out.deviceName)) throw bad('deviceName is invalid');
  if (out.contentId !== null && (typeof out.contentId !== 'string' || out.contentId === '' || out.contentId.length > 256)) throw bad('contentId must be a string of 1-256 characters');
  if (out.as !== 'member' && out.as !== 'creator') throw bad("as must be 'member' or 'creator'");
  if (!isRole(out.role)) throw bad('role must be page / agent / render');
  if (out.key !== null && !isB64Bytes(out.key, KEY_BYTES)) throw bad('key must be 32 bytes of base64url');
  if (out.key === null && (typeof out.password !== 'string' || out.password === '')) throw bad('Needs password or key');
  return out;
}

/**
 * Reads `PROMPTCUT_SHARED_CONFIG`. Returns null if unset; throws if set but unreadable or invalid.
 * @returns {null | Array<ReturnType<typeof normalizeEntry>>}
 */
export function loadSharedConfig(env = process.env) {
  const file = env[SHARED_CONFIG_ENV];
  if (!file) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw bad(`Cannot read the config file (${err?.code ?? 'bad-json'})`);
  }
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) throw bad('The config is an empty array');
  const device = localDeviceInfo(env);
  return list.map((e) => normalizeEntry(e, device));
}

/**
 * A config entry → `protocols()` called before each connection (passed to `createDocEndpoint`,
 * called before creating each session, not on resume).
 * Config contains no transport field: transport is selected automatically by the session layer
 * (`docs/plan/http-transport-contract.md` Section 4.3).
 * For projects given by name, looks up `projectId` once on first call; for those with a passphrase,
 * derives `K` on first call, caches `K`, and discards the passphrase.
 * @param {ReturnType<typeof normalizeEntry>} entry
 * @param {{ fetch?: typeof globalThis.fetch, role?: string }} [options] `role` overrides role in config
 */
export function sharedProtocols(entry, { fetch, role } = {}) {
  let projectId = entry.projectId;
  let key = entry.key;
  let password = entry.password;
  return async function protocols() {
    if (!projectId) projectId = (await lookupProject({ base: entry.url, name: entry.name, fetch })).projectId;
    return buildAuthProtocols({
      base: entry.url,
      projectId,
      username: entry.username,
      deviceId: entry.deviceId,
      deviceName: entry.deviceName,
      as: entry.as,
      ...(key ? { key } : { password }),
      role: role ?? entry.role,
      conversation: entry.conversation ?? undefined,
      owner: entry.owner ?? undefined,
      fetch,
      onKey(k) {
        key = k;
        password = null;
      },
    });
  };
}

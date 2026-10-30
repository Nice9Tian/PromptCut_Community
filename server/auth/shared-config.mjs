/**
 * Node 进程怎么拿共享项目的凭证（契约 `docs/plan/auth-contract.md` 第 11 节）。
 *
 * 预渲染进程、独立主机、探针读环境变量 `PROMPTCUT_SHARED_CONFIG`，它指向一个 JSON 文件：
 *   `{ url, projectId, username, deviceId, deviceName, as, password | key, role }`，
 * 也可以是这样的对象组成的数组（独立主机加入多个项目时）。
 * - `url`：文档服务地址（`ws://host:8787`、`ws://host:5190/docservice`）；
 * - `projectId` 可以换成 `name`（按名字查一次 `shared/lookup`）；
 * - `deviceId` / `deviceName` 不给时用本机设备信息（`device.mjs`）；`as` 缺省 `member`；`role` 缺省 `render`；
 * - `password` 与 `key`（已派生的 `K`）给一个。给 `password` 时第一次连接派生出 `K` 后只缓存 `K`。
 * - `contentId`（可选）：这个共享项目的项目文档 id（项目 JSON 的 `id`）。预渲染进程的推送队列与 plan 发布只认这个项目的产物，
 *   本机别的项目的帧留在本机（`server/push-scope.mjs`）；不写就不限（原来的行为）。
 *
 * 设了这个变量，就用它拼证明、连文档服务，并经 `auth.ticket` 取素材票据；没设就维持原来的做法：
 * 连回环地址时是本机身份，连不上就回落本机。
 * 文件内容（口令、`K`）不进日志、不进错误信息。
 */
import fs from 'node:fs';
import { buildAuthProtocols, lookupProject } from './client.mjs';
import { isProjectId, isUsername, isDeviceId, isDeviceName, isRole, isB64Bytes, KEY_BYTES } from './protocol.mjs';
import { localDeviceInfo } from './device.mjs';
import { migrateHostedText } from './hosted-default.mjs';

export const SHARED_CONFIG_ENV = 'PROMPTCUT_SHARED_CONFIG';

function bad(detail) {
  const err = new Error(`${SHARED_CONFIG_ENV}：${detail}`);
  err.code = 'bad-shared-config';
  return err;
}

/** 规整一条配置；不合格抛错（错误信息里不带口令与 K） */
export function normalizeEntry(raw, device = localDeviceInfo()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('每一项必须是对象');
  let url;
  try {
    url = new URL(migrateHostedText(raw.url)); // 换下来的托管主机名换成新的（hosted-default.mjs）
  } catch {
    throw bad('url 不是合法地址');
  }
  if (!['ws:', 'wss:'].includes(url.protocol)) throw bad('url 必须是 ws:// 或 wss://');
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
  if (out.projectId !== null && !isProjectId(out.projectId)) throw bad('projectId 不合法');
  if (out.projectId === null && (typeof out.name !== 'string' || out.name === '')) throw bad('要 projectId 或 name');
  if (!isUsername(out.username)) throw bad('username 不合法');
  if (!isDeviceId(out.deviceId)) throw bad('deviceId 要 16～64 个 [A-Za-z0-9_-]');
  if (!isDeviceName(out.deviceName)) throw bad('deviceName 不合法');
  if (out.contentId !== null && (typeof out.contentId !== 'string' || out.contentId === '' || out.contentId.length > 256)) throw bad('contentId 要是 1～256 字的字符串');
  if (out.as !== 'member' && out.as !== 'creator') throw bad("as 只能是 'member' 或 'creator'");
  if (!isRole(out.role)) throw bad('role 只能是 page / agent / render');
  if (out.key !== null && !isB64Bytes(out.key, KEY_BYTES)) throw bad('key 必须是 32 字节 base64url');
  if (out.key === null && (typeof out.password !== 'string' || out.password === '')) throw bad('要 password 或 key');
  return out;
}

/**
 * 读 `PROMPTCUT_SHARED_CONFIG`。没设回 null；设了但读不了、格式不对抛错。
 * @returns {null | Array<ReturnType<typeof normalizeEntry>>}
 */
export function loadSharedConfig(env = process.env) {
  const file = env[SHARED_CONFIG_ENV];
  if (!file) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw bad(`读不了配置文件（${err?.code ?? 'bad-json'}）`);
  }
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) throw bad('配置是空数组');
  const device = localDeviceInfo(env);
  return list.map((e) => normalizeEntry(e, device));
}

/**
 * 一条配置 → 每次连之前调的 `protocols()`（交给 `createDocEndpoint`，每次建会话前调、接续时不调）。
 * 配置里没有传输字段：传输由会话层自动选（`docs/plan/http-transport-contract.md` 第 4.3 节）。
 * 按名字给的项目，第一次调用时查一次 `projectId`；给口令的，第一次派生出 `K` 后缓存 `K`、丢掉口令。
 * @param {ReturnType<typeof normalizeEntry>} entry
 * @param {{ fetch?: typeof globalThis.fetch, role?: string }} [options] `role` 覆盖配置里的角色
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

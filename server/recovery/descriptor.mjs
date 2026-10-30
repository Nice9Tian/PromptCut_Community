import { migrateHostedText } from '../auth/hosted-default.mjs';

/** Non-secret file metadata. File roles and addresses never authorize a user. Retired hosted hosts map to their replacement. */
export function serviceIdentity(base) {
  if (typeof base !== 'string' || base.length > 2048) throw new TypeError('协作服务地址无效');
  const u = new URL(migrateHostedText(base));
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new TypeError('协作服务地址无效');
  u.protocol = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
  return u.href.replace(/\/+$/, '');
}
export function parseCollaboration(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 8192) throw new TypeError('协作恢复描述无效');
  if (!Number.isSafeInteger(value.version) || value.version < 1) throw new TypeError('协作恢复版本无效');
  // Preserve future formats verbatim. Callers show unsupported recovery and may save the readable file.
  if (value.version !== 1) return structuredClone(value);
  if (!/^sp_[a-z2-7]{26}$/.test(value.roomId) || !['lan', 'hosted'].includes(value.where)) throw new TypeError('协作房间关联无效');
  const service = serviceIdentity(value.service);
  const out = { version: 1, roomId: value.roomId, service, where: value.where };
  if (value.hint !== undefined) out.hint = serviceIdentity(value.hint);
  return out;
}
export const identityKey = ({ service, roomId, profile = 'default', as, username }) => JSON.stringify([serviceIdentity(service), roomId, profile, as, username]);
export const roomKey = ({ service, roomId }) => JSON.stringify([serviceIdentity(service), roomId]);

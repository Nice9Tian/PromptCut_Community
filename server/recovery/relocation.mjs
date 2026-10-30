/** Durable source fencing for explicit room relocation. No UI or automatic takeover authority.
 * Callers must authenticate the move and obtain its verified final manifest before freezing.
 * Credential-store updates persist before replacing the in-process record, without an async gap.
 */
import { isDeviceId, isProjectId } from '../auth/protocol.mjs';
import { serviceIdentity } from './descriptor.mjs';

export const isRelocationId = value => typeof value === 'string' && /^move_[a-f0-9]{32}$/.test(value);
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = reason => { throw Object.assign(new Error('Room relocation rejected'), { reason }); };
export function relocationTarget(value) {
  if (!value || !['lan', 'hosted'].includes(value.where) || typeof value.service !== 'string') return null;
  let service; try { service = serviceIdentity(value.service); } catch { return null; }
  if (service !== value.service || (value.where === 'lan' ? !isDeviceId(value.deviceId) : value.deviceId !== null)) return null;
  return { service, where: value.where, deviceId: value.deviceId };
}
export function relocationManifest(value) {
  return value && Number.isSafeInteger(value.rev) && value.rev >= 0 && isDigest(value.logDigest) && isDigest(value.assetDigest)
    ? { rev: value.rev, logDigest: value.logDigest, assetDigest: value.assetDigest } : null;
}
const isTxn = isRelocationId, targetOf = relocationTarget, manifestOf = relocationManifest;
function validFence(rec) {
  const r = rec?.relocation;
  return r && r.version === 1 && isProjectId(rec.projectId) && r.roomId === rec.projectId && isTxn(r.txnId)
    && ['staging', 'frozen', 'moved'].includes(r.phase) && Number.isSafeInteger(r.epoch) && r.epoch >= 1
    && Number.isSafeInteger(r.targetEpoch) && r.targetEpoch === r.epoch + 1
    && targetOf(r.target) && manifestOf(r.manifest);
}
/** Absence preserves existing offline LAN behavior; malformed known fences fail closed. */
export function roomUnavailableReason(rec) {
  if (!rec || !Object.hasOwn(rec, 'relocation')) return null;
  if (!validFence(rec)) return 'relocation-damaged';
  return rec.relocation.phase === 'moved' ? 'relocated' : 'relocating';
}
export function freezeRoom({ store, roomId, txnId, expectedEpoch, target, manifest }) {
  const destination = targetOf(target), final = manifestOf(manifest);
  if (!isProjectId(roomId) || !isTxn(txnId) || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1 || !destination || !final) fail('bad-relocation');
  const rec = store.peek(roomId);
  if (!rec) fail('no-project');
  const fence = { version: 1, roomId, txnId, phase: 'frozen', epoch: expectedEpoch, targetEpoch: expectedEpoch + 1, target: destination, manifest: final };
  const unavailable = roomUnavailableReason(rec);
  if (unavailable) {
    if (unavailable === 'relocating' && rec.relocation.phase === 'frozen' && same(rec.relocation, fence)) return structuredClone(fence);
    fail(unavailable === 'relocation-damaged' ? unavailable : 'relocation-conflict');
  }
  const epoch = rec.hostingEpoch ?? 1;
  if (!Number.isSafeInteger(epoch) || epoch !== expectedEpoch || !Number.isSafeInteger(epoch + 1)) fail('relocation-conflict');
  store.update(roomId, draft => { draft.relocation = fence; });
  return structuredClone(fence);
}
/** Only call with an exact result read from the device's trusted authority, never file data. */
export function markRoomMoved({ store, roomId, authority }) {
  const rec = store.peek(roomId), r = rec?.relocation;
  if (!validFence(rec) || !['frozen', 'moved'].includes(r.phase)) fail('relocation-conflict');
  if (authority?.roomId !== roomId || authority.txnId !== r.txnId || authority.epoch !== r.targetEpoch
    || !same(targetOf(authority.target), r.target) || !same(manifestOf(authority.manifest), r.manifest)) fail('relocation-conflict');
  if (r.phase === 'moved') return structuredClone(r);
  const updated = store.update(roomId, draft => { draft.relocation.phase = 'moved'; });
  return structuredClone(updated.relocation);
}

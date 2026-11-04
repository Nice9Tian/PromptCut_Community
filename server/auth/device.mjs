/**
 * Local device information (plan `docs/plan/Master-Execution-Plan.md` section 12.2 "Device name",
 * contract `auth-contract.md` section 5 "Local claim").
 *
 * - `deviceId`: Hostname, platform, architecture, and MAC of the first non-internal network
 *   interface are concatenated and SHA-256 hashed; `pc-` is prepended to the first 22 base64url
 *   characters (satisfying 16-64 `[A-Za-z0-9_-]` characters), used only when first creating a
 *   stable device record;
 * - `deviceName`: Hostname plus the first 4 characters of the hash above, e.g. `DESKTOP-ABC-x7Qe`;
 * - Environment variables `PROMPTCUT_DEVICE_ID` / `PROMPTCUT_DEVICE_NAME` can override (used when
 *   starting two instances on the same machine for testing).
 *
 * When the desktop data directory exists, atomically writes device.json on first run and reads it
 * thereafter; changes in network interface order or running replicas will not change the identity.
 * Development servers without a stable data directory keep the old algorithm; explicit test device
 * IDs do not write this record. Corrupted records are retained and an error is reported.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { isDeviceId, isDeviceName } from './protocol.mjs';
import { tr } from '../i18n.mjs';

function firstMac() {
  for (const list of Object.values(os.networkInterfaces() ?? {})) {
    for (const nic of list ?? []) {
      if (nic && !nic.internal && nic.mac && nic.mac !== '00:00:00:00:00:00') return nic.mac;
    }
  }
  return '';
}

/** @param {Record<string, string | undefined>} [env] */
export function localDeviceInfo(env = process.env) {
  const host = String(os.hostname() || 'host');
  const hash = createHash('sha256').update(`${host}\n${os.platform()}\n${os.arch()}\n${firstMac()}`, 'utf8').digest('base64url');
  const deviceId = isDeviceId(env.PROMPTCUT_DEVICE_ID) ? env.PROMPTCUT_DEVICE_ID : `pc-${hash.slice(0, 22)}`;
  const fallbackName = `${host.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 59) || 'host'}-${hash.slice(0, 4)}`;
  const deviceName = isDeviceName(env.PROMPTCUT_DEVICE_NAME) ? env.PROMPTCUT_DEVICE_NAME : fallbackName;
  if (env.PROMPTCUT_DATA_DIR && !isDeviceId(env.PROMPTCUT_DEVICE_ID)) {
    const file = path.join(env.PROMPTCUT_DATA_DIR, 'device.json');
    const read = () => {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (record.version !== 1 || !isDeviceId(record.deviceId) || !isDeviceName(record.deviceName)) throw new Error(tr("The local device identity record is corrupted; the original record was kept, please restore a backup"));
      return { deviceId: record.deviceId, deviceName: isDeviceName(env.PROMPTCUT_DEVICE_NAME) ? env.PROMPTCUT_DEVICE_NAME : record.deviceName };
    };
    if (fs.existsSync(file)) return read();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify({ version: 1, deviceId, deviceName })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // A hard link publishes the completed file exclusively; a concurrent first launcher keeps its own result.
      try { fs.linkSync(tmp, file); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    } finally { try { fs.unlinkSync(tmp); } catch {} }
    return read();
  }
  return { deviceId, deviceName };
}

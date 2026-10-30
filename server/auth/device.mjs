/**
 * 本机设备信息（计划 `docs/plan/Master-Execution-Plan.md` 第 12.2 节「设备名」、契约 `auth-contract.md` 第 5 节「本机声明」）。
 *
 * - `deviceId`：主机名、平台、架构与第一块非内部网卡的 MAC 拼起来取 sha256，前 22 个 base64url 字符前面加 `pc-`
 *   （满足 16～64 个 `[A-Za-z0-9_-]`），只用于首次创建稳定设备记录；
 * - `deviceName`：主机名加上面那串哈希的前 4 个字符，例如 `DESKTOP-ABC-x7Qe`；
 * - 环境变量 `PROMPTCUT_DEVICE_ID` / `PROMPTCUT_DEVICE_NAME` 可以覆盖（同一台机器上起两个实例做测试时用）。
 *
 * 桌面数据目录存在时，首次原子写入 device.json，以后读取它，网卡顺序或运行副本变化不会改变身份。
 * 没有稳定数据目录的开发服务保持旧算法；显式测试设备 ID 不写此记录。损坏记录保留并报错。
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { isDeviceId, isDeviceName } from './protocol.mjs';

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
      if (record.version !== 1 || !isDeviceId(record.deviceId) || !isDeviceName(record.deviceName)) throw new Error('本机设备身份记录损坏；保留原记录，请恢复备份');
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

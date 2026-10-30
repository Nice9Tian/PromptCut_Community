import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';

/** 仅TMP临时CA/各角色独立叶证书；不读生产钥匙。 */
export function assetWiringPki(dir, extraNames = []) {
  const openssl = process.env.OPENSSL ?? (process.platform === 'win32' ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin/openssl.exe') : 'openssl');
  const run = args => { const result = spawnSync(openssl, args, { cwd: dir, windowsHide: true, stdio: 'ignore', timeout: 30000 }); if (result.status !== 0) throw new Error('temporary-pki-generation-failed'); };
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Temporary asset wiring CA', '-keyout', 'ca.key', '-out', 'ca.crt']);
  fs.writeFileSync(path.join(dir, 'extensions.txt'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n');
  const ca = fs.readFileSync(path.join(dir, 'ca.crt'));
  const result = { ca };
  for (const name of ['account', 'doc', 'asset', 'wrong', ...extraNames]) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(name) || result[name]) throw new Error('temporary-pki-name');
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`]);
    run(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'extensions.txt', '-out', `${name}.crt`]);
    const cert = fs.readFileSync(path.join(dir, `${name}.crt`));
    result[name] = { key: fs.readFileSync(path.join(dir, `${name}.key`)), cert, ca, fingerprint256: new X509Certificate(cert).fingerprint256 };
  }
  return result;
}

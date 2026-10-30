/**
 * Start an isolated cloud directory on a second machine. No production service, account or firewall changes.
 *
 * PC_REOPEN_WAN_SERVICE=<https://host/hosted>: use an already deployed hosted service instead of starting a temporary
 * gateway (no tunnel, no SSH proxy). The WAN peer still runs on PC_REOPEN_SSH_HOST and reaches the room through that address.
 */
import '../lib/no-user-dirs.mjs';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import net from 'node:net';

export async function startWanProbe() {
  const host = process.env.PC_REOPEN_SSH_HOST;
  const key = process.env.PC_REOPEN_SSH_KEY;
  if (!host || !key) throw new Error('Set PC_REOPEN_SSH_HOST and PC_REOPEN_SSH_KEY for an authorized isolated test host');
  const sshArgs = ['-i', key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host];
  const run = command => execFileSync('ssh', [...sshArgs, command], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  const dir = run('mktemp -d /tmp/pc-reopen-wan.XXXXXX').trim();
  if (!/^\/tmp\/pc-reopen-wan\.[A-Za-z0-9]+$/.test(dir)) throw new Error('unexpected isolated remote directory');
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reopen-wan-upload-'));
  const archive = path.join(local, 'bundle.tar');
  execFileSync('tar', ['-cf', archive, 'server', 'cloud/scripts/probes/reopen-wan-peer.mjs', 'scripts/probes/reopen-public-tunnel.mjs', 'scripts/lib/no-user-dirs.mjs', 'scripts/lib/user-dirs.mjs'], { windowsHide: true, timeout: 30000 });
  execFileSync('scp', ['-i', key, '-o', 'BatchMode=yes', archive, `${host}:${dir}/bundle.tar`], { windowsHide: true, stdio: 'pipe', timeout: 30000 });
  run(`tar -xf ${dir}/bundle.tar -C ${dir}`);
  const remote = () => spawn('ssh', [...sshArgs, `cd ${dir} && node scripts/probes/reopen-wan-peer.mjs`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const deployed = (process.env.PC_REOPEN_WAN_SERVICE || '').replace(/\/+$/, '');
  if (deployed) {
    if (!/^https?:\/\//.test(deployed)) throw new Error('PC_REOPEN_WAN_SERVICE must be an http(s) address');
    const health = async () => (await fetch(`${deployed}/hosting/healthz`, { signal: AbortSignal.timeout(10000) })).json();
    if ((await health()).role !== 'hosting') throw new Error('deployed service has no hosting registry');
    return {
      service: deployed, remoteDirectory: dir, gatewayPid: null, publicHttp: true, path: 'deployed-service',
      hosting: { online: async () => { try { return (await health()).online > 0; } catch { return false; } } },
      peer: config => new Promise((resolve, reject) => {
        const child = remote(); let out = ''; child.stdout.on('data', b => { out += b; }); child.stderr.resume();
        const timer = setTimeout(() => { child.kill(); reject(new Error('WAN peer timed out; secrets omitted')); }, 30000);
        child.once('exit', code => { clearTimeout(timer); try { const result = JSON.parse(out.trim()); if (code || !result.ok) throw new Error(); resolve(result); } catch { reject(new Error('WAN peer failed; secrets omitted')); } });
        child.stdin.end(JSON.stringify({ ...config, op: 'member', service: deployed, dir }) + '\n');
      }),
      async close() {},
    };
  }
  const gateway = remote(); let stopped = false;
  const gatewayLines = readline.createInterface({ input: gateway.stdout }); gateway.stderr.resume();
  const launched = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('isolated WAN gateway startup timeout')), 20000);
    gatewayLines.once('line', line => { clearTimeout(timer); try { resolve(JSON.parse(line)); } catch { reject(new Error('isolated WAN gateway failed')); } });
    gateway.once('exit', code => { clearTimeout(timer); reject(new Error(`isolated WAN gateway exited (${code})`)); });
  });
  gateway.stdin.write(JSON.stringify({ op: 'gateway', dir }) + '\n');
  const address = await launched;
  const ip = host.split('@').at(-1); let service = `http://${ip}:${address.port}`, proxy, publicHttp = true, publicTunnel;
  const publicBinary = process.env.PC_REOPEN_PUBLIC_TUNNEL_BIN;
  if (publicBinary) {
    publicTunnel = spawn('ssh', [...sshArgs, `cd ${dir} && node scripts/probes/reopen-public-tunnel.mjs`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: publicTunnel.stdout }); publicTunnel.stderr.resume();
    const endpoint = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Temporary public ingress startup timeout')), 30000);
      lines.once('line', line => { clearTimeout(timer); try { resolve(JSON.parse(line)); } catch { reject(new Error('Temporary public ingress failed')); } });
      publicTunnel.once('exit', () => { clearTimeout(timer); reject(new Error('Temporary public ingress exited')); });
    });
    publicTunnel.stdin.write(JSON.stringify({ dir, binary: publicBinary, port: address.port }) + '\n');
    try {
      const result = await endpoint;
      if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(result.url)) throw new Error('Invalid temporary public URL');
      service = result.url;
      let healthy = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        try { healthy = (await fetch(`${service}/hosting/healthz`, { signal: AbortSignal.timeout(3000) })).ok; if (healthy) break; } catch {}
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!healthy) throw new Error('Temporary HTTPS gateway not reachable from original device');
    } catch (e) { publicTunnel.stdin.end(); gateway.stdin.end(); throw e; }
  }
  try {
    const r = await fetch(`${service}/hosting/healthz`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('isolated WAN gateway is not publicly reachable');
  } catch {
    publicHttp = false;
    const reserve = net.createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r));
    const port = reserve.address().port; await new Promise(r => reserve.close(r));
    proxy = spawn('ssh', ['-i', key, '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `127.0.0.1:${port}:127.0.0.1:${address.port}`, host], { windowsHide: true, stdio: 'ignore' });
    service = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (proxy.exitCode !== null) break;
      try { ready = (await fetch(`${service}/hosting/healthz`, { signal: AbortSignal.timeout(1000) })).ok; if (ready) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    if (!ready) { proxy.kill(); gateway.stdin.end(); throw new Error('isolated SSH test proxy failed'); }
  }
  return {
    service, remoteDirectory: dir, gatewayPid: address.pid, publicHttp, path: publicHttp && publicTunnel ? 'temporary-public-https-tunnel' : publicHttp ? 'public-http' : 'existing-ssh-test-proxy',
    hosting: { online: async () => { try { const r = await fetch(`${service}/hosting/healthz`, { signal: AbortSignal.timeout(2000) }); return (await r.json()).online > 0; } catch { return false; } } },
    peer: config => new Promise((resolve, reject) => {
      const child = remote(); let out = ''; child.stdout.on('data', b => { out += b; }); child.stderr.resume();
      const timer = setTimeout(() => { child.kill(); reject(new Error('isolated WAN peer timed out; secrets omitted')); }, 30000);
      child.once('exit', code => { clearTimeout(timer); try { const result = JSON.parse(out.trim()); if (code || !result.ok) throw new Error(); resolve(result); } catch { reject(new Error('isolated WAN peer failed; secrets omitted')); } });
      child.stdin.end(JSON.stringify({ ...config, op: 'member', service: publicHttp ? service : `http://127.0.0.1:${address.port}`, dir }) + '\n');
    }),
    async close() {
      if (stopped) return; stopped = true;
      const exited = new Promise(r => gateway.once('exit', r)); gateway.stdin.end();
      await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
      if (gateway.exitCode === null) gateway.kill();
      if (proxy && proxy.exitCode === null) proxy.kill();
      if (publicTunnel && publicTunnel.exitCode === null) {
        const done = new Promise(r => publicTunnel.once('exit', r)); publicTunnel.stdin.end();
        await Promise.race([done, new Promise(r => setTimeout(r, 5000))]);
        if (publicTunnel.exitCode === null) publicTunnel.kill();
      }
      // Keep the isolated evidence directory and protected member vault for review; no other remote paths touched.
    },
  };
}

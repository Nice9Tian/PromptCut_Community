/** Owned, temporary test HTTPS ingress. No account, DNS, service installation or host network changes. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const input = readline.createInterface({ input: process.stdin });
const config = JSON.parse(await new Promise(r => input.once('line', r)));
if (!/^\/tmp\/pc-reopen-wan\.[A-Za-z0-9]+$/.test(config.dir) || !/^\/tmp\/pc-reopen-public\.[A-Za-z0-9]+\/cloudflared$/.test(config.binary)
  || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid isolated tunnel configuration');
const configFile = path.join(config.dir, 'quick-tunnel.yml'); fs.writeFileSync(configFile, '{}\n', { mode: 0o600 });
const child = spawn(config.binary, ['tunnel', '--config', configFile, '--origincert', path.join(config.dir, 'no-account.pem'),
  '--credentials-file', path.join(config.dir, 'no-account.json'), '--no-autoupdate', '--metrics', '127.0.0.1:0',
  '--grace-period', '1s', '--protocol', 'http2', '--edge-ip-version', '4', '--url', `http://127.0.0.1:${config.port}`],
{ windowsHide: true, cwd: config.dir, stdio: ['ignore', 'pipe', 'pipe'] });
let published = false, stopped = false;
const read = b => {
  // Never publish raw daemon logs: request failures can contain query tickets.
  const url = b.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
  if (url && !published) { published = true; console.log(JSON.stringify({ url, pid: child.pid })); }
};
child.stdout.on('data', read); child.stderr.on('data', read);
const stop = async () => {
  if (stopped) return; stopped = true;
  if (child.exitCode === null && child.signalCode === null) { const exit = new Promise(r => child.once('exit', r)); child.kill(); await exit; }
};
input.once('close', () => { void stop().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
child.once('exit', () => { if (!stopped) { console.error('Isolated temporary ingress exited; daemon details withheld'); process.exitCode = 1; input.close(); } });

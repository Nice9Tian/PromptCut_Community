/** External member on a machine that can only dial out: authenticate into a reopened room through the
 * temporary public entry, read ticketed assets, then make one edit and read the project back.
 * Nothing secret is passed on the command line or printed. The edit comes last on purpose: the host
 * waits for it, so it must not arrive while the assets are still being read.
 *
 * Held run, the password never leaves this process:
 *   node scripts/probes/reopen-wan-member.mjs --hold --dir <owned dir> --to <host public key>
 *     prints {phase:"sealed", sealed} for the host, then waits for <dir>/run.json
 *     {"service","room","expected","edit","assetHash","assetSize"} and runs once.
 * Two-step run, the password stays in <dir>/member-secret.json (reopen-sealed.mjs member-secret):
 *   node scripts/probes/reopen-wan-member.mjs --dir <owned dir> --service <url> --room <id> --expected <project name>
 *     [--asset-hash <sha256> --asset-size <bytes>] [--edit <new project name>]
 * Either way the product's own protected device record is written under <dir>/member.
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ownedMemberSecret, seal } from './reopen-sealed.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const username = 'wan-member';
assert(arg('--dir'), '--dir <owned directory> is required');
const dir = path.resolve(arg('--dir')); fs.mkdirSync(dir, { recursive: true });
let password, run;
if (process.argv.includes('--hold')) {
  const to = arg('--to'), holdMs = Number(arg('--hold-minutes') ?? 180) * 60000, runFile = path.join(dir, 'run.json');
  assert(to, '--to <host public key> is required with --hold');
  assert(!fs.existsSync(runFile), 'run.json of an earlier run is still in this directory');
  password = randomBytes(32).toString('base64url');
  console.log(JSON.stringify({ phase: 'sealed', username, sealed: seal(to, { username, password }), expects: runFile }));
  for (const until = Date.now() + holdMs; !fs.existsSync(runFile);) { if (Date.now() > until) { console.log(JSON.stringify({ ok: false, step: 'hold', error: 'no run.json in time' })); process.exit(1); } await new Promise(r => setTimeout(r, 1000)); }
  await new Promise(r => setTimeout(r, 300)); // let the writer finish
  const j = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  run = { service: j.service, roomId: j.room, expected: j.expected, edit: j.edit, asset: j.assetHash ? { hash: j.assetHash, size: Number(j.assetSize) } : undefined };
} else {
  password = ownedMemberSecret(dir, username).password;
  run = { service: arg('--service'), roomId: arg('--room'), expected: arg('--expected'), edit: arg('--edit'), asset: arg('--asset-hash') ? { hash: arg('--asset-hash'), size: Number(arg('--asset-size')) } : undefined };
}
const { service, roomId, expected, edit, asset } = run;
assert(service && roomId && expected, 'service, room and expected are required');
assert(/^https:\/\/[a-z0-9.-]+$/.test(service), 'service must be an https origin');
assert(/^[A-Za-z0-9_-]{6,64}$/.test(roomId) && (!asset || (/^[0-9a-f]{64}$/.test(asset.hash) && Number.isInteger(asset.size))), 'room or asset parameters are malformed');
const peerScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reopen-wan-peer.mjs');

/** One connection of the existing WAN peer. It reads its configuration, password included, from stdin only. */
async function connect(step, more) {
  const peer = spawn(process.execPath, [peerScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = ''; peer.stdout.on('data', b => { out += b; }); peer.stderr.on('data', b => { err += b; });
  const timer = setTimeout(() => peer.kill(), 120000);
  peer.stdin.end(JSON.stringify({ op: 'member', dir, service, roomId, password, expected, ...more }) + '\n');
  const exitCode = await new Promise(resolve => peer.once('exit', resolve)); clearTimeout(timer);
  let result; try { result = JSON.parse(out.trim()); } catch { result = null; }
  if (exitCode === 0 && result?.ok) return result;
  // On failure the peer names only the step it was in.
  console.log(JSON.stringify({ ok: false, step, stage: /"stage":"([a-z-]{1,40})"/.exec(err)?.[1] ?? null, error: 'external member failed; secrets omitted', service, exitCode }));
  process.exit(1);
}

const read = asset ? await connect('read-assets', { asset }) : null;
const last = edit ? await connect('edit', { edit }) : read ?? await connect('open', {});
console.log(JSON.stringify({ ok: true, roomId: last.roomId, username: last.username, role: last.role, service, revBeforeEdit: last.rev, edit: edit ?? null,
  assets: read?.assets ?? [], connections: [read, edit ? last : null].filter(Boolean).length || 1, restoredDeviceIdentityOnLastConnection: last.restoredDeviceIdentity,
  passwordKeptInMemoryOnly: process.argv.includes('--hold'), node: process.version }));

// The rule for starting Chrome without its own sandbox, and the advice given when the sandbox is
// why Chrome did not start (server/chrome-sandbox.mjs).
// Run: node --test server/test/chrome-sandbox.test.mjs
//
//   CS-1  noSandboxReason: Linux only; explicit variable, root, container; `=0` forbids it;
//         `explicitOnly` leaves only the explicit variable
//   CS-2  sandboxArgsFor: the argument and one log line when the sandbox is off; for content the
//         app did not write, root / container do not turn it off, and the log line says what an
//         explicit opt-out means
//   CS-3  Recognising a sandbox failure and adding what to do about it; other errors are untouched
//   CS-4  Every place in server/ that launches Chrome with puppeteer goes through this module
//         (a new launch site that forgets it fails here)
//   CS-5  The export bakery still exports noSandboxReason, and its arguments follow the rule
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { noSandboxReason, sandboxArgsFor, isSandboxFailure, sandboxFailureHint, withSandboxHint } from '../chrome-sandbox.mjs';

const SERVER = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const linux = (over = {}) => ({ platform: 'linux', env: {}, getuid: () => 1000, exists: () => false, ...over });

test('CS-1 when Chrome may run without its sandbox', () => {
  assert.equal(noSandboxReason(linux()), null);
  assert.equal(noSandboxReason(linux({ env: { PROMPTCUT_CHROME_NO_SANDBOX: '1' } })), 'env');
  assert.equal(noSandboxReason(linux({ getuid: () => 0 })), 'root');
  assert.equal(noSandboxReason(linux({ exists: (p) => p === '/.dockerenv' })), 'container');
  assert.equal(noSandboxReason(linux({ exists: (p) => p === '/run/.containerenv' })), 'container');
  // =0 forbids it even as root or in a container
  assert.equal(noSandboxReason(linux({ env: { PROMPTCUT_CHROME_NO_SANDBOX: '0' }, getuid: () => 0, exists: () => true })), null);
  // Other values of the variable mean nothing
  assert.equal(noSandboxReason(linux({ env: { PROMPTCUT_CHROME_NO_SANDBOX: 'true' } })), null);
  // Never on Windows or macOS, whatever the variable says
  for (const platform of ['win32', 'darwin']) {
    assert.equal(noSandboxReason(linux({ platform, env: { PROMPTCUT_CHROME_NO_SANDBOX: '1' }, getuid: () => 0, exists: () => true })), null);
  }
  // A getuid or exists that throws counts as "no"
  assert.equal(noSandboxReason(linux({ getuid: () => { throw new Error('x'); }, exists: () => { throw new Error('y'); } })), null);

  // explicitOnly: being root or in a container is not enough
  assert.equal(noSandboxReason(linux({ explicitOnly: true, getuid: () => 0, exists: () => true })), null);
  assert.equal(noSandboxReason(linux({ explicitOnly: true, env: { PROMPTCUT_CHROME_NO_SANDBOX: '1' } })), 'env');
});

test('CS-2 the launch argument and the log line', () => {
  const logged = [];
  const log = (line) => logged.push(line);
  assert.deepEqual(sandboxArgsFor('the audio mix', linux({ log })), []);
  assert.deepEqual(logged, [], 'nothing is logged while the sandbox stays on');

  assert.deepEqual(sandboxArgsFor('the audio mix', linux({ log, getuid: () => 0 })), ['--no-sandbox']);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^Chrome for the audio mix is starting with --no-sandbox \(running as root\)\.$/);

  // Content the app did not write: root and container leave the sandbox on
  logged.length = 0;
  assert.deepEqual(sandboxArgsFor('the custom measurement sandbox', linux({ log, untrustedContent: true, getuid: () => 0, exists: () => true })), []);
  assert.deepEqual(logged, []);
  // The explicit variable turns it off, and the log line says what that gives up
  assert.deepEqual(sandboxArgsFor('the custom measurement sandbox', linux({ log, untrustedContent: true, env: { PROMPTCUT_CHROME_NO_SANDBOX: '1' } })), ['--no-sandbox']);
  assert.match(logged[0], /the custom measurement sandbox .*--no-sandbox \(PROMPTCUT_CHROME_NO_SANDBOX=1\)\. It loads content this app did not write/);

  // A logger that throws does not stop the launch
  assert.deepEqual(sandboxArgsFor('x', linux({ log: () => { throw new Error('log failed'); }, getuid: () => 0 })), ['--no-sandbox']);
  // Nothing on Windows
  assert.deepEqual(sandboxArgsFor('x', linux({ log, platform: 'win32', env: { PROMPTCUT_CHROME_NO_SANDBOX: '1' } })), []);
});

// What puppeteer throws on Ubuntu 23.10+ without an AppArmor profile for its Chrome
const UBUNTU_FAILURE = `Failed to launch the browser process:  Code: null

stderr:
[461233:461233:1117/071500.123456:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md. Otherwise see https://chromium.googlesource.com/chromium/src/+/main/docs/linux/suid_sandbox_development.md for more information on developing with the (older) SUID sandbox. If you want to live dangerously and need an immediate workaround, you can try using --no-sandbox.

TROUBLESHOOTING: https://pptr.dev/troubleshooting
`;

test('CS-3 a sandbox failure gets the reason and the fix; other errors are left alone', () => {
  assert.equal(isSandboxFailure(new Error(UBUNTU_FAILURE)), true);
  assert.equal(isSandboxFailure(new Error('Running as root without --no-sandbox is not supported. See https://crbug.com/638180.')), true);
  assert.equal(isSandboxFailure(UBUNTU_FAILURE), true, 'a plain string works too');
  for (const other of ['Could not find Chrome (ver. 152.0.7977.75).', 'Navigation timeout of 30000 ms exceeded', 'The browser is already running for /x/profile', '', undefined]) {
    assert.equal(isSandboxFailure(other === undefined ? undefined : new Error(other)), false, String(other));
  }

  const original = new Error(UBUNTU_FAILURE);
  const explained = withSandboxHint(original);
  assert.notEqual(explained, original);
  assert.equal(explained.cause, original);
  assert.equal(explained.sandboxFailure, true);
  assert.match(explained.message, /^No usable sandbox! Chrome could not set up its sandbox\. /, 'starts with Chrome\'s own first sentence and nothing else of its text');
  assert.match(withSandboxHint(new Error('Running as root without --no-sandbox is not supported. See https://crbug.com/638180.')).message, /^Running as root without --no-sandbox is not supported\. Chrome could not/);
  assert.match(explained.message, /AppArmor profile that grants `userns`/);
  assert.match(explained.message, /apparmor_parser -r/);
  assert.match(explained.message, /PROMPTCUT_CHROME_NO_SANDBOX=1/);
  assert.doesNotMatch(explained.message, /TROUBLESHOOTING|live dangerously/, 'Chrome\'s own advice to pass --no-sandbox is not repeated');
  assert.doesNotMatch(explained.message, /chromium\.googlesource\.com/);
  assert.ok(explained.message.length < 700, `short enough to read: ${explained.message.length}`);

  // For content the app did not write, the opt-out comes with what it gives up
  assert.match(withSandboxHint(original, { untrustedContent: true }).message, /removes the isolation around content this app did not write, so prefer the profile/);
  assert.doesNotMatch(sandboxFailureHint(), /removes the isolation/);

  const other = new Error('Could not find Chrome (ver. 152.0.7977.75).');
  assert.equal(withSandboxHint(other), other, 'not a sandbox failure: the same error object');
});

/** Every .mjs / .ts file under server/ outside the tests */
function serverSources(dir = SERVER, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'test' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) serverSources(full, out);
    else if (/\.(mjs|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('CS-4 every puppeteer launch under server/ follows the rule', () => {
  // Files that launch a Chrome through puppeteer's launcher. The hosted browser
  // (server/web/hosted/session.mjs) spawns its own process and takes its sandbox arguments from
  // the deployer through an allowlist, so it is not in this list by construction.
  const launchers = serverSources().filter((file) => /\b(?:puppeteer|pptr)\.launch\(/.test(fs.readFileSync(file, 'utf8')));
  const names = launchers.map((file) => path.relative(SERVER, file).split(path.sep).join('/')).sort();
  assert.deepEqual(names, ['audio-sandbox.mjs', 'bakery/audio-mix.mjs', 'bakery/chrome.mjs', 'web/browser.mjs'],
    'a new launch site: decide its sandbox rule in server/chrome-sandbox.mjs, then add it here');
  for (const file of launchers) {
    const src = fs.readFileSync(file, 'utf8');
    const name = path.relative(SERVER, file);
    assert.match(src, /from ['"](?:\.\.?\/)+chrome-sandbox\.mjs['"]/, `${name} imports the shared rule`);
    assert.match(src, /sandboxArgsFor\(|noSandboxReason\(/, `${name} takes its sandbox argument from the rule`);
    assert.match(src, /withSandboxHint\(/, `${name} explains a sandbox failure`);
  }
  // The two that load content the app did not write ask for the stricter half of the rule
  for (const rel of ['audio-sandbox.mjs', 'web/browser.mjs']) {
    assert.match(fs.readFileSync(path.join(SERVER, rel), 'utf8'), /sandboxArgsFor\([^)]*untrustedContent: true/, `${rel} only honours the explicit opt-out`);
  }
});

test('CS-5 the export bakery keeps exporting noSandboxReason and follows it', async () => {
  const bakery = await import('../bakery/chrome.mjs');
  assert.equal(bakery.noSandboxReason, noSandboxReason, 'the same function, re-exported');
  assert.ok(bakery.chromeLaunchArgs(linux({ getuid: () => 0 })).includes('--no-sandbox'));
  assert.ok(!bakery.chromeLaunchArgs(linux()).includes('--no-sandbox'));
  assert.ok(!bakery.chromeLaunchArgs(linux({ platform: 'win32', env: { PROMPTCUT_CHROME_NO_SANDBOX: '1' } })).includes('--no-sandbox'));
});

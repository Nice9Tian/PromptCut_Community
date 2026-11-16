/**
 * One rule for starting Chrome without its own sandbox, shared by every place that launches one,
 * and what to say when the sandbox is the reason Chrome did not start.
 *
 * # Why this exists
 *
 * Chrome's sandbox needs unprivileged user namespaces. Three situations take them away on Linux:
 * running as root (Chrome refuses to sandbox itself there), running in a container, and Ubuntu
 * 23.10 and later, where AppArmor only lets programs with a profile create them
 * (`kernel.apparmor_restrict_unprivileged_userns = 1`). Ubuntu ships such a profile for Google
 * Chrome in /opt/google/chrome, but not for the Chrome for Testing / chrome-headless-shell that
 * puppeteer downloads, so on a stock Ubuntu machine every launch dies with "No usable sandbox!".
 *
 * The fix that keeps the sandbox is an AppArmor profile granting `userns` to that Chrome. Running
 * with `--no-sandbox` is the fallback.
 *
 * # The rule
 *
 * `noSandboxReason()` gives the reason Chrome may run without its sandbox, or null:
 *   - `env`: `PROMPTCUT_CHROME_NO_SANDBOX=1`, asked for explicitly (`=0` forbids it outright);
 *   - `root` / `container`: Chrome cannot sandbox itself there at all.
 *
 * Where it applies depends on what the Chrome loads:
 *   - **This app's own pages** (frame export, the audio mix page): any of the three reasons.
 *   - **Content this app did not write** (the custom measurement sandbox, which runs code written
 *     by the user or the model; the in-app web browser, which loads arbitrary sites): only the
 *     explicit `env`. Being root or in a container must not quietly remove the one thing that
 *     isolates that content from the machine.
 *
 * Every launch without the sandbox writes a log line saying so. Only Linux is ever affected:
 * nothing is added on Windows or macOS.
 *
 * Standard library only; safe to import from anything on the server side.
 */
import fs from 'node:fs';

/**
 * Whether Chrome may be started without its sandbox, and why (`docs/plan/hosted-render-contract.md`
 * section 7.3). Evaluated only on **Linux**: never on Windows or macOS, keeping desktop app launch
 * arguments identical to before. Returns the reason, otherwise null:
 *   - `PROMPTCUT_CHROME_NO_SANDBOX=1` (explicitly requested) → `env`; set to `0` to never allow it;
 *   - the process runs as root (`getuid() === 0`) → `root`;
 *   - inside a container (`/.dockerenv` or `/run/.containerenv` exists) → `container`.
 * With `explicitOnly`, only the first counts (see "The rule" above).
 * Arguments can all be injected, so unit tests do not need to switch platforms.
 */
export function noSandboxReason({ platform = process.platform, env = process.env, getuid = process.getuid?.bind(process), exists = fs.existsSync, explicitOnly = false } = {}) {
  if (platform !== 'linux') return null;
  if (env.PROMPTCUT_CHROME_NO_SANDBOX === '0') return null;
  if (env.PROMPTCUT_CHROME_NO_SANDBOX === '1') return 'env';
  if (explicitOnly) return null;
  let uid = null;
  try { uid = typeof getuid === 'function' ? getuid() : null; } catch { uid = null; }
  if (uid === 0) return 'root';
  try { if (exists('/.dockerenv') || exists('/run/.containerenv')) return 'container'; } catch { /* If unable to check, assume not in a container */ }
  return null;
}

/**
 * The sandbox part of one Chrome launch: `['--no-sandbox']` or `[]`, with a log line when it is off.
 *
 * @param {string} what Which Chrome this is, for the log line ("the audio mix", "the in-app web browser")
 * @param {object} [o]
 * @param {boolean} [o.untrustedContent] This Chrome loads content the app did not write: only the
 *   explicit environment variable turns the sandbox off, and the log line says what that means
 * @param {(line: string) => void} [o.log]
 * Remaining fields are passed to `noSandboxReason` (for unit tests).
 */
export function sandboxArgsFor(what, { untrustedContent = false, log = (line) => console.warn(line), ...deps } = {}) {
  const reason = noSandboxReason({ ...deps, explicitOnly: untrustedContent });
  if (!reason) return [];
  const why = { env: 'PROMPTCUT_CHROME_NO_SANDBOX=1', root: 'running as root', container: 'running in a container' }[reason];
  try {
    log(`Chrome for ${what} is starting with --no-sandbox (${why}).`
      + (untrustedContent ? ' It loads content this app did not write, and with the sandbox off nothing but Chrome itself stands between that content and this machine.' : ''));
  } catch { /* A failing logger does not stop the launch */ }
  return ['--no-sandbox'];
}

/** Whether an error from launching Chrome says its sandbox could not be set up */
export function isSandboxFailure(err) {
  return /No usable sandbox|zygote_host_impl_linux|Running as root without --no-sandbox|setuid sandbox .*(not|isn't)|sandbox_linux\.cc/i.test(String(err?.message ?? err));
}

/**
 * What to do about a sandbox failure, as one paragraph for an error message.
 * @param {{ untrustedContent?: boolean }} [o]
 */
export function sandboxFailureHint({ untrustedContent = false } = {}) {
  return 'Chrome could not set up its sandbox. On Ubuntu 23.10 and later this is AppArmor refusing unprivileged user namespaces'
    + ' to the Chrome that puppeteer downloaded (it only allows programs that have a profile).'
    + ' To fix it and keep the sandbox, install an AppArmor profile that grants `userns` to that Chrome, in the same form as'
    + ' Ubuntu\'s own /etc/apparmor.d/chrome, and load it with `sudo apparmor_parser -r`.'
    + (untrustedContent
      ? ' Setting PROMPTCUT_CHROME_NO_SANDBOX=1 starts it without the sandbox instead; that removes the isolation around content this app did not write, so prefer the profile.'
      : ' Setting PROMPTCUT_CHROME_NO_SANDBOX=1 starts it without the sandbox instead.');
}

/**
 * If `err` is a sandbox failure, an error whose message ends with what to do about it (the
 * original is kept as `cause`); otherwise `err` itself. Chrome's own text is long and ends by
 * recommending `--no-sandbox`, so only its opening "No usable sandbox!" is kept in front of the
 * advice.
 * @param {unknown} err
 * @param {{ untrustedContent?: boolean }} [o]
 */
export function withSandboxHint(err, o = {}) {
  if (!isSandboxFailure(err)) return err;
  const original = String(err?.message ?? err);
  const short = /No usable sandbox!|Running as root without --no-sandbox is not supported\.?/i.exec(original)?.[0]
    ?? original.split('\n')[0].replace(/^\[[^\]]*\]\s*/, '').slice(0, 200);
  return Object.assign(new Error(`${short} ${sandboxFailureHint(o)}`, { cause: err }), { sandboxFailure: true });
}

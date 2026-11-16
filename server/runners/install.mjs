import { tr } from "../i18n.mjs";
// Native installers: no separate Node.js/npm dependency. Each vendor publishes the same installer
// twice: a PowerShell script for Windows and a shell script for macOS and Linux.
// `shell` is the interpreter the vendor's shell script asks for in its first line.
const PLANS = {
  claude: { label: 'Claude Code', url: 'https://claude.ai/install.ps1', posixUrl: 'https://claude.ai/install.sh', shell: 'bash' },
  codex: { label: 'Codex', url: 'https://chatgpt.com/codex/install.ps1', posixUrl: 'https://chatgpt.com/codex/install.sh', shell: 'sh' },
  agy: { label: 'Antigravity', url: 'https://antigravity.google/cli/install.ps1', posixUrl: 'https://antigravity.google/cli/install.sh', shell: 'bash' },
};
/** Platforms the vendors' shell installers support (they check `uname` themselves and refuse the rest) */
const POSIX_PLATFORMS = ['linux', 'darwin'];
// `platform` can be passed in (as with `resolveCli` and `cliCommand`), so tests on any system can
// take either branch.
/**
 * How to install a provider's CLI on this platform, or null when there is no one-click install
 * (unknown provider, or a platform the vendors publish no installer for).
 * `script` says which kind `url` is: `powershell` (Windows) or `sh` (macOS, Linux); for `sh`,
 * `shell` is the interpreter to run it with.
 */
export function installPlanFor(id, { platform = process.platform } = {}) {
  const plan = Object.hasOwn(PLANS, id) ? PLANS[id] : null;
  if (!plan) return null;
  const command = 'Download and install from the official source (no Node.js or npm needed)';
  if (platform === 'win32') return { id, label: plan.label, url: plan.url, script: 'powershell', command };
  if (POSIX_PLATFORMS.includes(platform)) return { id, label: plan.label, url: plan.posixUrl, script: 'sh', shell: plan.shell, command };
  return null;
}
export function manualHintFor(id, { platform = process.platform } = {}) {
  if (id === 'api') return tr("Direct API does not require installing a CLI.");
  return platform !== 'win32' && !POSIX_PLATFORMS.includes(platform) ? tr("One-click install supports Windows, macOS and Linux.") : tr("Unknown AI service.");
}

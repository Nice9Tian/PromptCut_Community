import { tr } from "../i18n.mjs";
// Native installers: no separate Node.js/npm dependency.
const PLANS = {
  claude: { label: 'Claude Code', url: 'https://claude.ai/install.ps1' },
  codex: { label: 'Codex', url: 'https://chatgpt.com/codex/install.ps1' },
  agy: { label: 'Antigravity', url: 'https://antigravity.google/cli/install.ps1' },
};
// `platform` can be passed in (as with `resolveCli` and `cliCommand`), so tests on any system can
// take either branch.
export function installPlanFor(id, { platform = process.platform } = {}) {
  const plan = Object.hasOwn(PLANS, id) ? PLANS[id] : null;
  if (!plan || platform !== 'win32') return null;
  return { id, ...plan, command: 'Download and install from the official source (no Node.js or npm needed)' };
}
export function manualHintFor(id, { platform = process.platform } = {}) {
  if (id === 'api') return tr("Direct API does not require installing a CLI.");
  return platform !== 'win32' ? tr("One-click install currently supports Windows only.") : tr("Unknown AI service.");
}

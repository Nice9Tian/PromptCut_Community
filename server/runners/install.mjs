// Native installers: no separate Node.js/npm dependency.
const PLANS = {
  claude: { label: 'Claude Code', url: 'https://claude.ai/install.ps1' },
  codex: { label: 'Codex', url: 'https://chatgpt.com/codex/install.ps1' },
  agy: { label: 'Antigravity', url: 'https://antigravity.google/cli/install.ps1' },
};
export function installPlanFor(id) {
  const plan = Object.hasOwn(PLANS, id) ? PLANS[id] : null;
  if (!plan || process.platform !== 'win32') return null;
  return { id, ...plan, command: '从官方下载安装（无需 Node.js 或 npm）' };
}
export function manualHintFor(id) {
  if (id === 'api') return 'API 直连无需安装 CLI。';
  return process.platform !== 'win32' ? '目前一键安装支持 Windows。' : '未知的 AI 服务。';
}

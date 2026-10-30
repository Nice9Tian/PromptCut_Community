// Explicit test-process loader. Never enabled by the application itself.
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
if (!process.env.PROMPTCUT_AUTH_SIMULATION_ROOT || process.env.PROMPTCUT_NO_PORT_FILE !== '1') throw new Error('Isolated auth probe environment required');
const fixture = fileURLToPath(new URL('../../server/test/fixtures/codex-auth-cli.mjs', import.meta.url));
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/server/runners/cli-runtime.mjs')) return result;
  let source = String(result.source);
  const resolveAt = '  const local = env.LOCALAPPDATA';
  if (!source.includes(resolveAt)) throw new Error('CLI fixture hook no longer matches');
  source = source.replace(resolveAt, '  return name + "-auth-simulation";\n' + resolveAt);
  source = source.replace("  if (platform === 'win32' && /\\.(cmd|bat)$/i.test(exe))", `  if (/-auth-simulation$/.test(exe)) return { command: process.execPath, args: [${JSON.stringify(fixture)}, ...args] };\n  if (platform === 'win32' && /\\.(cmd|bat)$/i.test(exe))`);
  return { ...result, source };
} });

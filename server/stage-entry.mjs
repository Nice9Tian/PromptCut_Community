/**
 * Generation of stage entry `stage.html` (contract `docs/plan/online-card-exec-contract.md`
 * section 3.3): copies `index.html` produced by online build, and adds the stage Content Security
 * Policy (`<meta http-equiv="Content-Security-Policy">`) at the very front of `<head>`. Both
 * entries reference the same script bundle, while `index.html` itself remains completely unchanged.
 * The original policy text is taken from `src/online/stagePolicy.mjs` (sharing the same source with
 * nginx response headers and local proxy). Pure function; called by the online build plugin in
 * `vite.config.ts`, verified by unit test `server/test/stage-policy-nginx.test.mjs`.
 */
import { STAGE_CSP_META } from '../src/online/stagePolicy.mjs';

export const STAGE_ENTRY_FILE = 'stage.html';

export function stageEntryHtml(indexHtml) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${STAGE_CSP_META}" />`;
  const m = /<head[^>]*>/i.exec(indexHtml);
  if (!m) throw new Error('index.html has no <head>, cannot generate the stage entry');
  const at = m.index + m[0].length;
  return `${indexHtml.slice(0, at)}\n    ${meta}${indexHtml.slice(at)}`;
}

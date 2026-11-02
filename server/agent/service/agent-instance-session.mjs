/**
 * Public forwarding entrypoint for an in-instance session round.
 *
 * Cloud implementation has moved to `cloud/agent/agent-instance-session.mjs`, mounted via
 * `./extensions.mjs`; community edition (without `cloud/` directory) does not load any
 * `server/account/` or `cloud/` modules.
 */
import { findAgentExtension } from './extensions.mjs';

export function createAgentInstanceSession(...args) {
  const ext = findAgentExtension('agent-instance-session');
  if (!ext?.createSession) {
    throw Object.assign(new Error('agent-instance-session extension is not mounted'), {
      status: 503,
      code: 'run-unavailable',
    });
  }
  return ext.createSession(...args);
}

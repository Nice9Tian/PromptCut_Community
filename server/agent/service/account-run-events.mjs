/**
 * Public forwarding entrypoint for locally persisting events and state of an account mode round.
 *
 * Cloud implementation has moved to `cloud/agent/account-run-events.mjs`, mounted via
 * `./extensions.mjs`; community edition (without `cloud/` directory) does not load any
 * `server/account/` or `cloud/` modules.
 */
import { findAgentExtension } from './extensions.mjs';

export function createAccountRunEvents(...args) {
  const ext = findAgentExtension('account-run-events');
  if (!ext?.createEvents) {
    throw Object.assign(new Error('account-run-events extension is not mounted'), {
      status: 503,
      code: 'run-unavailable',
    });
  }
  return ext.createEvents(...args);
}

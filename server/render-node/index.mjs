/**
 * Pure logic on the render node side (distributed prerender M2, contract
 * `docs/plan/render-queue-contract.md` Section B).
 *
 *   fingerprint.mjs  Environment fingerprint and result key
 *   filter.mjs       Filter claimable tasks by capability
 *   pick.mjs         Candidate ranking and selection
 *   split.mjs        Split `plan` tasks into fine-grained tasks (including per-card fingerprint
 *                    lock cardLocks / takeover, contract F.2)
 *   session.mjs      Node session state machine (claim, renew, yield, release)
 *   local-node.mjs   Local node arrangement (contract D.2, only recognizes injected endpoint /
 *                    executor / sink)
 *   ws-transport.mjs WebSocket endpoint to document service: token subprotocol, backoff reconnect,
 *                    disconnect drop (contract G.7)
 *   http-transport.mjs HTTP long polling endpoint of the same shape and WebSocket-like class
 *                    (protocol version 1, base of HT-b; no caller in HT-a, no communication with
 *                    server, `docs/plan/http-transport-contract.md` Section 15)
 *   session-link.mjs Client session layer createDocEndpoint: sequence numbers and acknowledgements,
 *                    resume after transport disconnect, resend (HT-a, contract
 *                    http-transport-contract Sections 3, 4, 9); used by business callers
 *   endpoint.mjs     Document service endpoint resolution (remote → attached in editor → local
 *                    loopback → fallback) and service address subscription (contract G.7, J.3)
 *   content-client.mjs Content store client: send content.put/get/list over the same endpoint,
 *                    match responses by reqId (C6.4)
 *   project-client.mjs Project snapshot client: send project.announce / project.snapshot.put/get
 *                    over the same endpoint (M5b J.2)
 *   host.mjs         Standalone render host (M6b): one connection and one host node per shared
 *                    project, global concurrency gate; `loadHostConfig` reads config file once
 *
 * Pure logic modules only import Node built-in modules, `../render-queue/index.mjs`, and
 * `../snapshot-store.mjs`, do not read environment variables, do not start timers, and do not
 * perform I/O. The only exceptions are the two network modules in M5a: `ws-transport.mjs` uses
 * global `WebSocket` and timers (both injectable; `http-transport.mjs` similarly, replaced with
 * global `fetch`), and `endpoint.mjs` reads `process.env` by default and uses global `fetch` (both
 * injectable), neither of which reads the file system. `content-client.mjs` in C6.4 is also an
 * exception: uses timers for request timeouts (injectable), sends and receives only through
 * injected endpoints, and does not read the file system. `project-client.mjs` in M5b is the same.
 * `session-link.mjs` in HT-a is also an exception: uses global `WebSocket` and timers (both
 * injectable), and reads `PROMPTCUT_TRANSPORT` by default in Node (overridable by options).
 */
export { normalizeOs, gpuClassOf, chromeMajorOf, envFingerprintOf, describeEnvironment, resultKeyOf, isChromiumUserAgent } from './fingerprint.mjs';
export { DEFAULT_WEIGHT_POLICY, checkClaimable, filterClaimable, testPlanOnly } from './filter.mjs';
export { rankCandidates, pickCandidate } from './pick.mjs';
export { planTaskOf, splitPlan, backfillPlanTaskOf, isBackfillPlan, clipsPlanTaskOf, isClipsPlan, isListPlan } from './split.mjs';
export { createNodeSession } from './session.mjs';
export { createLocalNode, idleLockTakeover } from './local-node.mjs';
export { createTaskRunner, untilAborted } from './task-runner.mjs';
export { BACKOFF_DEFAULTS, createWsEndpoint } from './ws-transport.mjs';
export { HTTP_CLIENT_DEFAULTS, createHttpEndpoint, HttpWebSocket, httpWebSocketClass } from './http-transport.mjs';
export { SESSION_DEFAULTS, createDocEndpoint, transportOf, wsUrlOf, httpUrlOf } from './session-link.mjs';
export { resolveDocservice, watchServiceEndpoints } from './endpoint.mjs';
export { CONTENT_CLIENT_DEFAULTS, createContentClient } from './content-client.mjs';
export { PROJECT_CLIENT_DEFAULTS, createProjectClient } from './project-client.mjs';
export { HOST_MAX_CONCURRENT, HOST_CAPABILITIES, hostMaxConcurrent, parseHostConfig, loadHostConfig, createRenderHost, fallbackTicketFor } from './host.mjs';

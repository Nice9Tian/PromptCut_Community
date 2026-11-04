/**
 * 0.7.18 Four-tier frame rendering priority for Cloud Agent viewing frames (contract
 * user-decisions-2026-10-16.md Section 3.1, RS18-local).
 *
 * Priority:
 *   1. Member desktop app (desktop)
 *   2. Online browser identified as PC (browser-pc)
 *   3. Host render service (hosted-render)
 *   4. Online browser identified as mobile (browser-mobile)
 *
 * When eligible online member device auxiliary nodes are available in the project (satisfying:
 * authorized / in project, online, code version matching project version, possessing on-demand
 * frame rendering capability, and fetching frames does not move the playhead on the user
 * interface), prioritize fetching frames from member devices in order of desktop app > PC browser;
 * if local nodes do not qualify, are offline, disconnect during execution, or time out,
 * automatically fall back to the host render service (if hosted rendering is also unavailable,
 * check if a mobile browser is available as fallback);
 * when this round is stopped, local and cloud in-flight requests are revoked together; after a
 * project version switch, late results from old versions are isolated and discarded.
 */

export const FRAME_SOURCE_LEVELS = Object.freeze({
  DESKTOP: 'desktop',
  BROWSER_PC: 'browser-pc',
  HOSTED_RENDER: 'hosted-render',
  BROWSER_MOBILE: 'browser-mobile',
});

/**
 * Determines whether a member device node qualifies for on-demand frame rendering
 * @param {object} node
 * @param {string | null} expectedCodeVersion
 * @returns {boolean}
 */
export function isQualifiedMemberNode(node, expectedCodeVersion = null) {
  if (!node || typeof node !== 'object') return false;
  // Must be online and authorized (accepts both online and live)
  const isOnline = node.online === true || node.live === true;
  if (!isOnline || node.authorized === false) return false;
  // Code version must match
  if (expectedCodeVersion && node.codeVersion && node.codeVersion !== expectedCodeVersion) return false;
  // Must have on-demand frame rendering capability
  if (node.capabilities && node.capabilities.canSnapshot === false) return false;
  if (node.canRenderFrames === false) return false;
  // Must ensure fetching frames does not move the playhead
  if (node.keepPlayhead === false) return false;
  return true;
}

/**
 * Classifies candidate nodes by frame rendering priority
 * @param {object} node
 * @returns {'desktop' | 'browser-pc' | 'browser-mobile' | 'unknown'}
 */
export function classifyNode(node) {
  if (!node) return 'unknown';
  const kind = String(node.kind ?? node.deviceKind ?? node.profile ?? node.clientType ?? '').toLowerCase();
  const platform = String(node.platform ?? '').toLowerCase();
  const isMobile = node.isMobile === true || platform === 'mobile' || kind === 'mobile' || kind === 'lowmem' || kind === 'phone' || kind === 'tablet';
  if (kind === 'desktop' || kind === 'pc' || platform === 'desktop') return FRAME_SOURCE_LEVELS.DESKTOP;
  if (isMobile) return FRAME_SOURCE_LEVELS.BROWSER_MOBILE;
  if (kind === 'browser' || platform === 'browser' || kind === 'web') return FRAME_SOURCE_LEVELS.BROWSER_PC;
  // By default, if the online page does not specify mobile, treat as browser PC browser
  return FRAME_SOURCE_LEVELS.BROWSER_PC;
}

/**
 * Filters and sorts candidate member device nodes: desktop app > PC browser > mobile browser
 * @param {object[]} nodes
 * @param {{ projectCodeVersion?: string | null }} options
 */
export function selectEligibleLocalNodes(nodes = [], { projectCodeVersion = null } = {}) {
  const eligible = (Array.isArray(nodes) ? nodes : []).filter(n => isQualifiedMemberNode(n, projectCodeVersion));
  const desktopNodes = [];
  const browserPcNodes = [];
  const browserMobileNodes = [];

  for (const node of eligible) {
    const cls = classifyNode(node);
    if (cls === FRAME_SOURCE_LEVELS.DESKTOP) desktopNodes.push(node);
    else if (cls === FRAME_SOURCE_LEVELS.BROWSER_PC) browserPcNodes.push(node);
    else if (cls === FRAME_SOURCE_LEVELS.BROWSER_MOBILE) browserMobileNodes.push(node);
  }

  return { desktopNodes, browserPcNodes, browserMobileNodes };
}

/**
 * Executes four-tier priority frame rendering dispatch for viewing frames
 *
 * @param {object} o
 * @param {object[]} [o.memberNodes] Member nodes currently online in the project
 * @param {string | null} [o.projectCodeVersion] Project code version
 * @param {() => Promise<object>} o.cloudLook Function to render frames via hosted render service
 * @param {(node: object, request: object, signal?: AbortSignal) => Promise<object>} [o.callLocal] Function to request frames from a member device
 * @param {() => number | null} [o.getProjectRev] Gets current project revision (for late detection)
 * @param {object} o.request Frame rendering request parameters (e.g. { path, body, timeoutMs })
 * @param {AbortSignal} [o.signal] Cancellation signal
 * @param {(event: string, fields?: object) => void} [o.log]
 */
export async function dispatchFrameSnapshot({
  memberNodes = [],
  projectCodeVersion = null,
  cloudLook,
  callLocal = null,
  getProjectRev = () => null,
  request,
  signal = null,
  log = () => {},
}) {
  if (signal?.aborted) {
    const err = Object.assign(new Error('run-fenced'), { status: 403, code: 'run-fenced' });
    throw signal.reason ?? err;
  }

  const { desktopNodes, browserPcNodes, browserMobileNodes } = selectEligibleLocalNodes(memberNodes, { projectCodeVersion });

  // 1. Member desktop app
  if (desktopNodes.length > 0 && typeof callLocal === 'function') {
    for (const node of desktopNodes) {
      if (signal?.aborted) break;
      const revBefore = getProjectRev();
      try {
        log('frame.dispatch', { source: FRAME_SOURCE_LEVELS.DESKTOP, nodeId: node.id ?? node.deviceId });
        const localSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(node.timeoutMs ?? 15_000)]) : AbortSignal.timeout(15_000);
        const res = await callLocal(node, request, localSignal);
        if (res && res.ok !== false) {
          const revAfter = getProjectRev();
          // Version switch/late result: after the project version changes, late local results from old
          // versions are isolated and discarded
          if (revBefore !== null && revAfter !== null && revBefore !== revAfter) {
            log('frame.stale-discarded', { source: FRAME_SOURCE_LEVELS.DESKTOP, revBefore, revAfter });
            continue;
          }
          log('frame.success', { source: FRAME_SOURCE_LEVELS.DESKTOP, nodeId: node.id ?? node.deviceId });
          return { ...res, source: FRAME_SOURCE_LEVELS.DESKTOP };
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        log('frame.local-failed', { source: FRAME_SOURCE_LEVELS.DESKTOP, message: String(err?.message ?? err) });
      }
    }
  }

  // 2. Online browser identified as PC
  if (browserPcNodes.length > 0 && typeof callLocal === 'function') {
    for (const node of browserPcNodes) {
      if (signal?.aborted) break;
      const revBefore = getProjectRev();
      try {
        log('frame.dispatch', { source: FRAME_SOURCE_LEVELS.BROWSER_PC, nodeId: node.id ?? node.deviceId });
        const localSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(node.timeoutMs ?? 15_000)]) : AbortSignal.timeout(15_000);
        const res = await callLocal(node, request, localSignal);
        if (res && res.ok !== false) {
          const revAfter = getProjectRev();
          if (revBefore !== null && revAfter !== null && revBefore !== revAfter) {
            log('frame.stale-discarded', { source: FRAME_SOURCE_LEVELS.BROWSER_PC, revBefore, revAfter });
            continue;
          }
          log('frame.success', { source: FRAME_SOURCE_LEVELS.BROWSER_PC, nodeId: node.id ?? node.deviceId });
          return { ...res, source: FRAME_SOURCE_LEVELS.BROWSER_PC };
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        log('frame.local-failed', { source: FRAME_SOURCE_LEVELS.BROWSER_PC, message: String(err?.message ?? err) });
      }
    }
  }

  // 3. Host render service (waits in its queue; multi-project mode from 0.7.19: projects take turns,
  // not letting any project monopolize it)
  // Record its response when hosted render produces no frame: return as-is when mobile browser
  // cannot cover it either, so the model sees the real reason
  // (project has no render node enabled, render timeout and its debug info, clip does not exist...),
  // rather than a generic "No available frame rendering node"
  let cloudOutcome = null;
  if (typeof cloudLook === 'function') {
    try {
      log('frame.dispatch', { source: FRAME_SOURCE_LEVELS.HOSTED_RENDER });
      const res = await cloudLook();
      if (res && res.ok !== false) {
        log('frame.success', { source: FRAME_SOURCE_LEVELS.HOSTED_RENDER });
        return { ...res, source: FRAME_SOURCE_LEVELS.HOSTED_RENDER };
      }
      log('frame.cloud-unsuccessful', { source: FRAME_SOURCE_LEVELS.HOSTED_RENDER, error: typeof res?.error === 'string' ? res.error.slice(0, 200) : null });
      if (res && typeof res === 'object') cloudOutcome = { result: { ...res, source: FRAME_SOURCE_LEVELS.HOSTED_RENDER } };
    } catch (err) {
      if (signal?.aborted) throw err;
      log('frame.cloud-failed', { source: FRAME_SOURCE_LEVELS.HOSTED_RENDER, look: err?.look ?? null, message: String(err?.message ?? err) });
      cloudOutcome = { error: err };
      // If the cloud throws an unavailable error and a mobile browser exists, try mobile browser fallback
    }
  }

  // 4. Online browser identified as mobile (fallback)
  if (browserMobileNodes.length > 0 && typeof callLocal === 'function') {
    for (const node of browserMobileNodes) {
      if (signal?.aborted) break;
      const revBefore = getProjectRev();
      try {
        log('frame.dispatch', { source: FRAME_SOURCE_LEVELS.BROWSER_MOBILE, nodeId: node.id ?? node.deviceId });
        const localSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(node.timeoutMs ?? 20_000)]) : AbortSignal.timeout(20_000);
        const res = await callLocal(node, request, localSignal);
        if (res && res.ok !== false) {
          const revAfter = getProjectRev();
          if (revBefore !== null && revAfter !== null && revBefore !== revAfter) {
            log('frame.stale-discarded', { source: FRAME_SOURCE_LEVELS.BROWSER_MOBILE, revBefore, revAfter });
            continue;
          }
          log('frame.success', { source: FRAME_SOURCE_LEVELS.BROWSER_MOBILE, nodeId: node.id ?? node.deviceId });
          return { ...res, source: FRAME_SOURCE_LEVELS.BROWSER_MOBILE };
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        log('frame.local-failed', { source: FRAME_SOURCE_LEVELS.BROWSER_MOBILE, message: String(err?.message ?? err) });
      }
    }
  }

  if (signal?.aborted) {
    throw signal.reason ?? Object.assign(new Error('run-fenced'), { status: 403, code: 'run-fenced' });
  }
  if (cloudOutcome?.error) throw cloudOutcome.error;
  if (cloudOutcome?.result) return cloudOutcome.result;
  throw new Error('Could not view this time: no render node is available (member devices are offline or ineligible, or the cloud render service is unavailable).');
}

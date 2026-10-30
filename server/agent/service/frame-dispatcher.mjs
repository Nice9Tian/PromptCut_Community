/**
 * 0.7.18 云端 Agent 看画面的出图四级先后（契约 user-decisions-2026-10-16.md 第 3.1 节，RS18-local）。
 *
 * 优先级：
 *   1. 成员的桌面版 (desktop)
 *   2. 身份为电脑的在线浏览器 (browser-pc)
 *   3. 托管方的渲染服务 (hosted-render)
 *   4. 身份为手机的在线浏览器 (browser-mobile)
 *
 * 当项目里有合格在线的成员设备辅助节点（满足：已授权/在项目内、在线、代码版本与项目版本匹配、
 * 具备即时出图能力，且取帧不改变用户界面上的播放头）时，按 桌面版 > 电脑浏览器 优先从成员设备取帧；
 * 若本地节点不满足资格、离线、执行中掉线或超时，自动退回托管方的渲染服务（若托管渲染也不可用再看是否有手机浏览器兜底）；
 * 本轮被停止时本地与云端在途请求一并撤回；项目版本切换后迟到的旧版本结果隔离丢弃。
 */

export const FRAME_SOURCE_LEVELS = Object.freeze({
  DESKTOP: 'desktop',
  BROWSER_PC: 'browser-pc',
  HOSTED_RENDER: 'hosted-render',
  BROWSER_MOBILE: 'browser-mobile',
});

/**
 * 判断一个成员设备节点是否具备即时出图资格
 * @param {object} node
 * @param {string | null} expectedCodeVersion
 * @returns {boolean}
 */
export function isQualifiedMemberNode(node, expectedCodeVersion = null) {
  if (!node || typeof node !== 'object') return false;
  // 必须在线且已授权（同时认 online 与 live）
  const isOnline = node.online === true || node.live === true;
  if (!isOnline || node.authorized === false) return false;
  // 代码版本必须匹配
  if (expectedCodeVersion && node.codeVersion && node.codeVersion !== expectedCodeVersion) return false;
  // 必须具备即时出图能力
  if (node.capabilities && node.capabilities.canSnapshot === false) return false;
  if (node.canRenderFrames === false) return false;
  // 必须保证取帧不移动播放头
  if (node.keepPlayhead === false) return false;
  return true;
}

/**
 * 对候选节点按出图优先级分级
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
  // 缺省若在线页未标 mobile 则按 browser 电脑浏览器处理
  return FRAME_SOURCE_LEVELS.BROWSER_PC;
}

/**
 * 筛选并排序候选成员设备节点：桌面版 > 电脑浏览器 > 手机浏览器
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
 * 执行四级优先级的看画面出图调度
 *
 * @param {object} o
 * @param {object[]} [o.memberNodes] 项目内当前在线的成员节点
 * @param {string | null} [o.projectCodeVersion] 项目代码版本
 * @param {() => Promise<object>} o.cloudLook 托管渲染服务出图的函数
 * @param {(node: object, request: object, signal?: AbortSignal) => Promise<object>} [o.callLocal] 向成员设备要帧的函数
 * @param {() => number | null} [o.getProjectRev] 获取当前项目版本号（用于迟到检测）
 * @param {object} o.request 出图请求参数（例如 { path, body, timeoutMs }）
 * @param {AbortSignal} [o.signal] 取消信号
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

  // 1. 成员的桌面版
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
          // 版本切换/迟到结果：项目改了版本后，旧版本的本地结果迟到要被隔离丢弃
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

  // 2. 身份为电脑的在线浏览器
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

  // 3. 托管方的渲染服务（进它的队列排着；0.7.19 起多项目模式：各项目轮流，不让哪个项目占着）
  // 托管渲染没出图时记下它的回话：手机浏览器也兜不住时原样交回，模型看到真正的原因
  // （项目没开渲染节点、渲染超时及其调试信息、片段不存在……），而不是笼统的「没有可用的出图节点」
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
      // 若云端抛出不可用的错误且有手机浏览器，尝试手机浏览器兜底
    }
  }

  // 4. 身份为手机的在线浏览器（兜底）
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
  throw new Error('这次没看成：没有可用的出图节点（成员设备离线或不合格，云端渲染服务不可用）。');
}

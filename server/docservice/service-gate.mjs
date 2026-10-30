/**
 * 托管方服务身份的权限：白名单（契约 `docs/plan/hosted-render-contract.md` 第 1.3、1.5 节）。
 *
 * 带 `service` 字段的连接按「缺省拒绝」接入：不在表里的消息类型一律 `forbidden`，表里没有这个服务就全拒。按 `service` 字段判、
 * 不按 `scope`：代成员进项目的服务（云端 Agent，`scope: 'member'` 加 `service: 'agent'`）同样走白名单。现有模块里按 `scope === 'member'` 拒绝的判断
 * （如服务地址登记）对新 scope 会变成放行，所以不靠逐个模块补判断，统一在组装层的 `gate(principal, type, msg)` 这一处把关。
 *
 * - **控制连接**（`scope: 'service'`、没有 `tenantId`，握手凭服务私钥得到）：只能发目录模块的 `hosted.watch`、`hosted.ticket`、
 *   `hosted.demand`、`hosted.delegate.verify`（最后一个只对云端 Agent 服务开，目录模块里判）；
 * - **数据连接**（凭目录模块签的票据进某个项目）：按服务名查 `SERVICE_ALLOW`：渲染服务一行；云端 Agent 代成员开的连接一行
 *   （`docs/plan/cloud-agent-contract.md` 第 4.4 节，只读成员的另拒改项目的两种）。云端 Agent 服务只用来发布预渲染重试计划的连接
 *   （principal 带 `purpose: 'publish'`）查另一张表 `SERVICE_PUBLISH_ALLOW`，`task.publish` 只许带片段清单的计划任务。
 *   三种消息另看内容：`content.put` 只许写预渲染清单，`auth.ticket` 只许要素材票据（要连接票据等于给自己换角色），
 *   `task.publish` 不许发布计划任务（渲染服务只发布自己切分出来的细任务）；云端 Agent 代成员的连接：`content.*` 只许
 *   `card-source` 一类（建卡改卡），`auth.ticket` 只许素材票据、读写的要成员本人有读写权限（导入素材，不超过成员本人）；
 * - 不是服务身份的连接发 `hosted.*` 一律 `forbidden`。
 *
 * 纯函数，不引任何模块。
 */

/** 控制连接能发的消息 */
export const SERVICE_CONTROL_TYPES = Object.freeze(['hosted.watch', 'hosted.ticket', 'hosted.demand', 'hosted.delegate.verify']);

/** 渲染服务能往内容库写的类别（预渲染清单） */
export const RENDER_CONTENT_KINDS = Object.freeze(['snapshot-manifest', 'render-manifest']);

/** 服务名 → 数据连接能发的消息类型 */
export const SERVICE_ALLOW = Object.freeze({
  render: Object.freeze([
    // 报到、认领、交付
    'node.hello', 'node.active', 'queue.watch', 'publisher.hello', 'task.publish',
    'task.claim', 'task.progress', 'task.complete', 'task.fail', 'task.release',
    // 读项目
    'project.open', 'project.close', 'project.snapshot.get',
    // 读内容库；写只许预渲染清单（下面按 kind 再判）
    'content.get', 'content.list', 'content.watch', 'content.put',
    // 素材服务的地址与票据（票据只许 asset，下面再判）
    'service.watch', 'auth.ticket',
  ]),
  // 云端 Agent 代成员开的连接（`docs/plan/cloud-agent-contract.md` 第 4.4 节）：身份是成员的，能做的不超过这位成员，
  // 而且只有下面这几种。只读成员（`access: 'r'`）的连接另拒 `AGENT_WRITE_TYPES`
  agent: Object.freeze([
    // 读项目、收别人的改动
    'project.open', 'project.close',
    // 改项目（只读的拒）
    'project.op', 'project.upload',
    // 工具调用事件（事件模块借内容库写 event-detail，不经这条连接直接写内容库）
    'events.create', 'events.complete', 'events.text',
    // 在场状态：别的成员「正在编辑」的片段、Agent 自己的范围、「这一轮在不在跑」
    'presence.set', 'presence.clear', 'presence.list',
    // 卡片源码（建卡改卡，`docs/plan/cloud-agent-contract.md` 第 9.4 节）：内容库里只许碰 `card-source` 这一类（下面按 kind 再判），写要读写权限
    'content.get', 'content.list', 'content.put',
    // 素材票据（导入素材、配音等产物入库）：只许 asset，要读写票据得成员本人有读写权限（下面再判）
    'auth.ticket',
    // 读本项目的共享成本记录（只读、只有耗时）：发布预渲染之前判轻重，只发重卡（`server/agent/service/render-clips.mjs`「只发重卡」）
    'cost.list',
  ]),
});

/** 云端 Agent 代成员的连接能碰的内容库类别 */
export const AGENT_CONTENT_KINDS = Object.freeze(['card-source']);

/**
 * 以服务自己的身份开、只用来发布预渲染重试计划的连接（principal 的 `purpose: 'publish'`，同上第 16 节 R2）：服务名 → 能发的消息。
 * `task.publish` 只许发带片段清单的计划任务（下面再判）；不能报到成节点、不能认领、不能读写项目与内容库、不能取任何票据。
 */
export const SERVICE_PUBLISH_ALLOW = Object.freeze({
  agent: Object.freeze(['publisher.hello', 'task.publish', 'task.unsubscribe']),
});

/** 只读成员的云端 Agent 连接不能发的（改项目的） */
export const AGENT_WRITE_TYPES = Object.freeze(['project.op', 'project.upload', 'content.put']);

/** 带片段清单的计划任务的结果键标记（与 `../render-queue/messages.mjs` 的 `CLIPS_KEY_MARK`、`BACKFILL_KEY_MARK` 相同；本文件不引模块，照抄，单测对拍） */
export const CLIP_LIST_KEY_MARKS = Object.freeze(['#clips:', '#backfill:']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {object} principal
 * @param {string} type
 * @param {object} [msg] 整条消息（三种消息要看内容）
 * @returns {string | null} 不放行的原因；放行回 null
 */
export function serviceGate(principal, type, msg) {
  const isService = typeof principal?.service === 'string' || principal?.scope === 'service';
  if (!isService) return type.startsWith('hosted.') ? 'forbidden' : null;
  const inSpace = typeof principal.tenantId === 'string' && principal.tenantId !== '';
  if (!inSpace) return principal.scope === 'service' && SERVICE_CONTROL_TYPES.includes(type) ? null : 'forbidden';
  if (principal.purpose !== undefined) {
    // 只用来发布的连接：另一张表，且必须是服务自己的身份
    if (principal.purpose !== 'publish' || principal.scope !== 'service') return 'forbidden';
    const publish = Object.hasOwn(SERVICE_PUBLISH_ALLOW, principal.service) ? SERVICE_PUBLISH_ALLOW[principal.service] : null;
    if (!publish || !publish.includes(type)) return 'forbidden';
    if (type === 'task.publish') {
      // 只许带片段清单的计划任务：种类是 plan、结果键带片段清单的标记、input.clips 是非空数组。别的（细任务、整项目的计划）一律拒
      const tasks = Array.isArray(msg?.tasks) ? msg.tasks : null;
      if (!tasks || tasks.length === 0) return 'forbidden';
      const clipPlan = (t) => isObj(t) && t.kind === 'plan' && typeof t.resultKey === 'string' && CLIP_LIST_KEY_MARKS.some((m) => t.resultKey.includes(m))
        && isObj(t.input) && Array.isArray(t.input.clips) && t.input.clips.length > 0;
      if (!tasks.every(clipPlan)) return 'forbidden';
    }
    return null;
  }
  const allow = Object.hasOwn(SERVICE_ALLOW, principal.service) ? SERVICE_ALLOW[principal.service] : null;
  const accountAgent = principal.realm === 'account' && principal.identityVersion === 2 && principal.service === 'agent';
  if (!allow || (!allow.includes(type) && !(accountAgent && type === 'selection.query'))) return 'forbidden';
  if (principal.service === 'agent') {
    // 代成员的连接必须是成员身份；只读的不能改项目
    if (principal.scope !== 'member') return 'forbidden';
    // v2 writes must pass the live run provider in the assembly gate. A cached
    // page access field cannot revoke a retained run or authorize a new one.
    if (!accountAgent && principal.access !== 'rw' && AGENT_WRITE_TYPES.includes(type)) return 'forbidden';
    // 内容库只许卡片源码这一类（预渲染清单、事件详情、别的类别都碰不到）
    if (type.startsWith('content.') && !AGENT_CONTENT_KINDS.includes(msg?.kind)) return 'forbidden';
    // 票据只许素材票据（连接票据、委托都要不到：Agent 不能给自己换角色、续命）；读写票据要成员本人有读写权限
    if (type === 'auth.ticket') {
      if (msg?.kind !== 'asset') return 'forbidden';
      if ((msg.access ?? 'r') !== 'r' && principal.access !== 'rw') return 'forbidden';
    }
  }
  if (principal.service === 'render') {
    if (type === 'content.put' && !RENDER_CONTENT_KINDS.includes(msg?.kind)) return 'forbidden';
    if (type === 'auth.ticket' && msg?.kind !== 'asset') return 'forbidden';
    if (type === 'task.publish') {
      // 形状不对的交给队列回 bad-message；这里只挡计划任务
      const tasks = Array.isArray(msg?.tasks) ? msg.tasks : [];
      if (tasks.some((t) => isObj(t) && t.kind === 'plan')) return 'forbidden';
    }
  }
  return null;
}

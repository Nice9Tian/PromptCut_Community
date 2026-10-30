/**
 * 渲染节点侧的纯逻辑(分布式预渲染 M2,契约 `docs/plan/render-queue-contract.md` B 节)。
 *
 *   fingerprint.mjs  环境指纹与结果键
 *   filter.mjs       按能力过滤可认领的任务
 *   pick.mjs         候选排序与挑选
 *   split.mjs        `plan` 任务切分成细任务(含卡片级指纹锁 cardLocks / takeover,契约 F.2)
 *   session.mjs      节点会话状态机(认领、续约、让路、放回)
 *   local-node.mjs   本机节点编排(契约 D.2,只认注入的 endpoint / executor / sink)
 *   ws-transport.mjs 到文档服务的 WebSocket 端点:令牌子协议、退避重连、断线丢弃(契约 G.7)
 *   http-transport.mjs 同一形状的 HTTP 长轮询端点与仿 WebSocket 的类(第 1 版协议,HT-b 的底座;HT-a 里没有调用方,与服务端不通,`docs/plan/http-transport-contract.md` 第 15 节)
 *   session-link.mjs 客户端会话层 createDocEndpoint:序号与确认、传输断开后接续、补发(HT-a,契约 http-transport-contract 第 3、4、9 节);业务调用方用它
 *   endpoint.mjs     文档服务端点解析(远端 → 编辑器里挂的 → 本机回环 → 回落)与服务地址订阅(契约 G.7、J.3)
 *   content-client.mjs 内容库客户端:在同一条端点上发 content.put/get/list,按 reqId 配回包(C6.4)
 *   project-client.mjs 项目快照客户端:在同一条端点上发 project.announce / project.snapshot.put/get(M5b J.2)
 *   host.mjs         独立渲染主机(M6b):每个共享项目一条连接、一个 host 节点,全局并发闸;`loadHostConfig` 读一次配置文件
 *
 * 纯逻辑模块只引 Node 内置模块、`../render-queue/index.mjs` 和 `../snapshot-store.mjs`,
 * 不读环境变量、不开计时器、不做 I/O。例外只有 M5a 的两个网络模块:`ws-transport.mjs` 用全局
 * `WebSocket` 与计时器(都可注入;`http-transport.mjs` 同样,换成全局 `fetch`),`endpoint.mjs` 缺省读 `process.env`、用全局 `fetch`(都可注入),
 * 两者都不读文件系统。C6.4 的 `content-client.mjs` 也例外:用计时器做请求超时(可注入),
 * 只经注入的端点收发,不读文件系统。M5b 的 `project-client.mjs` 同样。
 * HT-a 的 `session-link.mjs` 也例外:用全局 `WebSocket` 与计时器(都可注入),在 Node 里缺省读 `PROMPTCUT_TRANSPORT`(选项可覆盖)。
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

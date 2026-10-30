/**
 * PromptCut 的 stdio MCP 服务。两类调用方共用这一份:
 *
 *   - **AI 栏的命令行工具**(claude / codex / agy。编辑器起它们时在 MCP 的环境变量里塞 `PROMPTCUT_CALLER=cli`、
 *     `PROMPTCUT_PORT`、`PROMPTCUT_AGENT`):调用带上这一页的对话 ID,和以前一样;
 *   - **桌面 APP 的会话**(计划 `docs/plan/agent-workflow-plan.md` A4。用户在 PromptCut 里点「登记到 Claude Code / Codex」
 *     之后,那边每个会话起一份本进程):按 `%TEMP%\promptcut\port.json` 找用户正在用的实例;每个会话一个身份
 *     (Claude Code 一个进程一个会话,Codex 按 `_meta.threadId` 分线程,见 `server/agent/desktop-mcp.mjs`),
 *     厂商从 `initialize` 的 `clientInfo` 认;`instructions` 与本地工具 `get_skill_guide` 是 SKILL 提示词。
 *
 * 两类都把调用 POST 给编辑器的 `/api/mcp/call`,工具、权限、创造力等级、SKILL 闸、写入身份都在编辑器那边判。
 */
import * as readline from 'node:readline';
import { tools } from './mcp-tools.mjs';
import { injectCardParams, injectPartParams } from './card-params-schema.mjs';
import { GUIDE_TOOL, SKILL_INSTRUCTIONS, desktopSessionKey, discoverEditor, newProcessSession, skillGuide, threadOf, vendorOf } from './agent/desktop-mcp.mjs';

/** 这个进程是 AI 栏的命令行工具起的(否则就是桌面 APP 的会话) */
const CLI_CALLER = process.env.PROMPTCUT_CALLER === 'cli' || !!process.env.PROMPTCUT_AGENT;
/** 这个进程自己的会话号(Claude Code 一个会话一个进程) */
const PROCESS_SESSION = newProcessSession();
/** initialize 时认出来的客户端;没发 initialize 就是未知 */
let client = vendorOf(null);

/** 这次调用打到哪个编辑器:每次调用重新找一遍(用户可能重开过 PromptCut,端口变了) */
function getTargets() {
  const found = discoverEditor();
  if (!found.ok) throw Object.assign(new Error(found.message), { noEditor: true });
  return found;
}

/** 桌面会话这次调用的身份(编辑器据此登记) */
function desktopCaller(meta) {
  const thread = threadOf(meta);
  return {
    type: 'desktop',
    key: desktopSessionKey({ processSession: PROCESS_SESSION, thread, vendor: client.vendor }),
    vendor: client.vendor,
    label: client.label,
    client: client.client,
    ...(thread ? { thread } : {}),
  };
}

let lastBridgeHost = null;

function isConnRefused(err) {
  let found = false;
  function walk(e, depth) {
    if (found || depth > 5 || !e || typeof e !== 'object') return;
    if (e.code === 'ECONNREFUSED') {
      found = true;
      return;
    }
    if (e.cause) walk(e.cause, depth + 1);
    if (Array.isArray(e.errors)) {
      for (const child of e.errors) {
        walk(child, depth + 1);
      }
    }
  }
  walk(err, 0);
  return found;
}

function isFetchFailure(err) {
  return err?.name === 'TypeError' && /fetch failed/i.test(String(err?.message || ''));
}

/*
 * 每一次调用都有上限:这个工具自己声明的 timeoutMs(没有就 60 秒,和桥那边的默认一样)再加 30 秒。
 *
 * 原来 fetch 不设超时。端口连不上(ECONNREFUSED)是秒回的,问题出在端口「连得上但没人回话」——
 * 登记里写死的端口被别的程序占了、或者那个 PromptCut 卡死了 —— 这时 agy 那边的工具调用就一直挂着,
 * 整轮对话跟着停住,没有任何报错。多出来的 30 秒是留给桥自己的超时先到、把真正的报错传回来。
 */
function bridgeTimeoutMs(tool) {
  // 测试用:不然一条「端口没人回话」的用例要真等 90 秒
  const override = Number(process.env.PROMPTCUT_BRIDGE_TIMEOUT_MS);
  if (override > 0) return override;
  const def = tools.find((t) => t.name === tool);
  return (Number(def?.timeoutMs) || 60000) + 30000;
}

/**
 * callId:模型那一侧这次工具调用的 id。Claude Code 在 tools/call 的 `_meta["claudecode/toolUseId"]` 里带
 * (c65-integ2 查过本机 claude.exe 里的这段);编辑器把它放进工具调用事件,页面 AI 栏按它对上聊天记录。
 * pair:codex、agy 不带可用的 id,只带配对线索(见 pairingOf),编辑器拿它和 runner 报到的调用配对
 * (server/agent/call-pairing.mjs)。
 */
async function callBridge(tool, args, callId, pair, meta, { schemaOnly = false } = {}) {
  const { port, hosts } = getTargets();
  // AI 栏的命令行工具:带这一页的对话 ID(vite-plugin-ai 起 CLI 时塞的环境变量);桌面 APP 的会话:带会话身份与厂商。
  // 列工具时顺手取卡片 / 部件清单拼 schema(schemaOnly):那不是会话自己的操作,不报身份 —— 不进 AI 栏的分组、不受 SKILL 闸管
  const who = CLI_CALLER
    ? { agent: process.env.PROMPTCUT_AGENT || undefined }
    : schemaOnly ? {} : { caller: desktopCaller(meta) };
  for (const host of hosts) {
    try {
      const res = await fetch(`http://${host}:${port}/api/mcp/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, args, ...who, callId: callId || undefined, pair: pair || undefined }),
        signal: AbortSignal.timeout(bridgeTimeoutMs(tool)),
      });
      if (lastBridgeHost !== host) {
        process.stderr.write(`[mcp-server] bridge at ${host}:${port}\n`);
        lastBridgeHost = host;
      }
      return res;
    } catch (err) {
      if (isConnRefused(err)) {
        continue;
      }
      if (err?.name === 'TimeoutError') {
        throw new Error(`PromptCut 在 ${host}:${port} 上 ${Math.round(bridgeTimeoutMs(tool) / 1000)} 秒没有回应(${tool})。`
          + '可能是这个端口被别的程序占着、或者编辑台卡住了;这次调用没有执行完,可以稍后重试。');
      }
      if (isFetchFailure(err)) {
        const detail = err.cause?.code || err.cause?.message || err.message;
        throw Object.assign(new Error(`PromptCut 连接预览服务失败：调用 ${tool} 时连接被关闭（${detail}）。`
          + '可能是预渲染进程或 Chrome 正在重启，请稍后重试。'), { code: 'BRIDGE_UNAVAILABLE', retryable: true, cause: err });
      }
      throw err;
    }
  }
  const e = new Error('All hosts refused connection');
  e.allRefused = true;
  e.port = port;
  throw e;
}

/**
 * codex、agy 在 tools/call 的 `_meta` 里带的配对线索(实测原文见 docs/archive/agent-reports/AGENT-runner-callid.md):
 *   - codex:`threadId` 等于它输出流 thread.started 的 thread_id。它的 `_meta.callId`("exec-<uuid>")
 *     输出流里没有,用不上;配对只能按(thread、工具名、参数);
 *   - agy:`antigravity.google/conversation_id` 等于输出流的 conversation_id,`progressToken` 是
 *     "<uuid>:<步号>",步号等于输出流 step_update 的 step_index —— 拼成和 agy runner 一样的 callId 当提示。
 * 两者都不是就回 undefined(不配对)。scope、hint 的写法要和 runners/codex.mjs、runners/agy.mjs 一致。
 */
function pairingOf(meta) {
  if (!meta || typeof meta !== 'object') return undefined;
  const id = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(v) ? v : null);
  const conv = id(meta['antigravity.google/conversation_id']);
  if (conv) {
    const step = typeof meta.progressToken === 'string' ? /:(\d{1,9})$/.exec(meta.progressToken) : null;
    return { scope: `agy:${conv}`, ...(step ? { hint: `agy:${conv}:${Number(step[1])}` } : {}) };
  }
  const thread = id(meta.threadId) || id(meta['x-codex-turn-metadata']?.thread_id);
  if (thread) return { scope: `codex:${thread}` };
  return undefined;
}

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + '\n');
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + '\n');
}

async function handleMessage(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // ignore invalid json
  }
  
  if (!req.method) return; // ignore non-requests
  if (req.method === 'notifications/initialized') return; // ignore

  if (req.method === 'initialize') {
    let clientProtocolVersion = (req.params && req.params.protocolVersion) || "2025-03-26";
    if (clientProtocolVersion !== "2025-03-26") {
      clientProtocolVersion = "2025-03-26";
    }
    // 桌面 APP 的会话:认厂商(Claude Code 报 claude-code,Codex 报 codex-mcp-client),回 SKILL 提示词的短版
    client = vendorOf(req.params?.clientInfo);
    sendResponse(req.id, {
      protocolVersion: clientProtocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "promptcut", version: "0.2.0" },
      ...(CLI_CALLER ? {} : { instructions: SKILL_INSTRUCTIONS }),
    });
    return;
  }

  if (req.method === 'ping') {
    sendResponse(req.id, {});
    return;
  }

  if (req.method === 'tools/list') {
    let pubTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }));
    // 桌面会话多一个本地工具:完整的 SKILL 做法(编辑器没开也能读)
    if (!CLI_CALLER) pubTools.unshift({ ...GUIDE_TOOL });

    // Fetch cards to dynamically update the schema for add_clip and update_clip
    try {
      // 这里要按 controls 生成 params 的 anyOf schema,所以必须要完整版;
      // list_cards 不带参数返回的是摘要(没有 controls)。
      const res = await callBridge('list_cards', { detail: 'full' }, undefined, undefined, undefined, { schemaOnly: true });
      if (res.ok) {
        const out = await res.json();
        if (out.ok && out.result) {
          // 和 API 直连共用同一份构造(server/card-params-schema.mjs),
          // 免得两条路给模型看的 schema 不一样 —— 以前就是这么分叉的:
          // 这里注入了真实字段,而 API 直连那边一直是个空壳自由对象。
          injectCardParams(pubTools, out.result);
        }
      }
    } catch(e) {
      // Ignore if bridge is not available, we just return the generic schema
    }

    // 部件同理:add_part / set_part 的 params、add_composite 的 parts 换成按 partId 分支的真实 schema
    try {
      const res = await callBridge('list_parts', { detail: 'full' }, undefined, undefined, undefined, { schemaOnly: true });
      if (res.ok) {
        const out = await res.json();
        if (out.ok && out.result) injectPartParams(pubTools, out.result);
      }
    } catch (e) {
      // 拿不到就退回自由对象
    }

    sendResponse(req.id, { tools: pubTools });
    return;
  }

  if (req.method === 'tools/call') {
    const tool = req.params.name;
    const args = req.params.arguments || {};

    if (!CLI_CALLER && tool === GUIDE_TOOL.name) {
      sendResponse(req.id, { content: [{ type: "text", text: skillGuide({ vendorLabel: client.label }) }] });
      return;
    }

    let res;
    try {
      const meta = req.params._meta;
      const callId = meta && typeof meta === 'object' && typeof meta['claudecode/toolUseId'] === 'string' ? meta['claudecode/toolUseId'] : undefined;
      res = await callBridge(tool, args, callId, callId ? undefined : pairingOf(meta), meta);
    } catch (e) {
      if (e.allRefused || isConnRefused(e)) {
        sendResponse(req.id, {
          content: [{ type: "text", text: `PromptCut 没在运行(端口 ${e.port} 没有服务)。请先打开 PromptCut,再回来重试;不要反复重试。` }],
          isError: true
        });
      } else {
        sendResponse(req.id, {
          content: [{ type: "text", text: e.message }],
          isError: true
        });
      }
      return;
    }
      
    if (!res.ok) {
      const text = await res.text();
      sendResponse(req.id, {
        content: [{ type: "text", text: `HTTP ${res.status}: ${text}` }],
        isError: true
      });
      return;
    }
    
    const out = await res.json();
    if (out.ok) {
      // 带画面的工具(see_frames)把 base64 放在 __image 里。MCP 的 content 数组
      // 本来就支持 image 块，直接作为一个块发出去即可；但 base64 绝不能留在 text
      // 块里——那是几十万字符的乱码，模型看不见画面，上下文还被白白撑爆。
      // (API 直连那条路做的是同一件事，见 harness/agent.mjs 里的 __image 处理。)
      const payload = out.result || out;
      const image = payload && typeof payload === "object" ? payload.__image : null;
      // see_frames 素材模式(source: "media")一次带一页拼图:__images 是数组,每张各一个 image 块,顺序和 scenes 一致
      const images = payload && typeof payload === "object" && Array.isArray(payload.__images) ? payload.__images : [];
      const rest = image || images.length ? (({ __image, __images, ...r }) => r)(payload) : payload;
      const content = [{ type: "text", text: JSON.stringify(rest, null, 2) }];
      if (image?.base64) content.push({ type: "image", data: image.base64, mimeType: image.mime || "image/png" });
      for (const im of images) {
        if (!im?.base64) continue;
        content.push({ type: "text", text: `${im.label ?? `镜头 ${im.sceneIndex ?? "?"}`}:` });
        content.push({ type: "image", data: im.base64, mimeType: im.mime || "image/jpeg" });
      }
      sendResponse(req.id, { content });
    } else {
      sendResponse(req.id, {
        content: [{ type: "text", text: out.error || "Unknown error" }],
        isError: true
      });
    }
    return;
  }

  if (req.id !== undefined) {
    sendError(req.id, -32601, "Method not found");
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  handleMessage(line).catch(e => {
    process.stderr.write(`Error handling message: ${e.message}\n`);
  });
});

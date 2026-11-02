/**
 * PromptCut's stdio MCP server. Shared by two types of callers:
 *
 *   - **AI panel CLI tools** (claude / codex / agy. When the editor starts them, it puts
 *     `PROMPTCUT_CALLER=cli`, `PROMPTCUT_PORT`, and `PROMPTCUT_AGENT` into the MCP environment
 *     variables): calls include this page's chat ID, same as before;
 *   - **Desktop app sessions** (plan `docs/plan/agent-workflow-plan.md` A4. After the user clicks
 *     "Register to Claude Code / Codex" in PromptCut, each session over there spawns an instance of
 *     this process): finds the instance the user is currently using via `%TEMP%\promptcut\port.json`;
 *     one identity per session (Claude Code uses one process per session, while Codex divides threads
 *     by `_meta.threadId`, see `server/agent/desktop-mcp.mjs`), recognizing the vendor from
 *     `initialize`'s `clientInfo`; `instructions` and the local tool `get_skill_guide` are SKILL
 *     prompts.
 *
 * Both types POST calls to the editor's `/api/mcp/call`; tools, permissions, creativity level,
 * the SKILL gate, and write identity are all checked on the editor side.
 */
import * as readline from 'node:readline';
import { tools } from './mcp-tools.mjs';
import { injectCardParams, injectPartParams } from './card-params-schema.mjs';
import { GUIDE_TOOL, SKILL_INSTRUCTIONS, desktopSessionKey, discoverEditor, newProcessSession, skillGuide, threadOf, vendorOf } from './agent/desktop-mcp.mjs';
import { tr } from './i18n.mjs';

/** Whether this process was launched by an AI panel CLI tool (otherwise a desktop app session) */
const CLI_CALLER = process.env.PROMPTCUT_CALLER === 'cli' || !!process.env.PROMPTCUT_AGENT;
/** This process's own session id (Claude Code uses one process per session) */
const PROCESS_SESSION = newProcessSession();
/** Client recognized during initialize; unknown if initialize was not sent */
let client = vendorOf(null);

/** Which editor this call targets: rediscovered on each call (user may have reopened PromptCut, changing the port) */
function getTargets() {
  const found = discoverEditor();
  if (!found.ok) throw Object.assign(new Error(found.message), { noEditor: true });
  return found;
}

/** Desktop session identity for this call (used by editor to register) */
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
 * Every call has an upper limit: the timeoutMs declared by the tool itself (or 60 seconds if none,
 * matching the bridge's default) plus 30 seconds.
 *
 * Originally fetch had no timeout set. Failing to connect to the port (ECONNREFUSED) returns
 * instantly; the problem arises when the port "connects but nobody responds": the hardcoded port in
 * the registry is occupied by another program, or that PromptCut instance is frozen. In this case,
 * the tool call on the agy side hangs indefinitely, stalling the entire chat round without any
 * error. The extra 30 seconds allows the bridge's own timeout to trigger first and return the real
 * error.
 */
function bridgeTimeoutMs(tool) {
  // For testing: otherwise a "port connects but nobody responds" test case would have to wait a full 90s
  const override = Number(process.env.PROMPTCUT_BRIDGE_TIMEOUT_MS);
  if (override > 0) return override;
  const def = tools.find((t) => t.name === tool);
  return (Number(def?.timeoutMs) || 60000) + 30000;
}

/**
 * callId: id of this tool call on the model's side. Claude Code carries it in `_meta["claudecode/toolUseId"]`
 * of tools/call (c65-integ2 inspected this section in local claude.exe); the editor puts it into the
 * tool call event, and the page AI panel matches it against chat history.
 * pair: codex and agy do not carry a usable id, only pairing clues (see pairingOf); the editor uses
 * it to pair with calls checked in by the runner (server/agent/call-pairing.mjs).
 */
async function callBridge(tool, args, callId, pair, meta, { schemaOnly = false } = {}) {
  const { port, hosts } = getTargets();
  // AI panel CLI tools: carry this page's chat ID (environment variable injected when vite-plugin-ai
  // launches CLI); desktop app sessions: carry session identity and vendor.
  // When listing tools, card / part manifests are fetched along the way to build schema (schemaOnly):
  // that is not an operation of the session itself and does not report identity: does not enter AI
  // panel groups and is not governed by the SKILL gate.
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
        throw new Error(`PromptCut did not respond on ${host}:${port} within ${Math.round(bridgeTimeoutMs(tool) / 1000)} seconds (${tool}).`
          + ' The port may be in use by another program, or the editor may be stuck; this call did not finish, and you can retry later.');
      }
      if (isFetchFailure(err)) {
        const detail = err.cause?.code || err.cause?.message || err.message;
        throw Object.assign(new Error(`PromptCut failed to connect to the preview service: the connection was closed while calling ${tool} (${detail}).`
          + ' The prerender process or Chrome may be restarting, please retry later.'), { code: 'BRIDGE_UNAVAILABLE', retryable: true, cause: err });
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
 * Pairing clues carried in `_meta` of tools/call by codex and agy (for actual test verbatim, see
 * docs/archive/agent-reports/AGENT-runner-callid.md):
 *   - codex: `threadId` equals thread_id from its output stream thread.started. Its `_meta.callId`
 *     ("exec-<uuid>") is not in the output stream and cannot be used; pairing can only be done by
 *     (thread, tool name, params);
 *   - agy: `antigravity.google/conversation_id` equals conversation_id from the output stream;
 *     `progressToken` is "<uuid>:<step_number>", where step number equals step_index from the
 *     output stream step_update: assembled into the same callId as the agy runner as a hint.
 * If neither, returns undefined (no pairing). The formatting of scope and hint must match
 * runners/codex.mjs and runners/agy.mjs.
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
    // Desktop app sessions: recognize vendor (Claude Code reports claude-code, Codex reports
    // codex-mcp-client), return short version of SKILL prompt
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
    // Desktop sessions get one additional local tool: full SKILL instructions (readable even if editor is not running)
    if (!CLI_CALLER) pubTools.unshift({ ...GUIDE_TOOL });

    // Fetch cards to dynamically update the schema for add_clip and update_clip
    try {
      // Needs full version here to generate anyOf schema for params based on controls;
      // list_cards without arguments returns a summary (without controls).
      const res = await callBridge('list_cards', { detail: 'full' }, undefined, undefined, undefined, { schemaOnly: true });
      if (res.ok) {
        const out = await res.json();
        if (out.ok && out.result) {
          // Shares the same construction with direct API (server/card-params-schema.mjs),
          // to prevent the two paths from presenting different schemas to the model: this was how they diverged
          // before: real fields were injected here, while direct API was always an empty free-form object shell.
          injectCardParams(pubTools, out.result);
        }
      }
    } catch(e) {
      // Ignore if bridge is not available, we just return the generic schema
    }

    // Same for parts: params of add_part / set_part and parts of add_composite are replaced with real
    // schemas branching on partId
    try {
      const res = await callBridge('list_parts', { detail: 'full' }, undefined, undefined, undefined, { schemaOnly: true });
      if (res.ok) {
        const out = await res.json();
        if (out.ok && out.result) injectPartParams(pubTools, out.result);
      }
    } catch (e) {
      // Falls back to a free-form object if unavailable
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
          content: [{ type: "text", text: tr("PromptCut is not running (no service on port {0}). Open PromptCut first, then come back and retry; do not retry repeatedly.", e.port) }],
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
      // Tools with visuals (see_frames) place base64 in __image. MCP's content array
      // natively supports image blocks, so sending it directly as a block is sufficient; but base64
      // must never be left in text blocks: that is hundreds of thousands of characters of gibberish,
      // the model cannot see the visual, and the context window gets needlessly blown up.
      // (The direct API path does the same thing, see __image handling in harness/agent.mjs.)
      const payload = out.result || out;
      const image = payload && typeof payload === "object" ? payload.__image : null;
      // see_frames media mode (source: "media") carries one page collage at a time: __images is an array,
      // each with its own image block, in the same order as scenes
      const images = payload && typeof payload === "object" && Array.isArray(payload.__images) ? payload.__images : [];
      const rest = image || images.length ? (({ __image, __images, ...r }) => r)(payload) : payload;
      const content = [{ type: "text", text: JSON.stringify(rest, null, 2) }];
      if (image?.base64) content.push({ type: "image", data: image.base64, mimeType: image.mime || "image/png" });
      for (const im of images) {
        if (!im?.base64) continue;
        content.push({ type: "text", text: `${im.label ?? `Shot ${im.sceneIndex ?? "?"}`}:` });
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

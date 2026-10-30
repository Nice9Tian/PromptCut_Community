import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { setupRoot } from './cli-runtime.mjs';

export const AUTH_RECOVERY = 'Codex 登录已失效，请重新登录。登录成功后请自行重新发送或继续原指令。';
const reasons = new Set(['token_revoked', 'refresh_token_invalid', 'openai_unauthorized']);
const externalToolError = /\bmcp\b|mcp[_ :.-]|tools\/call|external tool/i;

// Only CLI transport errors enter here. MCP tool results and model text never do.
export function codexAuthReason(text) {
  if (externalToolError.test(text)) return null;
  if (/\btoken_revoked\b/i.test(text)) return 'token_revoked';
  if (/\b(?:refresh_token_reused|refresh_token_expired|refresh_token_invalidated|invalid_grant)\b/i.test(text)
      && /refresh|openai|oauth/i.test(text)) return 'refresh_token_invalid';
  const openaiUrl = (text.match(/https:\/\/[^\s<>"')]+/g) || []).some(candidate => {
    try { const url = new URL(candidate); return !url.username && !url.password && ['api.openai.com', 'auth.openai.com', 'chatgpt.com'].includes(url.hostname); } catch { return false; }
  });
  if (/\b401\b|\bUnauthorized\b/i.test(text)
      && (openaiUrl || /workspace routing discovery unauthorized/i.test(text))) return 'openai_unauthorized';
  return null;
}

// Rolling untruncated line tail recognises split keywords before a newline arrives.
export function authErrorDecoder(onReason) {
  const decoder = new StringDecoder('utf8');
  let tail = '';
  let external = false;
  return chunk => {
    const lines = (tail + decoder.write(chunk)).split(/\r?\n/);
    const pending = lines.pop();
    for (let i = 0; i < lines.length; i++) {
      if (i === 0 && external) continue;
      const line = lines[i];
      const reason = codexAuthReason(line);
      if (reason) { onReason(reason); return; }
    }
    external = lines.length ? externalToolError.test(pending) : external || externalToolError.test(pending);
    tail = pending.slice(-16384);
    // Examine all newly received bytes before bounding retained parser memory.
    const reason = external ? null : codexAuthReason(pending);
    if (reason) onReason(reason);
  };
}

export function createCodexAuthState(root, { io = fs } = {}) {
  const file = path.join(root, 'codex-home', 'promptcut-auth-state.json');
  let state = { version: 1, generation: randomUUID(), revision: randomUUID(), state: 'normal', reason: null, time: Date.now() };
  let loginAttempt;
  let persistenceWarning;
  try {
    const saved = JSON.parse(io.readFileSync(file, 'utf8'));
    if (saved.version !== 1 || typeof saved.generation !== 'string' || !saved.generation
        || !['normal', 'invalid', 'unknown'].includes(saved.state) || !Number.isFinite(saved.time)
        || (saved.revision !== undefined && (typeof saved.revision !== 'string' || !saved.revision))
        || (saved.state === 'invalid' && !reasons.has(saved.reason))) throw new Error('invalid record');
    // Whitelist fields: never preserve unexpected account/log content.
    state = { version: 1, generation: saved.generation, revision: typeof saved.revision === 'string' && saved.revision ? saved.revision : randomUUID(), state: saved.state, reason: saved.state === 'invalid' ? saved.reason : null, time: saved.time };
  } catch (e) {
    if (e.code !== 'ENOENT') state.state = 'unknown';
  }
  const save = () => {
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      io.mkdirSync(path.dirname(file), { recursive: true });
      io.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
      io.renameSync(temp, file);
      persistenceWarning = undefined;
    } catch {
      persistenceWarning = '认证状态暂时无法保存，后端重启后需要重新确认。';
      try { io.unlinkSync(temp); } catch {}
    }
  };
  const changed = () => { state.revision = randomUUID(); state.time = Date.now(); };
  return {
    snapshot: () => ({ ...state, ...(persistenceWarning ? { persistenceWarning } : {}) }),
    effective(raw = { loggedIn: null }) {
      const extra = { authGeneration: state.revision, ...(persistenceWarning ? { persistenceWarning } : {}) };
      if (state.state === 'invalid') return { ...raw, ...extra, loggedIn: false, status: 'invalid', reason: state.reason, detail: AUTH_RECOVERY, fixHint: AUTH_RECOVERY };
      if (state.state === 'unknown') return { ...raw, ...extra, loggedIn: null, status: 'unknown', fixHint: 'Codex 登录状态记录无法确认，请重新登录。' };
      return { ...raw, ...extra };
    },
    invalidate(generation, reason) {
      if (generation !== state.generation || !reasons.has(reason) || state.state === 'invalid') return false;
      state.state = 'invalid'; state.reason = reason; changed(); save();
      return true;
    },
    beginLogin() {
      // Retire old callbacks, but keep current runs authoritative until login succeeds.
      loginAttempt = { id: randomUUID(), generation: state.generation };
      changed(); save(); return loginAttempt;
    },
    completeLogin(attempt) {
      if (!attempt || attempt.id !== loginAttempt?.id || attempt.generation !== state.generation) return false;
      loginAttempt = undefined;
      state.state = 'normal'; state.reason = null; state.generation = randomUUID(); changed(); save();
      return true;
    },
  };
}

const homes = new Map();
export function codexAuthState() {
  const root = path.resolve(setupRoot());
  if (!homes.has(root)) homes.set(root, createCodexAuthState(root));
  return homes.get(root);
}

export function authFailureEvent(reason, changed = true) {
  return { type: 'error', message: AUTH_RECOVERY, retryable: false,
    ...(changed ? { authProvider: 'codex', authReason: reason, authGeneration: codexAuthState().snapshot().revision } : {}) };
}

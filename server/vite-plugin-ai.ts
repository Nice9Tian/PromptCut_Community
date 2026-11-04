import type { Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { overLimit } from './http-guard.mjs';
import { stagePortsOf } from './stage-ports.mjs';
import { createAgentInstance } from './agent/service/instance.mjs';
/*
 * Must use static import: during vite bundling configuration, prerender-client.mjs statically
 * imported by other plugins is bundled into the same bundle, and the state (prerender address,
 * whether it is ready) lives on that copy. If dynamically loaded with import(new URL(...)) here,
 * what is obtained is another module instance from disk with perpetually empty state: in testing,
 * server-side see_frames waited in vain for 60 s in whenPrerenderReady.
 */
import { prerenderPost } from './prerender-client.mjs';
// The mirror storage itself lives in the mirror plugin (mounted in both processes); here it only
// reads the latest version of the current editor page session
import { latestMirror, latestPlayhead } from './vite-plugin-mirror';
import { tr } from './i18n.mjs';


/**
 * Opens a directory in the file manager.
 * When explorer opens a directory, its exit code is 1, so here we ignore the exit code and do not
 * wait for it.
 */
function revealInFileManager(dir: string) {
  const opener = process.platform === 'win32' ? 'explorer.exe'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* If it fails to open, ignore it: the file is already written, and the path is returned to the UI */
  }
}

function sendJson(res: ServerResponse, code: number, data: any) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

/* 413 for payload too large: implementation moved to server/http-guard.mjs; vision uses same copy */

export default function vitePluginAi(): Plugin {
  return {
    name: 'vite-plugin-ai',
    configureServer(server) {
      server.httpServer?.on('listening', () => {
        // This file is how desktop app sessions (server/mcp-server.mjs) locate "the instance the user is
        // currently using"; being overwritten by another instance would lead the user's desktop app to the
        // wrong port. Editors started by tests and probes (PROMPTCUT_NO_PORT_FILE=1) do not write this:
        // common entrypoint scripts/lib/no-user-dirs.mjs and the global setup of npm test set this flag;
        // the desktop app and editors started by users with `npm run dev` continue writing it as usual.
        if (process.env.PROMPTCUT_NO_PORT_FILE === '1') return;
        try {
          const addr = server.httpServer?.address();
          if (addr && typeof addr !== 'string') {
            const port = addr.port;
            let host = addr.address;
            if (host === '::' || host === '0.0.0.0') {
              host = '127.0.0.1';
            }
            const tmpDir = path.join(os.tmpdir(), 'promptcut');
            fs.mkdirSync(tmpDir, { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'port.json'), JSON.stringify({
              port,
              host,
              /*
               * Two stage ports (E1). Reverse proxies at editor port +1 / +2, from which stage iframes load:
               * written here for people **outside the page**: desktop shell uses it to allowlist WebView2 /
               * probe port occupancy, and probe scripts no longer need to calculate it themselves. The page
               * does not read this (stage port table is injected by vite-plugin-stage-ports).
               * If proxy fails to start (port occupied), page falls back to same-origin single stage;
               * this table still reflects "which two ports it should have been".
               */
              stagePorts: stagePortsOf(port),
              pid: process.pid,
              startedAt: Date.now()
            }));
          }
        } catch {}
      });

      /*
       * The Agent service implementation is in server/agent/service/instance.mjs (contract
       * docs/plan/cloud-agent-contract.md Section 2.1): page channels, project replicas, tool call
       * entry points, chat, and interfaces for multi-Agent and desktop sessions are all there; here
       * its routes are mounted as-is onto the editor process.
       * What remains in this file are interfaces belonging exclusively to the desktop: driver manifest,
       * installation and login, diagnostics, machine code, configuration, quota panel, and port.json
       * above.
       */
      const agent = createAgentInstance({
        server: {
          httpServer: server.httpServer,
          ssrLoadModule: (id: string) => server.ssrLoadModule(id),
          config: { root: server.config.root },
          middlewares: { use: (route: string, handler: any) => { server.middlewares.use(route, handler); } },
        },
        prerenderPost,
        latestMirror,
        latestPlayhead,
      });
      const getQuotaGuard = agent.getQuotaGuard;

      async function getRunner() {
        let runnerUrl;
        if (process.env.PROMPTCUT_AI_FAKE_RUNNER === '1') {
          runnerUrl = new URL('./test/fake-runner.mjs', import.meta.url).href;
        } else {
          const mod = process.env.PROMPTCUT_AI_RUNNER_MODULE || './runners/index.mjs';
          runnerUrl = new URL(mod, import.meta.url).href;
        }
        try {
          return await import(runnerUrl);
        } catch (e: any) {
          throw new Error(`Runner is not ready or failed to load: ${e.message}`);
        }
      }

      server.middlewares.use('/api/ai/providers', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const urlStr = req.originalUrl || req.url || '';
          const refresh = /[?&]refresh=1(&|$)/.test(urlStr);
          const runners = await getRunner();
          const list = await runners.listProviders({ refresh });
          
          let stt = { engine: null as string | null, available: false, hint: 'STT removed' };
          sendJson(res, 200, { ok: true, providers: list, stt });
        } catch (e: any) {
          sendJson(res, 503, { ok: false, error: String(e) });
        }
      });

      // Bounded UI polling reads only the non-sensitive ledger, never launches a CLI.
      server.middlewares.use('/api/ai/auth-state', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        const { codexAuthState } = await import('./runners/codex-auth-state.mjs');
        const state = codexAuthState();
        sendJson(res, 200, { ok: true, codex: { ...state.snapshot(), auth: state.effective() } });
      });

      /**
       * List the available models for a provider.
       *
       * Two paths:
       *   - `agy`: run `agy models` (output is "name<TAB>description");
       *   - `api`: call OpenAI-compatible `GET {baseUrl}/v1/models`. Relay services basically all
       *     implement this endpoint, returning `{ data: [{ id, object, owned_by }], object: "list" }`.
       *
       * claude / codex have no corresponding command, and the manifest can only be manually filled in
       * settings: rather than fabricating a potentially outdated hardcoded list, it is better to
       * honestly say this provider cannot be read.
       */
      server.middlewares.use('/api/ai/models', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        const provider = new URL(req.url || '/', 'http://localhost').searchParams.get('provider');

        if (provider === 'api') {
          try {
            const { readConfig } = await import(new URL('./ai-config.mjs', import.meta.url).href);
            const api = (readConfig() as any)?.api || {};
            if (!api.apiKey) return sendJson(res, 400, { ok: false, error: tr("API Key is not set, cannot fetch the model list") });
            if (!api.baseUrl) return sendJson(res, 400, { ok: false, error: tr("Base URL is not set (official sources have no unified list endpoint, only relay services do)") });
            const { listApiModels } = await import(new URL('./runners/api-models.mjs', import.meta.url).href);
            const models = await listApiModels(api);
            return sendJson(res, 200, { ok: true, models });
          } catch (e: any) {
            return sendJson(res, 500, { ok: false, error: e.message || String(e) });
          }
        }

        if (provider !== 'agy') {
          return sendJson(res, 400, { ok: false, error: tr("This provider has no command to list models, please enter one manually above") });
        }
        try {
          const { resolveExe } = await getRunner();
          const { cliCommand, cliEnv } = await import(new URL('./runners/cli-runtime.mjs', import.meta.url).href);
          const { execFile } = await import('node:child_process');
          const inv = cliCommand(resolveExe('agy'), ['models']);
          const out = await new Promise<string>((resolve, reject) => {
            execFile(inv.command, inv.args, { env: cliEnv('agy'), timeout: 30000, windowsHide: true },
              (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout || '')));
          });
          // Only keep lines with "name<TAB>description", filtering out headers like "Fetching available models..."
          const models = out.split(/\r?\n/)
            .map((l) => l.split('\t')[0].trim())
            .filter((n) => /^[\w.:-]+$/.test(n));
          sendJson(res, 200, { ok: true, models });
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: e.message || String(e) });
        }
      });

      // Keep operations alive across dialog close/reopen and report actual results.
      const setupService = import(new URL('./runners/setup.mjs', import.meta.url).href)
        .then(mod => mod.createSetupService());
      server.httpServer?.once('close', () => { void setupService.then(service => service.dispose()); });
      server.middlewares.use('/api/ai/setup', async (req, res) => {
        if (req.method === 'POST') {
          // Paste authorization code: feed the code string the user pasted in the login dialog into stdin
          // of the running Claude login task.
          // The code is a credential: do not log it, do not include it in error messages; shape validation
          // and writing are in submitCode in setup.mjs.
          if (!req.headers['content-type']?.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'JSON required' });
          if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host && req.headers.origin !== 'https://' + req.headers.host) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
          let body = '';
          let over = false;
          req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, 'Request body exceeds 8KB'); });
          req.on('end', async () => {
            if (over) return;
            try {
              const parsed = JSON.parse(body || '{}');
              const job = (await setupService).submitCode(parsed.provider, parsed.code);
              sendJson(res, 200, { ok: true, job });
            } catch (e: any) { sendJson(res, 400, { ok: false, error: e instanceof SyntaxError ? tr("The request is not valid JSON") : e.message }); }
          });
          return;
        }
        if (req.method === 'DELETE') {
          if (!req.headers['content-type']?.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'JSON required' });
          if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host && req.headers.origin !== 'https://' + req.headers.host) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
          let body = '';
          let over = false;
          req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, 'Request body exceeds 8KB'); });
          req.on('end', async () => {
            if (over) return;
            try { (await setupService).cancel(JSON.parse(body).provider); sendJson(res, 200, { ok: true }); }
            catch (e: any) { sendJson(res, 400, { ok: false, error: e.message }); }
          });
          return;
        }
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET, POST, DELETE only' });
        res.setHeader('Cache-Control', 'no-store');
        try { sendJson(res, 200, { ok: true, jobs: (await setupService).list() }); }
        catch (e: any) { sendJson(res, 500, { ok: false, error: e.message }); }
      });
      for (const kind of ['install', 'login'] as const) {
        server.middlewares.use('/api/ai/' + kind, async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
          if (!req.headers['content-type']?.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'JSON required' });
          if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host && req.headers.origin !== 'https://' + req.headers.host) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
          let body = '';
          let over = false;
          req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, 'Request body exceeds 8KB'); });
          req.on('end', async () => {
            if (over) return;
            try {
              const { provider, dryRun, deviceAuth } = JSON.parse(body || '{}');
              if (kind === 'install' && dryRun) {
                const { installPlanFor, manualHintFor } = await import(new URL('./runners/install.mjs', import.meta.url).href);
                const plan = installPlanFor(provider);
                return sendJson(res, plan ? 200 : 400, plan ? { ok: true, ...plan } : { ok: false, hint: manualHintFor(provider) });
              }
              const job = (await setupService).start(provider, kind, { deviceAuth: deviceAuth === true });
              sendJson(res, 200, { ok: true, job });
            } catch (e: any) { sendJson(res, 400, { ok: false, error: e.message }); }
          });
        });
      }

      /**
       * POST /api/ai/diagnostics/save: save as a file when the report is too long, and open its folder.
       *
       * Why not always use the clipboard: diagnostic reports easily reach hundreds of KB once each
       * execution event is included; pasting into a chat box is both sluggish and unreadable. Write to
       * disk when exceeding the threshold, letting the user send the file directly.
       *
       * **Always create a separate timestamped folder each time**, containing only this single txt.
       * If opening the main "Diagnostic reports" directory directly, the user would see a pile of files
       * from previous runs and have to identify which one was just generated.
       */
      server.middlewares.use('/api/ai/diagnostics/save', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        let tooBig = false;
        // The report itself is bulky; the limit here is only used to block obviously abnormal requests
        req.on('data', (c) => { if (tooBig) return; body += c; tooBig = overLimit(req, res, body.length, 64 * 1024 * 1024, tr("The report is over 64MB and was not saved")); });
        req.on('end', () => {
          if (tooBig) return;
          try {
            const { text, label } = JSON.parse(body || '{}');
            if (typeof text !== 'string' || !text) return sendJson(res, 400, { ok: false, error: 'text is required' });
            const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
            const safeLabel = String(label || 'diagnostic').replace(/[\\/:*?"<>|]/g, '');
            // Kept together with ai.json, not cluttering the desktop; File Explorer opens it right away anyway
            const root = path.join(process.env.LOCALAPPDATA || os.homedir(), 'promptcut', tr("diagnostic reports"));
            const dir = path.join(root, `${safeLabel}-${stamp}`);
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `${safeLabel}-${stamp}.txt`);
            // With BOM: without it, Windows Notepad will read Chinese as ANSI garbled text
            fs.writeFileSync(file, '﻿' + text, 'utf8');
            revealInFileManager(dir);
            sendJson(res, 200, { ok: true, dir, file });
          } catch (e: any) { sendJson(res, 500, { ok: false, error: e.message }); }
        });
      });

      // Troubleshooting info: gathered completely when the user clicks "Diagnostics" to copy and show us.
      // It must never contain a plaintext Key: publicConfig() has already replaced it with { set, last4 }.
      //
      // Machine code must also be sanitized. It is not just an identifier; it **is** the encryption
      // passphrase when distributing API configuration (configShare uses it as password), and writing
      // the entire string into the report is equivalent to handing over the decryption passphrase.
      // Keep only the first group: enough for us to recognize which machine it is, not enough for anyone
      // to use for decryption.
      server.middlewares.use('/api/ai/diagnostics', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const [{ publicConfig }, { setupRoot }, { machineCode, redactMachineCode }, env, runners] = await Promise.all([
            import(new URL('./ai-config.mjs', import.meta.url).href),
            import(new URL('./runners/cli-runtime.mjs', import.meta.url).href),
            import(new URL('./runners/machine-id.mjs', import.meta.url).href),
            import(new URL('./harness/env-snapshot.mjs', import.meta.url).href),
            getRunner(),
          ]);
          res.setHeader('Cache-Control', 'no-store');
          /*
           * Driver liveness probes spawn a child process for each of claude / codex / agy (runners/auth.mjs,
           * 15-second timeout each). The diagnostic report path cannot afford to wait, and what it wants is
           * **the current state of this machine**, not "is the CLI still logged in?", so it takes ?refresh=0
           * to use in-process cache.
           *
           * It must also be wrapped in its own try: previously the entire response was all-or-nothing;
           * if the probe threw an error it returned 500, taking node and sessions down with it: yet those
           * two sections are precisely the most valuable output of this button, and coincidentally the most
           * prone to collateral damage when the machine has issues.
           */
          const refresh = new URL(req.url || '/', 'http://x').searchParams.get('refresh') !== '0';
          let providers: unknown;
          try {
            /*
             * Apply an additional time limit to the refresh=0 path (diagnostic snapshot).
             *
             * But **make it clear what this time limit cannot cover**, and do not treat it as a non-existent
             * guarantee: probeVersion in runners/index.mjs uses execFileSync, and all three providers call it
             * before the first await: that is, the listProviders(...) call itself blocks synchronously (up to
             * 15 seconds per CLI), and the setTimeout below is created only after it returns. If a CLI truly
             * hangs, this race does not take effect at all, and the entire dev server freezes together. The
             * real fix is changing probeVersion to async execFile, which requires a separate review round.
             *
             * What it does cover: the liveness probe itself returning slowly (rather than hanging completely),
             * and listProviders throwing an error. In both cases, node and sessions are returned as usual
             * below: those two sections are the most valuable output of this button and should not suffer
             * collateral damage from the providers slot.
             *
             * Do not overestimate the cache either: TTL is only 5 seconds (index.mjs), almost never hitting
             * when the user clicks the button, so the actual benefit of refresh=0 is "do not force refresh
             * probeAuth", not "serve directly from cache".
             *
             * The refresh=true path ("Diagnostics" in AI settings) applies no time limit: it wants the real
             * liveness probe result.
             */
            providers = refresh
              ? await runners.listProviders({ refresh })
              : await Promise.race([
                  runners.listProviders({ refresh: false }),
                  new Promise((resolve) => setTimeout(() => resolve({ error: 'Driver probe timed out', note: 'No reply after 2.5 seconds, skipping this field for now. The machine status below is still valid' }), 2500)),
                ]);
          }
          catch (e: any) { providers = { error: e?.message || String(e), note: 'Driver probe failed. The machine status below is still valid' }; }
          sendJson(res, 200, {
            ok: true,
            generatedAt: new Date().toISOString(),
            app: {
              platform: process.platform,
              arch: process.arch,
              node: process.version,
              cliHome: setupRoot(),
              configPath: process.env.PROMPTCUT_AI_CONFIG || '(default %LOCALAPPDATA%\\promptcut\\ai.json)',
            },
            machineCode: redactMachineCode(machineCode()),
            machineCodeNote: 'Only the first group is kept: the machine code is also the decryption passphrase for config distribution, so the full string is never sent out',
            // Current state of this local service process: uptime, remaining memory, packaged build or running
            // from source. For "it works after a restart" issues, without inspecting these you can only guess.
            node: env.nodeStatus(),
            /*
             * Backend session filing cabinet. Chats in the UI follow the project, whereas **which history the
             * server connects to** depends on that session id in localStorage; when the two are disconnected,
             * nothing can be seen in the UI (see 81f255b). Reporting "how many segments, how many items each,
             * how recent" is the only physical evidence of such invisible crosstalk. Contains no chat content.
             */
            sessions: env.inspectSessionStore(),
            providers,
            providersRefreshed: refresh,
            config: publicConfig(),
          });
        } catch (e: any) { sendJson(res, 500, { ok: false, error: e.message }); }
      });

      /*
       * Local identification code: used as encryption passphrase when distributing API configuration.
       * Only provides the digested code; raw fingerprints do not leave the server.
       *
       * Here we **intentionally return the full code**, not truncated like /api/ai/diagnostics: the user
       * needs to send this entire string to the person encrypting configuration for them, and truncating
       * it breaks this feature. Its protection comes from the same-origin checkpoint in
       * vite-plugin-api-guard: other web pages on this machine (all cross-origin) cannot hit
       * this endpoint.
       */
      server.middlewares.use('/api/ai/machine-code', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const { machineCode } = await import(new URL('./runners/machine-id.mjs', import.meta.url).href);
          res.setHeader('Cache-Control', 'no-store');
          sendJson(res, 200, { ok: true, code: machineCode() });
        } catch (e: any) { sendJson(res, 500, { ok: false, error: e.message }); }
      });

      server.middlewares.use('/api/ai/config', async (req, res) => {
        try {
          const { publicConfig, writeConfig, clearKey } = await import(new URL('./ai-config.mjs', import.meta.url).href);
          // POST /api/ai/config/clear-key {kind}: delete that provider's key file ("Clear key" in settings)
          if ((req.url || '').split('?')[0] === '/clear-key') {
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
            let body = '';
            let over = false;
            req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, 'Request body exceeds 8KB'); });
            req.on('end', () => {
              if (over) return;
              try {
                const { kind } = JSON.parse(body || '{}');
                clearKey(kind);
                sendJson(res, 200, { ok: true, config: publicConfig() });
              } catch (e: any) {
                sendJson(res, 400, { ok: false, error: e.message });
              }
            });
            return;
          }
          if (req.method === 'GET') {
            return sendJson(res, 200, { ok: true, config: publicConfig() });
          } else if (req.method === 'POST') {
            let body = '';
            let over = false;
            req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 200_000, tr("Request body is over 200KB")); });
            req.on('end', () => {
              if (over) return;
              try {
                const partial = JSON.parse(body);
                writeConfig(partial);
                sendJson(res, 200, { ok: true, config: publicConfig() });
              } catch (e: any) {
                sendJson(res, 400, { ok: false, error: e.message });
              }
            });
          } else {
            sendJson(res, 405, { ok: false, error: 'GET or POST only' });
          }
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: String(e) });
        }
      });

      server.middlewares.use('/api/ai/agy-permissions', async (req, res) => {
        try {
          const { status, grant } = await import(new URL('./agy-permissions.mjs', import.meta.url).href);
          if (req.method === 'GET') {
            return sendJson(res, 200, { ok: true, ...status() });
          } else if (req.method === 'POST') {
            return sendJson(res, 200, { ok: true, ...grant() });
          } else {
            sendJson(res, 405, { ok: false, error: 'GET or POST only' });
          }
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: String(e) });
        }
      });

      // Quota: for display in settings. refresh=1 forces a recheck (Claude runs claude -p, ~10 seconds)
      server.middlewares.use('/api/ai/quota', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const url = new URL(req.url || '/', 'http://localhost');
          const provider = url.searchParams.get('provider') || '';
          const { guard, mod } = await getQuotaGuard();
          if (!mod.QUOTA_PROVIDERS.includes(provider)) return sendJson(res, 400, { ok: false, error: tr("Only claude / codex have a quota window") });
          const { publicConfig } = await import(new URL('./ai-config.mjs', import.meta.url).href);
          const cfg = mod.normalizeQuotaConfig(publicConfig().quota);
          const quota = await guard.get(provider, { refresh: url.searchParams.get('refresh') === '1' });
          // When querying from the panel, the model must also be included; otherwise the displayed
          // "Circuit broken" will not match the evaluation when actually initiating chat
          const verdict = guard.verdict(provider, cfg, url.searchParams.get('model') || '');
          sendJson(res, 200, { ok: true, quota, config: cfg, blocked: !!verdict.blocked, message: verdict.message ?? null, bytesSince: guard.bytesSince(provider) });
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: String(e) });
        }
      });

    }
  };
}

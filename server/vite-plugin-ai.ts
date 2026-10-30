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
 * 必须静态 import:vite 打包配置时,别的插件静态引入的 prerender-client.mjs 被打进同一个包里,
 * 状态(预渲染的地址、就绪没有)在那一份上。这里要是换成 import(new URL(...)) 动态加载,拿到的是
 * 磁盘上的另一份模块实例,状态永远是空的 —— 实测服务端 see_frames 在 whenPrerenderReady 里干等 60 秒。
 */
import { prerenderPost } from './prerender-client.mjs';
// 镜像的存储本体在镜像插件里(两个进程都挂);这里只读当前编辑页 session 的最新一版
import { latestMirror, latestPlayhead } from './vite-plugin-mirror';


/**
 * 在文件管理器里打开一个目录。
 * explorer 打开目录时退出码就是 1,所以这里不看退出码,也不等它。
 */
function revealInFileManager(dir: string) {
  const opener = process.platform === 'win32' ? 'explorer.exe'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打不开就算了,文件已经写好了,路径也会回给界面 */
  }
}

function sendJson(res: ServerResponse, code: number, data: any) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

/* 请求体超限的 413:实现挪去 server/http-guard.mjs 了,vision 那边也要用同一份 */

export default function vitePluginAi(): Plugin {
  return {
    name: 'vite-plugin-ai',
    configureServer(server) {
      server.httpServer?.on('listening', () => {
        // 这个文件是桌面 APP 的会话(server/mcp-server.mjs)找「用户正在用的那个实例」的依据,被别的实例盖掉就会
        // 把用户的桌面 APP 引到错误的端口上。测试与探针起的编辑器(PROMPTCUT_NO_PORT_FILE=1)不写:公共入口
        // scripts/lib/no-user-dirs.mjs 与 npm test 的全局准备把它设上;桌面版和用户自己 `npm run dev` 起的编辑器照旧写
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
               * 两个舞台端口(E1)。编辑器端口 +1 / +2 的反向代理,舞台 iframe 从它们加载 ——
               * 写进来是给**页面之外**的人看的:桌面壳要按它给 WebView2 放行 / 探端口占用,
               * 探针脚本不用再自己推算。页面不读这里(端口表由 vite-plugin-stage-ports 注入)。
               * 代理没起来(端口被占)时页面退回同源单舞台,这张表仍然是「本该是哪两个」。
               */
              stagePorts: stagePortsOf(port),
              pid: process.pid,
              startedAt: Date.now()
            }));
          }
        } catch {}
      });

      /*
       * Agent 服务的实现在 server/agent/service/instance.mjs(契约 docs/plan/cloud-agent-contract.md 第 2.1 节):
       * 页面通道、项目副本、工具调用入口、对话、多 Agent 与桌面会话的接口都在那里,这里把它的路由原样挂到编辑器进程上。
       * 留在本文件的是只属于桌面的接口:驱动清单、安装与登录、诊断、机器码、配置、额度面板,以及上面的 port.json。
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
          throw new Error(`Runner 尚未就绪或加载失败: ${e.message}`);
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
       * 列出某家能用的模型。
       *
       * 两条路:
       *   - `agy`:跑 `agy models`(输出是「名字<TAB>说明」);
       *   - `api`:打 OpenAI 兼容的 `GET {baseUrl}/v1/models`。中转站基本都实现了这个口子,
       *     返回 `{ data: [{ id, object, owned_by }], object: "list" }`。
       *
       * claude / codex 没有对应命令,清单只能在设置里手填 —— 与其编一份可能过期的
       * 硬编码名单,不如老实说这一家读不到。
       */
      server.middlewares.use('/api/ai/models', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        const provider = new URL(req.url || '/', 'http://localhost').searchParams.get('provider');

        if (provider === 'api') {
          try {
            const { readConfig } = await import(new URL('./ai-config.mjs', import.meta.url).href);
            const api = (readConfig() as any)?.api || {};
            if (!api.apiKey) return sendJson(res, 400, { ok: false, error: '还没填 API Key,拉不了模型清单' });
            if (!api.baseUrl) return sendJson(res, 400, { ok: false, error: '还没填接口地址(官方源没有统一的清单口子,中转站才有)' });
            const { listApiModels } = await import(new URL('./runners/api-models.mjs', import.meta.url).href);
            const models = await listApiModels(api);
            return sendJson(res, 200, { ok: true, models });
          } catch (e: any) {
            return sendJson(res, 500, { ok: false, error: e.message || String(e) });
          }
        }

        if (provider !== 'agy') {
          return sendJson(res, 400, { ok: false, error: '这一家没有列出模型的命令,请在上面手填' });
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
          // 只收「名字<TAB>说明」那些行,把「Fetching available models...」之类的抬头滤掉
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
          // 粘贴授权码:把用户在登录对话框里粘的那串码送进正在跑的 Claude 登录任务的标准输入。
          // 码是凭证:不写日志,出错信息里不带它;形状校验和写入在 setup.mjs 的 submitCode。
          if (!req.headers['content-type']?.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'JSON required' });
          if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host && req.headers.origin !== 'https://' + req.headers.host) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
          let body = '';
          let over = false;
          req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, '请求体超过 8KB'); });
          req.on('end', async () => {
            if (over) return;
            try {
              const parsed = JSON.parse(body || '{}');
              const job = (await setupService).submitCode(parsed.provider, parsed.code);
              sendJson(res, 200, { ok: true, job });
            } catch (e: any) { sendJson(res, 400, { ok: false, error: e instanceof SyntaxError ? '请求不是有效的 JSON' : e.message }); }
          });
          return;
        }
        if (req.method === 'DELETE') {
          if (!req.headers['content-type']?.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'JSON required' });
          if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host && req.headers.origin !== 'https://' + req.headers.host) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
          let body = '';
          let over = false;
          req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, '请求体超过 8KB'); });
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
          req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, '请求体超过 8KB'); });
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
       * POST /api/ai/diagnostics/save —— 报告太长时存成文件,并打开它所在的文件夹。
       *
       * 为什么不一律走剪贴板:诊断报告带上每一步执行事件之后动辄几百 KB,
       * 粘到聊天框里既贴不动也没人看。超过阈值就落盘,让用户直接把文件发过来。
       *
       * **每次单独建一个带时间戳的文件夹**,里面就这一个 txt。直接打开
       * 「诊断报告」总目录的话,用户会看到一堆历次的文件,还得自己认哪个是刚生成的。
       */
      server.middlewares.use('/api/ai/diagnostics/save', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        let tooBig = false;
        // 报告本身就是大块头,这里的上限只用来挡住明显不正常的请求
        req.on('data', (c) => { if (tooBig) return; body += c; tooBig = overLimit(req, res, body.length, 64 * 1024 * 1024, '报告超过 64MB,没有保存'); });
        req.on('end', () => {
          if (tooBig) return;
          try {
            const { text, label } = JSON.parse(body || '{}');
            if (typeof text !== 'string' || !text) return sendJson(res, 400, { ok: false, error: 'text 必填' });
            const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
            const safeLabel = String(label || '诊断').replace(/[\\/:*?"<>|]/g, '');
            // 和 ai.json 放一处,不往桌面上堆东西;反正马上就用资源管理器打开了
            const root = path.join(process.env.LOCALAPPDATA || os.homedir(), 'promptcut', '诊断报告');
            const dir = path.join(root, `${safeLabel}-${stamp}`);
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `${safeLabel}-${stamp}.txt`);
            // 带 BOM:Windows 记事本没有它会把中文按 ANSI 读成乱码
            fs.writeFileSync(file, '﻿' + text, 'utf8');
            revealInFileManager(dir);
            sendJson(res, 200, { ok: true, dir, file });
          } catch (e: any) { sendJson(res, 500, { ok: false, error: e.message }); }
        });
      });

      // 排查信息:用户点「诊断」时一次性拿全,复制给我们看。
      // 里面绝不能有明文 Key —— publicConfig() 已经把它换成 { set, last4 }。
      //
      // 机器码同样要脱敏。它不只是个编号,它**就是**分发 API 配置时的加密口令
      // (configShare 拿它当 password),整串写进报告等于把解密口令一起交出去。
      // 只留第一组:够我们认出是哪台机器,不够任何人拿去解密。
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
           * 驱动探活会给 claude / codex / agy 各起一个子进程(runners/auth.mjs,
           * 单个超时 15 秒)。诊断报告那条路等不起,而且它要的是**这台机器的现状**,
           * 不是「CLI 现在还登着吗」,所以它带 ?refresh=0 走进程内缓存。
           *
           * 还要把它单独 try 起来:原来整个响应是 all-or-nothing 的,探活一抛错就 500,
           * 把 node 和 sessions 一起带走 —— 而那两段恰恰是这个按钮最有价值的产出,
           * 偏偏在机器出问题的时候最容易被连坐。
           */
          const refresh = new URL(req.url || '/', 'http://x').searchParams.get('refresh') !== '0';
          let providers: unknown;
          try {
            /*
             * refresh=0 那条路(诊断快照)再压一道时限。
             *
             * 但**要说清这道时限管不到什么**,别把它当成一张不存在的保票:
             * runners/index.mjs 的 probeVersion 用的是 execFileSync,而三个 provider
             * 都在第一个 await 之前调它 —— 也就是说 listProviders(...) 这个调用本身
             * 就同步阻塞(每个 CLI 上限 15 秒),下面那个 setTimeout 要等它返回之后
             * 才被创建。CLI 真卡住时这道 race 完全不生效,整个 dev server 一起冻住。
             * 真修法是把 probeVersion 改成异步 execFile,那要单独一轮评审。
             *
             * 它管得到的是:探活本身返回慢(而不是卡死)、以及 listProviders 抛错。
             * 这两种下面照常把 node 和 sessions 返回 —— 那两段才是这个按钮最有价值的
             * 产出,不该被 providers 这一格连坐。
             *
             * 缓存也别高估:TTL 只有 5 秒(index.mjs),用户点按钮时基本不命中,
             * 所以 refresh=0 的实际收益是「不强制刷新 probeAuth」,不是「直接走缓存」。
             *
             * refresh=true 那条路(AI 设置里的「诊断」)不压时限:它要的就是真实探活结果。
             */
            providers = refresh
              ? await runners.listProviders({ refresh })
              : await Promise.race([
                  runners.listProviders({ refresh: false }),
                  new Promise((resolve) => setTimeout(() => resolve({ error: '驱动探活超时', 说明: '超过 2.5 秒没回来,这一格先跳过 —— 下面那些机器状态仍然有效' }), 2500)),
                ]);
          }
          catch (e: any) { providers = { error: e?.message || String(e), 说明: '驱动探活失败 —— 下面那些机器状态仍然有效' }; }
          sendJson(res, 200, {
            ok: true,
            generatedAt: new Date().toISOString(),
            app: {
              platform: process.platform,
              arch: process.arch,
              node: process.version,
              cliHome: setupRoot(),
              configPath: process.env.PROMPTCUT_AI_CONFIG || '(默认 %LOCALAPPDATA%\\promptcut\\ai.json)',
            },
            machineCode: redactMachineCode(machineCode()),
            machineCodeNote: '只保留首组:机器码同时是配置分发的解密口令,整串不外发',
            // 本地服务这个进程的现状:跑了多久、内存还剩多少、是打包版还是源码跑的。
            // 「重启一下就好了」这类问题,不看这些就只能靠猜。
            node: env.nodeStatus(),
            /*
             * 后端的会话文件柜。界面上的对话是按项目走的,而**服务端接哪段历史**取决于
             * localStorage 里那把会话 id;两者脱节时界面上完全看不出来(见 81f255b)。
             * 报「有几段、各几条、多新」,是这类看不见的串台唯一的物证。不含对话内容。
             */
            sessions: env.inspectSessionStore(),
            providers,
            providersRefreshed: refresh,
            config: publicConfig(),
          });
        } catch (e: any) { sendJson(res, 500, { ok: false, error: e.message }); }
      });

      /*
       * 本机识别码:分发 API 配置时当加密口令用。只给摘要后的码,原始指纹不出服务端。
       *
       * 这里**故意返回完整码**,不像 /api/ai/diagnostics 那样截断 —— 用户就是要把这一整串
       * 发给帮他加密配置的人,截了这个功能就没了。它的保护来自 vite-plugin-api-guard 那道
       * 同源卡口:本机上别的网页(它们都是跨源)打不进这个接口。
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
          // POST /api/ai/config/clear-key {kind}:删掉那一路的密钥文件(设置窗口里的「清理密钥」)
          if ((req.url || '').split('?')[0] === '/clear-key') {
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
            let body = '';
            let over = false;
            req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, '请求体超过 8KB'); });
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
            req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 200_000, '请求体超过 200KB'); });
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

      // 额度:给设置窗口显示用。refresh=1 强制重查(Claude 那条要跑一次 claude -p,十来秒)
      server.middlewares.use('/api/ai/quota', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const url = new URL(req.url || '/', 'http://localhost');
          const provider = url.searchParams.get('provider') || '';
          const { guard, mod } = await getQuotaGuard();
          if (!mod.QUOTA_PROVIDERS.includes(provider)) return sendJson(res, 400, { ok: false, error: '只有 claude / codex 有额度窗口' });
          const { publicConfig } = await import(new URL('./ai-config.mjs', import.meta.url).href);
          const cfg = mod.normalizeQuotaConfig(publicConfig().quota);
          const quota = await guard.get(provider, { refresh: url.searchParams.get('refresh') === '1' });
          // 面板问的时候也要带上模型,不然显示的「已熔断」和真正发起对话时的判定对不上
          const verdict = guard.verdict(provider, cfg, url.searchParams.get('model') || '');
          sendJson(res, 200, { ok: true, quota, config: cfg, blocked: !!verdict.blocked, message: verdict.message ?? null, bytesSince: guard.bytesSince(provider) });
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: String(e) });
        }
      });

    }
  };
}

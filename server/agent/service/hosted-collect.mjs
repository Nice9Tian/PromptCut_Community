/**
 * 云端 Agent 的网页采集(`collect_status`、`collect_install`、`collect_search`、`collect_probe`、`collect_download`、`collect_job`、
 * `collect_logout`;契约 `docs/plan/cloud-agent-contract.md` 第 9.4d 节)。
 *
 * 桌面版里这些工具打编辑器进程的 `/api/collect/*`,由它起 `python -m promptcut_collect <子命令>`(里面是 yt-dlp 与 ffmpeg)。
 * 云节点上没有编辑器进程,这里照同一份命令行与 JSONL 约定起同一个包,规矩是:
 *
 *   - **外部程序只经工作区的受限子进程起**(`workspace.mjs` 的 `spawn`):工作目录是这个对话的工作目录,环境变量按白名单重建,
 *     不带任何 `PROMPTCUT_*`、服务的私钥目录与数据目录;起出来的是一棵杀得掉的进程树,超时、取消、超限时杀的是整棵树
 *     (Python 再起的下载与 ffmpeg 一起),等到 exit + close 才算完(公共实现 `perception/runner.mjs`);
 *   - **Python 用隔离模式起**(`-I`):工作目录里是成员和模型弄进来的文件,不让它排进模块搜索路径;包目录只来自部署配置;
 *   - **只经出网闸的代理出网**(`egress.mjs` 的 `startProxy`):子进程的环境里只有指向这个回环代理的 `HTTP_PROXY` / `HTTPS_PROXY`,
 *     代理对每个目标做与出网闸相同的检查——回环、内网、云厂商元数据地址、同机服务一律到不了。每次调用起一个代理、用完关掉;
 *   - **下载物只落在对话的工作目录**(`collect/<作业号>/`),进素材库走 `import_media` 的那条路(凭成员本人的素材票据写素材服务、
 *     在项目副本上登记;只读成员在下载之前就被拒);入库后删掉;
 *   - **作业表在服务端**,按实例(项目 × 成员)分,并随对话落盘(`collect/jobs.json`):服务重启后查得到「中断了」,不是「找不到」;
 *   - **上限**:单个作业的下载物大小、时长、墙钟时间,整个进程与每位成员同时在跑的作业数;
 *   - **用量**:每次调用记一行(`service: 'collect'`,按次数与下载的字节)。
 *
 * **`collect_install` 在云端不装东西**:节点上有没有采集工具由部署决定(`PROMPTCUT_AGENT_COLLECT_PYTHON`),模型不能触发往节点上装。
 * 登录态(`user_interface_collect_login`)要用户自己扫码,是「要操作发起人界面」的工具;云端不存任何站点的 cookies,下载按未登录的画质。
 *
 * **需要登录的站点(0.7.18,工具包 C1;`collect-bridge.mjs`)**:宿主给了 `delegate`(绑在当前这一轮上的委托口子)时,
 * `collect_download` 先问它——链接属于有登录支持的站点、发起人本人在线且用的是桌面版、他的电脑上有登录态,就由他的电脑下载并
 * 直接传进这个项目的素材库,云端核实后登记(作业的 `route` 是 `delegated`);其余情形一律照旧在云端匿名下载(`route` 是 `anonymous`),
 * 委托没成的原因与画质差别写进作业的 `notes`。`collect_login`、`collect_login_check` 只在本人电脑上操作,也经这个口子。
 * 不给 `delegate` 时本文件的行为与原来一模一样。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedPythonArgs, splitRoots, superviseChild } from './perception/runner.mjs';

export const COLLECT_DEFAULTS = Object.freeze({
  /** 查状态、探测、搜索的时限 */
  statusMs: 20_000,
  probeMs: 50_000,
  /** 一个下载作业的墙钟上限 */
  downloadMs: 15 * 60_000,
  /** 一个作业的下载物合计上限(与按地址导入素材同一个数) */
  maxDownloadBytes: 512 * 1024 * 1024,
  /** 片子的时长上限(秒):探到更长的就停 */
  maxDurationSeconds: 2 * 3600,
  /** 一个作业最多入库几个文件(多 P 稿件) */
  maxItems: 20,
  /** 整个进程同时在跑的下载 */
  maxRunning: 2,
  /** 一位成员在一个项目里同时在跑的下载 */
  maxRunningPerInstance: 1,
  /** 作业表里留多少条已结束的 */
  historyJobs: 20,
  /** 多久量一次下载目录的体积 */
  watchMs: 1500,
});

/** 没有委托口子(没接线,或不是账号模式)时两个登录工具的回答:如实说只能在本人电脑上操作 */
const LOGIN_LOCAL_ONLY = (tool) => ({
  ok: false, initiatorOnly: true,
  error: `${tool} 只能在发起人自己的电脑上操作:站点的登录态只留在他的机器上,云端不存、也拿不到。请告诉用户在电脑上的 PromptCut 里登录;云端照常按未登录的画质采集。`,
});
const NOT_INSTALLED = '这台云节点没有装采集工具(yt-dlp)。云端不能由 Agent 往节点上装东西:请告诉用户联系托管方,或在电脑上的 PromptCut 里采集后导入。';
const QUALITIES = new Set([2160, 1440, 1080, 720, 480, 360]);
const SITES = new Set(['auto', 'bilibili', 'generic']);
/** 模型给的链接:只收 http(s) 地址,或 B 站的 BV 号 / av 号 */
const URL_OK = /^(?:https?:\/\/[^\s]+|BV[0-9A-Za-z]{10}|av\d{1,12})$/i;

/** 一个实例(项目 × 成员)的作业表 */
export const newCollectState = () => ({ jobs: new Map() });

/**
 * 进程级的那一份。
 * @param {object} o
 * @param {{ python: string, args?: string[], pythonPath?: string, ffmpegDir?: string } | null} o.config 节点上的采集工具(部署决定);没有就是 null
 * @param {{ startProxy(): Promise<{ url: string, close(): Promise<void> }> }} o.egress 出网闸
 */
export function createCollect({ config = null, egress, limits: limitsIn = {}, log = () => {} } = {}) {
  const limits = { ...COLLECT_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响工具 */ } };
  let running = 0;
  /** `config.args` 只给探针与单测(把解释器整个换成替身脚本,见 `readCollectConfig`);正式的一律隔离模式,包目录来自部署配置 */
  const stubArgs = config && Array.isArray(config.args) && config.args.length ? config.args : null;
  const pythonArgv = (sub, args) => (stubArgs
    ? [...stubArgs, sub, ...args]
    : isolatedPythonArgs('promptcut_collect', { roots: splitRoots(config.pythonPath), args: [sub, ...args] }));

  /**
   * 起一次采集子进程:经工作区(工作目录、环境白名单、进程树)、只给它出网闸的代理。逐行读 JSONL。
   * 回 `{ child, done, kill }`:`done` 在整棵进程树 exit + close、代理也关了之后解析成 `{ code, events, stderrTail }`;`kill` 杀整棵树。
   */
  async function runCollect(ws, sub, args, { timeoutMs, onEvent = () => {}, signal } = {}) {
    if (!config) throw Object.assign(new Error(NOT_INSTALLED), { notInstalled: true });
    const proxy = await egress.startProxy();
    const pathKey = Object.keys(process.env).find((k) => /^path$/i.test(k)) ?? 'PATH';
    // PYTHON* 环境变量在隔离模式下不生效(无缓冲、UTF-8、不写字节码、包目录都由命令行给),这里不设
    const env = {
      HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, ALL_PROXY: proxy.url, http_proxy: proxy.url, https_proxy: proxy.url, all_proxy: proxy.url,
      NO_PROXY: '', no_proxy: '',
      ...(config.ffmpegDir ? { [pathKey]: `${config.ffmpegDir}${path.delimiter}${process.env[pathKey] ?? ''}` } : {}),
    };
    let child;
    try {
      child = ws.spawn(config.python, pythonArgv(sub, args), { env });
    } catch (err) {
      await proxy.close().catch(() => {});
      throw err;
    }
    const events = [];
    const stderrTail = [];
    let buf = '';
    const feed = (text) => {
      buf += text;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const lineText = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!lineText) continue;
        try { const ev = JSON.parse(lineText); if (ev && typeof ev === 'object') { events.push(ev); onEvent(ev); } } catch { /* 不是 JSON 的行不要 */ }
        if (events.length > 5000) events.splice(0, 1000);
      }
    };
    // 采集还没有接运行资源登记器(它拿不到这一轮的可信上下文,接线归最后的接线包):取消走调用方给的信号,超时在这里
    const run = await superviseChild(child, {
      timeoutMs, signal,
      onStdout: (d) => feed(d.toString('utf8')),
      onStderr: (d) => { for (const l of d.toString('utf8').split(/\r?\n/)) if (l.trim()) { stderrTail.push(l.trim().slice(0, 300)); if (stderrTail.length > 20) stderrTail.shift(); } },
    });
    const done = run.done.then(async (end) => {
      if (buf.trim()) feed('\n');
      if (end.spawnError) stderrTail.push(String(end.spawnError?.message ?? end.spawnError).slice(0, 300));
      await proxy.close().catch(() => {});
      return { code: end.spawnError ? -1 : (end.code ?? -1), events, stderrTail };
    });
    return { child, done, kill: run.kill };
  }

  const pickError = (events, stderrTail, code) => {
    const ev = [...events].reverse().find((e) => e.event === 'error');
    if (typeof ev?.message === 'string' && ev.message) return ev.message.slice(0, 300);
    const useful = [...stderrTail].reverse().find((l) => /error|失败|找不到|not found|refused|forbidden/i.test(l));
    return (useful || `采集进程退出码 ${code}`).slice(0, 300);
  };

  /**
   * 一个对话的工具。
   * @param {object} d
   * @param {ReturnType<typeof newCollectState>} d.state 这个实例的作业表
   * @param {() => object} d.workspace
   * @param {() => Promise<void>} d.ensureCanWrite
   * @param {(rel: string, name: string) => Promise<{ mediaId: string, kind: string, clipId?: string, duration?: number, width?: number, height?: number, bytes?: number }>} d.importFile
   *   把工作区里的一个文件装进素材库(`import_media` 的那条路)
   * @param {(row: object) => void} d.record
   * @param {null | (() => (null | { download?: Function, login: Function, loginCheck: Function }))} [d.delegate]
   *   当前这一轮的委托口子(`collect-bridge.mjs` 的 `forRun(context)`);每次调用现取,没有就回 null(照旧只在云端匿名下载)
   */
  function forConversation({ state, workspace, ensureCanWrite, importFile, record = () => {}, ToolError = Error, conversationId = '', delegate = null }) {
    const currentDelegate = () => {
      try { const d = typeof delegate === 'function' ? delegate() : null; return d && typeof d.download === 'function' ? d : null; } catch { return null; }
    };
    /** 登录那两个工具用的口子。宿主可以只给登录、不给代下(代下没开放时):那时 `collect_download` 照旧只在云端匿名下载 */
    const currentLogin = () => {
      try { const d = typeof delegate === 'function' ? delegate() : null; return d && typeof d.login === 'function' && typeof d.loginCheck === 'function' ? d : null; } catch { return null; }
    };
    const usage = (model, { bytes = 0, ok = true, ms = 0 } = {}) => {
      try { record({ service: 'collect', vendor: 'yt-dlp', model, units: bytes, unit: 'bytes', ok, ms }); } catch { /* 记用量失败不影响结果 */ }
    };
    const viewOf = (job) => ({
      jobId: job.id, status: job.status, stage: job.stage, percent: job.percent, speed: job.speed ?? null, eta: job.eta ?? null,
      url: job.url, quality: job.quality, site: job.site, ...(job.route ? { route: job.route } : {}),
      ...(job.info ? { info: job.info } : {}), ...(job.notes.length ? { notes: job.notes.slice(-8) } : {}),
      ...(job.status === 'done' ? { items: job.items, mediaIds: job.items.map((it) => it.mediaId) } : {}),
      ...(job.message ? { message: job.message } : {}),
      startedAt: job.startedAt, finishedAt: job.finishedAt ?? null,
    });

    /** 作业表随对话落盘(只有可序列化的字段);写不了不影响作业 */
    const JOBS_FILE = 'collect/jobs.json';
    function persist() {
      try {
        const mine = [...state.jobs.values()].filter((j) => j.conversationId === conversationId).map((j) => {
          const { child: _c, abort: _a, ...rest } = j;
          return rest;
        });
        workspace().write(JOBS_FILE, JSON.stringify(mine));
      } catch (err) { say('agent.collect.persist-failed', { message: String(err?.message ?? err).slice(0, 120) }); }
    }
    /** 内存里没有的作业号:看这个对话落盘的那一份(服务重启过)。上次还在跑的,现在是「中断了」 */
    function fromDisk(id) {
      try {
        const ws = workspace();
        if (!ws.exists(JOBS_FILE)) return null;
        const saved = JSON.parse(ws.read(JOBS_FILE, { maxBytes: 2 * 1024 * 1024 }).toString('utf8'));
        const job = Array.isArray(saved) ? saved.find((j) => j?.id === id) : null;
        if (!job) return null;
        if (job.status === 'running') { job.status = 'error'; job.message = '云端 Agent 服务重启过,这次下载中断了。请重新 collect_download。'; job.finishedAt ??= Date.now(); }
        return { ...job, notes: Array.isArray(job.notes) ? job.notes : [], items: Array.isArray(job.items) ? job.items : [] };
      } catch { return null; }
    }
    function trim() {
      const done = [...state.jobs.values()].filter((j) => j.status !== 'running');
      for (const old of done.slice(0, Math.max(0, done.length - limits.historyJobs))) state.jobs.delete(old.id);
    }

    const checkUrl = (raw) => {
      const url = typeof raw === 'string' ? raw.trim() : '';
      if (!url || url.length > 2000 || !URL_OK.test(url)) throw new ToolError('url 要是 http(s) 开头的网页链接,或 B 站的 BV 号 / av 号。');
      return url;
    };
    const siteArgs = (site) => (typeof site === 'string' && SITES.has(site) && site !== 'auto' ? ['--site', site] : []);

    async function status() {
      if (!config) {
        return { ok: true, ready: false, cloud: true, ytdlp: { installed: false, version: null }, ffmpeg: null, presets: [], cookies: {}, hint: NOT_INSTALLED };
      }
      const t0 = Date.now();
      const run = await runCollect(workspace(), 'status', [], { timeoutMs: limits.statusMs });
      const out = await run.done;
      const st = out.events.find((e) => e.event === 'status');
      usage('status', { ok: !!st, ms: Date.now() - t0 });
      if (!st) return { ok: true, ready: false, cloud: true, ytdlp: { installed: false, version: null }, ffmpeg: null, presets: [], cookies: {}, hint: `采集工具起不来:${pickError(out.events, out.stderrTail, out.code)}。请告诉用户联系托管方。` };
      const { event: _e, pylibs: _p, ffmpeg, ...rest } = st;
      return {
        ok: true, ...rest, ffmpeg: !!ffmpeg, cloud: true, cookies: {},
        hint: rest.ready
          ? '云端的采集经托管方的出口出网,不带任何站点的登录态(按未登录的画质);下载物装进这个项目的素材库。'
          : (rest.ytdlp?.installed === false ? NOT_INSTALLED : '采集工具没有就绪(缺 ffmpeg 或别的依赖),这不是工具能修的,请告诉用户联系托管方。'),
      };
    }

    async function install() {
      const st = await status();
      if (st.ready) return { ok: true, ready: true, alreadyInstalled: true, hint: '这台云节点已经装好采集工具,不用装。' };
      return { ok: false, cloudUnavailable: true, error: NOT_INSTALLED };
    }

    async function search(args) {
      const query = typeof args?.query === 'string' ? args.query.trim().slice(0, 200) : '';
      if (!query) throw new ToolError('query 不能是空的');
      const limit = Math.min(10, Math.max(1, Math.round(Number(args.limit) || 5)));
      const site = args.site === 'generic' ? 'generic' : 'bilibili';
      const t0 = Date.now();
      const run = await runCollect(workspace(), 'search', ['--query', query, '--site', site, '--limit', String(limit)], { timeoutMs: limits.probeMs * 2 });
      const out = await run.done;
      const done = out.events.find((e) => e.event === 'done');
      usage('search', { ok: !!done, ms: Date.now() - t0 });
      if (!done) throw new ToolError(`搜索没有成功:${pickError(out.events, out.stderrTail, out.code)}`);
      const { event: _e, ...rest } = done;
      return { ok: true, ...rest };
    }

    async function probe(args) {
      const url = checkUrl(args?.url);
      const quality = QUALITIES.has(Number(args.quality)) ? ['--quality', String(Number(args.quality))] : [];
      const notes = [];
      const t0 = Date.now();
      const run = await runCollect(workspace(), 'probe', ['--url', url, ...siteArgs(args.site), ...quality], {
        timeoutMs: limits.probeMs,
        onEvent: (ev) => { if (ev.event === 'retry') notes.push(`第 ${ev.attempt} 次遇到临时错误,${ev.wait}s 后重试:${String(ev.message ?? '').slice(0, 160)}`); },
      });
      const out = await run.done;
      const done = out.events.find((e) => e.event === 'done');
      usage('probe', { ok: !!done, ms: Date.now() - t0 });
      if (!done) throw new ToolError(`探测没有成功:${pickError(out.events, out.stderrTail, out.code)}`);
      const { event: _e, formats: _f, ...rest } = done;
      const tooLong = Number(rest.duration) > limits.maxDurationSeconds;
      return { ok: true, ...rest, ...(notes.length ? { notes } : {}), ...(tooLong ? { tooLong: true, hint: `这段片子超过 ${Math.round(limits.maxDurationSeconds / 3600)} 小时,云端不下载这么长的。` } : {}) };
    }

    async function runDownload(job, args) {
      const ws = workspace();
      const rel = `collect/${job.id}`;
      const outDir = path.dirname(ws.resolve(`${rel}/x`));
      fs.mkdirSync(outDir, { recursive: true });
      const t0 = Date.now();
      let bytes = 0;
      let overLimit = null;
      const staged = [];
      let sawDone = false;
      const dirBytes = () => { let n = 0; try { for (const f of fs.readdirSync(outDir, { withFileTypes: true })) if (f.isFile()) n += fs.statSync(path.join(outDir, f.name)).size; } catch { /* 正在写 */ } return n; };
      const argv = ['--url', job.url, '--out-dir', outDir, '--quality', String(job.quality), ...siteArgs(job.site),
        ...(args.audioOnly === true ? ['--audio-only'] : []), ...(args.allParts === true ? ['--all-parts'] : []), ...(args.keepCodec === true ? ['--keep-codec'] : [])];
      let run = null;
      let watch = null;
      try {
        run = await runCollect(ws, 'download', argv, {
          timeoutMs: limits.downloadMs, signal: job.abort.signal,
          onEvent: (ev) => {
            if (ev.event === 'info') {
              job.info = { id: ev.id, title: ev.title, duration: ev.duration, uploader: ev.uploader, webpage_url: ev.webpage_url };
              if (Number(ev.duration) > limits.maxDurationSeconds) { overLimit = `这段片子超过 ${Math.round(limits.maxDurationSeconds / 3600)} 小时,云端不下载这么长的`; run?.kill(); }
            } else if (ev.event === 'retry') {
              job.notes.push(`第 ${ev.attempt} 次遇到临时错误,${ev.wait}s 后重试:${String(ev.message ?? '').slice(0, 160)}`);
            } else if (ev.event === 'progress') {
              const p = typeof ev.percent === 'number' ? ev.percent : undefined;
              job.stage = String(ev.stage ?? 'video');
              job.speed = typeof ev.speed === 'number' ? ev.speed : null;
              job.eta = typeof ev.eta === 'number' ? ev.eta : null;
              if (job.stage === 'transcode') job.percent = Math.round(97 + (p ?? 0) * 0.03);
              else if (job.stage === 'merge') job.percent = p && p >= 100 ? 99 : 97;
              else if (typeof ev.overall === 'number') job.percent = Math.round(ev.overall);
              else if (p != null) job.percent = Math.round(p * 0.9);
            } else if (ev.event === 'item') {
              if (staged.length < limits.maxItems) staged.push(ev);
            } else if (ev.event === 'done') {
              sawDone = true;
            }
          },
        });
        job.child = run.child;
        // 下载物的体积:边下边量,超了就停(代理只管去哪,不管下多少)
        watch = setInterval(() => {
          bytes = dirBytes();
          if (bytes > limits.maxDownloadBytes && !overLimit) { overLimit = `下载物超过 ${Math.round(limits.maxDownloadBytes / (1024 * 1024))} MB 的上限`; run.kill(); }
        }, limits.watchMs);
        watch.unref?.();
        const out = await run.done;
        clearInterval(watch); watch = null;
        bytes = Math.max(bytes, dirBytes());
        job.child = null;
        if (job.abort.signal.aborted) { job.status = 'error'; job.message = '已取消'; return; }
        if (overLimit || bytes > limits.maxDownloadBytes) { job.status = 'error'; job.message = `${overLimit ?? '下载物超过上限'},已停下,没有入库。`; return; }
        if (!sawDone) {
          const timedOut = Date.now() - t0 >= limits.downloadMs - 500;
          job.status = 'error';
          job.message = timedOut ? `下载超过 ${Math.round(limits.downloadMs / 60_000)} 分钟的时限,已停下。` : pickError(out.events, out.stderrTail, out.code);
          if (out.events.some((e) => e.notInstalled)) job.message = NOT_INSTALLED;
          return;
        }
        // 入库:只认这个作业目录里这一层的文件(按报上来的文件名取最后一段),别处的路径一概不认
        job.stage = 'ingest';
        for (const ev of staged) {
          const filename = path.basename(String(ev.filename ?? '') || String(ev.path ?? ''));
          // 下载器起的文件名可能带工作区不收的字符:先在作业目录里改成一个安全的名字,再经工作区核一遍(链接指到外面的照样被拒)
          const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(filename)?.[1] ?? '').toLowerCase();
          const fileRel = `${rel}/item-${job.items.length}${ext ? `.${ext}` : ''}`;
          let exists = false;
          try {
            const from = path.join(outDir, filename);
            if (filename && fs.lstatSync(from).isFile()) { fs.renameSync(from, path.join(outDir, path.basename(fileRel))); exists = ws.exists(fileRel); }
          } catch { exists = false; }
          if (!exists) { job.status = 'error'; job.message = `采集进程报了文件「${filename || '(没有文件名)'}」,作业目录里却没有它`; return; }
          try {
            const media = await importFile(fileRel, filename);
            job.items.push({
              title: typeof ev.title === 'string' ? ev.title.slice(0, 200) : undefined, filename,
              mediaId: media.mediaId, kind: media.kind, ...(media.clipId ? { clipId: media.clipId } : {}),
              duration: media.duration ?? (Number.isFinite(ev.duration) ? ev.duration : undefined), width: media.width ?? ev.width, height: media.height ?? ev.height,
              vcodec: typeof ev.vcodec === 'string' ? ev.vcodec : undefined, bytes: media.bytes,
            });
          } catch (err) {
            job.status = 'error';
            job.message = `下载好了但没能送进素材库:${String(err?.message ?? err).slice(0, 200)}`;
            return;
          }
        }
        if (!job.items.length) { job.status = 'error'; job.message = '采集进程说做完了,但没有报出任何文件。'; return; }
        job.status = 'done'; job.stage = 'done'; job.percent = 100;
      } catch (err) {
        job.status = 'error';
        job.message = String(err?.message ?? err).slice(0, 300);
      } finally {
        if (watch) clearInterval(watch);
        job.child = null;
        job.finishedAt = Date.now();
        running = Math.max(0, running - 1);
        usage('download', { bytes, ok: job.status === 'done', ms: Date.now() - t0 });
        // 作业目录用完就删(入了库的在素材服务里;没入库的不留)
        try { fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 留给对话删除时清 */ }
        trim();
        persist();
        say('agent.collect.job', { status: job.status, bytes, items: job.items.length, ms: Date.now() - t0 });
      }
    }

    /**
     * 一个下载作业从头到尾:有委托口子就先问它;委托成了作业就此做完;没成(或本来就不用委托)接着在云端匿名下载。
     * 委托口子说「这一轮已经不能写了」时不再匿名下载。
     */
    async function runJob(job, args, delegated) {
      if (delegated) {
        const t0 = Date.now();
        let out;
        try {
          out = await delegated.download({ id: job.id, url: job.url, quality: job.quality, site: job.site }, args, {
            signal: job.abort.signal,
            onProgress: (p) => {
              if (job.route !== 'delegated') { job.route = 'delegated'; persist(); }
              if (typeof p?.stage === 'string') job.stage = p.stage;
              if (typeof p?.percent === 'number') job.percent = Math.max(0, Math.min(99, Math.round(p.percent)));
            },
          });
        } catch (err) {
          say('agent.collect.delegate-failed', { code: String(err?.code ?? 'error').slice(0, 60) });
          out = { delegated: false, why: 'failed', note: '委托发起人的电脑下载没有成功;已改为云端按未登录的画质下载,画质可能低于登录后的。' };
        }
        if (out?.delegated === true || out?.stop === true) {
          const ok = out.delegated === true && Array.isArray(out.items) && out.items.length > 0;
          job.route = 'delegated';
          if (ok) { job.items = out.items; job.status = 'done'; job.stage = 'done'; job.percent = 100; job.notes.push('这条链接由发起人自己的电脑用他本机的登录态下载,文件由他的电脑直接传进这个项目的素材库;登录信息没有离开他的电脑。'); }
          else { job.status = 'error'; job.message = job.abort.signal.aborted ? '已取消' : String(out.message ?? '委托发起人的电脑下载没有成功。').slice(0, 300); }
          job.finishedAt = Date.now();
          running = Math.max(0, running - 1);
          usage('delegate', { bytes: ok ? job.items.reduce((sum, it) => sum + (Number(it.bytes) || 0), 0) : 0, ok, ms: Date.now() - t0 });
          trim();
          persist();
          say('agent.collect.job', { status: job.status, route: 'delegated', items: job.items.length, ms: Date.now() - t0 });
          return;
        }
        if (typeof out?.note === 'string' && out.note) job.notes.push(out.note.slice(0, 300));
      }
      job.route = 'anonymous';
      job.stage = 'starting'; job.percent = 0;
      if (!config) {
        job.status = 'error'; job.message = NOT_INSTALLED; job.finishedAt = Date.now();
        running = Math.max(0, running - 1);
        trim(); persist();
        return;
      }
      if (job.abort.signal.aborted) {
        job.status = 'error'; job.message = '已取消'; job.finishedAt = Date.now();
        running = Math.max(0, running - 1);
        trim(); persist();
        return;
      }
      persist();
      await runDownload(job, args);
    }

    async function download(args) {
      const url = checkUrl(args?.url);
      const delegated = currentDelegate();
      if (!config && !delegated) return { ok: false, cloudUnavailable: true, error: NOT_INSTALLED };
      // 下载物要进素材库:只读成员在下载之前就被拒(不白占带宽)
      await ensureCanWrite();
      const mine = [...state.jobs.values()].filter((j) => j.status === 'running').length;
      if (mine >= limits.maxRunningPerInstance) throw new ToolError(`已经有 ${mine} 个下载在跑,等它做完(collect_job 查进度)再下下一个。`);
      if (running >= limits.maxRunning) throw new ToolError('云端现在同时在跑的下载已满,过一会儿再试。');
      const job = {
        id: `collect-${randomBytes(6).toString('hex')}`, conversationId, url,
        quality: QUALITIES.has(Number(args.quality)) ? Number(args.quality) : 1080,
        site: typeof args.site === 'string' && SITES.has(args.site) ? args.site : 'auto',
        status: 'running', stage: 'starting', percent: 0, speed: null, eta: null, info: null, notes: [], items: [], message: null, route: null,
        startedAt: Date.now(), finishedAt: null, abort: new AbortController(), child: null,
      };
      if (typeof args.cookies === 'string' && args.cookies) job.notes.push('云端不存任何站点的登录态,cookies 参数没有用上(按未登录的画质下载)。');
      state.jobs.set(job.id, job);
      running += 1;
      persist();
      void runJob(job, args ?? {}, delegated);
      return { ok: true, jobId: job.id, status: 'running', hint: '下载在云端后台跑。用 collect_job 查进度,两次之间用 wait 等 3 秒;done 且带 mediaIds 才算进了素材库。' };
    }

    async function jobOf(args) {
      const id = String(args?.jobId ?? '');
      const job = state.jobs.get(id) ?? fromDisk(id);
      if (!job) throw new ToolError('找不到这个下载作业。');
      return { ok: job.status !== 'error', ...viewOf(job) };
    }

    return {
      collect_status: status,
      collect_install: install,
      collect_search: search,
      collect_probe: probe,
      collect_download: download,
      collect_job: jobOf,
      collect_logout: async () => ({ ok: true, loggedOut: false, note: '云端不存任何站点的登录态,没有可退出的。' }),
      /** 登录只在本人电脑上操作:有委托口子就经反向通道让发起页打开本机的登录窗口(本人不在线回不在线),没有就如实说 */
      collect_login: async (args) => { const d = currentLogin(); return d ? d.login(args ?? {}) : LOGIN_LOCAL_ONLY('user_interface_collect_login'); },
      collect_login_check: async (args) => { const d = currentLogin(); return d ? d.loginCheck(args ?? {}) : LOGIN_LOCAL_ONLY('collect_login_check'); },
      /** 这个对话结束或被删时调:停掉它还在跑的下载 */
      stopAll() { for (const j of state.jobs.values()) if (j.conversationId === conversationId && j.status === 'running') j.abort.abort(); },
    };
  }

  return { available: !!config, forConversation, limits, describe: () => ({ installed: !!config, running }) };
}

/**
 * 从环境变量读节点上的采集工具(部署决定)。没配回 null。
 *   PROMPTCUT_AGENT_COLLECT_PYTHON     装了 yt-dlp 的 Python 解释器(绝对路径;隔离模式起 `promptcut_collect`,包目录是检出里的 `python/`。
 *                                      隔离模式不看用户 site:yt-dlp 要装在这个解释器自己的 site-packages 或虚拟环境里)
 *   PROMPTCUT_AGENT_COLLECT_TEST_ARGS  **只给探针与单测**:JSON 数组,替换掉隔离模式的开关与包名(把解释器换成一个替身脚本)。
 *                                      生产不设;设了日志里有 `agent.collect.test-runner`
 */
export function readCollectConfig(env, { root }) {
  const python = env.PROMPTCUT_AGENT_COLLECT_PYTHON;
  if (typeof python !== 'string' || !python) return null;
  if (!path.isAbsolute(python) || !fs.existsSync(python)) return { error: 'PROMPTCUT_AGENT_COLLECT_PYTHON 要是存在的解释器的绝对路径' };
  let args = null;
  if (env.PROMPTCUT_AGENT_COLLECT_TEST_ARGS) {
    try { const a = JSON.parse(env.PROMPTCUT_AGENT_COLLECT_TEST_ARGS); if (Array.isArray(a) && a.every((x) => typeof x === 'string')) args = a; } catch { /* 下面报错 */ }
    if (!args) return { error: 'PROMPTCUT_AGENT_COLLECT_TEST_ARGS 要是字符串的 JSON 数组' };
  }
  const ffmpeg = env.PROMPTCUT_FFMPEG && path.isAbsolute(env.PROMPTCUT_FFMPEG) ? path.dirname(env.PROMPTCUT_FFMPEG) : null;
  return { python, ...(args ? { args, testRunner: true } : {}), pythonPath: path.join(root, 'python'), ...(ffmpeg ? { ffmpegDir: ffmpeg } : {}) };
}

/**
 * 「停下就精确」的探针:往回跳以后停下的活渲画面,要和往前到达的同一帧相同
 * (`docs/semantics/product/rendering.md`「停下就精确」;出处 `docs/plan/render-refactor-task.md`「己」的「先要修的两处」第 1 条)。
 *
 *   node scripts/probes/seek-back-exact-probe.mjs [--port 7484] [--out <目录>] [--json <文件>] [--cards a,b] [--modes natural,heavy,swap] [--survey [--survey-cards a,b]]
 *   node scripts/probes/seek-back-exact-probe.mjs --origin http://127.0.0.1:7480 …   # 接一台已经起好的 dev server,不自己起
 *
 * 不带 `--origin` 时自己起一台隔离的编辑器(`preview-stop-lib.mjs` 的 `startIsolatedEditor`;舞台端口是 +1、+2,三个连号都要空着),
 * 跑完结束它。Chrome 无头。
 *
 * 验什么。画布与 WebGL 的卡(粒子卡 `particles`、两张粒子封装卡、`scene-3d`,以及两张粒子卡叠在一起的 `particles-pair`),
 * 每个用例单独一个项目(0～6 秒),不播放,只在时间轴上点(`actions.seek`,父页发带 settle 的 `setTime`),
 * 每次等它回到精确活渲再取活画布的像素(`particles-pair` 是两张卡的画布上下拼成一张):
 *
 *   - `fwd37`:从第 20 帧往前跳到第 37 帧(跳 17 帧,走跳转那条路);`fwd59`、`fwd164` 同理,一路往前;
 *   - `back37`:从第 164 帧**往回跳**到第 37 帧;`back59`:从第 164 帧往回跳到第 59 帧;
 *   - `step38`:从 `back37` 往前挪一帧;`back37b`:再往回挪一帧;`fwd38`:从第 20 帧往前跳到第 38 帧;
 *   - `back0` / `init0`:回到第 0 帧 / 项目刚建好时的第 0 帧。
 *
 * 断言(每张卡、每种分派各一遍):
 *   - `back37` 与 `fwd37` 逐像素相同;`back59` 与 `fwd59`、`back37b` 与 `fwd37`、`step38` 与 `fwd38`、`back0` 与 `init0` 同理;
 *   - 对照:`fwd37` 与 `fwd59`(两个不同的时刻)差得明显 —— 不同的像素不少于 1000 个。粒子这类稀疏的画面,随便哪两帧的全图
 *     平均差都只有 1.2 左右,所以主断言用「一个像素都不差」,对照证明这把尺子在两个不同的帧之间量得出差别;
 *   - 每次取像素时这张卡是活渲(没挂快照、没被抑制、没在追帧);第 0 帧之外画布不是空的(`particles-pair` 两张各自都不空);
 *   - 舞台说重挂载了,包裹层就得是新挂的节点:这个舞台按片段重挂载的代数(`remountGen`)涨了,或者这一次是后台舞台整场景补跑后
 *     互换上来的(整台重挂载),那么到达之后这张卡的包裹层不能还是原来那个 DOM 节点(探针事先在节点上留记号)。
 *
 * 三种分派(`--modes`,缺省三种都跑):
 *   - `natural`:照页面自己测出来的成本记录;
 *   - `heavy`:钉成重卡(`pinnedHeavy`),停下时走可见舞台里按片段追帧那一路;
 *   - `swap`:钉成重卡并把记录改成只认全局时钟(`vtOk = false`),停下时走后台舞台整场景补跑再互换那一路。
 *
 * `--survey`:另外抽几张别的有状态的卡(`SURVEY_CARDS`;`--survey-cards` 点名)各走一遍同样的步骤,
 * 比的是可见舞台的截图(预览里缩放过的;先取消选中,免得编辑台画在上面的选中描边进图),结果只记录、不算失败(写进 `survey`)。
 * `--cards none` 时主用例一个都不跑,只抽查。
 *
 * 验收:退出码 0,结果里 `fails: []`。耗时只记录(`verification.md`「耗时只记录,不当闸门」)。等待时限只为防卡死。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { flagArg } from './probe-connect.mjs';
import { createTimings } from './probe-timings.mjs';
import { comparePixels, costRecordOf, decodePng, openEditorPage, savePng, sleep, startIsolatedEditor, waitFor } from './preview-stop-lib.mjs';

const args = process.argv.slice(2);
const GIVEN_ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '7484', args)) || 7484;
const RUN = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), `pc-seek-back-${RUN}`);
const OUT = path.resolve(flagArg('out', null, args) || path.join(WORK, 'out'));
const JSON_OUT = flagArg('json', null, args);
const SURVEY = args.includes('--survey');
const FPS = 30;
const SECONDS = 6;

const CARDS = {
  particles: { cardId: 'particles', params: { color: '#30ff60', quantity: 120, links: 'yes', seed: 5 } },
  'particles-snow': { cardId: 'particles-snow', params: {} },
  'particles-life': { cardId: 'particles-life', params: {} },
  'scene-3d': { cardId: 'scene-3d', params: { spinY: 0.4, spinX: 0.2 } },
  // 两张粒子卡同屏(各一条轨道):引擎的随机数源和容器名是全局的,两张卡不能互相顶替、互相取走对方的随机数
  'particles-pair': { clips: [
    { cardId: 'particles', params: { color: '#30ff60', quantity: 120, links: 'yes', seed: 5 } },
    { cardId: 'particles', params: { color: '#ff5fa0', quantity: 60, links: 'no', seed: 9, size: 6 } },
  ] },
};
const SURVEY_CARDS = {
  lottie: { cardId: 'lottie', params: {} },
  odometer: { cardId: 'odometer', params: {} },
  'mu-typing': { cardId: 'mu-typing', params: {} },
  'mu-number-ticker': { cardId: 'mu-number-ticker', params: {} },
  'terminal-3d': { cardId: 'terminal-3d', params: {} },
  'growth-curve': { cardId: 'growth-curve', params: {} },
  'punch-pill': { cardId: 'punch-pill', params: {} },
  'blur-text': { cardId: 'blur-text', params: {} },
  checklist: { cardId: 'checklist', params: {} },
  'ring-metric': { cardId: 'ring-metric', params: {} },
  'mu-word-rotate': { cardId: 'mu-word-rotate', params: {} },
};
// `--cards none`:主用例一个都不跑(只抽查时用)
const wantCards = (flagArg('cards', null, args) || Object.keys(CARDS).join(',')).split(',').map((s) => s.trim()).filter((s) => s && s !== 'none');
const wantModes = (flagArg('modes', null, args) || 'natural,heavy,swap').split(',').map((s) => s.trim()).filter(Boolean);
const wantSurvey = (flagArg('survey-cards', null, args) || Object.keys(SURVEY_CARDS).join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const fails = [];
const notes = [];
const timings = createTimings('seek-back-exact-probe');
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 700))); return !!cond; };

const out = { origin: null, ownEditor: !GIVEN_ORIGIN, out: OUT, cards: wantCards, modes: wantModes, cases: [] };
let editor = null;
let browser = null;
try {
  await fs.mkdir(OUT, { recursive: true });
  if (!GIVEN_ORIGIN) editor = await startIsolatedEditor({ port: PORT, work: WORK });
  const origin = (GIVEN_ORIGIN || editor.origin).replace(/\/+$/, '');
  out.origin = origin;
  const ed = await openEditorPage(origin);
  browser = ed.browser;
  const { page, store, frontFrame, frontId, parentDiag, stageFrames } = ed;

  /** 可见舞台里这几张卡此刻的状态(每张一份) */
  const cardStates = async (clipIds) => {
    const f = await frontFrame();
    if (!f) return null;
    return f.evaluate((ids) => {
      const d = window.__pcStageDiag?.();
      if (!d) return null;
      return ids.map((id) => {
        const wrap = document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]:not([data-pc-media])`);
        return {
          role: d.role, t: d.t, cls: wrap?.className ?? null,
          settling: d.settling.includes(id), suppressed: d.suppressed.includes(id), awaiting: d.awaiting.includes(id),
          snapshot: d.snapshots.includes(id), catchUps: d.catchUps.length,
          remountGen: (d.remountGen.find((e) => e[0] === id) ?? [id, 0])[1],
          pipeline: window.__pcStagePipelineAt?.(id, d.t) ?? null,
          // 包裹层节点上探针留的记号(`markWrappers`):还在 = 还是那个节点,没了 = 重挂载过
          mark: wrap ? wrap.__pcProbeMark ?? null : null,
        };
      });
    }, clipIds).catch(() => null);
  };

  /** 两个舞台里这几张卡的包裹层节点各留一个记号:之后记号还在,说明这个节点没有被重挂载过 */
  let markSeq = 0;
  const markWrappers = async (clipIds) => {
    const n = ++markSeq;
    for (const f of stageFrames()) {
      await f.evaluate((ids, n2) => {
        for (const id of ids) {
          const wrap = document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]:not([data-pc-media])`);
          if (wrap) wrap.__pcProbeMark = n2;
        }
      }, clipIds, n).catch(() => {});
    }
  };

  /** 这几张卡活画布此刻的像素(PNG):每张卡一条横带,从上到下拼成一张(一张卡就是它自己的画布) */
  const grabCanvas = async (clipIds) => {
    const f = await frontFrame();
    if (!f) return null;
    return f.evaluate((ids) => {
      const bands = [];
      for (const id of ids) {
        const wrap = document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]:not([data-pc-media])`);
        if (!wrap) return { error: 'no-wrap', id };
        const live = [...wrap.querySelectorAll('canvas')].filter((el) => !el.hasAttribute('data-pc-stream-plane')
          && !el.closest('[data-pc-snapshot-plane],[data-pc-placeholder-slot],[data-pc-proxy-plane]') && el.width && el.height);
        if (!live.length) return { error: 'no-canvas', id, cls: wrap.className };
        bands.push(live);
      }
      const w = Math.max(...bands.map((b) => b[0].width));
      const h = bands[0][0].height;
      const c = document.createElement('canvas');
      c.width = w; c.height = h * bands.length;
      const ctx = c.getContext('2d');
      bands.forEach((live, i) => { for (const el of live) ctx.drawImage(el, 0, i * h, el.width, h); });
      return { png: c.toDataURL('image/png'), bands: bands.length };
    }, clipIds).catch((e) => ({ error: String(e).slice(0, 200) }));
  };

  /** 可见舞台那个 iframe 的截图(抽查别的卡用:DOM 卡没有画布可取) */
  const grabStage = async () => {
    const id = await frontId();
    const handle = await page.$(`iframe[src*="stage=1"][src*="id=${id}"]`);
    if (!handle) return { error: 'no-iframe' };
    const b64 = await handle.screenshot({ encoding: 'base64', type: 'png' });
    return { png: 'data:image/png;base64,' + b64, bands: 1 };
  };

  /**
   * 点到第 `frame` 帧,等这几张卡回到精确活渲、画面稳住,回这一刻的像素。
   * 「稳住」:状态都落定之后隔 150 毫秒取两次、再隔 250 毫秒取第三次,三次相同,期间可见舞台没有换。
   */
  const arrive = async (clipIds, frame, label, { pin = null, shot = grabCanvas, tag = '' } = {}) => {
    if (pin) for (const id of clipIds) await costRecordOf(page, id, pin);
    const sec = frame / FPS;
    await markWrappers(clipIds);
    const before = await cardStates(clipIds);
    const beforeFront = await frontId();
    const started = Date.now();
    await store('actions.pause(); actions.seek(args[0]);', sec);
    const settledState = async () => {
      const pd = await parentDiag();
      if (!pd || pd.swapInFlight) return null;
      const last = pd.setTimeLog?.[pd.setTimeLog.length - 1];
      if (!last || Math.abs(last.sec - sec) > 1e-6 || !last.settle) return null;
      const list = await cardStates(clipIds);
      if (!list) return null;
      for (const s of list) {
        if (s.role !== 'front' || Math.abs(s.t - sec) > 1e-6) return null;
        if (s.settling || s.suppressed || s.awaiting || s.snapshot || s.catchUps) return null;
        if (/pc-(settling|suppressed|awaiting|snapshot)/.test(s.cls ?? '')) return null;
      }
      return { list, frontId: pd.frontId };
    };
    let result = null;
    let noShotSince = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const s1 = await settledState();
      if (!s1) { noShotSince = null; await sleep(50); continue; }
      const a = await shot(clipIds);
      if (!a?.png) {
        // 状态都落定了、活画布却一直取不到(画布被摘掉了):不必等满 30 秒
        noShotSince ??= Date.now();
        if (Date.now() - noShotSince > 4000) break;
        await sleep(80);
        continue;
      }
      noShotSince = null;
      await sleep(150);
      const b = await shot(clipIds);
      await sleep(250);
      const c = await shot(clipIds);
      const s2 = await settledState();
      if (!s2 || s2.frontId !== s1.frontId || a.png !== b?.png || b?.png !== c?.png) continue;
      result = { state: s2, png: c.png, bands: c.bands };
      break;
    }
    const ms = Date.now() - started;
    if (!result) {
      const pd = await parentDiag();
      check(false, `${tag}${label}:第 ${frame} 帧没有回到精确活渲、或取不到活画布`, { states: await cardStates(clipIds), shot: await shot(clipIds).then((r) => r?.error ?? 'ok', () => 'throw'),
        swapInFlight: pd?.swapInFlight, lastSetTime: pd?.setTimeLog?.slice(-2), heavy: pd?.snapshotFeed?.heavy });
      return null;
    }
    await savePng(OUT, `${tag}${label}.png`, result.png);
    const pixels = decodePng(result.png);
    // 每条横带(每张卡)各自有多少不透明的像素
    const bandH = pixels.h / result.bands;
    const ink = Array.from({ length: result.bands }, () => 0);
    for (let y = 0; y < pixels.h; y++) {
      const band = Math.min(result.bands - 1, Math.floor(y / bandH));
      const row = y * pixels.w * 4;
      for (let x = 0; x < pixels.w; x++) if (pixels.data[row + x * 4 + 3]) ink[band]++;
    }
    const first = result.state.list[0];
    // 换过可见舞台(后台整场景补跑时整台重挂载),或这个舞台按片段重挂载的代数涨了:包裹层就该是新挂的节点
    const swapped = result.state.frontId !== beforeFront;
    const genUp = !swapped && !!before && result.state.list.some((s, i) => s.remountGen > before[i].remountGen);
    const sameNode = result.state.list.some((s) => s.mark !== null);
    return { label, frame, ms, pixels, ink, frontId: result.state.frontId, pipeline: first.pipeline,
      remounted: before && !swapped ? first.remountGen - before[0].remountGen : null, swapped,
      staleNode: (swapped || genUp) && sameNode ? (swapped ? 'swap' : 'clip') : null };
  };

  /** 一个用例、一种分派:走完整套步骤,回各张画面和比较结果 */
  const STEPS = [[0, 'init0'], [20, 'at20'], [37, 'fwd37'], [59, 'fwd59'], [164, 'fwd164'], [37, 'back37'], [38, 'step38'], [37, 'back37b'],
    [20, 'at20b'], [38, 'fwd38'], [164, 'fwd164b'], [59, 'back59'], [0, 'back0']];
  const runSequence = async (clipIds, tag, { pin, shot, assert }) => {
    const shots = {};
    const info = [];
    for (const [frame, label] of STEPS) {
      const r = await arrive(clipIds, frame, label, { pin, shot, tag });
      if (!r) continue;
      shots[label] = r;
      info.push({ label, frame, ms: r.ms, ink: r.ink, frontId: r.frontId, pipeline: r.pipeline, remounted: r.remounted, swapped: r.swapped, staleNode: r.staleNode });
    }
    const cmp = (a, b) => (shots[a] && shots[b] ? comparePixels(shots[a].pixels, shots[b].pixels) : { error: 'missing', a: !!shots[a], b: !!shots[b] });
    const pairs = { back37: cmp('back37', 'fwd37'), back37b: cmp('back37b', 'fwd37'), back59: cmp('back59', 'fwd59'), step38: cmp('step38', 'fwd38'),
      back0: cmp('back0', 'init0'), fwd164b: cmp('fwd164b', 'fwd164'), at20b: cmp('at20b', 'at20') };
    const control = { fwd37vs59: cmp('fwd37', 'fwd59'), fwd37vs38: cmp('fwd37', 'fwd38'), back37vsFwd59: cmp('back37', 'fwd59') };
    const ok = (c) => !!c && !c.error && c.identical;
    const say = assert ? check : (cond, label, extra) => { if (!cond) notes.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
    say(info.length === STEPS.length, `${tag}每一步都回到了精确活渲`, info.map((i) => i.label));
    // 第 0 帧可以是空的(有的粒子配置起步时一个粒子都没有);之后每张卡都要有画面
    say(info.filter((i) => i.frame > 0).every((i) => i.ink.every((n) => n > 0)), `${tag}第 0 帧之外每一步、每张卡的活画布都不是空的`, info.map((i) => [i.label, ...i.ink]));
    say(info.every((i) => !i.staleNode), `${tag}舞台说重挂载了(按片段重挂载的代数涨了,或后台整场景补跑后互换),这张卡的包裹层就是新挂的节点`,
      info.filter((i) => i.staleNode).map((i) => `${i.label}@${i.frontId}:${i.staleNode === 'swap' ? '互换后还是旧节点' : '代数涨了还是旧节点'}`));
    say(ok(pairs.back37), `${tag}往回跳到第 37 帧(从第 164 帧)与往前到达的同一帧逐像素相同`, pairs.back37);
    say(ok(pairs.back59), `${tag}往回跳到第 59 帧(从第 164 帧)与往前到达的同一帧逐像素相同`, pairs.back59);
    say(ok(pairs.back37b), `${tag}往回挪一帧到第 37 帧与往前到达的同一帧逐像素相同`, pairs.back37b);
    say(ok(pairs.step38), `${tag}往回跳之后再往前挪一帧(第 38 帧)与往前到达的同一帧逐像素相同`, pairs.step38);
    say(ok(pairs.back0), `${tag}回到第 0 帧与项目刚建好时的第 0 帧逐像素相同`, pairs.back0);
    say(ok(pairs.fwd164b) && ok(pairs.at20b), `${tag}同一帧两次往前到达逐像素相同`, { fwd164b: pairs.fwd164b, at20b: pairs.at20b });
    say(!control.fwd37vs59.error && control.fwd37vs59.diffPixels >= 1000, `${tag}对照:第 37 帧与第 59 帧差得明显(不同的像素不少于 1000 个)`, control.fwd37vs59);
    return { info, pairs, control };
  };

  /** 新建项目,放上这个用例的卡(每张一条轨道,0～6 秒),等页面把它们测完。回片段 id */
  const setupCase = async (name, def) => {
    const clips = def.clips ?? [def];
    const clipIds = await store(`actions.newProject(args[0]);
      const ids = [];
      for (const c of args[2]) {
        const trackId = ids.length ? actions.addTrack('t' + ids.length).id : undefined;
        const clip = actions.addCardClip(c.cardId, 0, { duration: args[1], params: c.params, ...(trackId ? { trackId } : {}) });
        if (clip) ids.push(clip.id);
      }
      // 取消选中:编辑台画在预览上面的选中描边会进截图(抽查别的卡时比的是截图)
      actions.select([]);
      actions.pause(); actions.seek(0);
      return ids;`, `seek-back-${name}-${RUN}`, SECONDS, clips);
    if (!clipIds || clipIds.length !== clips.length) return null;
    // 等页面把卡测完(成本记录落进分派表);等不到就照没有记录的样子接着跑,记一笔
    for (const id of clipIds) if (!(await waitFor(() => costRecordOf(page, id), 120000, 500))) notes.push(`${name}:120 秒没等到成本记录`);
    // 第二趟(带快照的那一趟)会把记录整条重写:等它不再变
    let last = '';
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const now = JSON.stringify(await Promise.all(clipIds.map((id) => costRecordOf(page, id))));
      if (now === last && i >= 3) break;
      last = now;
    }
    return clipIds;
  };

  const recordBrief = (r) => (r ? { stepMs: r.stepMs ?? null, catchUpMs: r.catchUpMs ?? null, vtOk: r.vtOk ?? null, seekOk: r.seekOk ?? null, seekMs: r.seekMs ?? null,
    capped: r.capped ?? null, pinnedHeavy: r.pinnedHeavy ?? null } : null);

  for (const name of wantCards) {
    const def = CARDS[name];
    if (!check(!!def, `认得这个用例:${name}`)) continue;
    const started = Date.now();
    const clipIds = await setupCase(name, def);
    if (!check(!!clipIds, `${name}:加上了卡`)) continue;
    const natural = await Promise.all(clipIds.map((id) => costRecordOf(page, id)));
    const entry = { card: name, clipIds, record: natural.map(recordBrief), modes: {} };
    out.cases.push(entry);
    for (const mode of wantModes) {
      const pin = mode === 'heavy' ? { pinnedHeavy: true, vtOk: true } : mode === 'swap' ? { pinnedHeavy: true, vtOk: false } : null;
      if (pin) {
        for (const id of clipIds) await costRecordOf(page, id, pin);
        await sleep(400);
        const pd = await parentDiag();
        check(clipIds.every((id) => pd?.snapshotFeed?.heavy?.includes(id)), `${name}/${mode}:父页的分派表里这几张卡判重`, pd?.snapshotFeed?.heavy);
      }
      const t0 = Date.now();
      const res = await runSequence(clipIds, `${name}-${mode}-`, { pin, shot: grabCanvas, assert: true });
      entry.modes[mode] = { ...res, pin, ms: Date.now() - t0 };
      timings.record(`${name}/${mode}:${STEPS.length} 次到达共用时`, Date.now() - t0);
      // 撤掉钉的那一位,下一种分派从页面自己的记录起
      if (pin) for (let i = 0; i < clipIds.length; i++) await costRecordOf(page, clipIds[i], { pinnedHeavy: false, vtOk: natural[i]?.vtOk ?? true });
    }
    timings.record(`${name}:整个用例用时(含等测量)`, Date.now() - started);
  }

  if (SURVEY) {
    out.survey = [];
    for (const name of wantSurvey) {
      const def = SURVEY_CARDS[name] ?? CARDS[name];
      if (!def) { out.survey.push({ card: name, error: 'unknown' }); continue; }
      const clipIds = await setupCase(name, def);
      if (!clipIds) { out.survey.push({ card: name, error: 'no-clip' }); continue; }
      const natural = recordBrief(await costRecordOf(page, clipIds[0]));
      const before = notes.length;
      const res = await runSequence(clipIds, `survey-${name}-`, { pin: null, shot: grabStage, assert: false });
      out.survey.push({ card: name, clipIds, record: natural, pairs: res.pairs, control: res.control, info: res.info, notes: notes.splice(before) });
    }
  }

  out.pageErrors = ed.pageErrors.slice(0, 10);
} catch (e) {
  fails.push(`探针异常:${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  try { await browser?.close(); } catch { /* 已经关了 */ }
  try { editor?.stop(); } catch { /* 已经停了 */ }
}

out.notes = notes;
out.fails = fails;
out.timings = timings.list;
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
const pairLine = (pairs) => Object.entries(pairs).map(([k, v]) => `${k}=${v.error ? 'ERR' : v.identical ? '同' : `差${v.diffPixels}px/内容均差${v.meanContent}/最大${v.max}`}`).join(' ');
const pathLine = (info) => info.map((i) => `${i.label}@${i.frontId}${i.swapped ? '换' : ''}${i.remounted ? `+${i.remounted}` : ''}${i.staleNode ? '!旧节点' : ''}(${i.pipeline},${i.ms}ms)`).join(' ');
const ctlLine = (c) => (c?.error ? 'ERR' : `差${c.diffPixels}px/内容均差${c.meanContent}`);
for (const cs of out.cases) {
  console.log(`\n[${cs.card}] 成本记录 ${JSON.stringify(cs.record)}`);
  for (const [mode, m] of Object.entries(cs.modes)) {
    console.log(`  ${mode}: ${pairLine(m.pairs)} | 对照 37↔59 ${ctlLine(m.control.fwd37vs59)}`);
    console.log(`    路: ${pathLine(m.info)}`);
  }
}
for (const sv of out.survey ?? []) {
  console.log(`\n[抽查 ${sv.card}] 成本记录 ${JSON.stringify(sv.record ?? sv.error)}`);
  if (!sv.pairs) continue;
  console.log(`  ${pairLine(sv.pairs)} | 对照 37↔59 ${ctlLine(sv.control.fwd37vs59)}`);
  console.log(`    路: ${pathLine(sv.info)}`);
}
timings.print();
console.log(JSON.stringify({ probe: 'seek-back-exact-probe', out: OUT, cases: out.cases.length, notes, fails }, null, 2));
process.exit(fails.length ? 1 : 0);

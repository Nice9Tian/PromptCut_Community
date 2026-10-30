/** Real .proc playback, in an isolated source/cache copy. Input stays read-only.
 * node scripts/verify-playback-project.mjs --project <file.proc> [--seconds 12]
 */
import './lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs/promises';
import { existsSync, lstatSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { fork, execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import assert from 'node:assert/strict';
import { framesPlugin, frameService, renderProject } from '../server/vite-plugin-frames.ts';
import { mediaPlugin } from '../server/vite-plugin-media.ts';
import { setPrerender } from '../server/prerender-client.mjs';

const arg = name => { const at = process.argv.indexOf(name); return at < 0 ? null : process.argv[at + 1]; };
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = process.argv.includes('--worker');
const out = path.resolve(arg('--out') || path.join(repo, 'out', `real-playback-${Date.now()}`));
const app = path.join(out, 'app');
process.env.PUPPETEER_CACHE_DIR ||= path.join(repo, 'desktop/src-tauri/runtime/chrome');
process.env.PROMPTCUT_EXPORT_DIR = path.join(out, 'exports');
process.env.PROMPTCUT_DATA_DIR = path.join(out, 'data');

const harness = `
import './render/stageClockEntry';
import {createRoot} from 'react-dom/client';
import {useEffect,useRef,useState} from 'react';
import './index.css'; import './skins/skins.css';
import ExportView from './ExportView';
import {UnifiedPreview} from './editor/preview/UnifiedPreview';
function Test({project}) {
 const [t,setT]=useState(0), [playing,setPlaying]=useState(false);
 const current=useRef({t,playing}); current.current={t,playing};
 useEffect(()=>{ window.testPlayer={seek:setT,play:()=>setPlaying(true),pause:()=>setPlaying(false),trace:[], get:()=>current.current}; },[]);
 useEffect(()=>{if(!playing)return; let raf, last=performance.now(), acc=current.current.t, wrote=acc;
 const tick=now=>{ if(Math.abs(current.current.t-wrote)>1.5/project.fps)acc=current.current.t; acc+=(now-last)/1000;last=now;
 if(acc>=project.duration){setPlaying(false);setT(project.duration);return;}
 wrote=Math.floor(acc*project.fps+1e-7)/project.fps;setT(wrote);raf=requestAnimationFrame(tick);};
 raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);},[playing]);
 useEffect(()=>{let raf,last=-1;const tick=now=>{const c=current.current;const frame=Math.round(c.t*project.fps);
 if(c.playing&&frame!==last){const canvas=document.querySelector('canvas');window.testPlayer.trace.push({target:frame,shown:Number(canvas?.dataset.frame??-1),at:now});last=frame;}
 raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);},[]);
 return <div style={{position:'relative',width:project.width,height:project.height,background:'#222'}}><UnifiedPreview project={project} t={t} playing={playing}/></div>;
}
const root=createRoot(document.getElementById('root'));
if(location.search.includes('export=1'))root.render(<ExportView/>);
else fetch('/test-project').then(r=>r.json()).then(p=>root.render(<Test project={p}/>));
`;

/*
 * app/ 下这几个目录是指回仓库的 junction。out 目录要留给人看,可谁以后递归删它,都会顺着
 * junction 删进仓库(主仓库的 node_modules 就这样被清空过),所以跑完就拆,失败、Ctrl+C 也拆。
 * 只拆链接本身:unlink 删的是 junction 这一项,不进目标目录。拆完确认链接没了、仓库里的目标还在。
 * 必须是同步的:兜底挂在 process 'exit' 上,那里跑不了异步。
 */
const LINKED = ['node_modules', 'public', 'server', 'scripts'];
/** 建链接时仓库里真有的那几个目标;null = 还没建,或者已经拆过 */
let linkedTargets = null;
function unlinkJunctions() {
  if (!linkedTargets) return;
  const targets = linkedTargets;
  linkedTargets = null;
  const removed = [];
  const fail = (message) => { console.error('JUNCTION ' + message); process.exitCode = 1; };
  for (const folder of LINKED) {
    const link = path.join(app, folder);
    const st = lstatSync(link, { throwIfNoEntry: false });
    if (!st) continue;
    if (!st.isSymbolicLink()) { fail(`${link} 不是链接,没动它`); continue; }
    try { unlinkSync(link); } catch (e) { fail(`拆不掉 ${link}(${e.code || e}):删 ${out} 之前先在 PowerShell 里 [System.IO.Directory]::Delete('${link}')`); continue; }
    if (lstatSync(link, { throwIfNoEntry: false })) fail(`${link} 拆过了还在`);
    else removed.push(folder);
  }
  for (const target of targets) if (!existsSync(target)) fail(`拆完之后仓库里的 ${target} 不见了`);
  if (removed.length) console.log('UNLINKED', removed.join(','));
}

let doc, inputHash;
if (!worker) {
  assert.ok(arg('--project'), 'Provide --project <file.proc>');
  const input = await fs.readFile(arg('--project')); inputHash = createHash('sha256').update(input).digest('hex');
  doc = JSON.parse(input);
  for (const media of doc.project.media || []) if (media.path) await fs.access(media.path);
  await fs.mkdir(app, { recursive: true });
  await fs.cp(path.join(repo, 'src'), path.join(app, 'src'), { recursive: true });
  await fs.copyFile(path.join(repo, 'index.html'), path.join(app, 'index.html'));
  // 先挂兜底再建链接:建到一半失败也要拆。Ctrl+C 默认不走 'exit',改成正常退出
  linkedTargets = LINKED.map((folder) => path.join(repo, folder)).filter((target) => existsSync(target));
  process.on('exit', unlinkJunctions);
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
  for (const folder of LINKED) await fs.symlink(path.join(repo, folder), path.join(app, folder), 'junction');
  for (const card of doc.cards || []) {
    assert.match(card.id, /^[\w-]+$/);
    await fs.writeFile(path.join(app, 'src/cards/user', card.id + '.tsx'), card.source);
  }
  await fs.writeFile(path.join(app, 'src/main.tsx'), harness);
  await fs.writeFile(path.join(out, 'project.json'), JSON.stringify(renderProject(doc.project)));
}
const project = JSON.parse(await fs.readFile(path.join(out, 'project.json'), 'utf8'));
let remoteUrl = null;
const server = await createServer({ configFile: false, root: app, cacheDir: path.join(out, worker ? 'vite-worker' : 'vite'),
  plugins: [{ name: 'isolated-project-test', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (worker) {
        res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.end(); return; }
      }
      if (req.url === '/test-project') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(project)); return; }
      if (req.url === '/api/prerender/info') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ready:!!remoteUrl,url:remoteUrl})); return; }
      if (req.url === '/test-status') {
        const pipeline = frameService(server.config.root, `http://127.0.0.1:${server.httpServer.address().port}`);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ leased: pipeline.backgroundLeaseUntil > Date.now(),
          background: !!pipeline.lanes.get('background'), status: [...pipeline.entries.values()].map(e=>e.status),
          pids: [...pipeline.lanes].map(([lane,s])=>({lane,pid:s.bakery.browser.process().pid})), pool: pipeline.userPool.length })); return;
      }
      next();
    });
  } }, framesPlugin(), mediaPlugin(), react(), tailwindcss()],
  server: { host: '127.0.0.1', port: worker ? 49173 : 49172, hmr: false, watch: null, fs: { allow: [repo] } } });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const pipeline = frameService(app, origin);
if (worker) {
  process.send?.({ origin });
  process.on('message', async message => { if (message === 'close') { await pipeline.close(); await server.close(); process.exit(0); } });
} else {
  const results = { input: path.basename(arg('--project')), inputHash, width: project.width, height: project.height, fps: project.fps,
    duration: project.duration, tracks: project.tracks.length, clips: project.tracks.flatMap(t=>t.clips).length, media: project.media.length, runs: [], errors: [] };
  let remote, browser;
  const statuses = [];
  const renders = [];
  const see = pipeline.see_frames.bind(pipeline);
  pipeline.see_frames = async (p, times, options = {}) => {
    const started = performance.now(); let last = started;
    const batch = { times, lane: options.lane, at: Date.now(), frames: [] }; renders.push(batch);
    try { return await see(p, times, { ...options, onFrame: async (frame, value) => {
      const now = performance.now(); batch.frames.push({frame,ms:now-last,totalMs:now-started,source:value.source});last=now;
      await options.onFrame?.(frame,value);
    }}); } catch(e) { batch.error=String(e);throw e; }
  };
  try {
    remote = fork(fileURLToPath(import.meta.url), ['--worker', '--out', out], { env: { ...process.env, PROMPTCUT_ROLE: 'prerender' }, stdio: ['ignore','pipe','pipe','ipc'], windowsHide: true });
    const workerLog = await fs.open(path.join(out, 'worker.log'), 'w');
    remote.stdout.on('data', b=>{void workerLog.write(b);}); remote.stderr.on('data', b=>{void workerLog.write(b);});
    remoteUrl = await new Promise((resolve,reject)=>{remote.once('message',m=>resolve(m.origin));remote.once('error',reject);remote.once('exit',code=>reject(new Error('Worker exited '+code)));});
    setPrerender({url:remoteUrl,ready:true});
    const puppeteer=(await import('puppeteer')).default;
    browser=await puppeteer.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
    const page=await browser.newPage(); await page.setViewport({width:1920,height:1080});
    page.on('pageerror',e=>results.errors.push(String(e)));
    page.on('response',async response=>{if(response.url().endsWith('/api/frames/playback')) {
      try {const s=await response.json();statuses.push({at:Date.now(),epoch:s.epoch,playing:s.playing,metrics:s.metrics,error:s.error});}catch{}
    }});
    // Exercise the normal import endpoint; old code identities may safely discard
    // embedded HTML while media and card source still render from this project.
    if (doc.snapshots) results.snapshotImport = await fetch(origin+'/api/frames/import', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project,snapshots:doc.snapshots})}).then(r=>r.json());
    await page.goto(origin); await page.waitForFunction(()=>!!window.testPlayer,{timeout:60000});
    const before=performance.now();
    await page.waitForSelector('img',{timeout:60000});
    results.firstPausedMs=Math.round(performance.now()-before);
    await page.screenshot({path:path.join(out,'paused-start.png')});
    const startBackground=await fetch(remoteUrl+'/test-status').then(r=>r.json()); results.backgroundBefore=startBackground;
    console.log('READY',JSON.stringify({firstPausedMs:results.firstPausedMs,background:startBackground}));
    const seconds=Math.min(project.duration,Number(arg('--seconds'))||project.duration);
    const summarize=trace=>{const shown=trace.filter(r=>r.shown>=0);const lags=shown.map(r=>(r.target-r.shown)*1000/project.fps).sort((a,b)=>a-b);
      return {sampled:trace.length,shown:shown.length,blankPct:+((1-shown.length/Math.max(1,trace.length))*100).toFixed(2),
        uniqueFrames:new Set(shown.map(r=>r.shown)).size, p95LagMs:lags[Math.floor(lags.length*.95)]??null,maxLagMs:lags.at(-1)??null,
        future:shown.filter(r=>r.shown>r.target+1).length,backward:shown.filter((r,i)=>i&&r.shown<shown[i-1].shown).length};};
    for(const name of ['cold','warm']) {
      await page.evaluate(()=>{window.testPlayer.pause();window.testPlayer.seek(0);window.testPlayer.trace.length=0;});
      await new Promise(r=>setTimeout(r,250));
      const started=performance.now(); await page.evaluate(()=>window.testPlayer.play());
      while(performance.now()-started<seconds*1000 && await page.evaluate(()=>window.testPlayer.get().playing)) {
        await new Promise(r=>setTimeout(r,1000));
        const current=await page.evaluate(()=>window.testPlayer.get().t);
        if(Math.round(current)%10===0) console.log('PROGRESS',name,current.toFixed(2),statuses.at(-1)?.metrics);
      }
      await page.evaluate(()=>window.testPlayer.pause()); await new Promise(r=>setTimeout(r,300));
      const trace=await page.evaluate(()=>window.testPlayer.trace);
      await fs.writeFile(path.join(out,name+'-trace.json'),JSON.stringify(trace));
      const run={name,seconds,...summarize(trace),metrics:statuses.filter(s=>s.playing).at(-1)?.metrics};results.runs.push(run);
      console.log('RUN',JSON.stringify(run));
      assert.equal(run.future,0); assert.equal(run.backward,0);
      await page.screenshot({path:path.join(out,name+'-end.png')});
    }
    const seekTimes=[52.8,83.3,27.3,5.4,88.1];results.seeks=[];
    for(const time of seekTimes) {
      const start=performance.now(); const result=await pipeline.see_frames(project,[time],{lane:'user'});
      const frame=Math.round(time*project.fps);assert.ok(result.get(frame)?.buf.length);
      results.seeks.push({time,ms:Math.round(performance.now()-start),source:result.get(frame).source});
    }
    await new Promise(r=>setTimeout(r,1500));
    results.backgroundAfter=await fetch(remoteUrl+'/test-status').then(r=>r.json());
    // Explicitly borrow a Chrome that has already started, not just a queued B job.
    assert.ok(results.backgroundAfter.background, 'background Chrome resumed after pause');
    await page.evaluate(()=>{window.testPlayer.seek(40);window.testPlayer.play();});
    await new Promise(r=>setTimeout(r,1500));
    results.backgroundBorrowed=await fetch(remoteUrl+'/test-status').then(r=>r.json());
    assert.equal(results.backgroundBorrowed.leased,true);
    assert.equal(results.backgroundBorrowed.background,false);
    await page.evaluate(()=>window.testPlayer.pause());
    await new Promise(r=>setTimeout(r,1500));
    results.backgroundReleased=await fetch(remoteUrl+'/test-status').then(r=>r.json());
    assert.equal(results.backgroundReleased.leased,false);
    results.playbackEpochs=[...new Set(statuses.map(s=>s.epoch))];
    results.statusErrors=[...new Set(statuses.map(s=>s.error).filter(Boolean))];
    assert.deepEqual(results.errors,[]); assert.deepEqual(results.statusErrors,[]);
    const {findFfmpeg}=await import('../server/bakery/index.mjs');const ffprobe=(await findFfmpeg()).replace(/ffmpeg(\.exe)?$/i,'ffprobe$1');
    const entry=await pipeline.entry(project);
    results.mov=JSON.parse(execFileSync(ffprobe,['-v','error','-show_entries','stream=codec_name,nb_frames,duration,width,height','-of','json',entry.playbackMovie.movieFile],{windowsHide:true}).toString());
    results.inputUnchanged=inputHash===createHash('sha256').update(await fs.readFile(arg('--project'))).digest('hex');
    assert.ok(results.inputUnchanged);
  } catch(error) {results.failure=String(error.stack||error);process.exitCode=1;console.error(error);}
  finally {
    await fs.writeFile(path.join(out,'results.json'),JSON.stringify(results,null,2));
    await fs.writeFile(path.join(out,'statuses.json'),JSON.stringify(statuses,null,2));
    await fs.writeFile(path.join(out,'renders.json'),JSON.stringify(renders,null,2));
    await browser?.close(); await pipeline.close(); await server.close();
    if(remote?.connected){remote.send('close');await new Promise(resolve=>{remote.once('exit',resolve);setTimeout(()=>{remote.kill();resolve();},10000).unref();});}
    // 两台 vite(本进程和 worker)都关了才拆:worker 的根也是 app/
    unlinkJunctions();
  }
  console.log('ARTIFACTS',out);
}

/**
 * Run: node scripts/probes/placeholder-probe.mjs
 * Starts its own Vite server on 5240 and a static redirect service on 5243, launches Chrome,
 * writes screenshots under %TEMP%, and stops only the processes it started.
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { openBrowser, serve, closeAll } from './probe-connect.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const origin = 'http://127.0.0.1:5240';
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-placeholder-'));
const results = { screenshots: out, checks: {} };
function check(name, ok, detail) { results.checks[name] = { pass: !!ok, ...detail }; if (!ok) results.failed = true; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function portFree(port) {
  return new Promise(resolve => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
}
async function ready() {
  for (let i=0;i<100;i++) {
    try { const r=await fetch(`${origin}/scripts/probes/placeholder-harness.html`); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('Vite on 5240 did not become ready');
}
function pixel(buffer,x,y) { const p=PNG.sync.read(buffer); const i=(Math.round(y)*p.width+Math.round(x))*4; return [...p.data.subarray(i,i+3)]; }
function paintedBounds(buffer) {
  const p=PNG.sync.read(buffer); let left=p.width,top=p.height,right=-1,bottom=-1;
  for(let y=45;y<Math.min(p.height,900);y++) for(let x=10;x<Math.min(p.width,1090);x++) {
    const i=(y*p.width+x)*4;
    if(Math.abs(p.data[i]-98)+Math.abs(p.data[i+1]-128)+Math.abs(p.data[i+2]-163)<12) continue;
    left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
  }
  return {left,top,right,bottom};
}
const p90 = xs => { const s=[...xs].sort((a,b)=>a-b); return s[Math.ceil(s.length*.9)-1] ?? 0; };

let vite, staticServer, browserHandle, page, cdp;
try {
  for (const p of [5240,5241,5242,5243]) if (!await portFree(p)) throw new Error(`port ${p} is occupied; refusing to touch it`);
  const viteBin=path.resolve(path.dirname(require.resolve('vite')),'../../bin/vite.js');
  vite=spawn(process.execPath,[viteBin,'--port','5240','--strictPort','--host','127.0.0.1'],{cwd:root,stdio:'ignore',windowsHide:true});
  await ready();
  staticServer=await serve(5243,(req,res)=>{res.writeHead(302,{Location:`${origin}/scripts/probes/placeholder-harness.html${req.url.includes('?')?req.url.slice(req.url.indexOf('?')):''}`});res.end();},'127.0.0.1');
  browserHandle=await openBrowser({launch:{headless:true,args:['--window-size=1200,950'],defaultViewport:{width:1200,height:950,deviceScaleFactor:1}}});
  page=await browserHandle.browser.newPage();
  await page.setViewport({width:1200,height:950,deviceScaleFactor:1});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5243/?n=30',{waitUntil:'networkidle0'});
  await page.waitForFunction(()=>document.querySelectorAll('[data-pc-placeholder-plane]').length===30);
  check('load',errors.length===0,{errors});
  const variants=await page.evaluate(()=>[...document.querySelectorAll('[data-pc-clip]')].slice(0,9).map((w,i)=>{
    const p=w.querySelector('[data-pc-placeholder-plane]'),r=w.querySelector('.reference');
    const a=p.getBoundingClientRect(),b=r.getBoundingClientRect();
    const error=Math.max(...['left','top','right','bottom'].map(k=>Math.abs(a[k]-b[k])));
    return {variant:w.querySelector('.caption').textContent,error,kind:p.dataset.pcPlaceholderKind,background:getComputedStyle(p).backgroundImage};
  }));
  check('geometry',variants.slice(0,8).every(v=>v.error<=1),{variants:variants.map(({variant,error,kind})=>({variant,error,kind}))});
  check('badge',variants[8].kind==='badge' && variants[8].background==='none',{background:variants[8].background});
  await page.screenshot({path:path.join(out,'geometry-30.png')});
  const screenshotCases=[];
  for(const [name,transform,perspective] of [['plain','none',false],['rotate45','rotate(45deg)',false],['scale03','scale(.3)',false],['scale3','scale(3)',false],['perspective','rotateY(30deg) rotateX(18deg)',true]]) {
    await page.evaluate(({transform,perspective})=>{
      window.placeholderHarness.mount(1);
      const w=document.querySelector('[data-pc-clip]');w.style.left='320px';w.style.top='250px';w.style.transform=transform;
      document.getElementById('stage').style.perspective=perspective?'800px':'none';
      w.querySelector('.sample').style.display='none';w.querySelector('.caption').style.display='none';
      const r=w.querySelector('.reference');r.hidden=false;r.style.background='#30343d';r.style.outline='none';
      w.querySelector('[data-pc-placeholder-plane]').hidden=true;
    },{transform,perspective});
    await sleep(40);
    const reference=await page.screenshot();
    await page.evaluate(()=>{const w=document.querySelector('[data-pc-clip]');w.querySelector('.reference').hidden=true;w.querySelector('[data-pc-placeholder-plane]').hidden=false;});
    await sleep(160);
    const actual=await page.screenshot();
    const a=paintedBounds(reference),b=paintedBounds(actual);
    const error=Math.max(...['left','top','right','bottom'].map(k=>Math.abs(a[k]-b[k])));
    screenshotCases.push({name,error,reference:a,placeholder:b});
    fs.writeFileSync(path.join(out,`reference-${name}.png`),reference);
    fs.writeFileSync(path.join(out,`placeholder-${name}.png`),actual);
  }
  check('screenshot_bounds',screenshotCases.every(c=>c.error<=1),{cases:screenshotCases});
  await page.evaluate(()=>window.placeholderHarness.mount(30));
  await page.waitForFunction(()=>document.querySelectorAll('[data-pc-placeholder-plane]').length===30);

  const delay=await page.evaluate(async()=>{
    const p=document.querySelector('[data-pc-placeholder-plane]');
    p.hidden=true; await new Promise(r=>setTimeout(r,30));
    const hiddenDisplay=getComputedStyle(p).display;
    window.placeholderHarness.setPlaceholderShown(p,true);
    await new Promise(r=>setTimeout(r,80));
    const shortGapOpacity=Number(getComputedStyle(p).opacity);
    window.placeholderHarness.setPlaceholderShown(p,false);
    await new Promise(r=>setTimeout(r,30));
    window.placeholderHarness.setPlaceholderShown(p,true);
    const t0=performance.now();
    const samples=[];
    for(const target of [40,80,105,150,180]) {
      await new Promise(r=>setTimeout(r,Math.max(0,target-(performance.now()-t0))));
      samples.push({ms:performance.now()-t0,opacity:Number(getComputedStyle(p).opacity)});
    }
    return {hiddenDisplay,shortGapOpacity,samples};
  });
  check('120ms_delay',delay.hiddenDisplay==='none' && delay.shortGapOpacity===0 && delay.samples.filter(v=>v.ms<120).every(v=>v.opacity===0) && delay.samples.filter(v=>v.ms>=145).every(v=>v.opacity===1),delay);
  await page.screenshot({path:path.join(out,'visible-after-delay.png')});

  const pin=await page.evaluate(async()=>{
    const d=window.placeholderHarness.animationDemo();
    const before=getComputedStyle(d.icon).transform;
    await new Promise(r=>setTimeout(r,180));
    const after=getComputedStyle(d.icon).transform;
    return {frozen:d.frozen,before,after,ownAnimations:document.getAnimations().filter(a=>window.placeholderHarness.isPlaceholderAnimation(a)).length};
  });
  check('pinner_exemption',pin.ownAnimations>0 && pin.before!==pin.after,pin);

  await page.evaluate(()=>window.placeholderHarness.mount(1));
  await page.waitForFunction(()=>document.querySelectorAll('[data-pc-placeholder-plane]').length===1);
  await sleep(200);
  const samplePoint=await page.evaluate(()=>{const r=document.querySelector('[data-pc-placeholder-plane]').getBoundingClientRect();return {x:Math.floor(r.left+8),y:Math.floor(r.top+8)};});
  const normal=await page.screenshot();
  await page.evaluate(()=>{document.querySelector('[data-pc-clip]').style.mixBlendMode='multiply';});
  await sleep(100);
  const mixed=await page.screenshot();
  const normalPixel=pixel(normal,samplePoint.x,samplePoint.y),mixedPixel=pixel(mixed,samplePoint.x,samplePoint.y);
  check('blend_measured',normalPixel.some((v,i)=>v!==mixedPixel[i]),{samplePoint,normalPixel,mixedPixel,mitigation:'The wrapper blend mode also blends the noise; stage must host it outside that blended wrapper to preserve neutral colors.'});
  fs.writeFileSync(path.join(out,'blend-normal.png'),normal); fs.writeFileSync(path.join(out,'blend-multiply.png'),mixed);

  await page.evaluate(()=>window.placeholderHarness.mount(30));
  await page.waitForFunction(()=>document.querySelectorAll('[data-pc-placeholder-plane]').length===30);
  await sleep(450);
  cdp=await page.createCDPSession();
  await cdp.send('LayerTree.enable');
  let layers=[]; cdp.on('LayerTree.layerTreeDidChange',event=>{layers=event.layers??[];});
  await page.evaluate(()=>window.placeholderHarness.planes().forEach(p=>p.hidden=true));
  await sleep(250);
  const layerBefore=layers.length;
  const layerCases=[];
  for(const n of [1,10,30,60]) {
    await page.evaluate(n=>window.placeholderHarness.mount(n),n);
    await page.waitForFunction(n=>document.querySelectorAll('[data-pc-placeholder-plane]').length===n,{},n);
    await sleep(220);
    await page.evaluate(()=>window.placeholderHarness.planes().forEach(p=>p.hidden=true));
    await sleep(220);
    const hiddenLayers=layers.length;
    const hiddenIds=new Set(layers.map(l=>l.layerId));
    await page.evaluate(()=>window.placeholderHarness.planes().forEach(p=>p.hidden=false));
    await sleep(220);
    const details=n===1?await Promise.all(layers.filter(l=>!hiddenIds.has(l.layerId)).map(async l=>({id:l.layerId,node:l.backendNodeId,dom:l.backendNodeId?(await cdp.send('DOM.describeNode',{backendNodeId:l.backendNodeId})).node.nodeName:null,reasons:(await cdp.send('LayerTree.compositingReasons',{layerId:l.layerId})).compositingReasons}))):undefined;
    layerCases.push({n,hiddenLayers,visibleLayers:layers.length,added:layers.length-hiddenLayers,...(details?{details}:{})});
    if(n!==30)await page.screenshot({path:path.join(out,`geometry-${n}.png`),fullPage:true});
  }
  await page.evaluate(()=>window.placeholderHarness.mount(30));
  await page.waitForFunction(()=>document.querySelectorAll('[data-pc-placeholder-plane]').length===30);
  await sleep(200);
  const beat=async shown=>page.evaluate(async shown=>{
    for(const p of window.placeholderHarness.planes()) p.hidden=!shown;
    await new Promise(r=>setTimeout(r,200));
    const pinner=window.placeholderHarness.animationDemo().filtered;
    const samples=[]; let frame=0;
    await new Promise(resolve=>{
      const id=setInterval(()=>{
        const t=performance.now(); pinner.sync(frame++*1000/30);
        samples.push(performance.now()-t);
        if(samples.length===150){clearInterval(id);resolve();}
      },1000/30);
    });
    return samples;
  },shown);
  const baseline=await beat(false);
  await sleep(150);
  const visible=await beat(true);
  await sleep(150);
  const layerAfter=layers.length;
  const beatDelta=Number((p90(visible)-p90(baseline)).toFixed(3));
  check('beat_p90_recorded',Number.isFinite(beatDelta),{baselineP90:p90(baseline),visibleP90:p90(visible),deltaMs:beatDelta}); // 每拍耗时差只记录(耗时只记录,不当闸门(verification.md,2026-10-07 用户改定);2026-10-23 探针总审改)
  const thirtyLayers=layerCases.find(c=>c.n===30);
  check('layer_budget_30',thirtyLayers.added<=31,{cases:layerCases,before:layerBefore,after:layerAfter,limit:31});
  const layerPredictions=await page.evaluate(ns=>ns.map(n=>window.placeholderHarness.layersFor(n)),[1,10,30,60]);
  check('layersFor_estimate',layerCases.every((c,i)=>c.added<=layerPredictions[i]),{predictions:layerPredictions});

  const events=[];
  cdp.on('Tracing.dataCollected',({value})=>events.push(...value));
  const complete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));
  await cdp.send('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline',transferMode:'ReportEvents'});
  await sleep(5000);
  await cdp.send('Tracing.end'); await complete;
  const stamps=events.filter(e=>e.ts).map(e=>e.ts); const lo=Math.min(...stamps)+200000,hi=Math.max(...stamps)-200000;
  const steady=events.filter(e=>e.ts>=lo&&e.ts<=hi);
  const counts=Object.fromEntries(['Paint','Layout','RecalculateStyles','UpdateLayoutTree'].map(name=>[name,steady.filter(e=>e.name===name).length]));
  check('steady_trace',counts.Paint===0&&counts.Layout===0&&counts.RecalculateStyles===0,{counts,seconds:(hi-lo)/1e6});
  // 原先这里有一条 check('main_thread_component_script', true, …)：条件写死 true，什么也不证（2026-10-23 探针总审删）。
  // 它想说的「占位符自己不排 JS」由上面的 steady_trace（这段里 Paint / Layout / RecalculateStyles 都是 0）证明。
  fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
  if(results.failed) process.exitCode=1;
} catch(e) { console.error(e); process.exitCode=1; }
finally {
  await cdp?.detach().catch(()=>{});
  await page?.close().catch(()=>{});
  await browserHandle?.close().catch(()=>{});
  if(staticServer) await closeAll([staticServer]);
  if(vite && vite.exitCode===null) { vite.kill(); await new Promise(r=>{vite.once('exit',r);setTimeout(r,3000);}); }
}

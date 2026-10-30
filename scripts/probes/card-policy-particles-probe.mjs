/**
 * particles 唯一画面变化的精确验收，不用没有NASA的演示项目代替。
 * 真实 ParticlesCard 旧/新源码逐帧比较；空/inline/URL配置、参数边界、seed/links、背景各种分支。
 * 每例12帧，另核当前逐帧与直接跳帧相同。在线NASA使用原URL；网络截获回公开纯色fixture图，未打包徽标。
 * node scripts/probes/card-policy-particles-probe.mjs --port 5908 [--out <TMP>] [--before 461206a3]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
const arg=(k,d)=>process.argv.includes(k)?process.argv[process.argv.indexOf(k)+1]:d;
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PORT=Number(arg('--port',5908)), ORIGIN=`http://127.0.0.1:${PORT}`;
const OUT=arg('--out',fs.mkdtempSync(path.join(os.tmpdir(),'pc-policy-particles-')));fs.mkdirSync(OUT,{recursive:true});
const BEFORE=arg('--before','461206a3');
const sources={old:execFileSync('git',['show',`${BEFORE}:src/cards/native/particles.tsx`],{cwd:ROOT,encoding:'utf8',windowsHide:true}),current:fs.readFileSync(path.join(ROOT,'src/cards/native/particles.tsx'),'utf8')};
const nasa=JSON.parse(fs.readFileSync(path.join(ROOT,'server/catalog/particles/nasa.json'),'utf8'));
const NASA_URL=/url\(['"]?([^'")]+)['"]?\)/.exec(nasa.background.image)[1];
const cyan=new PNG({width:16,height:16});for(let i=0;i<256;i++)cyan.data.set([0,210,225,255],i*4);const image=PNG.sync.write(cyan);
const dataUrl=`data:image/png;base64,${image.toString('base64')}`;
const params={config:'',color:'#8ab4ff',quantity:20,speed:1.2,size:3,links:'yes',seed:1};
const inline=(background)=>JSON.stringify({particles:{number:{value:20},move:{enable:true,speed:1},size:{value:3}},background});
const cases=[
  ['defaults',{}],['links-off-seed', {links:'no',seed:7,color:'#e04070',quantity:40,speed:2,size:7}],
  ['zero-particles',{quantity:0,speed:0,size:0.5,seed:0}],['lower-bounds',{quantity:-2,speed:-1,size:-1,seed:1}],
  ['inline-data',{config:inline({image:`url(${dataUrl})`,size:'25%',repeat:'no-repeat',position:'50% 50%'})}],
  ['inline-no-image',{config:inline({color:'#fff'})}],['url-config',{config:'/config.json'}],
  ['nasa-original-url',{config:'/nasa.json'}],['inline-protocol-relative',{config:inline({image:`url(//127.0.0.1:${PORT}/image.png)`,size:'30%',position:'50% 50%',repeat:'no-repeat'})}],
  ['inline-local',{config:inline({image:'url(/image.png)',size:'20%',repeat:'no-repeat'})}],
];
const ids={old:path.join(ROOT,'__card_policy_old.tsx').replace(/\\/g,'/'),current:path.join(ROOT,'__card_policy_current.tsx').replace(/\\/g,'/')};
const plugin={name:'card-policy-particles-fixture',enforce:'pre',resolveId(id){if(id==='/old.tsx'||id==='/__card_policy_old.tsx'||id===ids.old)return ids.old;if(id==='/current.tsx'||id==='/__card_policy_current.tsx'||id===ids.current)return ids.current;},load(id){const key=Object.entries(ids).find(([,p])=>p===id.replace(/\\/g,'/'))?.[0];if(!key)return;return sources[key].replace(/from "(\.[^"]+)"/g,(_,p)=>`from "/${path.posix.normalize('src/cards/native/'+p)}"`);},configureServer(server){server.middlewares.use(async(req,res,next)=>{
  res.setHeader('cache-control','no-store');
  if(req.url==='/config.json'||req.url==='/nasa.json'){res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/nasa.json'?nasa:JSON.parse(inline({image:'url(/image.png)',repeat:'no-repeat'}))));return;}
  if(req.url==='/image.png'){res.setHeader('content-type','image/png');res.end(image);return;}
  if(req.url==='/fixture'){res.setHeader('content-type','text/html; charset=utf-8');res.end(await server.transformIndexHtml(req.url,`<style>body{margin:0;background:#101010}.absolute{position:absolute}.inset-0{inset:0}#box{position:relative;width:320px;height:180px}</style><div id="box"></div><script type="module">
  import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
  import {particlesCard as old} from '/old.tsx';import {particlesCard as current} from '/current.tsx';import {waitForFrameWork} from '/src/kernel/frameReady.ts';
  const root=createRoot(document.getElementById('box'));let C,params;window.mount=async(key,p,online)=>{window.__pcOnlinePage=online;C=(key==='old'?old:current).Component;params=p;flushSync(()=>root.render(React.createElement(C,{params,t:0,key:'card'})));await waitForFrameWork();};
  window.frame=async(t)=>{flushSync(()=>root.render(React.createElement(C,{params,t,key:'card'})));await waitForFrameWork();};window.ready=true;
  </script>`));return;}
  next();});}};
const vite=await createServer({root:ROOT,configFile:false,plugins:[plugin],server:{host:'127.0.0.1',port:PORT,strictPort:true,fs:{allow:[ROOT,path.resolve(ROOT,'../..')] }},esbuild:{jsx:'automatic'},logLevel:'error'});
await vite.listen();
const browser=await puppeteer.launch({headless:true,args:[...PROBE_CHROME_ARGS,'--no-sandbox','--force-device-scale-factor=1']});
const checks=[], frames=[], requests=[];const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}`);};
async function pageFor(key,p,online=false){const page=await browser.newPage();page.on('pageerror',e=>console.log('PAGEERROR',String(e)));page.on('requestfailed',r=>console.log('REQUESTFAILED',r.url(),r.failure()?.errorText));page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text())});await page.setViewport({width:360,height:220,deviceScaleFactor:1});await page.setRequestInterception(true);page.on('request',r=>{if(r.url()===NASA_URL){requests.push({key,online,url:r.url()});r.respond({status:200,contentType:'image/png',body:image});}else r.continue();});await page.goto(ORIGIN+'/fixture');await page.waitForFunction(()=>window.ready);await Promise.race([page.evaluate((key,p,online)=>window.mount(key,p,online),key,p,online),new Promise((_,reject)=>setTimeout(()=>reject(new Error('mount timeout '+key)),15000))]);console.log('MOUNTED',key);return page;}
const pixels=async(page)=>{const c=await page.createCDPSession();try{const r=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true,clip:{x:0,y:0,width:320,height:180,scale:1}});return PNG.sync.read(Buffer.from(r.data,'base64'));}finally{await c.detach();}};
const hash=(p)=>crypto.createHash('sha256').update(p.data).digest('hex');
try{
  for(const [name,overrides] of cases){
    const p={...params,...overrides}, snapshots={};let last;
    for(const key of ['old','current']){
      console.log('BEGIN',name,key);const page=await pageFor(key,p);snapshots[key]=[];
      for(let i=0;i<12;i++){const t=i/30;await page.evaluate(t=>window.frame(t),t);const image=await pixels(page);snapshots[key].push(image);if(i===11)console.log('FRAMES',name,key,12);}
      if(key==='current'&&name==='nasa-original-url')fs.writeFileSync(path.join(OUT,'nasa-desktop.png'),PNG.sync.write(snapshots[key][11]));
      await page.close();
    }
    let equal=0;for(let i=0;i<12;i++){const old=snapshots.old[i],current=snapshots.current[i];if(old.data.equals(current.data))equal++;frames.push({name,t:i/30,old:hash(old),current:hash(current)});last=current;}
    check(name+' 桌面改前后12帧逐像素相同',equal===12,{equal,total:12});
    const jump=await pageFor('current',p);await jump.evaluate(t=>window.frame(t),11/30);const direct=await pixels(jump);check(name+' 逐帧与直接跳帧一致',direct.data.equals(last.data));await jump.close();
  }
  const p={...params,config:'/nasa.json'};const old=await pageFor('old',p,true),current=await pageFor('current',p,true);
  const oldBg=await old.evaluate(()=>document.querySelector('canvas').style.backgroundImage);const currentBg=await current.evaluate(()=>document.querySelector('canvas').style.backgroundImage);
  check('在线旧策略删背景、新策略保留原NASA URL',!oldBg&&currentBg.includes(NASA_URL),{oldBg,currentBg});
  const painted=await pixels(current);let cyanCount=0;for(let i=0;i<painted.data.length;i+=4)if(painted.data[i]===0&&painted.data[i+1]===210&&painted.data[i+2]===225)cyanCount++;
  check('在线外链背景图真实可见，原URL请求实际发生',cyanCount>100&&requests.some(r=>r.key==='current'&&r.online&&r.url===NASA_URL),{cyanCount});
  fs.writeFileSync(path.join(OUT,'nasa-online.png'),PNG.sync.write(await pixels(current)));await old.close();await current.close();
}finally{await browser.close();await vite.close();}
const result={ok:checks.every(c=>c.ok),before:BEFORE,cases:cases.length,desktopFrames:cases.length*12,checks,frames,requests,out:OUT,nasaFixture:'原URL网络响应替换为公开纯色PNG，未外网下载/未将NASA徽标入包'};fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:result.ok,cases:result.cases,desktopFrames:result.desktopFrames,fail:checks.filter(c=>!c.ok),out:OUT}));process.exitCode=result.ok?0:1;

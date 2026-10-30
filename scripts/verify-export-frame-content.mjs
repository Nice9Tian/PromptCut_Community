/** Real headless-shell regression: retained GPU pixels and full-scene video export. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer} from 'vite';
import {PNG} from 'pngjs';
import {openBakery} from '../server/bakery/index.mjs';
import {exportUnified} from '../server/bakery/export-unified.mjs';
const out=path.resolve('work/export-frame-content');
await fs.mkdir(out,{recursive:true});
const media=path.join(out,'source.mp4');
execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error',
  '-f','lavfi','-i','color=c=red:s=64x64:r=30:d=0.5',
  '-f','lavfi','-i','color=c=blue:s=64x64:r=30:d=0.5',
  '-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]',
  '-c:v','libx264','-pix_fmt','yuv420p',media],{windowsHide:true});
process.env.PROMPTCUT_ROLE='prerender';
process.env.PROMPTCUT_MEDIA_DIR=out;
// 自己起的服务器用 5226:5190～5199 留给用户的编辑台和别的常驻服务,5203～5205 是验证用的 dev-test
const server=await createServer({configFile:'vite.prerender.config.ts',server:{host:'127.0.0.1',port:5226,strictPort:true}});
const origin='http://127.0.0.1:5226';
const project={id:'export-frame-content',width:64,height:64,fps:30,duration:1,themeId:'default',tracks:[],media:[]};
const url=p=>`${origin}/?export=1&timeline=${encodeURIComponent('data:application/json,'+encodeURIComponent(JSON.stringify(p)))}`;
const pixel=buf=>{const p=PNG.sync.read(buf),i=(32*p.width+32)*4;return [...p.data.subarray(i,i+4)];};
let bakery;
const evidence={retention:[],video:[],seek:[]};
try{
 await server.listen();
 bakery=await openBakery({url:url(project)});await bakery.page.setViewport({width:64,height:64});
 await bakery.page.evaluate(async()=>{
   const c=document.createElement('canvas');c.width=c.height=64;c.style.cssText='position:fixed;inset:0;z-index:99999';document.body.append(c);window.__retainedCanvas=c;
   const {CardGpuExecutor}=await import('/src/render/cards/gpuExecutor.ts');window.__retainedGpu=new CardGpuExecutor(c,async()=>null);
   await window.__retainedGpu.execute({type:'glsl',fragment:'void main(){outColor=vec4(1.,0.,0.,1.);}'},0);
 });
 for(let tick=0;tick<5;tick++){
   await bakery.beginFrame();
   const data=await bakery.page.evaluate(()=>window.__retainedCanvas.toDataURL());
   const rgba=pixel(Buffer.from(data.split(',')[1],'base64'));evidence.retention.push({tick,rgba});
 }
 await bakery.page.evaluate(()=>{window.__retainedGpu.dispose();window.__retainedCanvas.remove();});
 await bakery.close();bakery=null;
 const videoProject={...project,media:[{id:'video',kind:'video',url:origin+'/api/media/file?path='+encodeURIComponent(media),duration:1}],tracks:[{id:'video-track',clips:[{id:'video-clip',mediaId:'video',start:0,end:1,params:{}}]}]};
 await exportUnified(videoProject,{url:url(videoProject),out,frames:'0-5',workers:1,noVideo:true,writeFrames:false,
   onFrame:async(frame,buf)=>{evidence.video.push({frame,rgba:pixel(buf)});await fs.writeFile(path.join(out,`video-${frame}.png`),buf);}});
 await exportUnified(videoProject,{url:url(videoProject),out,targetFrames:[24,3,18],workers:1,noVideo:true,writeFrames:false,
   onFrame:async(frame,buf)=>{evidence.seek.push({frame,rgba:pixel(buf)});await fs.writeFile(path.join(out,`seek-${frame}.png`),buf);}});
 await fs.writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
 assert(evidence.retention.every(x=>x.rgba[0]===255&&x.rgba[3]===255),'Completed GLSL canvas lost its pixels after compositor ticks');
 assert.equal(evidence.video.length,6);
 assert(evidence.video.every(x=>x.rgba[0]>240&&x.rgba[1]<8&&x.rgba[3]===255),'Unified export omitted a decoded video layer');
 assert.deepEqual(evidence.seek.map(x=>x.frame),[3,18,24]);
 assert(evidence.seek.every(({frame,rgba})=>rgba[frame<15?0:2]>240&&rgba[1]<8&&rgba[frame<15?2:0]<8&&rgba[3]===255),
   'Sparse export captured an empty or stale video frame before seek completed');
 console.log('PASS retained GPU canvas, six full-scene video frames, and sparse red/blue video seeking');
}finally{await bakery?.close();await server.close();}

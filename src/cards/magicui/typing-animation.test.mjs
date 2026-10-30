import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
test('mu-typing uses shared grapheme times for direct seek, crop and optional pauses while remaining silent',async()=>{
  const vite=await createServer({root,configFile:false,logLevel:'error',server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
  try {
    const {typingAnimationCard:card}=await vite.ssrLoadModule('/src/cards/magicui/typing-animation.card.tsx');
    assert.equal(card.audio,undefined);
    assert.deepEqual(card.defaults,{text:'这是一段打字机测试文字',duration:120});
    const view=(params,t,sourceOffset=0)=>renderToStaticMarkup(createElement(card.Component,{params:{...card.defaults,...params},playToken:0,t,sourceOffset}));
    const text=markup=>markup.match(/<h1[^>]*>(.*?)<\/h1>/su)?.[1];
    assert.equal(text(view({text:'ABC'},0)),'');
    assert.equal(text(view({text:'ABC'},.12)),'A');
    assert.equal(text(view({text:'ABC'},.24)),'AB');
    assert.equal(text(view({text:'ABC'},0,.24)),'AB');
    assert.equal(text(view({text:'ABC'},.12,.24)),'ABC');
    const params={text:'中👩🏽‍💻，末',duration:100,punctuationPauseMs:200};
    assert.equal(text(view(params,.2)),'中👩🏽‍💻');
    assert.equal(text(view(params,.5)),'中👩🏽‍💻，');
    assert.equal(text(view(params,.6)),'中👩🏽‍💻，末');
    assert.equal(card.timing(params).settleMs,600);
    assert.equal(card.timing({text:'👩🏽‍💻',duration:120}).settleMs,120);
  } finally {await vite.close();}
});

test('mu-typing 收到挂载钟就按它取字(平铺时间轴导出),算法与旧的挂载即播相同、不加边界容差',async()=>{
  const vite=await createServer({root,configFile:false,logLevel:'error',server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
  try {
    const {typingAnimationCard:card}=await vite.ssrLoadModule('/src/cards/magicui/typing-animation.card.tsx');
    const view=(params,props)=>renderToStaticMarkup(createElement(card.Component,{params:{...card.defaults,...params},playToken:0,...props}));
    const text=markup=>markup.match(/<h1[^>]*>(.*?)<\/h1>/su)?.[1];
    // 第 183 帧:按片段起点是 100 ms(0 个字),旧实现从第 179 帧起计时是 133 ms(1 个字)
    assert.equal(text(view({},{t:3/30})),'');
    assert.equal(text(view({},{t:3/30,mountClockMs:183/30*1000-179/30*1000})),'这');
    // 第 197 帧:599.9999999999991 ms,旧实现是 4 个字;按 t 的那条路在整帧边界上有容差(第 198 帧 = 600 ms → 5 个字)
    assert.equal(text(view({},{t:17/30,mountClockMs:197/30*1000-179/30*1000})),'这是一段');
    assert.equal(text(view({},{t:198/30-6})),'这是一段打');
    // 源偏移照样叠加;字素计时不退回码元
    assert.equal(text(view({text:'ABC'},{t:0,sourceOffset:.24,mountClockMs:0})),'AB');
    assert.equal(text(view({text:'中👩🏽‍💻末',duration:100},{t:0,mountClockMs:200})),'中👩🏽‍💻');
  } finally {await vite.close();}
});

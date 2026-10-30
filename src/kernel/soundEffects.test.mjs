import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationRecipe, createTypingSoundRecipe, renderSoundEffectBlock, validateSoundEffectRecipe, soundEffectReuseKey, SOUND_EFFECT_LIMITS } from './soundEffects.ts';

const compareAccess = recipe => {
  assert.ok(recipe.frames <= SOUND_EFFECT_LIMITS.maxBlockFrames);
  const whole = renderSoundEffectBlock(recipe, {start:0,count:recipe.frames});
  assert.ok(whole.some(x=>x!==0));
  for (const size of [127,4096,7001]) {
    const chunks=[];
    for(let start=0;start<recipe.frames;start+=size) chunks.push({start,count:Math.min(size,recipe.frames-start)});
    const actual=new Float32Array(whole.length);
    for(const range of chunks.reverse()) actual.set(renderSoundEffectBlock(recipe,range),range.start*recipe.channels);
    assert.deepEqual(actual,whole,`reverse chunks ${size}`);
  }
  const start=Math.floor(recipe.frames*.4),count=Math.floor(recipe.frames*.3);
  assert.deepEqual(renderSoundEffectBlock(recipe,{start,count}),whole.slice(start*recipe.channels,(start+count)*recipe.channels));
  assert.deepEqual(renderSoundEffectBlock(recipe,{start:recipe.frames,count:50}),new Float32Array(50*recipe.channels));
  assert.deepEqual(renderSoundEffectBlock(recipe,{start:-5,count:10}).slice(0,5*recipe.channels),new Float32Array(5*recipe.channels));
  assert.deepEqual(renderSoundEffectBlock(recipe,{start:0,count:recipe.frames}),whole,'repeat');
};

test('notification whole/chunks/reversed/seek/replay and tails are sample-identical',()=>{
  for(const waveform of ['sine','triangle','bell']) compareAccess(createNotificationRecipe({waveform,notes:[0,7,12],duration:.25,interval:.14},{seed:13}));
});

test('keyboard noise, overlap and release tails are sample-addressed, not block-state',()=>{
  for(const tone of ['soft','mechanical']) compareAccess(createTypingSoundRecipe({text:'中 👩🏽‍💻，A!',duration:45,jitterMs:10,seed:42,punctuationPauseMs:50},{tone,duration:.09}));
});

test('full recipe survives JSON and shared visual source aligns within half a sample',()=>{
  const recipe=createTypingSoundRecipe({text:'你好， 👩🏽‍💻\ne\u0301',duration:63.3,delayMs:30,punctuationPauseMs:121,newlinePauseMs:140,jitterMs:7,seed:12},{},{sampleRate:44100,channels:1});
  assert.deepEqual(validateSoundEffectRecipe(JSON.parse(JSON.stringify(recipe))),recipe);
  for(const e of recipe.events) {
    const visual=recipe.typingSource.events.find(v=>v.id===e.id);
    assert.ok(Math.abs(e.frame-visual.atMs*recipe.sampleRate/1000)<=.5);
    assert.equal(visual.sound,true);
  }
  assert.equal(recipe.typingSource.events.filter(e=>e.sound).length,recipe.events.length);
  assert.ok(Object.keys(recipe.params).length>=6);
});

test('seed variation, linear gain and bounded overlap do not clip or hide overload',()=>{
  const a=createTypingSoundRecipe({text:'abcdefghij',duration:0},{gain:1},{seed:1});
  const b=createTypingSoundRecipe({text:'abcdefghij',duration:0},{gain:.5},{seed:1});
  const x=renderSoundEffectBlock(a,{start:0,count:a.frames}), y=renderSoundEffectBlock(b,{start:0,count:b.frames});
  assert.ok(x.every((v,i)=>Number.isFinite(v)&&Math.abs(v)<=.8&&Math.abs(v/2-y[i])<1e-8));
  const other=renderSoundEffectBlock(createTypingSoundRecipe({text:'abcdefghij',duration:0},{gain:1},{seed:2}),{start:0,count:a.frames});
  assert.notDeepEqual(other,x);
  const silence=renderSoundEffectBlock(createTypingSoundRecipe({text:'abc'},{gain:0}),{start:0,count:10000});
  assert.ok(silence.every(v=>v===0));
});

test('reuse identity is canonical and covers synth version, seed, events, params and format',()=>{
  const a=createNotificationRecipe(), key=soundEffectReuseKey(a);
  assert.equal(soundEffectReuseKey(Object.fromEntries(Object.entries(a).reverse())),key);
  for(const patch of [{seed:1},{synthVersion:'future-v2'},{frames:a.frames+1},{channels:1},{sampleRate:44100},{params:{...a.params,gain:.1}},{events:a.events.map(e=>({...e,frame:e.frame+1}))}]) assert.notEqual(soundEffectReuseKey({...a,...patch}),key);
  assert.throws(()=>renderSoundEffectBlock({...a,synthVersion:'future-v2'},{start:0,count:1}),/synthVersion/);
  assert.match(key,/^sound-effect:/);
});

test('duration, event work, format and sample request budgets reject rather than truncate',()=>{
  assert.throws(()=>createNotificationRecipe({}, {frames:48000*60+1}),/budget/);
  assert.throws(()=>createNotificationRecipe({}, {sampleRate:12345}),/sampleRate/);
  assert.throws(()=>createNotificationRecipe({}, {channels:3}),/channels/);
  assert.throws(()=>createTypingSoundRecipe({text:'a'.repeat(2000),duration:0},{duration:.5}),/work/);
  const a=createNotificationRecipe();
  for(const range of [{start:0,count:65537},{start:.1,count:10},{start:0,count:NaN},{start:0,count:1,sampleRate:44100}]) assert.throws(()=>renderSoundEffectBlock(a,range));
  assert.throws(()=>validateSoundEffectRecipe({...a,events:[a.events[0],a.events[0]]}),/unique/);
  assert.throws(()=>validateSoundEffectRecipe({...a,params:{...a.params,gain:5}}),/gain/);
  assert.deepEqual(renderSoundEffectBlock(a,{start:0,count:0}),new Float32Array());
});

test('explicit asset duration crops only by request, natural last sample fades to zero',()=>{
  const a=createNotificationRecipe();
  assert.deepEqual(renderSoundEffectBlock(a,{start:a.frames-1,count:1}),new Float32Array(2));
  const cropped=createNotificationRecipe({}, {frames:1000});
  assert.equal(cropped.frames,1000);
  assert.deepEqual(renderSoundEffectBlock(cropped,{start:900,count:200}).slice(200),new Float32Array(200));
  assert.equal(createTypingSoundRecipe({text:' \n',duration:100}).frames,9600);
});

test('persisted source metadata is validated before rendering and does not silently change the schedule',()=>{
  const a=createTypingSoundRecipe({text:'A,B'});
  for(const source of [{...a.typingSource.source,pauses:null},{...a.typingSource.source,pauses:{}},{...a.typingSource.source,duration:NaN},{...a.typingSource.source,duration:50},{...a.typingSource.source,punctuationSound:false}]) {
    assert.throws(()=>validateSoundEffectRecipe({...a,typingSource:{...a.typingSource,source}}),/Typing|typing/);
  }
  assert.throws(()=>validateSoundEffectRecipe({...a,typingSource:{...a.typingSource,events:[null]}}),/typing event/);
});

test('dense events have an explicit overlap budget so one synthesis block cannot monopolize cancellation',()=>{
  const allowed=createTypingSoundRecipe({text:'a'.repeat(64),duration:0},{duration:.075});
  assert.ok(renderSoundEffectBlock(allowed,{start:0,count:4096}).every(Number.isFinite));
  assert.throws(()=>createTypingSoundRecipe({text:'a'.repeat(65),duration:0},{duration:.075}),/64-voice resource budget/);
  assert.doesNotThrow(()=>createTypingSoundRecipe({text:'a'.repeat(1000),duration:30},{duration:.02}));
});

test('persisted recipe validation rejects incomplete snapshots instead of substituting new defaults',()=>{
  const a=createTypingSoundRecipe({text:'A'});
  for(const key of ['seed','sampleRate','channels','frames']) {const broken=structuredClone(a);delete broken[key];assert.throws(()=>validateSoundEffectRecipe(broken),/missing/);}
  for(const key of Object.keys(a.params)) {const broken=structuredClone(a);delete broken.params[key];assert.throws(()=>validateSoundEffectRecipe(broken),/missing/);}
  for(const key of Object.keys(a.typingSource.source)) {const broken=structuredClone(a);delete broken.typingSource.source[key];assert.throws(()=>validateSoundEffectRecipe(broken),/missing/);}
});

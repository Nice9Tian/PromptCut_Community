import '../../testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { notificationSoundCard, keyboardSoundCard } from './sound-effects.ts';
import { cardSourceVersion } from '../../render/cardSourceVersion.mjs';

for (const card of [notificationSoundCard, keyboardSoundCard]) test(`${card.id} is a discoverable native no-input stereo audio preset`,async()=>{
  assert.equal(card.kind,'audio');
  assert.equal(card.source,'native');
  assert.equal(card.frameMode,'direct');
  assert.deepEqual(card.inputs,{});
  assert.equal(card.Component,undefined);
  assert.ok(card.controls.length>=9);
  for(const c of card.controls) assert.ok(c.key in card.defaults,`${c.key} default`);
  const whole=await card.audio({}, {start:0,count:48000,sampleRate:48000},card.defaults);
  assert.equal(whole.length,96000);
  assert.ok(whole.some(v=>v!==0));
  const chunk=await card.audio({}, {start:17000,count:1234,sampleRate:48000},card.defaults);
  assert.deepEqual(chunk,whole.slice(34000,36468));
  assert.ok(whole.every(Number.isFinite));
});

test('notification note list validates rather than silently dropping malformed notes',()=>{
  for(const notes of ['', '0,,7', 'x', '0,100']) assert.throws(()=>notificationSoundCard.audio({}, {start:0,count:20,sampleRate:48000},{...notificationSoundCard.defaults,notes}));
});

test('sound card cache closure includes synthesis and typing dependency source',()=>{
  const files={};
  for(const file of ['cards/native/sound-effects.ts','kernel/soundEffects.ts','kernel/typingEvents.ts']) files[`/src/${file}`]=fs.readFileSync(new URL(`../../${file}`,import.meta.url),'utf8');
  for(const card of [notificationSoundCard,keyboardSoundCard]) {
    const version=cardSourceVersion(card,files);
    assert.ok(version.includes('/src/kernel/soundEffects.ts'));
    assert.ok(version.includes('/src/kernel/typingEvents.ts'));
    assert.notEqual(version,cardSourceVersion(card,{...files,'/src/kernel/soundEffects.ts':files['/src/kernel/soundEffects.ts']+'\n// changed'}));
  }
});

test('native audio adapts full host-sized ranges to bounded synthesis blocks without losing tails',async()=>{
  const card=keyboardSoundCard, range={start:0,count:100000,sampleRate:48000};
  const full=await card.audio({},range,card.defaults);
  assert.equal(full.length,200000);
  for(const start of [0,60000,65536,72000,95000]) {
    const count=Math.min(4096,100000-start);
    assert.deepEqual(await card.audio({}, {...range,start,count},card.defaults),full.slice(start*2,(start+count)*2));
  }
  await assert.rejects(()=>card.audio({}, {...range,count:1048577},card.defaults),/budget/);
});

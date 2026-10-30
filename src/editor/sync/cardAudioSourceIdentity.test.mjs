import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('同步AV代码只读解析，身份与本地闭包一致；改共享依赖使WAV过期', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { OnlineCardSources } = await server.ssrLoadModule('/src/editor/sync/onlineCardSources.ts');
    const { cardSourceVersion } = await server.ssrLoadModule('/src/render/cardSourceVersion.mjs');
    const { cyrb53 } = await server.ssrLoadModule('/src/render/cyrb53.mjs');
    const { builtinCardSourceFiles } = await server.ssrLoadModule('/src/render/cardSourceFiles.mjs');
    const key = 'src/cards/user/av-synced.tsx', dep = 'src/cards/user/av-data.ts';
    const body = `import { value } from './av-data'; export const card = { id:'av-synced', name:'测试', defaults:{ value }, controls:[], Component:()=>null, audio:()=>{ throw Error('不得执行'); } };`;
    const audioKey = 'src/cards/user/upstream-audio.tsx';
    const store = new Map([[key, body], [dep, 'export const value = 1;'], [audioKey, `export const c = { id:'upstream',name:'音频',defaults:{},controls:[],audio:()=>new Float32Array(2) };`]]);
    let entries = [], gen = 1;
    const request = async msg => msg.type === 'content.list'
      ? { type: 'content.listing', items: [...store.keys()].map(key => ({ key, hash: String(gen) })) }
      : { type: 'content.item', body: store.get(msg.key), hash: String(gen) };
    const sync = new OnlineCardSources({ linkKey: () => 'p', request, sourceFiles: builtinCardSourceFiles, apply: values => { entries = values; return true; } });
    await sync.sync();
    assert.equal(entries.length, 2); assert.equal(entries[0].embeddedAudio, true);
    const audio = entries.find(c => c.id === "upstream");
    assert.equal(audio.embeddedAudio, undefined); assert.equal(typeof audio.audioSourceVersion, "string");
    const local = cyrb53(`user:${cardSourceVersion({ id: 'av-synced' }, { ...builtinCardSourceFiles, ...Object.fromEntries([...store].map(([k, v]) => [`/${k}`, v])) }, `/${key}`)}`);
    assert.equal(entries[0].audioSourceVersion, local);
    const old = entries[0].audioSourceVersion;
    store.set(dep, 'export const value = 22;'); gen++;
    await sync.sync(); assert.notEqual(entries[0].audioSourceVersion, old);
    sync.stop();
  } finally { await server.close(); }
});

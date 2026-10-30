// Keep this Vite macro unconditional: conditional import.meta.glob is not
// transformed into the eager raw module table.
const globbed = import.meta.glob([
  '/src/cards/**/*.{ts,tsx,mjs,css}', '/src/parts/**/*.{ts,tsx,mjs,css}',
  '/src/render/**/*.{ts,tsx,mjs,css}', '/src/kernel/**/*.{ts,tsx,mjs,css}',
  '!/src/**/*.test.{ts,tsx,mjs,js}',
], { query: '?raw', import: 'default', eager: true });

/*
 * 热更新的边界(C6.6 集成 3b):卡片、部件、render、kernel 下任何一个文件改了,这张源码表就要重算。
 * 以前它不接热更新,于是沿「本模块 → costIdentity → probeRunner → ProbeGate / Preview」一路冒到编辑器,
 * Preview 的 effect 在 Fast Refresh 里重跑、清掉舞台的 RPC 客户端。
 * 现在本模块自己接住:重跑时把新表**原地**写进第一次导出的那个对象(引用它的模块手里拿的一直是那一个),
 * 所以不用通知谁换引用,下次算源码版本 / 身份键时读到的就是新的。
 */
const kept = import.meta.hot?.data?.files;
if (kept) {
  for (const k of Object.keys(kept)) if (!(k in globbed)) delete kept[k];
  Object.assign(kept, globbed);
}
export const builtinCardSourceFiles = kept ?? globbed;
if (import.meta.hot) {
  import.meta.hot.data.files = builtinCardSourceFiles;
  import.meta.hot.data.version = (import.meta.hot.data.version ?? -1) + 1;
  import.meta.hot.accept();
}

/**
 * 源码表换过几次(首次装载 0,热更新重跑一次加一)。按源码表记忆化的一方(`costIdentity.ts` 的源码版本表)拿它当键。
 * 读的是 `import.meta.hot.data`(同一模块的各次执行共用这一份),所以引用方手里旧实例的这个函数也读得到新值。
 */
export function cardSourceFilesVersion() {
  return import.meta.hot?.data?.version ?? 0;
}

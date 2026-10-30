/**
 * 声音线程里的占位模块(`docs/plan/online-card-exec-contract.md` 3.5)。纯逻辑,单测直接载入。
 *
 * 声音线程是专用后台线程,没有 DOM。一载入就要 DOM 的包(`lottie-web`、`@tsparticles/*`、`react-dom`)和带画面的内置模块
 * (`src/cards/`、`src/parts/` 下的组件文件)在那里给占位:**引进来、取上面的名字都不报错**(同一个文件里既有画面又有 `audio()`
 * 的卡,文件顶上照常写 `import lottie from "lottie-web"`、`const Box = motion.div`),**真去调用或 `new` 才抛**
 * 「声音代码里不能用 <名字>」。卡片文件的顶层要是调用了占位,这张卡在声音线程里就载入失败,它的声音在线合成不了、退回已有产物。
 */

/** 占位被调用时抛的错;声音线程据它把原因报回去 */
export const SOUND_STUB_PREFIX = "声音代码里不能用 ";

export function soundStubMessage(name: string): string {
  return `${SOUND_STUB_PREFIX}${name}`;
}

/** 一个模块的占位:任何属性都是同一种占位(可以一路点下去),调用、`new` 才抛 */
export function createSoundStub(name: string): unknown {
  const fail = (): never => { throw new Error(soundStubMessage(name)); };
  // 目标是函数:占位本身可以被当成组件引用、当成函数取 `.name`,只是不能真调
  const target = function soundStub() { /* 占位 */ };
  const stub: unknown = new Proxy(target, {
    get(_t, key) {
      if (key === "__esModule") return true;
      // 被 `await`、被模板字符串拼接、被 JSON 序列化时不该抛,也不该被当成 thenable
      if (key === "then" || key === Symbol.toPrimitive || key === Symbol.iterator || key === Symbol.asyncIterator || key === "toJSON") return undefined;
      if (key === Symbol.toStringTag) return "SoundStub";
      if (key === "toString") return () => `[占位 ${name}]`;
      if (key === "$$typeof" || key === "prototype") return undefined;
      return stub;
    },
    has: () => true,
    apply: fail,
    construct: fail,
    set: () => true,
  });
  return stub;
}

/** 错误信息里是不是占位抛的(声音线程把它归成「这张卡的声音在线合成不了」) */
export function isSoundStubError(err: unknown): boolean {
  return String((err as Error)?.message ?? err).includes(SOUND_STUB_PREFIX);
}

/** 先试真的,载入失败(模块顶层碰了 `document` / `window`)就给占位 */
export function realOrStub(name: string, load: () => Promise<unknown>): () => Promise<unknown> {
  return async () => {
    try { return await load(); } catch { return createSoundStub(name); }
  };
}

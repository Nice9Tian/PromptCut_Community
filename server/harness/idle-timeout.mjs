/**
 * 流式请求的超时该按「多久没来数据」算,不是按「一共跑了多久」算。
 *
 * # 起因
 *
 * 原来是 `AbortSignal.timeout(120000)` —— 那是**整段请求的墙钟上限**,而且包括读流的时间。
 * 于是一个健康地流了 121 秒的长回合会被硬掐断,界面上一句
 * 「The operation was aborted due to timeout」,前面说到一半的话就停在那儿。
 * 上下文越大、工具越多,一个回合越容易超过两分钟 —— 也就是说**活干得越多越容易被掐**。
 *
 * # 做法
 *
 * 每收到一块数据就把表拨回去。真正卡住(上游不吐字了)才会触发,正常流下去多久都不算超时。
 * 连接阶段同样受它管:发出去之后迟迟没有响应头,也是「没来数据」。
 *
 * 包在 fetch 这一层,provider 和 agent 都不用改 —— 它们看到的还是一个普通响应。
 */

/** 造一个和 `AbortSignal.timeout` 同形状的超时错误,好让上层按老办法认出来 */
function timeoutError(ms) {
  const e = new Error(`The operation was aborted due to timeout（${Math.round(ms / 1000)} 秒没有收到任何数据）`);
  e.name = 'TimeoutError';
  return e;
}

function toBodyIterator(source) {
  if (typeof source?.[Symbol.asyncIterator] === 'function') {
    const it = source[Symbol.asyncIterator]();
    return {
      next: () => it.next(),
      close: async () => { try { await it.return?.(); } catch {} },
    };
  }
  if (typeof source?.getReader === 'function') {
    const reader = source.getReader();
    return {
      next: () => reader.read(),
      close: async () => {
        try { await reader.cancel?.(); } catch {}
        try { reader.releaseLock?.(); } catch {}
      },
    };
  }
  return null;
}

/**
 * 把 fetch 包成「闲置超时」的。
 *
 * @param fetchImpl 真正发请求的
 * @param idleMs    多久没有任何数据算卡住
 */
export function withIdleTimeout(fetchImpl, { idleMs = 120000 } = {}) {
  return async function idleTimeoutFetch(url, init) {
    const ac = new AbortController();
    let timer = null;
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const bump = () => {
      stop();
      timer = setTimeout(() => ac.abort(timeoutError(idleMs)), idleMs);
      // 这个定时器不该拦着进程退出:请求本身有别的办法结束
      timer.unref?.();
    };

    bump();
    const signal = init?.signal ? AbortSignal.any([init.signal, ac.signal]) : ac.signal;

    let res;
    try {
      res = await fetchImpl(url, { ...init, signal });
    } catch (e) {
      stop();
      throw e;
    }

    // 出错的响应不流,正文由 assertOk 一次读完,表可以停了
    if (!res || !res.ok || !res.body) {
      stop();
      return res;
    }

    bump(); // 响应头到了,重新计时:接下来看的是第一块正文来得快不快

    const source = res.body;
    async function* watched() {
      const iter = toBodyIterator(source);
      if (!iter) {
        stop();
        return;
      }
      try {
        while (true) {
          const { done, value } = await iter.next();
          if (done) break;
          bump();
          yield value;
        }
      } finally {
        stop();
        await iter.close();
      }
    }

    /*
     * 只把 body 换掉,别的字段照抄。
     *
     * 不用 Proxy 也不改原对象:下游只用到 ok / status / headers / text / body 这几样
     * (assertOk 和 readSse),明写出来比反射清楚,也不会因为 Response 的某个 getter
     * 绑在原型上而在包装后炸掉。
     */
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      text: () => res.text(),
      json: () => res.json(),
      body: watched(),
    };
  };
}


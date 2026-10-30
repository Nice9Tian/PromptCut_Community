/**
 * A render shard can lose its Chrome in the middle of an export. On 2026-09-14
 * the browser process of one shard in a four-shard Tokyo export exited with
 * 0xC0000409 two and a half minutes in. The DevTools WebSocket closed, every
 * pending CDP call rejected with TargetCloseError, and the whole export failed
 * although the other three shards were healthy. The next export of the same
 * project finished normally.
 *
 * A shard can be restarted: it begins at a safe cut and replays its own
 * history, so a fresh Chrome renders the same frames. Only the frames an
 * earlier attempt already delivered are dropped (`resumableSink`), because the
 * part movie must hold every frame exactly once.
 */

/** Error names puppeteer uses once the DevTools connection or session is gone. */
const LOSS_ERRORS = new Set(['TargetCloseError', 'ConnectionClosedError']);

/** True when the error means the Chrome behind a bakery went away. A call made
 * after the disconnect can fail with a plain Error instead ("Attempted to use
 * detached Frame"); `useBakery` marks those from the connection state. A
 * timeout, a cancellation or a page error is not a loss: retrying those would
 * only repeat them. */
export function isBrowserLoss(error) {
  if (!error || error.cancelled) return false;
  for (let e = error, depth = 0; e && depth < 4; e = e.cause, depth++) {
    if (e.browserLost === true || LOSS_ERRORS.has(e.name)) return true;
    if (e.name === 'ProtocolError' && /\b(Target closed|Session closed)\b/.test(String(e.message || ''))) return true;
  }
  return false;
}

/** How the Chrome process ended, e.g. "退出码 0xC0000409". The WebSocket can
 * close slightly before the process reports its exit, so wait briefly. */
export async function browserExitNote(browser, waitMs = 2000) {
  const proc = browser?.process?.();
  if (!proc) return '';
  if (proc.exitCode === null && !proc.signalCode) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      timer.unref?.();
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (proc.exitCode !== null && proc.exitCode !== undefined) {
    return `退出码 0x${(proc.exitCode >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  }
  return proc.signalCode ? `信号 ${proc.signalCode}` : '';
}

/** Use a bakery and always close it. The connection state and the exit status
 * are read before close(), which would otherwise disconnect a healthy browser
 * and replace a crashed one's exit status with our own kill. */
export async function useBakery(bakery, use) {
  try {
    return await use(bakery);
  } catch (error) {
    if (error && typeof error === 'object' && !error.cancelled
      && (isBrowserLoss(error) || bakery.browser?.connected === false)) {
      error.browserLost = true;
      error.browserExit ??= await browserExitNote(bakery.browser);
    }
    throw error;
  } finally {
    await bakery.close().catch(() => {});
  }
}

/**
 * Forward frames to `sink`, skipping frames that an earlier attempt delivered.
 * Call begin() at the start of every attempt. Within one attempt every frame is
 * forwarded as before.
 */
export function resumableSink(sink) {
  let delivered = -Infinity;
  let skipThrough = -Infinity;
  return {
    begin() { skipThrough = delivered; },
    async write(frame, buffer) {
      if (frame <= skipThrough) return;
      await sink(frame, buffer);
      if (frame > delivered) delivered = frame;
    },
  };
}

/** Run `run(attempt)` again with a fresh Chrome when the browser was lost. */
export async function retryOnBrowserLoss(run, { attempts = 3, label = '', log = console.warn } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      if (!isBrowserLoss(error)) throw error;
      const exit = error.browserExit ? `,${error.browserExit}` : '';
      if (attempt + 1 >= attempts) {
        throw new Error(`导出用的 Chrome 在渲染${label}时中途退出${exit},换新 Chrome 重试 ${attempts - 1} 次仍失败。`
          + '可以减少并行分片数、关掉占内存的程序后再导出。', { cause: error });
      }
      log(`[export] 渲染${label}时 Chrome 中途退出${exit},换一个新 Chrome 重渲这一段(第 ${attempt + 2}/${attempts} 次)`);
    }
  }
}

/**
 * Child process and browser tracking for clean cancellation, plus shared video
 * shard concatenation and ordered frame piping.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const activeChildren = new Set();
const activeBrowsers = new Set();

export function trackChild(proc) {
  if (!proc) return proc;
  activeChildren.add(proc);
  const drop = () => activeChildren.delete(proc);
  proc.once('close', drop);
  proc.once('exit', drop);
  proc.once('error', drop);
  return proc;
}

export function trackBrowser(browser) {
  if (!browser) return browser;
  activeBrowsers.add(browser);
  const proc = browser.process?.();
  const drop = () => activeBrowsers.delete(browser);
  browser.once?.('disconnected', drop);
  proc?.once?.('exit', drop);
  proc?.once?.('close', drop);
  return browser;
}

export function killTrackedChildren() {
  for (const proc of [...activeChildren]) {
    activeChildren.delete(proc);
    try { proc.kill('SIGKILL'); } catch {}
  }
  for (const browser of [...activeBrowsers]) {
    activeBrowsers.delete(browser);
    try { browser.process?.()?.kill('SIGKILL'); } catch {}
    try { browser.close?.().catch?.(() => {}); } catch {}
  }
}

function concatPath(file) {
  return String(file).replace(/\\/g, '/').replace(/'/g, "'\\''");
}

/** Join independently encoded part movies without decoding them again. */
export async function concatVideos(ffmpeg, parts, output) {
  if (!parts.length) throw new Error('No export shards to merge');
  const list = output + '.concat.txt';
  await fs.writeFile(list, parts.map((file) => `file '${concatPath(path.resolve(file))}'`).join('\n') + '\n', 'utf8');
  try {
    await new Promise((resolve, reject) => {
      const proc = trackChild(spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
        '-i', list, '-c', 'copy', output], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }));
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
      proc.on('error', reject);
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Failed to merge export shards (ffmpeg ${code}): ${stderr}`)));
    });
  } finally {
    await fs.rm(list, { force: true });
  }
}

/**
 * Feed multi-shard frames into an ordered async consumer (`startFrame..endFrame`)
 * while capping buffered out-of-order PNGs in RAM and reading spilled frames from
 * disk once their owning shard has flushed all writes.
 */
export function createOrderedFramePipe({ startFrame, endFrame, framesDir, ext = 'png', write }) {
  let next = startFrame;
  let chain = Promise.resolve();
  let failure = null;
  const memory = new Map();
  const spilled = new Map();
  const MEMORY_LIMIT = 256;

  const drainMemory = async () => {
    while (next <= endFrame && !failure && memory.has(next)) {
      const buf = memory.get(next);
      memory.delete(next);
      next++;
      await write(buf);
    }
  };

  const enqueueMemoryDrain = () => {
    chain = chain.then(drainMemory).catch((e) => { failure ||= e; });
    return chain;
  };

  return {
    async push(frame, buf, shardFlushed) {
      if (failure) throw failure;
      if (frame < next + 64 || memory.size < MEMORY_LIMIT || !shardFlushed) {
        memory.set(frame, buf);
      } else {
        spilled.set(frame, shardFlushed);
        return;
      }
      if (memory.has(next)) {
        await enqueueMemoryDrain();
        if (failure) throw failure;
      }
    },
    async finish() {
      await enqueueMemoryDrain();
      while (next <= endFrame && !failure) {
        if (memory.has(next)) {
          await enqueueMemoryDrain();
          continue;
        }
        if (!spilled.has(next)) break;
        const shardReady = spilled.get(next);
        spilled.delete(next);
        await shardReady;
        const name = String(next).padStart(6, '0');
        const buf = await fs.readFile(path.join(framesDir, `${name}.${ext}`));
        next++;
        await write(buf);
      }
      if (failure) throw failure;
      if (next <= endFrame) throw new Error(`Ordered frame pipe ended at frame ${next - 1}, expected ${endFrame}`);
    },
  };
}

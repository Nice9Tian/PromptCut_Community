import { EventEmitter } from 'node:events';
import { accountError } from './run-asset-client.mjs';

/** Adapt the actual frozen run-resources API; no new context authority, no
 * never-aborting fake signal, and no OS-tree/Jobs closure claim. */
export function createToolAssetResources(resources) {
  if (!['register', 'signalFor', 'authorize', 'verifyFence'].every(k => typeof resources?.[k] === 'function'))
    throw accountError(503, 'project-assets-resources-unconfigured');
  const owned = new Set();
  return {
    async track(context, resource, kind = 'stream') {
      if (!resource || resource.closed === true) throw accountError(503, 'project-assets-resource-already-closed');
      const registration = await resources.register(context, { kind, resource });
      const signal = resources.signalFor(context);
      const abort = () => resource.destroy(); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const entry = { resource, closed: registration.closed }; owned.add(entry);
      registration.closed.finally(() => { owned.delete(entry); signal.removeEventListener('abort', abort); }).catch(() => {});
      return { closed: registration.closed, signal };
    },
    handle(handle) {
      const resource = new EventEmitter(); resource.closed = false;
      const closed = new Promise(resolve => handle.once('close', () => { resource.closed = true; resource.emit('close'); resolve(); }));
      resource.destroy = () => { void handle.close().catch(() => {}); };
      return { resource, closed, async close() { await handle.close(); await closed; } };
    },
    async close() {
      const entries = [...owned]; for (const entry of entries) entry.resource.destroy();
      await Promise.all(entries.map(e => e.closed));
      return { streamsClosed: true, dispatchesOpen: 0, pending: false };
    },
  };
}

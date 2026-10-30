import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, PassThrough } from 'node:stream';
import { accountError, digestOf, validateAssetRef, resourceRevision, assetRefId, exactShape, reference, createLocalRunAssetClient } from './run-asset-client.mjs';
import { createToolAssetResources } from './tool-assets-resources.mjs';
import { waitAssetWritable } from '../../asset-store/project-access.mjs';

const fail = (status, code) => { throw accountError(status, code); };
/** Tools pass media references/bytes, never project/run credentials or paths.
 * reserveImport is a trusted workspace quota adapter; absent means 503, not a
 * new default budget. Stored bytes and doc addMedia remain distinct outcomes. */
export function createProjectAssets({ contextAccess, runAssetClient: clientIn, store = null, projectId = null, media = undefined, workspace, resources,
  reserveImport, maxImportBytes, verifySourceJob } = {}) {
  const client = clientIn ?? (store ? createLocalRunAssetClient({ store, projectId, media }) : null);
  if (typeof contextAccess?.authorize !== 'function' || !['issue', 'request', 'json'].every(k => typeof client?.[k] === 'function') ||
      typeof workspace !== 'function' || typeof reserveImport !== 'function' || !Number.isSafeInteger(maxImportBytes) || maxImportBytes < 1)
    fail(503, 'project-assets-unconfigured');
  const owned = createToolAssetResources(resources), pending = new Set(); let stopped = false, closePromise;
  const watch = task => { pending.add(task); void task.then(() => pending.delete(task), () => pending.delete(task)); return task; };
  const invocation = fn => (...args) => watch(Promise.resolve().then(() => fn(...args)));
  const authorize = async (context, action) => {
    if (stopped) fail(503, 'project-assets-closed'); await contextAccess.authorize(context, action);
    if (stopped) fail(503, 'project-assets-closed');
  };
  const track = async (context, stream) => {
    const registration = await owned.track(context, stream);
    if (stopped) { stream.destroy(); await registration.closed; fail(503, 'project-assets-closed'); }
    return registration;
  };
  const json = async (context, handle, options) => {
    await authorize(context, ['PUT', 'POST'].includes(options.method) && !options.verify ? 'write' : 'read');
    return client.json(context, handle, options, stream => track(context, stream));
  };
  async function openRead(context, mediaId, options = {}) {
    if (!reference(mediaId) || !exactShape(options, [], ['tier', 'range']) || !['original', 'small'].includes(options.tier ?? 'original')) fail(400, 'project-assets-input-invalid');
    await authorize(context, 'read');
    const handle = await client.issue(context, 'openRead', { mediaId, tier: options.tier ?? 'original' }, crypto.randomUUID());
    await authorize(context, 'read');
    const response = await client.request(context, handle, { method: 'GET', requestId: crypto.randomUUID(), ...(options.range ? { range: options.range } : {}) });
    const output = new PassThrough(); output.on('error', () => {});
    let inputRegistration, outputRegistration;
    try {
      inputRegistration = await track(context, response.stream); outputRegistration = await track(context, output);
      if (![200, 206].includes(response.status)) fail(response.status, response.status === 404 ? 'asset-missing' : 'project-assets-read-failed');
      await authorize(context, 'read');
    } catch (error) { output.destroy(); response.stream.destroy(); await response.closed; throw error; }
    const pumping = (async () => {
      const digest = crypto.createHash('sha256'); let size = 0;
      for await (const piece of response.stream) {
        await authorize(context, 'read'); inputRegistration.signal.throwIfAborted();
        const bytes = Buffer.from(piece); size += bytes.length; digest.update(bytes);
        if (!options.range && size > handle.resource.size) fail(409, 'asset-size-mismatch');
        if (!output.write(bytes)) await waitAssetWritable(output);
      }
      if (!options.range && (size !== handle.resource.size || digest.digest('hex') !== handle.resource.hash)) fail(409, 'asset-hash-mismatch');
      await authorize(context, 'read'); output.end();
    })();
    void pumping.catch(error => output.destroy(error));
    const closed = (async () => {
      let error; try { await pumping; } catch (failure) { error = failure; response.stream.destroy(); output.destroy(failure); }
      await Promise.all([inputRegistration.closed, outputRegistration.closed, response.closed]); if (error) throw error;
    })(); watch(closed);
    return { stream: output, assetRef: handle.resource, mediaRev: handle.mediaRev, projectRev: handle.projectRev, kind: handle.kind, closed };
  }
  async function importBytes(context, source, options) {
    if (!exactShape(options, ['name', 'kind', 'requestId'], ['sourceJobId']) || !reference(options.requestId) ||
        typeof options.name !== 'string' || !options.name || /[\r\n\0]/.test(options.name) || !['audio', 'image', 'video'].includes(options.kind)) fail(400, 'project-assets-input-invalid');
    await authorize(context, 'write');
    if (!source || (typeof source[Symbol.asyncIterator] !== 'function' && !(source instanceof Uint8Array))) fail(400, 'project-assets-source-invalid');
    if (options.sourceJobId && (typeof verifySourceJob !== 'function' || await verifySourceJob(context, options.sourceJobId) !== true)) fail(403, 'project-assets-job-mismatch');
    const ws = await workspace(context), ext = path.extname(options.name).slice(1).toLowerCase();
    await authorize(context, 'write');
    if (!/^[a-z0-9]{1,8}$/.test(ext) || typeof ws?.resolve !== 'function' || typeof ws?.remove !== 'function') fail(503, 'project-assets-workspace-unconfigured');
    const importId = `import:${digestOf({ context, requestId: options.requestId })}`;
    const rel = `.tmp/run-import-${crypto.randomUUID()}`, file = ws.resolve(rel);
    const handle = await fs.open(file, 'wx'), wrapped = owned.handle(handle);
    let size = 0; const digest = crypto.createHash('sha256');
    const input = source?.destroy ? source : Readable.from(source instanceof Uint8Array ? [source] : source);
    try {
      await owned.track(context, wrapped.resource); await track(context, input);
      for await (const piece of input) { await authorize(context, 'write'); const bytes = Buffer.from(piece); size += bytes.length;
        if (size > maxImportBytes) fail(413, 'project-assets-import-too-large');
        await reserveImport(context, bytes.length);
        for (let offset = 0; offset < bytes.length;) { await authorize(context, 'write'); const write = await handle.write(bytes, offset, bytes.length - offset); if (!write.bytesWritten) fail(503, 'project-assets-spool-write-failed'); offset += write.bytesWritten; }
        digest.update(bytes); }
      await authorize(context, 'write');
      await handle.sync(); await wrapped.close(); await authorize(context, 'write');
      if (!size) fail(400, 'project-assets-empty-import');
      const hash = digest.digest('hex');
      const issued = await client.issue(context, 'import', { hash, size, ext, name: options.name, kind: options.kind, importId }, options.requestId);
      await authorize(context, 'write');
      const statHandle = await client.issue(context, 'verifyRef', { hash, size }, `stat:${crypto.randomUUID()}`);
      await authorize(context, 'write');
      const read = await fs.open(file, 'r'), readResource = owned.handle(read); await track(context, readResource.resource);
      try {
        let status = await json(context, statHandle, { method: 'GET', suffix: '/chunks', importId, requestId: crypto.randomUUID() });
        if (!Number.isSafeInteger(status.chunkSize) || status.chunkSize < 1 || status.chunkSize > maxImportBytes || !Array.isArray(status.received)) fail(503, 'run-asset-response-invalid');
        if (!status.complete) {
          for (let n = 0; n < Math.ceil(size / status.chunkSize); n++) if (!status.received.includes(n)) {
            await authorize(context, 'write'); const bytes = Buffer.alloc(Math.min(status.chunkSize, size - n * status.chunkSize));
            const readResult = await read.read(bytes, 0, bytes.length, n * status.chunkSize); if (readResult.bytesRead !== bytes.length) fail(409, 'project-assets-spool-changed');
            const result = await json(context, issued, { method: 'PUT', suffix: `/${n}`, requestId: crypto.randomUUID(), importId, chunkIndex: n, body: bytes });
            if (!['ok', 'complete'].includes(result?.status)) fail(409, 'project-assets-chunk-rejected');
          }
          const complete = await json(context, issued, { method: 'POST', suffix: '/complete', requestId: crypto.randomUUID(), importId, body: Buffer.alloc(0) });
          if (complete?.status !== 'ok' || complete.size !== size) fail(409, 'project-assets-complete-rejected');
        }
      } finally { await readResource.close(); }
      await authorize(context, 'write');
      return { importId, assetRef: issued.resource, state: 'stored', resourceRev: issued.resourceRev };
    } finally { input.destroy(); await wrapped.close(); ws.remove(rel); }
  }
  async function verifyRef(context, ref) {
    if (!exactShape(ref, ['projectId', 'hash', 'size']) || ref.projectId !== context.projectId) fail(403, 'project-assets-project-mismatch');
    await authorize(context, 'read'); const handle = await client.issue(context, 'verifyRef', { hash: ref.hash, size: ref.size }, crypto.randomUUID());
    const result = await json(context, handle, { method: 'POST', verify: true, requestId: crypto.randomUUID(), contentType: 'application/json', body: Buffer.from(JSON.stringify(ref)) });
    const resource = validateAssetRef(result.assetRef);
    if (resource.projectId !== ref.projectId || resource.hash !== ref.hash || resource.size !== ref.size ||
        result.resourceRev !== resourceRevision(resource) || result.assetRefId !== assetRefId(resource)) fail(503, 'run-asset-response-invalid');
    await authorize(context, 'read'); return result;
  }
  return { openRead: invocation(openRead), import: invocation(importBytes), verifyRef: invocation(verifyRef),
    close() {
      if (!closePromise) {
        stopped = true;
        closePromise = (async () => {
          const outcomes = await Promise.allSettled([owned.close(), ...pending]);
          const receipt = await owned.close(); // Includes resources whose setup was already in flight.
          if (outcomes[0].status === 'rejected') throw outcomes[0].reason;
          return receipt;
        })();
      }
      return closePromise;
    } };
}

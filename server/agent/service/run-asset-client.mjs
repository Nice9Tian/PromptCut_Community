import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { minimalContentType } from '../../asset-store/blob-store.mjs';

export const RUN_ASSET_DATA_ROOT = '/internal/v2/asset/run/';

export const accountError = (status, code) => Object.assign(new Error(code), { status, code });

export const canonicalJson = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item ?? null)).join(',')}]`;
  const entries = Object.keys(value)
    .filter(key => value[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
};
export const digestOf = value => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

export const reference = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
export const hashOf = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isSize = value => Number.isSafeInteger(value) && value >= 0;
const isText = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value);

export function exactShape(value, required, optional = []) {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key)),
  );
}

export function validateAssetRef(ref) {
  if (!exactShape(ref, ['projectId', 'ns', 'hash', 'size', 'contentType'], ['ext']) ||
      !reference(ref.projectId) || ref.ns !== 'media' || !hashOf(ref.hash) || !isSize(ref.size) ||
      !isText(ref.contentType) || (ref.ext !== undefined && !/^[a-z0-9]{1,16}$/.test(ref.ext))) {
    throw accountError(400, 'resource-invalid');
  }
  return structuredClone(ref);
}

export const resourceRevision = ref => digestOf({ v: 1, ...validateAssetRef(ref) });
export const assetRefId = ref => `asset:${resourceRevision(ref)}`;

/**
 * 本机直连 BlobStore 的运行期素材客户端（社区版 / 本机模式，不经云端 mTLS transport）。
 * 支持 `server/asset-store/fs-store.mjs` 或 `memory-store.mjs`。
 */
export function createLocalRunAssetClient({ store, projectId: fixedProjectId = null, media = () => ({}) } = {}) {
  if (!store || typeof store.chunks !== 'function' || typeof store.putChunk !== 'function' ||
      typeof store.complete !== 'function' || typeof store.read !== 'function' || typeof store.stat !== 'function') {
    throw accountError(503, 'run-asset-store-unconfigured');
  }
  const issued = new WeakMap();
  const buildRef = (projectId, { hash, size, ext, contentType }) => {
    const cleanExt = typeof ext === 'string' && /^[a-z0-9]{1,16}$/.test(ext) ? ext : undefined;
    return validateAssetRef({
      projectId,
      ns: 'media',
      hash,
      size,
      contentType: contentType || minimalContentType(cleanExt ?? ''),
      ...(cleanExt ? { ext: cleanExt } : {}),
    });
  };
  const issue = async (context, purpose, selector) => {
    const projectId = fixedProjectId ?? context?.projectId;
    if (!reference(projectId)) throw accountError(400, 'resource-invalid');
    let resource;
    let kind = selector?.kind ?? 'video';
    const mediaRev = 'local-media-rev';
    const projectRev = 1;
    if (purpose === 'openRead') {
      const table = (await media(projectId)) ?? {};
      const entry = table[selector?.mediaId];
      const tier = selector?.tier === 'small' ? 'small' : 'original';
      const chosen = tier === 'small' && entry?.small ? entry.small : entry;
      if (!chosen?.hash || !Number.isSafeInteger(chosen?.size)) throw accountError(404, 'asset-missing');
      resource = buildRef(projectId, {
        hash: chosen.hash,
        size: chosen.size,
        ext: chosen.ext ?? entry?.ext,
        contentType: chosen.contentType ?? entry?.contentType,
      });
      kind = entry?.kind ?? kind;
    } else {
      const st = purpose === 'verifyRef' ? await store.stat(selector?.hash) : null;
      resource = buildRef(projectId, {
        hash: selector?.hash,
        size: selector?.size,
        ext: selector?.ext ?? st?.ext,
        contentType: selector?.contentType ?? st?.contentType,
      });
    }
    const value = Object.freeze({
      assetHandleId: `local_handle_${randomUUID()}`,
      resource,
      resourceRev: resourceRevision(resource),
      mediaRev,
      projectRev,
      kind,
      ext: resource.ext ?? selector?.ext ?? 'bin',
    });
    issued.set(value, digestOf(context));
    return value;
  };
  const request = async (context, handle, { method, range }) => {
    if (issued.get(handle) !== digestOf(context) || handle.resource.projectId !== context.projectId) {
      throw accountError(403, 'run-asset-handle-untrusted');
    }
    if (method === 'GET') {
      const stream = await store.read(handle.resource.hash, range);
      if (!stream) {
        const empty = Readable.from([]);
        return { status: 404, stream: empty, closed: Promise.resolve() };
      }
      const closed = new Promise(resolve => {
        stream.once('close', resolve);
        stream.once('end', resolve);
        stream.once('error', () => resolve());
      });
      return { status: range ? 206 : 200, stream, closed };
    }
    throw accountError(405, 'run-asset-method-unsupported');
  };
  const json = async (context, handle, options) => {
    if (issued.get(handle) !== digestOf(context) || handle.resource.projectId !== context.projectId) {
      throw accountError(403, 'run-asset-handle-untrusted');
    }
    const { hash, size } = handle.resource;
    if (options.verify) {
      const st = await store.stat(hash);
      if (!st || st.size !== size) throw accountError(404, 'asset-missing');
      const assetRef = buildRef(context.projectId, {
        hash,
        size,
        ext: st.ext || handle.resource.ext,
        contentType: st.contentType || handle.resource.contentType,
      });
      return {
        assetRef,
        resourceRev: resourceRevision(assetRef),
        assetRefId: assetRefId(assetRef),
      };
    }
    if (options.method === 'GET' && options.suffix === '/chunks') {
      return await store.chunks(hash);
    }
    if (options.method === 'PUT' && Number.isInteger(options.chunkIndex)) {
      return await store.putChunk(
        hash,
        options.chunkIndex,
        { size, ext: handle.ext ?? 'bin' },
        Readable.from([Buffer.from(options.body ?? [])]),
      );
    }
    if (options.method === 'POST' && options.suffix === '/complete') {
      return await store.complete(hash);
    }
    throw accountError(400, 'run-asset-response-invalid');
  };
  return { issue, request, json };
}

/** Thin consumer of the trusted worker facade. It owns neither RAM key nor
 * raw ticket and cannot construct an arbitrary instance signing invocation. */
export function createRunAssetClient({ transport, maxResponseBytes, store = null, projectId = null, media = undefined } = {}) {
  if (!transport && store) {
    return createLocalRunAssetClient({ store, projectId, media });
  }
  if (!['issue', 'request'].every(k => typeof transport?.[k] === 'function') ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw accountError(503, 'run-asset-transport-unconfigured');
  const issued = new WeakMap();
  const issue = async (context, purpose, selector, requestId) => {
    const result = await transport.issue({ context, purpose, selector, requestId });
    const resource = validateAssetRef(result?.resource);
    if (!reference(result.assetHandleId) || resource.projectId !== context.projectId || result.resourceRev !== resourceRevision(resource))
      throw accountError(503, 'run-asset-response-invalid');
    const value = Object.freeze({ ...result, resource }); issued.set(value, digestOf(context)); return value;
  };
  async function request(context, handle, { method, suffix = '', verify = false, requestId, ...options }) {
    if (issued.get(handle) !== digestOf(context) || handle.resource.projectId !== context.projectId) throw accountError(403, 'run-asset-handle-untrusted');
    const result = await transport.request({ context, assetHandleId: handle.assetHandleId, method,
      url: verify ? `${RUN_ASSET_DATA_ROOT}refs/verify` : `${RUN_ASSET_DATA_ROOT}media/${handle.resource.hash}${suffix}`,
      requestId, ...options });
    if (!result?.stream || typeof result.stream.destroy !== 'function' || !result.closed?.then ||
        !Number.isInteger(result.status)) throw accountError(503, 'run-asset-response-invalid');
    return result;
  }
  async function json(context, handle, options, track) {
    const result = await request(context, handle, options); await track(result.stream);
    const pieces = []; let size = 0;
    try { for await (const piece of result.stream) { size += piece.length;
      if (size > maxResponseBytes) throw accountError(503, 'run-asset-response-invalid'); pieces.push(piece); }
      await result.closed;
      let value; try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(pieces))); }
      catch { throw accountError(503, 'run-asset-response-invalid'); }
      if (result.status >= 400 || value?.ok !== true) throw accountError(result.status, value?.code ?? 'run-asset-response-invalid');
      return value.result;
    } finally { result.stream.destroy(); }
  }
  return { issue, request, json };
}

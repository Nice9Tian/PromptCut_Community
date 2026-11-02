/**
 * Synthetic legacy file matrix (fixtures, not tests) used by 0.7.18 itemized acceptance check
 * 2.1-8 "Convert expired cloud project to local" and 2.1-19 "Acceptance check for legacy files
 * after cleanup".
 *
 * The converter (which converts legacy cloud files to local projects after receiving the "no longer
 * exists" certificate issued by the document service) is not on main yet, so only **legacy file
 * samples** are created here: same shape as the .proc / .procp left by real legacy test projects
 * (with `collaboration` associations, asset references, cards), to be used as input once the
 * converter is merged in the future, and can also be used to verify the workflow before the
 * re-verification of real legacy files (2.1-19). They **cannot** replace the real legacy files
 * required by 2.1-19.
 *
 * Usage:
 *   import { buildOldProcMatrix } from './accept-018-files-old-proc-fixtures.mjs';
 *   const m = await buildOldProcMatrix(dir);   // m.files is file paths, m.expect is facts each sample should satisfy
 *
 * Samples (all deterministic content, fixed hash, reproducible):
 *   hostedAllMedia.procp     Cloud (hosted) room association + package has all 2 assets
 *   hostedPartialMedia.procp Same as above, but package only has 1 (the other is not in package)
 *   hostedNoMedia.procp      Same as above, but package has no assets at all (arrangement only)
 *   hostedPlain.proc         Plain .proc with cloud room association (asset references have hash and name only)
 *   lanPlain.proc            Plain .proc with LAN (lan) room association
 *   barePlain.proc           Legacy .proc without any collaboration association
 *   bareLegacyJson.proc      Older bare Project JSON (no format shell)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { srcUrl } from '../../src/testing/registerTs.mjs';

const proc = await import(srcUrl('editor/io/proc.ts'));
const procp = await import(srcUrl('editor/io/procp.ts'));

export const OLD_ROOM_ID = 'sp_abcdefghijklmnopqrstuvwxyz'; // sp_ + 26 lowercase base32 characters
export const OLD_SERVICE = 'https://old-test-node.invalid';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export const MEDIA = [
  { id: 'media-video-1', name: 'old-scene.mp4', kind: 'video', bytes: Buffer.from('OLD-VIDEO-BYTES-0001-'.repeat(40)), ext: 'mp4', duration: 4 },
  { id: 'media-audio-1', name: 'old-voice.wav', kind: 'audio', bytes: Buffer.from('OLD-AUDIO-BYTES-0002-'.repeat(40)), ext: 'wav', duration: 2 },
].map(m => ({ ...m, hash: sha(m.bytes) }));

function oldProject(name) {
  return {
    id: 'old-content-' + name,
    name,
    tracks: [
      { id: 'track-video', kind: 'video', clips: [{ id: 'clip-v1', mediaId: MEDIA[0].id, start: 0, end: 4, offset: 0 }] },
      { id: 'track-audio', kind: 'audio', clips: [{ id: 'clip-a1', mediaId: MEDIA[1].id, start: 1, end: 3, offset: 0 }] },
    ],
    media: MEDIA.map(m => ({ id: m.id, name: m.name, kind: m.kind, hash: m.hash, url: `/@media/${m.hash}`, duration: m.duration })),
  };
}
const collab = (where) => ({ version: 1, roomId: OLD_ROOM_ID, service: OLD_SERVICE, where });
const procText = (name, collaboration) => JSON.stringify({ format: proc.PROC_FORMAT, version: proc.PROC_VERSION, project: oldProject(name),
  ...(collaboration ? { collaboration } : {}), ai: { script: 'old script of ' + name, messages: [] } }, null, 2);

export async function buildOldProcMatrix(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  const put = (key, file, data) => { files[key] = path.join(dir, file); fs.writeFileSync(files[key], data); };
  const pack = async (name, mediaIn) => {
    const entries = [{ name: 'project.proc', blob: new Blob([procText(name, collab('hosted'))]) },
      ...mediaIn.map(m => ({ name: `media/${m.hash}.${m.ext}`, blob: new Blob([m.bytes]) }))];
    return Buffer.from(await (await procp.writeZip(entries)).arrayBuffer());
  };
  put('hostedAllMedia', 'hostedAllMedia.procp', await pack('hostedAllMedia', MEDIA));
  put('hostedPartialMedia', 'hostedPartialMedia.procp', await pack('hostedPartialMedia', [MEDIA[0]]));
  put('hostedNoMedia', 'hostedNoMedia.procp', await pack('hostedNoMedia', []));
  put('hostedPlain', 'hostedPlain.proc', procText('hostedPlain', collab('hosted')));
  put('lanPlain', 'lanPlain.proc', procText('lanPlain', collab('lan')));
  put('barePlain', 'barePlain.proc', procText('barePlain', null));
  put('bareLegacyJson', 'bareLegacyJson.proc', JSON.stringify(oldProject('bareLegacyJson')));
  return {
    files,
    media: MEDIA,
    roomId: OLD_ROOM_ID,
    service: OLD_SERVICE,
    /** Facts each sample should satisfy (compared for "no content lost" in conversion results once converter is merged) */
    expect: {
      hostedAllMedia: { association: 'hosted', packedHashes: MEDIA.map(m => m.hash) },
      hostedPartialMedia: { association: 'hosted', packedHashes: [MEDIA[0].hash], absentHashes: [MEDIA[1].hash] },
      hostedNoMedia: { association: 'hosted', packedHashes: [], absentHashes: MEDIA.map(m => m.hash) },
      hostedPlain: { association: 'hosted' },
      lanPlain: { association: 'lan' },
      barePlain: { association: null },
      bareLegacyJson: { association: null },
    },
  };
}

/**
 * 0.7.18 逐项验收 2.1-8「过期云端项目转本地」、2.1-19「清理后旧文件验收」用的合成旧文件矩阵(夹具,不是测试)。
 *
 * 转换器(拿到文档服务签发的「已不存在」证明后把旧云端文件转成本地项目)在 main 上还没有,所以这里只造**旧文件样本**:
 * 与真实旧测试项目留下的 .proc / .procp 同形状(带 `collaboration` 关联、素材引用、卡片),将来转换器合入后拿它们当输入,
 * 真实旧文件复验(2.1-19)前也可以先拿它们把流程跑通。它们**不能**代替 2.1-19 要求的真实旧文件。
 *
 * 用法:
 *   import { buildOldProcMatrix } from './accept-018-files-old-proc-fixtures.mjs';
 *   const m = await buildOldProcMatrix(dir);   // m.files 是文件路径,m.expect 是每个样本应当满足的事实
 *
 * 样本(全是确定的内容,哈希固定,可重复):
 *   hostedAllMedia.procp     云端(hosted)房间关联 + 包里带齐 2 个素材
 *   hostedPartialMedia.procp 同上但包里只带 1 个(另一个不在包里)
 *   hostedNoMedia.procp      同上但包里一个素材都没有(只有编排)
 *   hostedPlain.proc         云端房间关联的普通 .proc(素材引用只有哈希和名字)
 *   lanPlain.proc            局域网(lan)房间关联的普通 .proc
 *   barePlain.proc           没有任何协作关联的旧 .proc
 *   bareLegacyJson.proc      更旧的裸 Project JSON(没有 format 外壳)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { srcUrl } from '../../src/testing/registerTs.mjs';

const proc = await import(srcUrl('editor/io/proc.ts'));
const procp = await import(srcUrl('editor/io/procp.ts'));

export const OLD_ROOM_ID = 'sp_abcdefghijklmnopqrstuvwxyz'; // sp_ + 26 位 base32 小写
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
    /** 每个样本应当满足的事实(转换器合入后,转换结果的「内容不丢」就拿这些比) */
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

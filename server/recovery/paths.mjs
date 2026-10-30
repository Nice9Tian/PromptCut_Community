import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

/** Shared by the document service and its asset ticket verifier. */
export function localDocumentDir(root, env = process.env) {
  return env.PROMPTCUT_DOCSERVICE_DATA || path.join(env.PROMPTCUT_DATA_DIR || path.join(root, 'out'), 'docservice');
}
export function recoveryDir(root, env = process.env) {
  return path.join(env.PROMPTCUT_DATA_DIR || path.join(root, 'out'), 'collaboration');
}
/** Copy the old runtime-owned service once, before opening either its document or ticket store. */
export function prepareLocalDocumentDir(root, env = process.env) {
  const target = localDocumentDir(root, env), legacy = path.join(root, 'out', 'docservice');
  if (!env.PROMPTCUT_DATA_DIR || env.PROMPTCUT_DOCSERVICE_DATA || path.resolve(target) === path.resolve(legacy) || fs.existsSync(target) || !fs.existsSync(legacy)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staged = `${target}.migration-${process.pid}-${randomBytes(6).toString('hex')}`;
  fs.cpSync(legacy, staged, { recursive: true, errorOnExist: true, force: false, filter(source) {
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error('旧协作服务含外部链接，保留原数据，请显式恢复备份');
    return true;
  } });
  // A complete directory becomes visible in one rename. Never overwrite a newer stable directory.
  try { fs.renameSync(staged, target); } catch (e) { if (!fs.existsSync(target)) throw e; }
  return target;
}

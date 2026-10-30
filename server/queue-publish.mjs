/**
 * 预渲染发布方定版本(`vite-plugin-frames.ts` 队列模式的 `publish`;C6.5 设计稿第 3、13 节,`AGENT-c65-integ.md` 第 7 节遗留)。
 *
 * - **项目没有真身**(文档服务从没收到过 `project.op`):照 M5b 的老流程 —— `project.announce` 报摘要拿 `projectRev`,
 *   `putSnapshot` 把这一版的内容传上去,节点按 `projectId@projectRev` 取快照。
 * - **项目有真身**(页面或 Agent 已经在向文档服务提交操作):版本号只由真身决定,发布方不再发号、不再上传快照,
 *   直接以真身的 `rev` 发布 `plan`;节点取项目时由文档服务从真身发回(当前版本的 `project.snapshot.get`)。
 *   这里的 `project.announce` 只是询问:有真身时它不发号、不改任何状态,回真身的版本号与摘要(`authoritative: true`)。
 *   发布方手里的这一份(页面推来的)与真身逐字节相同才以真身发布;不同(页面还有没确认的修改,
 *   或页面没接文档服务而真身是早先留下的)就不交给队列,由本机自己产 —— 否则队列产出的是另一份内容,
 *   本机这一版等不到结果。
 *
 * 只依赖 Node 内置模块。
 */
import { createHash } from 'node:crypto';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * @param {object} options
 * @param {{ announce(projectId: string, digest: string, session?: string): Promise<{ projectRev: number, authoritative?: boolean, digest?: string }>,
 *   putSnapshot(projectId: string, projectRev: number, digest: string, text: string): Promise<void> }} options.projects
 * @param {string} options.projectId
 * @param {string} [options.session]
 * @param {string} options.text 渲染用的那一份(`renderProject` 之后)的 JSON 文本:老流程上传它
 * @param {string} options.rawText 页面推来的原样项目的 JSON 文本:有真身时与真身比对
 * @returns {Promise<{ projectRev: number, digest: string, via: 'announce' | 'body' } | { skip: 'body-mismatch', projectRev: number }>}
 */
export async function resolvePublishVersion({ projects, projectId, session, text, rawText }) {
  const digest = sha256(text);
  const announced = await projects.announce(projectId, digest, session);
  if (announced?.authoritative === true) {
    const rawDigest = sha256(rawText);
    if (rawDigest !== announced.digest) return { skip: 'body-mismatch', projectRev: announced.projectRev };
    return { projectRev: announced.projectRev, digest: rawDigest, via: 'body' };
  }
  await projects.putSnapshot(projectId, announced.projectRev, digest, text);
  return { projectRev: announced.projectRev, digest, via: 'announce' };
}

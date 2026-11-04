/**
 * Prerender publisher determines version (`publish` in queue mode of `vite-plugin-frames.ts`;
 * C6.5 design draft sections 3 and 13, `AGENT-c65-integ.md` section 7 leftover).
 *
 * - **The project has no authoritative copy** (the document service has never received `project.op`):
 *   follow the legacy M5b workflow: `project.announce` reports the digest to get `projectRev`,
 *   `putSnapshot` uploads the content of this version, and nodes fetch snapshots by
 *   `projectId@projectRev`.
 * - **The project has an authoritative copy** (the page or Agent is already submitting operations to
 *   the document service): the version number is determined solely by the authoritative copy; the
 *   publisher no longer assigns numbers or uploads snapshots, publishing `plan` directly with the
 *   authoritative copy's `rev`; when nodes fetch the project, the document service sends it back
 *   from the authoritative copy (current version's `project.snapshot.get`). Here `project.announce`
 *   is merely an inquiry: when an authoritative copy exists, it does not assign numbers or change
 *   any state, returning the authoritative copy's version number and digest (`authoritative: true`).
 *   Only when the copy held by the publisher (pushed by the page) is byte-for-byte identical to the
 *   authoritative copy will it be published under the authoritative copy; if different (the page
 *   still has unconfirmed edits, or the page is not connected to the document service while the
 *   authoritative copy was left over from earlier), it is not handed to the queue and is produced
 *   locally by this machine: otherwise the queue produces different content, and this local version
 *   will never receive results.
 *
 * Depends only on Node built-in modules.
 */
import { createHash } from 'node:crypto';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * @param {object} options
 * @param {{ announce(projectId: string, digest: string, session?: string): Promise<{ projectRev: number, authoritative?: boolean, digest?: string }>,
 *   putSnapshot(projectId: string, projectRev: number, digest: string, text: string): Promise<void> }} options.projects
 * @param {string} options.projectId
 * @param {string} [options.session]
 * @param {string} options.text JSON text used for rendering (after `renderProject`): uploaded in legacy workflow
 * @param {string} options.rawText Raw project JSON text pushed by the page: compared with the authoritative copy when one exists
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

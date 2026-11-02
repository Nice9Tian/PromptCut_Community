/**
 * The push queue only pushes artifacts of the bound project (handoff document `HANDOFF-2026-09-29.md`
 * Section 4, item 3; report `docs/archive/agent-reports/AGENT-push-scope.md`).
 *
 * The prerender process frame store is shared across all local projects on this machine: frames
 * written into the frame store by other concurrently open local projects also enter the push queue
 * via push hooks. The push queue connects to the asset service of the shared project (cloud, LAN
 * host), where frames from other projects should not go: asset service tickets are "only valid within
 * this project" (`product/asset-service.md` "Read and write with tickets"); the pure browser node
 * rule "do not allow other projects' content into the user's browser" applies similarly.
 * Here, enqueuing is decided based on "which project document this segment belongs to":
 *
 *   - Snapshot local tier: `project.id` of the entry version for `entryKey`;
 *   - Snapshot shared tier: keys are content-addressed, and several projects may share the same one;
 *     counted as matching as long as a card plan of an entry version in the **bound project** uses
 *     this snapshot key (content is identical, so pushing it is pushing the bound project's own content);
 *   - Track stream: state of this stream held by the producer records which entry version it belongs
 *     to (`entryKey`); if it does not match, check whether content keys of the stream's member cards
 *     appear in the bound project's card plan (same as above, content-addressed).
 *   - Layer table (`layers:<project id>`): judged directly by project id.
 *
 * If an entry cannot be found (already replaced, or not yet present right after process startup),
 * treat it as "not belonging": content from other projects is better kept on this machine than
 * pushed to the wrong place. Segments already in push queue files are not re-evaluated (queue files
 * are organized into directories by project, containing only segments for that project).
 *
 * `contentIds()` returns:
 *   - `ALL`: unrestricted (no shared project boundary: local identity connects to local or own
 *     cluster's document service; or legacy path config did not specify a project document id);
 *   - `null`: unknown yet (page has not submitted project document id): cannot judge, returns null,
 *     held by the push queue until known;
 *   - Array of strings: recognizes only these project document ids.
 */
export const ALL = 'all';

const controlKeyOf = (control) => control?.contentKey ?? control?.snapshotKey ?? null;

/**
 * @param {object} options
 * @param {any} options.pipeline  `FramePipeline` (reads `entries`, `streamProducer()`)
 * @param {() => (typeof ALL | string[] | null)} options.contentIds
 */
export function createPushScope({ pipeline, contentIds }) {
  if (!pipeline) throw new TypeError('createPushScope requires pipeline');
  if (typeof contentIds !== 'function') throw new TypeError('createPushScope requires contentIds()');
  const ids = () => {
    let v;
    try { v = contentIds(); } catch { v = null; }
    if (v === ALL) return ALL;
    if (!Array.isArray(v)) return null;
    const list = v.filter(id => typeof id === 'string' && id);
    return list.length ? list : null;
  };
  const entries = () => { try { return [...(pipeline.entries?.values?.() ?? [])]; } catch { return []; } };
  const inScope = (list, entry) => !!entry && typeof entry.project?.id === 'string' && list.includes(entry.project.id);

  /** Whether the project document id is in scope: true / false / null (unknown yet) */
  function acceptsProject(projectId) {
    const list = ids();
    if (list === ALL) return true;
    if (list === null) return null;
    return typeof projectId === 'string' && list.includes(projectId);
  }

  /** Whether a push queue segment (after `normalizeUnit` in `artifact-push.mjs`) is in scope: true / false / null (unknown yet) */
  function accepts(unit) {
    const list = ids();
    if (list === ALL) return true;
    if (list === null) return null;
    if (!unit || typeof unit !== 'object') return false;
    if (unit.kind === 'snapshot') {
      if (unit.tier === 'local') {
        const entry = pipeline.entries?.get?.(unit.entryKey);
        return inScope(list, entry);
      }
      const key = unit.dirKey ?? unit.resultKey;
      for (const entry of entries()) {
        if (!inScope(list, entry) || !Array.isArray(entry.cardPlan)) continue;
        if (entry.cardPlan.some(control => control && control.snapshotKey === key)) return true;
      }
      return false;
    }
    if (unit.kind === 'stream') {
      let state = null;
      try { state = pipeline.streamProducer?.()?.streams?.get?.(unit.resultKey) ?? null; } catch { state = null; }
      if (!state) return false;
      if (state.entryKey && inScope(list, pipeline.entries?.get?.(state.entryKey))) return true;
      const members = new Set((state.spec?.members ?? []).map(controlKeyOf).filter(Boolean));
      if (!members.size) return false;
      for (const entry of entries()) {
        if (!inScope(list, entry) || !Array.isArray(entry.cardPlan)) continue;
        if (entry.cardPlan.some(control => members.has(controlKeyOf(control)))) return true;
      }
      return false;
    }
    return false;
  }

  return { accepts, acceptsProject, describe: () => { const list = ids(); return list === ALL ? ALL : list === null ? 'pending' : [...list]; } };
}

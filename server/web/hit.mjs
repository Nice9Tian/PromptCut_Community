/**
 * Hit testing: translates coordinates reported from image inspection by the model into a uid.
 *
 * ## Why this layer is needed
 *
 * The model reasons from images: "click login at top right" is a position in its mind, not an id.
 * Asking it to look up a uid in the clickable manifest first is forcing it to do a table lookup
 * humans never do. But actual clicks must use uid: coordinate clicks (CDP's Input.dispatchMouseEvent)
 * do not wait for clickability, do not scroll, and do not handle obstruction, whereas puppeteer's
 * Locator handles all of this for you. So this layer's responsibility is: **receive coordinates, return uid**.
 *
 * ## The real risk is not "clicking empty space", but "silently misclicking a neighbor"
 *
 * Verified in testing on MDN top navigation: bounding boxes of adjacent items have **zero gap**:
 *     e6 «HTML» b=[128,79,183,107]   e7 «CSS» b=[183,79,229,107]
 * Drifting 30 image pixels right from HTML center lands on CSS with an **exact hit**: no layer errors out,
 * the page navigates away, and the model only notices in the next round. Radius search is actually
 * safe: true blank areas correctly miss at R=0/6/20.
 *
 * Therefore, the design here has two rules:
 *   1. `expect`: the model passes along "what I intend to click"; if the hit name mismatches, **do not click**,
 *      and return candidates instead. Verified: drifting 30px onto CSS with expect:"HTML" correctly recovers e6.
 *   2. Boundary straddling, z-axis stacking, or name mismatch: always return candidates for the model
 *      to choose from, rather than gambling on its behalf.
 *
 * Candidates include uid; the model can directly call web_click({u}) in the next round. **Do not make it
 * "reply 1/2/3"**: that is a temporary numbering space valid only in that response, requiring state storage
 * and cross-round reconciliation, whereas uid is already readily available. Sequence numbers are only for
 * readability by humans and models; what is callable is always u.
 */

import { scaleOf, liveViewport } from './view.mjs';

/** Upper bound for radius search, in **image** pixels. 14 is ~22px on the page, the size of a small icon */
const DEFAULT_RADIUS = 14;

/** Max candidates to return. A dense page can yield a dozen around one point; returning all dumps the problem back */
const MAX_CANDIDATES = 5;

/* c8 ignore start - Function body is serialized and executed in the page, not run in node */
function probeAt(ix, iy, expect, radius, maxCands, scale) {
  // Image coordinates → page coordinates. view.mjs scales proportionally along the longer edge, so
  // both axes share a single scale, which is precalculated on the node side and passed in: not
  // recalculated in the page to prevent constants in two places from drifting apart
  const px = ix / scale;
  const py = iy / scale;

  const tagged = document.querySelectorAll('[data-pcuid]');
  if (!tagged.length) return { ok: false, reason: 'no_snapshot' };

  const seen = new Map();
  const climb = (el) => {
    let n = el;
    // Look up 6 levels: the manifest registers <a>/<button>, but clicks often hit inner <span>/<svg>
    for (let d = 0; n && d < 6; d++, n = n.parentElement) {
      if (n.getAttribute && n.getAttribute('data-pcuid')) return n;
    }
    return null;
  };
  const add = (el, dist, stacked) => {
    const u = el.getAttribute('data-pcuid');
    if (!u || seen.has(u)) return;
    const r = el.getBoundingClientRect();
    seen.set(u, {
      u,
      t: el.tagName.toLowerCase(),
      n: (el.getAttribute('aria-label') || el.innerText || el.value || '')
        .trim().replace(/\s+/g, ' ').slice(0, 40),
      b: [Math.round(r.left * scale), Math.round(r.top * scale),
          Math.round(r.right * scale), Math.round(r.bottom * scale)],
      d: Math.round(dist),
      ...(stacked ? { stacked: true } : {}),
    });
  };

  // 1) Entire z-axis directly below the point. elementsFromPoint also returns occluded layers, so it
  //    can identify "this button is under the cookie banner": such candidates must be flagged, as
  //    clicking directly will likely be intercepted
  const stack = document.elementsFromPoint(px, py);
  stack.forEach((el, idx) => { const h = climb(el); if (h) add(h, 0, idx > 0); });

  // 2) Neighbors within radius. Only useful when nothing is directly below, or when offering candidates
  for (let r = 2; r <= radius; r += 2) {
    for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      const h = climb(document.elementFromPoint(px + dx / scale, py + dy / scale));
      if (h) add(h, r, false);
    }
  }

  const cands = [...seen.values()].sort((a, b) => a.d - b.d);
  if (!cands.length) {
    const top = document.elementFromPoint(px, py);
    return {
      ok: false,
      reason: 'empty',
      saw: (top && top.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60),
    };
  }

  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, '');
  if (expect) {
    const e = norm(expect);
    const hit = cands.filter((c) => norm(c.n) && (norm(c.n).includes(e) || e.includes(norm(c.n))));
    // Name matches and unique → this is it, even if coordinates drifted onto a neighbor
    if (hit.length === 1) return { ok: true, mode: 'expect', pick: hit[0] };
    // Multiple matches or zero matches: should not gamble on the model's behalf
    return { ok: false, reason: hit.length ? 'ambiguous' : 'expect_mismatch',
             expect, cands: cands.slice(0, maxCands) };
  }

  // No expect provided: only click directly if unique and not covered by other layers
  if (cands.length === 1 && !cands[0].stacked) return { ok: true, mode: 'unique', pick: cands[0] };
  return { ok: false, reason: 'ambiguous', cands: cands.slice(0, maxCands) };
}
/* c8 ignore stop */

/**
 * Image coordinates → uid.
 *
 * Returns either `{ ok:true, pick }` (ready to click) or `{ ok:false, reason, cands? }`.
 * **Do not click here**: clicking belongs to session.mjs; this layer only turns coordinates into
 * a reliable uid or a clear rejection. Separated so this layer can be tested independently:
 * given coordinates and a page, the determination is deterministic.
 */
export async function resolveAt(page, ix, iy, { expect = null, radius = DEFAULT_RADIUS } = {}) {
  // Must use the same dimension source as captureView, otherwise coordinates mapped back from image
  // to page will drift globally
  const scale = scaleOf(await liveViewport(page));
  return await page.evaluate(probeAt, ix, iy, expect, radius, MAX_CANDIDATES, scale);
}

/** Format resolution result into text for the model. Candidate numbering is only for readability; callable target is u */
export function explain(res) {
  if (res.ok) return null;
  if (res.reason === 'no_snapshot') {
    return 'No screenshot has been taken of this page yet, so the coordinates have no reference. Call web_view first to get the image and the clickable manifest, then click using the coordinates in the image.';
  }
  if (res.reason === 'empty') {
    return `Nothing clickable at that position${res.saw ? ` (saw the text "${res.saw}")` : ''}. Re-locate it using the image, or use u to specify an element from the manifest directly.`;
  }
  const lines = res.cands.map((c, i) =>
    `  ${i + 1}. u="${c.u}" «${c.n || '(no text)'}» <${c.t}> b=[${c.b.join(',')}] ${c.d}px away`
    + (c.stacked ? ' ⚠ covered by a layer above, you may need to close that layer first' : ''));
  const head = res.reason === 'expect_mismatch'
    ? `No element named "${res.expect}" near that position. You may have misjudged the position, or the page has changed. Nearby:`
    : 'Multiple clickable elements near that position, cannot tell which one you want. Specify one with web_click({u:"..."}):';
  return `${head}\n${lines.join('\n')}`;
}

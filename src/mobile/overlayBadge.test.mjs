/**
 * Overlay card badge on mobile app clips (`overlayBadge.ts`, semantics "Mobile app interface"
 * in `workflow/editing.md`).
 *
 * What must be guarded is that last tier: when even the name is squeezed out, the badge does not
 * consume clicks: it is almost the entire clip, and the user mostly wants to select this clip,
 * but a slip of the finger enters the overlay card. The entry point for that tier is "Overlay layer"
 * in the sub-navigation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { OVM_TAP_PX, OVM_WIDE_PX, planOverlayBadge } from "./overlayBadge.ts";

test("no badge is drawn when nothing is attached", () => {
  assert.equal(planOverlayBadge(200, 0), null);
  assert.equal(planOverlayBadge(20, 0), null);
});

test("wide enough to write \"Overlay N\"", () => {
  assert.deepEqual(planOverlayBadge(OVM_WIDE_PX, 2), { text: "Overlay 2", tappable: true });
});

test("narrower writes only the number, still tappable", () => {
  assert.deepEqual(planOverlayBadge(OVM_WIDE_PX - 1, 3), { text: "3", tappable: true });
  assert.deepEqual(planOverlayBadge(OVM_TAP_PX, 3), { text: "3", tappable: true });
});

test("the narrowest tier does not take taps, the whole hot area belongs to the clip", () => {
  assert.deepEqual(planOverlayBadge(OVM_TAP_PX - 1, 1), { text: "1", tappable: false });
  // Narrowest clip on timeline is 18px (FullTimeline's Math.max(..., 18)); that tier definitely
  // falls here
  assert.equal(planOverlayBadge(18, 1).tappable, false);
});

test("two digits also fit", () => {
  assert.equal(planOverlayBadge(300, 12).text, "Overlay 12");
  assert.equal(planOverlayBadge(80, 12).text, "12");
});

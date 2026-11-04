/**
 * Unit tests for total duration rules. Run: node --test src/kernel/duration.test.mjs
 *
 * Pins down the "Total duration" rule in product/project-model.md: defaults to content end,
 * tracks content; can be manually shortened, cannot be extended past the content end;
 * empty projects retain their original value.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { contentEndOf, effectiveDuration, manualDurationFor } from "./duration.ts";

const clip = (id, start, end) => ({ id, cardId: "x", start, end, params: {} });

test("The content end is the maximum across tracks; with no clips it is 0", () => {
  assert.equal(contentEndOf([]), 0);
  assert.equal(contentEndOf([{ id: "t", name: "t", clips: [] }]), 0);
  assert.equal(contentEndOf([
    { id: "a", name: "a", clips: [clip("c1", 0, 5)] },
    { id: "b", name: "b", clips: [clip("c2", 3, 18.5), clip("c3", 1, 2)] },
  ]), 18.5);
});

test("Without truncation the total duration is the content end: adding content extends it, deleting content shortens it", () => {
  assert.equal(effectiveDuration(12, 30, null), 12, "After deleting down to 12 seconds, the duration shrinks back to 12, leaving no black tail");
  assert.equal(effectiveDuration(42.5, 30, null), 42.5, "Content extends to 42.5, the duration grows with it and nothing is cut off");
});

test("After truncation the total duration stays at the manual value, but not beyond the content end", () => {
  assert.equal(effectiveDuration(40, 40, 25), 25);
  assert.equal(effectiveDuration(20, 25, 25), 20, "If content is deleted to be shorter than the truncation point, the duration follows the content");
});

test("An empty project keeps its original value and does not collapse to 0", () => {
  assert.equal(effectiveDuration(0, 30, null), 30);
  assert.equal(effectiveDuration(0, 30, 10), 30);
});

test("Only a value shorter than the content end is recorded as truncation; equal or longer goes back to following the content", () => {
  assert.equal(manualDurationFor(25, 40), 25);
  assert.equal(manualDurationFor(40, 40), null, "Equal to the content end does not count as truncation");
  assert.equal(manualDurationFor(90, 40), null, "Cannot be stretched, and leaves no limit that would block new content later");
  assert.equal(manualDurationFor(60, 0), null, "Setting a duration on an empty project does not count as truncation; content added later follows as usual");
});

test("After setting a stretched value, adding more content still makes the duration follow", () => {
  const manual = manualDurationFor(90, 40);
  assert.equal(effectiveDuration(40, 40, manual), 40);
  assert.equal(effectiveDuration(120, 40, manual), 120, "Not blocked by 90");
});

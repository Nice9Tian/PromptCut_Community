import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_FALLBACK_HUE, AGENT_HUE, agentColorFor, hueGap, oklchOf } from "./agentColor.ts";

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test("oklchOf: known values for white, black, pure red", () => {
  const w = oklchOf("#ffffff");
  close(w.l, 1, 0.001, "white lightness");
  close(w.c, 0, 0.001, "white chroma");
  close(oklchOf("#000000").l, 0, 0.001, "black lightness");
  const red = oklchOf("#ff0000");
  close(red.l, 0.628, 0.002, "red lightness");
  close(red.c, 0.2577, 0.002, "red chroma");
  close(red.h, 29.23, 0.2, "red hue");
  assert.equal(oklchOf("not-a-color"), null);
});

for (const [name, accent] of [["studio dark accent", "#00DBDB"], ["studio light accent", "#0E7A85"], ["aurora accent", "#14b8a6"]]) {
  test(`${name} ${accent} → yellow with the same lightness and chroma`, () => {
    const a = oklchOf(accent);
    const y = oklchOf(agentColorFor(accent));
    close(y.l, a.l, 0.006, "lightness");
    close(y.c, Math.max(0.09, a.c), 0.006, "chroma");
    assert.ok(hueGap(y.h, AGENT_HUE) < 2, `hue should be near yellow ${AGENT_HUE}°, got ${y.h}`);
  });
}

test("the amber accent is itself yellow-orange: the Agent switches to purple so it does not clash with the accent", () => {
  const accent = "#f59e0b";
  const y = oklchOf(agentColorFor(accent));
  assert.ok(hueGap(y.h, AGENT_FALLBACK_HUE) < 3, `should be purple, actual hue ${y.h}`);
  close(y.l, oklchOf(accent).l, 0.006, "lightness still matches the accent");
});

test("after changing hue it left the sRGB gamut: lightness and hue stay, only chroma is reduced", () => {
  // Neon magenta #ec4899: lightness ~0.66, chroma ~0.2; yellow cannot be this saturated at this
  // lightness
  const accent = "#ec4899";
  const out = agentColorFor(accent);
  assert.match(out, /^#[0-9a-f]{6}$/);
  const a = oklchOf(accent);
  const y = oklchOf(out);
  close(y.l, a.l, 0.01, "lightness");
  assert.ok(y.c <= a.c + 0.001, "chroma can only go down, never up");
  assert.ok(hueGap(y.h, AGENT_HUE) < 4, `hue is still yellow, got ${y.h}`);
});

test("a gray accent still yields a visibly yellow color; unparseable input gives a fixed yellow", () => {
  const y = oklchOf(agentColorFor("#888888"));
  assert.ok(y.c >= 0.08, `chroma at least 0.08, got ${y.c}`);
  assert.ok(hueGap(y.h, AGENT_HUE) < 3);
  assert.equal(agentColorFor("oops"), "#d6b13c");
});

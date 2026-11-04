// Card parameter validation + card creation source validation. Both modules are pure logic and run
// directly here after transpilation, without requiring React, a browser, or a dev server. How to
// run: node --test server/test/cards.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

/** assert.throws does not return the error to you, but here we need to assert the error message itself */
const caught = (fn) => { try { fn(); } catch (e) { return e; } throw new Error('Should have thrown but did not'); };

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cards-test-'));
fs.mkdirSync(OUT, { recursive: true });

function compile(srcRel, outName, rewrites = []) {
  let src = fs.readFileSync(path.join(ROOT, srcRel), 'utf8');
  for (const [from, to] of rewrites) src = src.split(from).join(to);
  // Relative .mjs that actually exist in source files (`./frameMode.mjs`, `../xxx.mjs`) point back to
  // original locations; those just created by rewrites above like `./registry.mjs` only exist in the
  // temporary directory and cannot be found in place, so keep them as is
  src = src.replace(/from (["'])(\.\.?\/[^"']+\.mjs)\1/g, (m, _q, f) => {
    const abs = path.resolve(ROOT, path.dirname(srcRel), f);
    return fs.existsSync(abs) ? `from '${pathToFileURL(abs).href}'` : m;
  });
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const file = path.join(OUT, outName);
  fs.writeFileSync(file, js);
  return 'file:///' + file.replace(/\\/g, '/');
}

const registryUrl = compile('src/kernel/registry.ts', 'registry.mjs');
const cardParamsUrl = compile('src/kernel/cardParams.ts', 'cardParams.mjs', [['./registry.ts', './registry.mjs']]);
// Transpilation artifacts land in temporary directory and cannot resolve node_modules, so replace
// typescript with an absolute URL
const tsUrl = pathToFileURL(require_.resolve('typescript')).href;
// Same for .mjs in same plugin directory (http-guard, card-overrides, prerender-client...): point
// back to original files under server/ after transpiling to temporary directory
const localMjs = [...new Set([...fs.readFileSync(path.join(ROOT, 'server/vite-plugin-cards.ts'), 'utf8').matchAll(/from '\.\/([\w-]+\.mjs)'/g)].map((m) => m[1]))]
  .map((f) => [`from './${f}'`, `from '${pathToFileURL(path.join(ROOT, 'server', f)).href}'`]);
const pluginUrl = compile('server/vite-plugin-cards.ts', 'cards-plugin.mjs', [["from 'typescript'", `from '${tsUrl}'`], ...localMjs]);

const { registerCards } = await import(registryUrl);
const { validateCardParams, findCard } = await import(cardParamsUrl);
const { checkCardSource, checkSourceEdit, applyCardPatch, translateCardSource, reviewCardSource, suggestControls, installBundledCards } = await import(pluginUrl);

// A minimal mock card, matching the shape of a real card
registerCards([{
  id: 'demo-card', name: 'Demo', description: 'd', source: 'native',
  defaults: { lines: '', mode: 'a', size: 10, accent: '#fff' },
  controls: [
    { key: 'lines', label: 'Content', type: 'text', required: true, hint: 'One per line.' },
    { key: 'mode', label: 'Mode', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    { key: 'size', label: 'Font size', type: 'number' },
    { key: 'accent', label: 'Primary color', type: 'color' },
  ],
  Component: () => null,
}]);

// ── validateCardParams ────────────────────────────────────────────
test('Required field empty → reject, and include the hint', () => {
  const e = caught(() => validateCardParams('demo-card', { size: 20 }));
  assert.match(e.message, /lines/);
  assert.match(e.message, /required/);
  assert.match(e.message, /One per line/);      // hint must be passed through
});

test('Required field with only whitespace → still counts as not filled', () => {
  assert.throws(() => validateCardParams('demo-card', { lines: '   ' }), /required/);
});

test('Required field filled → pass, and return the merged result', () => {
  const merged = validateCardParams('demo-card', { lines: '0|1|Hello|' });
  assert.equal(merged.lines, '0|1|Hello|');
  assert.equal(merged.mode, 'a');          // Use defaults when not passed
  assert.equal(merged.size, 10);
});

test('Wrong key name → reject, and list the real parameter names', () => {
  const e = caught(() => validateCardParams('demo-card', { lines: 'x', linez: 'y' }));
  assert.match(e.message, /linez/);
  assert.match(e.message, /is not a parameter of demo-card/);
  assert.match(e.message, /mode/);          // Tell it which parameters are valid
});

test('select value not among the options → reject and list the allowed values', () => {
  const e = caught(() => validateCardParams('demo-card', { lines: 'x', mode: 'c' }));
  assert.match(e.message, /a \/ b/);
});

test('number received a string → reject', () => {
  assert.throws(() => validateCardParams('demo-card', { lines: 'x', size: '20' }), /needs a number/);
});

test('Changing a secondary parameter of an existing clip must not be rejected just because this call omitted the required field', () => {
  const merged = validateCardParams('demo-card', { size: 30 }, { lines: '0|1|Already filled in|' });
  assert.equal(merged.size, 30);
  assert.equal(merged.lines, '0|1|Already filled in|');
});

test('Card does not exist → error and list the available ids', () => {
  const e = caught(() => findCard('no-such-card'));
  assert.match(e.message, /demo-card/);
});

// ── checkCardSource ───────────────────────────────────────────────
const GOOD = `
import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  return <motion.div animate={{ opacity: 1 }}>{params.text}</motion.div>;
}
export const priceTag: CardDef<Params> = {
  id: "price-tag", name: "Price", description: "d", source: "user",
  frameMode: "stateful",
  defaults: { text: "¥1" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
`;

test('Valid source → pass', () => {
  const r = checkCardSource('price-tag', GOOD, ['odometer'], { mode: 'author' });
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('id is not kebab-case → reject', () => {
  assert.match(checkCardSource('PriceTag', GOOD, [], { mode: 'author' }).errors.join('\n'), /kebab-case/);
});

test('id does not match the id in the source → reject', () => {
  const r = checkCardSource('other-id', GOOD, [], { mode: 'author' });
  assert.match(r.errors.join('\n'), /price-tag.*does not match|does not match/s);
});

test('id collision → reject', () => {
  assert.match(checkCardSource('price-tag', GOOD, ['price-tag'], { mode: 'author' }).errors.join('\n'), /already exists/);
});

test('mu- prefix → reject', () => {
  const src = GOOD.replace('id: "price-tag"', 'id: "mu-thing"');
  assert.match(checkCardSource('mu-thing', src, [], { mode: 'author' }).errors.join('\n'), /mu- prefix/);
});

test('No CardDef named export → reject', () => {
  const src = GOOD.replace('export const priceTag: CardDef<Params>', 'const priceTag: any');
  assert.match(checkCardSource('price-tag', src, [], { mode: 'author' }).errors.join('\n'), /named export/);
});

test('Uses Date.now → reject', () => {
  const src = GOOD.replace('params.text', 'params.text + Date.now()');
  assert.match(checkCardSource('price-tag', src, [], { mode: 'author' }).errors.join('\n'), /Date\.now/);
});

test('Uses setInterval → reject', () => {
  const src = GOOD.replace('return <motion', 'setInterval(() => {}, 16);\n  return <motion');
  assert.match(checkCardSource('price-tag', src, [], { mode: 'author' }).errors.join('\n'), /setTimeout \/ setInterval/);
});

test('Uses IntersectionObserver → reject', () => {
  const src = GOOD.replace('return <motion', 'new IntersectionObserver(() => {});\n  return <motion');
  assert.match(checkCardSource('price-tag', src, [], { mode: 'author' }).errors.join('\n'), /IntersectionObserver/);
});

test('Syntax error → reject and give the line number', () => {
  const src = GOOD.replace('defaults: { text: "¥1" },', 'defaults: { text: "¥1" ,');
  const r = checkCardSource('price-tag', src, [], { mode: 'author' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /Syntax error/);
});

test('Missing controls field → reject', () => {
  const src = GOOD.replace('  controls: [{ key: "text", label: "Text", type: "text" }],\n', '');
  assert.match(checkCardSource('price-tag', src, [], { mode: 'author' }).errors.join('\n'), /missing the controls field/);
});

// ── A0: review table is the sole authority for independent + frameMode required ──────────────
// Getting these two wrong throws no error; it just gives a frosted-glass card the
// "standalone card" treatment: dead assets are stored separately and shared to the cloud,
// smearing someone else's video when switching the lower layer. So pin down one for each of the
// three paths (built-in card edit, user card edit, create).
const INDEPENDENT = '  compositing: "independent",\n';

test("A0: user card edit_card adds compositing: independent → reject", () => {
  const after = GOOD.replace('  defaults:', INDEPENDENT + '  defaults:');
  const r = checkCardSource('price-tag', after, [], { mode: 'author', before: GOOD });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /review sheet/);
});

test("A0: user card edit_card changes copy only → pass", () => {
  const after = GOOD.replace('name: "Price"', 'name: "Cost"');
  const r = checkCardSource('price-tag', after, [], { mode: 'author', before: GOOD });
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test("A0: user card already had independent and this edit adds none → not pursued (delta-based rule)", () => {
  const withIt = GOOD.replace('  defaults:', INDEPENDENT + '  defaults:');
  const after = withIt.replace('name: "Price"', 'name: "Cost"');
  const r = checkCardSource('price-tag', after, [], { mode: 'author', before: withIt });
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test("A0: create_card source contains compositing: independent → reject (before is an empty string, so any occurrence is rejected)", () => {
  const src = GOOD.replace('  defaults:', INDEPENDENT + '  defaults:');
  const r = checkCardSource('price-tag', src, [], { mode: 'author', before: '' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /capabilities\.json/);
});

test("A0: built-in card edit_card (checkSourceEdit) adds independent → reject", () => {
  const after = GOOD.replace('  defaults:', INDEPENDENT + '  defaults:');
  const r = checkSourceEdit('src/cards/native/price-tag.tsx', GOOD, after);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /capabilities\.json/);
});

test("A0: author mode missing frameMode → reject; install mode accepts it as is", () => {
  const src = GOOD.replace('  frameMode: "stateful",\n', '');
  assert.match(checkCardSource('price-tag', src, [], { mode: 'author' }).errors.join('\n'), /missing the frameMode field/);
  const installed = checkCardSource('price-tag', src, [], { mode: 'install' });
  assert.equal(installed.ok, true, installed.errors.join('\n'));
});

test("A0: built-in CardDef file loses frameMode after the edit → reject", () => {
  const after = GOOD.replace('  frameMode: "stateful",\n', '');
  const r = checkSourceEdit('src/cards/native/price-tag.tsx', GOOD, after);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /The frameMode field is missing in CardDef/);
});

test("A0: a CardDef<any>[] aggregate file can be edited even without frameMode", () => {
  const before = 'import type { CardDef } from "../../kernel/types";\nimport { a } from "./a";\nexport const nativeCards: CardDef<any>[] = [a];\n';
  const after = before.replace('[a]', '[a, a]');
  const r = checkSourceEdit('src/cards/native/index.ts', before, after);
  assert.equal(r.ok, true, r.errors.join('\n'));
});

// ── Translator: mechanical translation + review gate + controls suggestions ──────────────────
// The review tiers come from byte-for-byte comparisons of 11 cards on the export pipeline;
// what is pinned down here is "which class of code gets blocked at which tier", so that anyone
// relaxing the rules later does not inadvertently let in mechanisms that cannot be supported.

test('translate: strip use client, point @/lib/utils to the local copy, and report what changed', () => {
  const r = translateCardSource('"use client"\nimport { cn } from "@/lib/utils"\nexport const x = 1');
  assert.equal(/use client/.test(r.source), false);
  assert.match(r.source, /from "\.\.\/magicui\/vendor\/cn"/);
  assert.equal(r.rewrites.length, 2);
});

test('review tier 2: blocks the card\'s own frame loop, and no longer blocks WebGL / three itself', () => {
  const tiers = (src) => reviewCardSource(src).map((f) => f.tier);
  // The export page pinned Math.random to be seeded and disabled scripts during screenshots:
  // particle cards tested byte-for-byte identical, so these two rules no longer reject them
  assert.deepEqual(tiers('const c = ref.current.getContext("2d")'), []);
  assert.deepEqual(tiers('const x = Math.random()'), []);
  // WebGL itself is allowed: after adding --enable-unsafe-swiftshader to export, three cards
  // tested byte-for-byte identical across two passes of 20/20 frames
  assert.deepEqual(tiers('const gl = c.getContext("webgl")'), []);
  assert.deepEqual(tiers('import * as THREE from "three"'), []);
  assert.deepEqual(tiers('import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"'), []);
  // What truly cannot be supported is the combination of "3D scene + running its own frame loop"
  assert.deepEqual(tiers('renderer.setAnimationLoop((t) => draw(t))'), [2]);
  // Bare rAF driving a three scene: previously slipped through here
  assert.deepEqual(tiers('import * as THREE from "three"\nrequestAnimationFrame(function l(){ mesh.rotation.y += 0.01; requestAnimationFrame(l) })'), [2]);
  assert.deepEqual(tiers('const gl = c.getContext("webgl")\nrequestAnimationFrame(loop)'), [2]);
  // Bypassing setAnimationLoop via variable names is also caught (it also uses three)
  assert.deepEqual(tiers('import * as THREE from "three"\nconst fn = "setAnimationLoop"; renderer[fn](cb)'), [2]);
  // Mentions in comments do not count as usage: this rule's error message tells people to
  // "follow how scene-3d.tsx is written", and the comments in that card happen to explain why
  // setAnimationLoop cannot be used: matching comments too would create a contradiction
  assert.deepEqual(tiers('// Do not use setAnimationLoop, it accumulates by delta\nimport * as THREE from "three"\nrenderer.render(s, c)'), []);
  assert.deepEqual(tiers('/* three\'s setAnimationLoop cannot be supported on this pipeline */\nconst x = 1'), []);
  // A // inside a string should not be treated as a comment; subsequent code must still be visible
  assert.deepEqual(tiers('const url = "http://x"; renderer.setAnimationLoop(cb)'), [2]);
  // But we **cannot** block every rAF on sight: using rAF in 2D cards has been verified on this
  // pipeline, and a blanket ban would cause massive collateral damage
  assert.deepEqual(tiers('requestAnimationFrame(() => setX(1))'), []);
  // 3D frameworks with their own frame loops: belong to tier 2 and are not installed
  assert.deepEqual(tiers('import { Canvas } from "@react-three/fiber"').sort(), [2, 'deps']);
  // Installed particle / Lottie libraries are permitted dependencies
  assert.deepEqual(tiers('import { tsParticles } from "@tsparticles/engine"\nimport lottie from "lottie-web"'), []);
});

test('review tier 3: mouse / hover / scroll', () => {
  const tiers = (src) => reviewCardSource(src).map((f) => f.tier);
  assert.deepEqual(tiers('window.addEventListener("mousemove", h)'), [3]);
  assert.deepEqual(tiers('<motion.div whileHover={{ scale: 1.1 }} />'), [3]);
  assert.deepEqual(tiers('const { scrollY } = useScroll()'), [3]);
});

test('review dependencies: libraries that are not installed are rejected, allowed ones pass', () => {
  assert.equal(reviewCardSource('import { Sparkles } from "lucide-react"')[0].tier, 'deps');
  assert.deepEqual(
    reviewCardSource('import { motion } from "motion/react"\nimport { cn } from "../magicui/vendor/cn"\nimport type { CardDef } from "../../kernel/types"'),
    [],
  );
});

test('review animation classes: the 22 MagicUI groups are vendored and pass, undefined ones are rejected', () => {
  assert.deepEqual(reviewCardSource('<span className="animate-shiny-text animate-spin" />'), []);
  const f = reviewCardSource('<span className="animate-wobble" />');
  assert.equal(f.length, 1);
  assert.equal(f[0].tier, 'keyframes');
  assert.match(f[0].detail, /magicui-animations\.css/);
});

test('review source/license: copied-in code with no declaration → reject; Commons Clause → reject; MIT → pass', () => {
  const body = 'export const A = () => null';
  // Pasting MagicUI code directly: contains traces of @/lib/utils but does not state the source
  const undeclared = reviewCardSource('import { cn } from "@/lib/utils"\n' + body).filter((f) => f.tier === 'license');
  assert.equal(undeclared.length, 1);
  assert.match(undeclared[0].rule, /not declared/);
  // The translator has already removed the trace of @/lib/utils, but hints.vendored still requires
  // a declaration
  assert.equal(reviewCardSource(body, { vendored: true }).filter((f) => f.tier === 'license').length, 1);
  const bad = reviewCardSource('/**\n * Source: https://reactbits.dev/x\n * MIT + Commons Clause\n */\n' + body);
  assert.match(bad.find((f) => f.tier === 'license').rule, /does not allow distribution/);
  const ok = reviewCardSource('/**\n * Source: https://magicui.design/docs/components/x\n * MIT License\n */\n' + body);
  assert.deepEqual(ok, []);
});

test('checkCardSource merges review findings into errors, with tier labels', () => {
  const src = GOOD.replace('return <motion', 'renderer.setAnimationLoop((ms) => draw(ms));\n  return <motion');
  const r = checkCardSource('price-tag', src, [], { mode: 'author' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /\[Tier 2·pipeline not supported yet\] Own frame loop/);
  assert.equal(r.findings.length, 1);
});

test('mu- prefix: allowed when the file header declares magicui as the source', () => {
  const src = '/**\n * Source: https://magicui.design/docs/components/thing\n * MIT License\n */\n' + GOOD.replace('id: "price-tag"', 'id: "mu-thing"');
  const r = checkCardSource('mu-thing', src, [], { mode: 'author' });
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('suggestControls: infer controls from the *Props interface, skipping className/children', () => {
  const s = suggestControls(`
    interface ShinyProps extends React.HTMLAttributes<HTMLSpanElement> {
      text: string; shimmerWidth?: number; loop?: boolean; mode: "fast" | "slow"; words: string[]; className?: string; children?: React.ReactNode;
    }`);
  assert.deepEqual(s.map((x) => [x.key, x.type]), [['text', 'text'], ['shimmerWidth', 'number'], ['loop', 'select'], ['mode', 'select'], ['words', 'text']]);
  assert.match(s.find((x) => x.key === 'mode').hint, /fast \/ slow/);
  assert.match(s.find((x) => x.key === 'words').hint, /\|/);
});

// ── applyCardPatch: partial card edits ───────────────────────────────────────────────
// None of the following cases throw errors when failing; they just quietly alter the file into
// something else: and "other parts mysteriously changing when editing a card" is precisely the
// flaw this feature is meant to eliminate, so pin down each one.

test('When there is exactly one match, replace only that one', () => {
  const r = applyCardPatch('a\nsize: 120\nb', 'size: 120', 'size: 64');
  assert.equal(r.ok, true);
  assert.equal(r.after, 'a\nsize: 64\nb');
  assert.equal(r.replaced, 1);
});

test('$& in replace must not be expanded as a replacement token', () => {
  // String.replace(str, str) replaces $& with the matched content; split/join does not.
  // The replacement here is verbatim source code written by the model and must be written to disk as is.
  const r = applyCardPatch('x AAA y', 'AAA', 'cost = "$&"');
  assert.equal(r.after, 'x cost = "$&" y');
});

test('$1 and $` in replace are likewise written to disk as is', () => {
  assert.equal(applyCardPatch('[T]', 'T', '.replace(/x/, "$1")').after, '[.replace(/x/, "$1")]');
  assert.equal(applyCardPatch('[T]', 'T', 'a$`b').after, '[a$`b]');
});

test('Regex metacharacters in find are treated literally, not as a pattern', () => {
  const r = applyCardPatch('const a = arr.map(x => x)', 'arr.map(x => x)', 'arr');
  assert.equal(r.after, 'const a = arr');
});

test('No match at all → error pointing to get_card_source', () => {
  const r = applyCardPatch('abc', 'xyz', 'q');
  assert.equal(r.ok, false);
  assert.match(r.error, /get_card_source/);
});

test('Multiple matches without replaceAll → error stating how many occurrences matched', () => {
  const r = applyCardPatch('p p p', 'p', 'q');
  assert.equal(r.ok, false);
  assert.match(r.error, /matched 3 places/);
});

test('With replaceAll, replace all and report truthfully how many occurrences were replaced', () => {
  const r = applyCardPatch('p p p', 'p', 'q', true);
  assert.equal(r.after, 'q q q');
  assert.equal(r.replaced, 3);
});

test('replace identical to find → error, do not leave a "success" that did nothing', () => {
  assert.equal(applyCardPatch('abc', 'b', 'b').ok, false);
});

test('Empty find → error (otherwise it would match every position)', () => {
  assert.equal(applyCardPatch('abc', '', 'x').ok, false);
});

// ── installBundledCards: install bundled custom cards back to this machine on .proc open ───
function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-install-test-'));
  return { root, history: path.join(root, '.pc-work', 'card-history'), user: path.join(root, 'src', 'cards', 'user') };
}
const V2 = GOOD.replace('"¥1"', '"¥2"');

test('install: not present on this machine → write into src/cards/user/', () => {
  const { root, history, user } = tmpRoot();
  const [r] = installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: GOOD }], existingIds: ['odometer'] });
  assert.equal(r.status, 'written', r.error);
  assert.equal(fs.readFileSync(path.join(user, 'price-tag.tsx'), 'utf8'), translateCardSource(GOOD).source);
});

test('install: same on this machine → leave alone; different → the project wins, the old version is backed up by content and only once', () => {
  const { root, history, user } = tmpRoot();
  installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: GOOD }], existingIds: [] });
  assert.equal(installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: GOOD }], existingIds: [] })[0].status, 'unchanged');

  const [r] = installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: V2 }], existingIds: [] });
  assert.equal(r.status, 'updated');
  assert.match(fs.readFileSync(path.join(user, 'price-tag.tsx'), 'utf8'), /¥2/);
  assert.match(fs.readFileSync(path.join(root, r.backup), 'utf8'), /¥1/, 'The backup holds the replaced old local version');

  // Opening two projects back and forth: the same old version is backed up once and does not accumulate
  installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: GOOD }], existingIds: [] });
  installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: V2 }], existingIds: [] });
  assert.equal(fs.readdirSync(history).length, 2);
});

test('install: anything that fails review is not installed, what this machine already has is left as is', () => {
  const { root, history, user } = tmpRoot();
  installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: GOOD }], existingIds: [] });
  const bad = GOOD.replace('return <motion.div', 'setTimeout(() => {}, 1);\n  return <motion.div');
  const [r] = installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: bad }], existingIds: [] });
  assert.equal(r.status, 'rejected');
  assert.match(r.error, /setTimeout/);
  assert.doesNotMatch(fs.readFileSync(path.join(user, 'price-tag.tsx'), 'utf8'), /setTimeout/);
});

test('install: id blocks path traversal and must not replace a built-in card', () => {
  const { root, history } = tmpRoot();
  const rs = installBundledCards({
    root, historyDir: history, existingIds: ['price-tag'],
    cards: [{ id: '../../evil', source: GOOD }, { id: 'price-tag', source: GOOD }, { id: 'x', source: 1 }],
  });
  assert.deepEqual(rs.map((r) => r.status), ['rejected', 'rejected', 'rejected']);
  assert.equal(fs.existsSync(path.join(root, 'src', 'evil.tsx')), false);
  assert.match(rs[1].error, /already exists/);
});

test('install: when an overlay layer exists, both comparison and writes go through the overlay layer, the base version is untouched', () => {
  const { root, history, user } = tmpRoot();
  const layer = path.join(root, 'layer');
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(path.join(user, 'price-tag.tsx'), translateCardSource(GOOD).source);
  process.env.PROMPTCUT_CARD_OVERRIDES = layer;
  try {
    const [r] = installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: V2 }], existingIds: [] });
    assert.equal(r.status, 'updated');
    assert.match(fs.readFileSync(path.join(layer, 'src', 'cards', 'user', 'price-tag.tsx'), 'utf8'), /¥2/);
    assert.match(fs.readFileSync(path.join(user, 'price-tag.tsx'), 'utf8'), /¥1/, 'The base version is read-only, the patch replaces only the overlay layer');
    assert.equal(installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: V2 }], existingIds: [] })[0].status, 'unchanged', 'The comparison is against the effective copy');
  } finally {
    delete process.env.PROMPTCUT_CARD_OVERRIDES;
  }
});

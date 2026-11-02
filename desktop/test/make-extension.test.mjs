// 拓展包的纯逻辑：拓展表、许可证硬闸、manifest 生成。
// 这里挡住的是三件会一路烂到用户机器上的事：
//   1. full 档漏了 light 档的某个依赖或模型（两处各写一份就一定会漂移）；
//   2. manifest 里混进构建机的本地路径（from），用户机上根本不存在这个盘符；
//   3. 加了个新权重却忘了写许可证 —— 那就是在无证分发。
// 跑法：node --test desktop/test/make-extension.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  makeExtensions, buildManifest, buildLicenseText, assertModelMeta, outDirFor, MODEL_META,
  KNOWN_LICENSES, licenseFullText,
} from '../scripts/make-extension.mjs';

/** 各模型的假路径：纯逻辑测试不碰真文件 */
const SRC = {
  transnet: 'X:/fake/transnetv2.onnx',
  yunet: 'X:/fake/yunet.onnx',
  rtdetr: 'X:/fake/rtdetr_r18vd.onnx',
  bootstapir: 'X:/fake/bootstapir_v2.pt',
  dino: 'X:/fake/grounding-dino-tiny',
};
const files = (ext) => ext.models.map((m) => m.file);

// ── 两档的内容 ────────────────────────────────────────────────────────
test('light tier provides shot detection + subject detection, without tracking', () => {
  const { light } = makeExtensions(SRC);
  assert.equal(light.tier, 'light');
  assert.deepEqual(light.provides, ['shots', 'subject']);
  assert.deepEqual(files(light).sort(), ['rtdetr_r18vd.onnx', 'transnetv2.onnx', 'yunet.onnx']);
  // 轻装档的卖点就是不带 torch，掺进来包会大 200 MB
  assert.ok(!light.requirements.some((r) => r.includes('track')), 'light should not carry the tracking dependency manifest');
});

test('full tier is a superset of light: no dependency manifest entry or model may be missing', () => {
  const { light, full } = makeExtensions(SRC);
  for (const r of light.requirements) {
    assert.ok(full.requirements.includes(r), `full is missing the light dependency manifest ${r}`);
  }
  for (const f of files(light)) {
    assert.ok(files(full).includes(f), `full is missing the light model ${f}`);
  }
  assert.deepEqual(full.provides, ['shots', 'subject', 'track']);
  assert.ok(files(full).includes('bootstapir_v2.pt'));
  assert.ok(files(full).includes('grounding-dino-tiny'));
  assert.equal(full.requirements.length, light.requirements.length + 2);
});

test('old names shots / track / stt are still there, re-packaging a single item must not break', () => {
  const table = makeExtensions({ model: 'X:/fake/whatever.bin' });
  for (const n of ['shots', 'track', 'stt']) assert.ok(table[n], `${n} is missing`);
  // 单项包认 --model，两档认各自的开关
  assert.equal(table.shots.models[0].from, 'X:/fake/whatever.bin');
  assert.equal(table.stt.models.length, 0, 'Speech models are downloaded on demand, not shipped in the package');
});

test('Each tier goes into its own subdirectory, single-item packages are flat', () => {
  const t = makeExtensions(SRC);
  assert.equal(outDirFor(t.light, '/rel'), join('/rel', '_light'));
  assert.equal(outDirFor(t.full, '/rel'), join('/rel', '_full'));
  assert.equal(outDirFor(t.shots, '/rel'), '/rel');
});

// ── manifest ─────────────────────────────────────────────────────────
test('The manifest carries no local path of the build machine, directory-type models keep the dir flag', () => {
  const { full } = makeExtensions(SRC);
  const man = buildManifest({ name: 'full', ext: full, wheels: ['a-1.0-py3-none-any.whl'] });
  for (const m of man.models) {
    assert.ok(!('from' in m), `${m.file} wrote the local path from into the manifest`);
    assert.ok(m.title && m.license && m.source);
  }
  const dino = man.models.find((m) => m.file === 'grounding-dino-tiny');
  assert.equal(dino.dir, true, 'Directory-type models must be marked dir, the installer uses it to decide on recursive copy');
  assert.equal(man.tier, 'full');
  assert.deepEqual(man.provides, ['shots', 'subject', 'track']);
  assert.equal(man.format, 'promptcut-extension/1');
  assert.deepEqual(man.wheels, ['a-1.0-py3-none-any.whl']);
});

test('The manifest of a single-item package has no tier field', () => {
  const { shots } = makeExtensions({ model: 'X:/fake/t.onnx' });
  const man = buildManifest({ name: 'shots', ext: shots, wheels: [] });
  assert.ok(!('tier' in man));
  assert.deepEqual(man.provides, ['shots']);
});

// ── 许可证硬闸 ────────────────────────────────────────────────────────
test('A package cannot be built when license / source / title is missing', () => {
  for (const field of ['title', 'license', 'source']) {
    const bad = { ...MODEL_META.yunet };
    delete bad[field];
    assert.throws(() => assertModelMeta(bad), new RegExp(field), `Missing ${field} was let through`);
  }
  assert.doesNotThrow(() => assertModelMeta(MODEL_META.yunet));
});

test('buildManifest throws immediately when a model without a license is mixed into the extension table', () => {
  const { light } = makeExtensions(SRC);
  const broken = { ...light, models: [...light.models, { file: 'mystery.onnx', from: 'X:/x' }] };
  assert.throws(() => buildManifest({ name: 'light', ext: broken, wheels: [] }), /mystery\.onnx/);
});

test('Every bundled weight has all four license fields filled in', () => {
  for (const [key, meta] of Object.entries(MODEL_META)) {
    assert.doesNotThrow(() => assertModelMeta(meta), `${key} is missing license fields`);
  }
});

test('The license text in the package writes directory-type models as xxx/, and every model appears', () => {
  const { full } = makeExtensions(SRC);
  const text = buildLicenseText(full);
  for (const m of full.models) assert.ok(text.includes(m.title), `The license text is missing ${m.title}`);
  assert.ok(text.includes('grounding-dino-tiny/'));
  assert.ok(!text.includes('X:/fake'), 'The license text leaks the build machine path');
});

// ── 许可证标识符必须是 SPDX 认得的，且有全文可附 ──────────────────────
// 2026-09-07 之前 YuNet 被标成 Apache-2.0（实际是 MIT），错误一路写进了两个 exe、
// 两份 manifest 和两份包内许可证文件。名字写错没人拦，因为当时的硬闸只看「有没有填」。
test('yunet is MIT, not Apache-2.0, and source points to the model directory', () => {
  // opencv_zoo 根仓库是 Apache-2.0，但 models/face_detection_yunet/ 目录自带 MIT LICENSE
  // （Copyright (c) 2020 Shiqi Yu），以目录内的为准 —— 2026-09-07 curl 核对过。
  assert.equal(MODEL_META.yunet.license, 'MIT');
  assert.match(MODEL_META.yunet.source, /face_detection_yunet/,
    'source must be exact to the model directory, pointing to the root repo would be read as Apache-2.0');
  assert.match(MODEL_META.yunet.copyright, /Shiqi Yu/);
  // 权重的训练上游 ShiqiYu/libfacedetection.train 是 BSD-3-Clause，全文也要附
  assert.deepEqual(MODEL_META.yunet.alsoLicenses.map((a) => a.id), ['BSD-3-Clause']);
});

test('Every model\'s license is an identifier recognized by SPDX (the full text with the same name is under licenses/)', () => {
  assert.ok(KNOWN_LICENSES.length >= 3, `licenses/ directory is empty? Only found ${KNOWN_LICENSES.join()}`);
  for (const [key, meta] of Object.entries(MODEL_META)) {
    for (const id of [meta.license, ...(meta.alsoLicenses || []).map((a) => a.id)]) {
      assert.ok(KNOWN_LICENSES.includes(id), `The license "${id}" of ${key} is not in ${KNOWN_LICENSES.join(' / ')}`);
    }
  }
});

test('A misspelled license (Apache 2.0 missing the hyphen) means the package cannot be built', () => {
  const bad = { ...MODEL_META.rtdetr, license: 'Apache 2.0' };
  assert.throws(() => assertModelMeta(bad), /SPDX/);
  // alsoLicenses 里拼错同样要拦
  const bad2 = { ...MODEL_META.yunet, alsoLicenses: [{ id: 'BSD3', why: 'x' }] };
  assert.throws(() => assertModelMeta(bad2), /BSD3/);
});

test('The package carries the full license text, not just the license name', () => {
  const { light } = makeExtensions(SRC);
  const text = buildLicenseText(light);
  // MIT 的实体条款（TransNet V2 和 YuNet 两个权重共用这一份）
  assert.ok(text.includes('Permission is hereby granted, free of charge'), 'Missing full MIT text');
  // Apache-2.0 的实体条款（RT-DETR）
  assert.ok(text.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'),
    'Missing full Apache-2.0 text');
  // BSD-3-Clause（YuNet 权重的训练上游）
  assert.ok(text.includes('Neither the name of'), 'Missing full BSD-3-Clause text');
  // 每份全文的抬头要写清原始版权行，否则 MIT「保留版权声明」这条没做到
  assert.ok(text.includes('Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>'));
  assert.ok(text.includes('Copyright (c) 2020 Tomáš Souček'));
  // MPL-2.0 的 wheel（certifi / tqdm）要给源码地址
  assert.ok(text.includes('github.com/certifi/python-certifi'));
  // 全篇 CRLF，别混换行符
  assert.ok(!/[^\r]\n/.test(text), 'The license text contains a bare \\n');
});

test('Full text in the full tier is not duplicated: one MIT copy covers two models and appears only once', () => {
  const { full } = makeExtensions(SRC);
  const text = buildLicenseText(full);
  const mitCount = text.split('Permission is hereby granted, free of charge').length - 1;
  assert.equal(mitCount, 1, `The full MIT text appeared ${mitCount} times`);
  // 但抬头要把两个适用的模型都列出来
  const head = text.slice(text.indexOf('Full license text'));
  assert.ok(head.includes('TransNet V2') && head.includes('YuNet'));
});

test('Apache-2.0 under licenses/ and LICENSE-opencv shipped with the python package have the same body text', () => {
  // 两处各存一份是有意的（一份跟拓展包走，一份跟 site-packages 走），
  // 但正文漂移就会出现「同一个许可证两个版本」，改一处忘一处时这条会红。
  const here = fileURLToPath(new URL('.', import.meta.url));
  const opencv = readFileSync(join(here, '../../python/promptcut_subject/LICENSE-opencv'), 'utf-8')
    .replace(/\r\n/g, '\n');
  assert.ok(opencv.includes(licenseFullText('Apache-2.0')),
    'The Apache-2.0 body text in LICENSE-opencv does not match scripts/licenses/Apache-2.0.txt');
});

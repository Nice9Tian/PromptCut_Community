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
test('light 档提供镜头识别 + 主体检测，不带追踪', () => {
  const { light } = makeExtensions(SRC);
  assert.equal(light.tier, 'light');
  assert.deepEqual(light.provides, ['shots', 'subject']);
  assert.deepEqual(files(light).sort(), ['rtdetr_r18vd.onnx', 'transnetv2.onnx', 'yunet.onnx']);
  // 轻装档的卖点就是不带 torch，掺进来包会大 200 MB
  assert.ok(!light.requirements.some((r) => r.includes('track')), 'light 不该带追踪的依赖清单');
});

test('full 档是 light 的超集：依赖清单和模型一个都不能少', () => {
  const { light, full } = makeExtensions(SRC);
  for (const r of light.requirements) {
    assert.ok(full.requirements.includes(r), `full 少了 light 的依赖清单 ${r}`);
  }
  for (const f of files(light)) {
    assert.ok(files(full).includes(f), `full 少了 light 的模型 ${f}`);
  }
  assert.deepEqual(full.provides, ['shots', 'subject', 'track']);
  assert.ok(files(full).includes('bootstapir_v2.pt'));
  assert.ok(files(full).includes('grounding-dino-tiny'));
  assert.equal(full.requirements.length, light.requirements.length + 2);
});

test('老名字 shots / track / stt 还在，单独重打某一项的活不能断', () => {
  const table = makeExtensions({ model: 'X:/fake/whatever.bin' });
  for (const n of ['shots', 'track', 'stt']) assert.ok(table[n], `${n} 不见了`);
  // 单项包认 --model，两档认各自的开关
  assert.equal(table.shots.models[0].from, 'X:/fake/whatever.bin');
  assert.equal(table.stt.models.length, 0, '语音模型按需下载，不随包发');
});

test('两档各进各的子目录，单项包平铺', () => {
  const t = makeExtensions(SRC);
  assert.equal(outDirFor(t.light, '/rel'), join('/rel', '_light'));
  assert.equal(outDirFor(t.full, '/rel'), join('/rel', '_full'));
  assert.equal(outDirFor(t.shots, '/rel'), '/rel');
});

// ── manifest ─────────────────────────────────────────────────────────
test('manifest 不带构建机的本地路径，目录型模型保留 dir 标记', () => {
  const { full } = makeExtensions(SRC);
  const man = buildManifest({ name: 'full', ext: full, wheels: ['a-1.0-py3-none-any.whl'] });
  for (const m of man.models) {
    assert.ok(!('from' in m), `${m.file} 把本地路径 from 写进 manifest 了`);
    assert.ok(m.title && m.license && m.source);
  }
  const dino = man.models.find((m) => m.file === 'grounding-dino-tiny');
  assert.equal(dino.dir, true, '目录型模型要标 dir，安装器靠它决定递归拷');
  assert.equal(man.tier, 'full');
  assert.deepEqual(man.provides, ['shots', 'subject', 'track']);
  assert.equal(man.format, 'promptcut-extension/1');
  assert.deepEqual(man.wheels, ['a-1.0-py3-none-any.whl']);
});

test('单项包的 manifest 不带 tier 字段', () => {
  const { shots } = makeExtensions({ model: 'X:/fake/t.onnx' });
  const man = buildManifest({ name: 'shots', ext: shots, wheels: [] });
  assert.ok(!('tier' in man));
  assert.deepEqual(man.provides, ['shots']);
});

// ── 许可证硬闸 ────────────────────────────────────────────────────────
test('缺 license / source / title 就打不出包', () => {
  for (const field of ['title', 'license', 'source']) {
    const bad = { ...MODEL_META.yunet };
    delete bad[field];
    assert.throws(() => assertModelMeta(bad), new RegExp(field), `缺 ${field} 居然放过了`);
  }
  assert.doesNotThrow(() => assertModelMeta(MODEL_META.yunet));
});

test('缺许可证的模型混进拓展表时，buildManifest 直接抛', () => {
  const { light } = makeExtensions(SRC);
  const broken = { ...light, models: [...light.models, { file: 'mystery.onnx', from: 'X:/x' }] };
  assert.throws(() => buildManifest({ name: 'light', ext: broken, wheels: [] }), /mystery\.onnx/);
});

test('每个随包权重都写齐了许可证四件套', () => {
  for (const [key, meta] of Object.entries(MODEL_META)) {
    assert.doesNotThrow(() => assertModelMeta(meta), `${key} 缺许可证字段`);
  }
});

test('包内许可证文本把目录型模型写成 xxx/，且每个模型都出现', () => {
  const { full } = makeExtensions(SRC);
  const text = buildLicenseText(full);
  for (const m of full.models) assert.ok(text.includes(m.title), `许可证文本漏了 ${m.title}`);
  assert.ok(text.includes('grounding-dino-tiny/'));
  assert.ok(!text.includes('X:/fake'), '许可证文本泄露了构建机路径');
});

// ── 许可证标识符必须是 SPDX 认得的，且有全文可附 ──────────────────────
// 2026-09-07 之前 YuNet 被标成 Apache-2.0（实际是 MIT），错误一路写进了两个 exe、
// 两份 manifest 和两份包内许可证文件。名字写错没人拦，因为当时的硬闸只看「有没有填」。
test('yunet 是 MIT，不是 Apache-2.0，且 source 指到模型目录', () => {
  // opencv_zoo 根仓库是 Apache-2.0，但 models/face_detection_yunet/ 目录自带 MIT LICENSE
  // （Copyright (c) 2020 Shiqi Yu），以目录内的为准 —— 2026-09-07 curl 核对过。
  assert.equal(MODEL_META.yunet.license, 'MIT');
  assert.match(MODEL_META.yunet.source, /face_detection_yunet/,
    'source 要精确到模型目录，指到根仓库会被读成 Apache-2.0');
  assert.match(MODEL_META.yunet.copyright, /Shiqi Yu/);
  // 权重的训练上游 ShiqiYu/libfacedetection.train 是 BSD-3-Clause，全文也要附
  assert.deepEqual(MODEL_META.yunet.alsoLicenses.map((a) => a.id), ['BSD-3-Clause']);
});

test('每个模型的 license 都是 SPDX 里认得的标识符（licenses/ 下有同名全文）', () => {
  assert.ok(KNOWN_LICENSES.length >= 3, `licenses/ 目录空了？只找到 ${KNOWN_LICENSES.join()}`);
  for (const [key, meta] of Object.entries(MODEL_META)) {
    for (const id of [meta.license, ...(meta.alsoLicenses || []).map((a) => a.id)]) {
      assert.ok(KNOWN_LICENSES.includes(id), `${key} 的 license "${id}" 不在 ${KNOWN_LICENSES.join(' / ')} 里`);
    }
  }
});

test('license 拼错（Apache 2.0 少个连字符）就打不出包', () => {
  const bad = { ...MODEL_META.rtdetr, license: 'Apache 2.0' };
  assert.throws(() => assertModelMeta(bad), /SPDX/);
  // alsoLicenses 里拼错同样要拦
  const bad2 = { ...MODEL_META.yunet, alsoLicenses: [{ id: 'BSD3', why: 'x' }] };
  assert.throws(() => assertModelMeta(bad2), /BSD3/);
});

test('包里带的是许可证全文，不只是许可证名字', () => {
  const { light } = makeExtensions(SRC);
  const text = buildLicenseText(light);
  // MIT 的实体条款（TransNet V2 和 YuNet 两个权重共用这一份）
  assert.ok(text.includes('Permission is hereby granted, free of charge'), '缺 MIT 全文');
  // Apache-2.0 的实体条款（RT-DETR）
  assert.ok(text.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'),
    '缺 Apache-2.0 全文');
  // BSD-3-Clause（YuNet 权重的训练上游）
  assert.ok(text.includes('Neither the name of'), '缺 BSD-3-Clause 全文');
  // 每份全文的抬头要写清原始版权行，否则 MIT「保留版权声明」这条没做到
  assert.ok(text.includes('Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>'));
  assert.ok(text.includes('Copyright (c) 2020 Tomáš Souček'));
  // MPL-2.0 的 wheel（certifi / tqdm）要给源码地址
  assert.ok(text.includes('github.com/certifi/python-certifi'));
  // 全篇 CRLF，别混换行符
  assert.ok(!/[^\r]\n/.test(text), '许可证文本里混了裸 \\n');
});

test('full 档的全文不重复：一份 MIT 管两个模型，只出现一次', () => {
  const { full } = makeExtensions(SRC);
  const text = buildLicenseText(full);
  const mitCount = text.split('Permission is hereby granted, free of charge').length - 1;
  assert.equal(mitCount, 1, `MIT 全文出现了 ${mitCount} 次`);
  // 但抬头要把两个适用的模型都列出来
  const head = text.slice(text.indexOf('许可证全文'));
  assert.ok(head.includes('TransNet V2') && head.includes('YuNet'));
});

test('licenses/ 下的 Apache-2.0 和随 python 包发的 LICENSE-opencv 是同一份正文', () => {
  // 两处各存一份是有意的（一份跟拓展包走，一份跟 site-packages 走），
  // 但正文漂移就会出现「同一个许可证两个版本」，改一处忘一处时这条会红。
  const here = fileURLToPath(new URL('.', import.meta.url));
  const opencv = readFileSync(join(here, '../../python/promptcut_subject/LICENSE-opencv'), 'utf-8')
    .replace(/\r\n/g, '\n');
  assert.ok(opencv.includes(licenseFullText('Apache-2.0')),
    'LICENSE-opencv 里的 Apache-2.0 正文和 scripts/licenses/Apache-2.0.txt 不一致');
});

#!/usr/bin/env node
/**
 * 云端 Agent 网页采集的**下载器替身**(测试夹具;`server/test/cloud-agent-collect.test.mjs` 与 `scripts/probes/cloud-agent-collect-probe.mjs` 用)。
 *
 * 这台开发机上没有 yt-dlp,也不许为了测试去装。这个脚本顶替 `python -m promptcut_collect <子命令>`:说同一份命令行与 JSONL,
 * 并且**像真的下载器那样只按环境里的代理出网**(`HTTP_PROXY`)——所以「子进程经出网闸的代理出网、落盘、入库、记用量」这条链路
 * 用它就能整条验通;真的 yt-dlp 留到节点上验。
 *
 * 它同时是一个只读、只报告的越权探测夹具(定义见 `docs/plan/sound-online-render-task.md` 文末「越权探测卡」一节的同一种办法):
 * 把自己看到的环境(工作目录、环境变量的**名字**、有没有任何 `PROMPTCUT_*`)写进 `status` 的回答里,供探针断言;
 * 它不读别的文件、不改任何东西,只向调用方给的地址发请求(探针给的都是本机回环上的替身)。
 *
 * 用法(由 Agent 服务起):node fake-collect.mjs status | probe --url U | search --query Q | download --url U --out-dir D
 * 地址里的记号(探针用来挑行为):
 *   …/slow      下载时每 200 ms 写一块、一直不停(验取消、时限、体积上限)
 *   …/outside   下载完报一个作业目录以外的文件路径(验「别处的路径一概不认」)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const argv = process.argv.slice(2);
const sub = argv[0];
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const proxyUrl = process.env.HTTP_PROXY || process.env.http_proxy || '';

/** 经环境里的代理发一个明文 HTTP 请求;没有代理就直接失败(真的下载器在这里也只认代理) */
function viaProxy(url, { onChunk } = {}) {
  return new Promise((resolve, reject) => {
    if (!proxyUrl) return reject(new Error('no proxy in environment'));
    const p = new URL(proxyUrl);
    const req = http.request({ host: p.hostname, port: p.port, method: 'GET', path: url, headers: { Host: new URL(url).host } }, (res) => {
      const chunks = [];
      res.on('data', (d) => { if (onChunk) onChunk(d); else chunks.push(d); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const fail = (message, code = 1) => { emit({ event: 'error', message }); process.exit(code); };

async function main() {
  if (sub === 'status') {
    emit({
      event: 'status', version: 'fake', ready: true, ytdlp: { installed: true, version: 'fake-stand-in', error: null }, ffmpeg: '/fake/ffmpeg', pylibs: null,
      presets: [{ name: 'bilibili', notes: 'fake' }, { name: 'generic', notes: 'fake' }],
      // 只读、只报告:子进程自己看到的环境(只有名字,不带值)
      seen: {
        cwd: process.cwd(),
        envNames: Object.keys(process.env).sort(),
        promptcutEnv: Object.keys(process.env).filter((k) => /^PROMPTCUT_/i.test(k)),
        proxy: !!proxyUrl,
        home: process.env.HOME ?? process.env.USERPROFILE ?? null,
        tmp: process.env.TMPDIR ?? process.env.TEMP ?? null,
      },
    });
    return;
  }
  if (sub === 'search') {
    emit({ event: 'done', query: opt('--query'), site: opt('--site') ?? 'bilibili', results: [{ id: 'BV1FAKE00000', title: 'Fake Search Hit', url: 'https://www.bilibili.com/video/BV1FAKE00000', duration: 12.5, uploader: 'tester', view_count: 1234, max_height: 1080 }], warnings: [] });
    return;
  }
  const url = opt('--url');
  if (!url || !/^http:\/\//.test(url)) fail('fake-collect: 只认 http:// 地址');
  if (sub === 'probe') {
    let res;
    try { res = await viaProxy(url); } catch (err) { fail(`Unable to download webpage: ${err.message}`); }
    if (res.status !== 200) fail(`Unable to download webpage: HTTP Error ${res.status}${res.headers['x-egress-refused'] ? ` (egress refused: ${res.headers['x-egress-refused']})` : ''}`);
    const duration = Number(res.headers['x-fake-duration'] ?? 12.5);
    emit({ event: 'done', id: 'FAKE0001', title: 'Fake Video', duration, uploader: 'tester', extractor: 'fake', site: 'generic', url, heights: [1080, 720], parts: null, subtitles: [], formats: [{ big: 'x'.repeat(100) }], warnings: [] });
    return;
  }
  if (sub === 'download') {
    const outDir = opt('--out-dir');
    if (!outDir) fail('fake-collect: 要 --out-dir');
    emit({ event: 'start', url, out_dir: outDir, quality: Number(opt('--quality') ?? 1080) });
    const filename = 'Fake Clip [FAKE0001].mp4';
    const file = path.join(outDir, filename);
    const fd = fs.openSync(file, 'w');
    let bytes = 0;
    let res;
    let announced = false;
    try {
      res = await viaProxy(url, {
        onChunk: (d) => {
          fs.writeSync(fd, d); bytes += d.length;
          emit({ event: 'progress', stage: 'video', percent: 50, overall: 45, downloaded: bytes, speed: 1000, eta: 1 });
        },
      });
    } catch (err) {
      fs.closeSync(fd);
      fail(`ERROR: ${err.message}`);
    }
    fs.closeSync(fd);
    if (res.status !== 200) fail(`HTTP Error ${res.status}${res.headers['x-egress-refused'] ? ` (egress refused: ${res.headers['x-egress-refused']})` : ''}`);
    if (!announced) { announced = true; emit({ event: 'info', id: 'FAKE0001', title: 'Fake Video', duration: Number(res.headers['x-fake-duration'] ?? 12.5), uploader: 'tester', site: 'generic', webpage_url: url }); }
    emit({ event: 'progress', stage: 'merge', percent: 100 });
    if (/\/outside$/.test(new URL(url).pathname)) {
      // 报一个作业目录以外的路径:调用方只认作业目录里这一层的文件
      emit({ event: 'item', id: 'FAKE0001', title: 'Outside', path: path.resolve(outDir, '..', '..', 'attachments', 'not-mine.mp4'), filename: '../../attachments/not-mine.mp4', bytes });
    } else {
      emit({ event: 'item', id: 'FAKE0001', title: 'Fake Video', path: file, filename, bytes, vcodec: 'h264', width: 1920, height: 1080, fps: 30, duration: 12.5, transcoded: false, audio_only: false });
    }
    emit({ event: 'done', items: [], site: 'generic', url, warnings: [] });
    return;
  }
  if (sub === 'install') fail('fake-collect: 云端不该调到 install', 2);
  fail(`fake-collect: unknown subcommand ${sub}`, 2);
}

main().catch((err) => fail(String(err?.message ?? err)));

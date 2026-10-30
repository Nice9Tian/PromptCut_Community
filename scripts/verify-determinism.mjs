import './lib/no-user-dirs.mjs';
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import { exportFrames } from '../server/bakery/index.mjs';

async function verify() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url') opts.url = args[++i];
    else if (args[i] === '--frames') opts.frames = args[++i];
    else if (args[i] === '--fps') opts.fps = parseFloat(args[++i]);
  }

  fs.mkdirSync('out', { recursive: true });
  const isolatedRoot = fs.mkdtempSync(path.resolve('out', 'determinism-'));
  const outA = path.join(isolatedRoot, 'verify-a');
  const outB = path.join(isolatedRoot, 'verify-b');
  
  console.log('--- Exporting First Pass ---');
  await exportFrames({ ...opts, out: outA, noVideo: true });
  
  console.log('\n--- Exporting Second Pass ---');
  await exportFrames({ ...opts, out: outB, noVideo: true });

  console.log('\n--- Comparing Frames ---');
  const framesA = fs.readdirSync(path.join(outA, 'frames')).filter(f => f.endsWith('.png')).sort();
  const framesB = fs.readdirSync(path.join(outB, 'frames')).filter(f => f.endsWith('.png')).sort();

  if (framesA.length !== framesB.length) {
    console.error(`Frame count mismatch: ${framesA.length} vs ${framesB.length}`);
    process.exit(1);
  }

  let identicalCount = 0;
  let diffCount = 0;
  let worstFrame = null;
  let worstDiffRatio = 0;
  const diffList = [];

  for (let i = 0; i < framesA.length; i++) {
    const file = framesA[i];
    const pathA = path.join(outA, 'frames', file);
    const pathB = path.join(outB, 'frames', file);

    const pngA = PNG.sync.read(fs.readFileSync(pathA));
    const pngB = PNG.sync.read(fs.readFileSync(pathB));

    let diffPixels = 0;
    const totalPixels = pngA.width * pngA.height;

    for (let y = 0; y < pngA.height; y++) {
      for (let x = 0; x < pngA.width; x++) {
        const idx = (pngA.width * y + x) << 2;
        if (
          pngA.data[idx] !== pngB.data[idx] ||
          pngA.data[idx + 1] !== pngB.data[idx + 1] ||
          pngA.data[idx + 2] !== pngB.data[idx + 2] ||
          pngA.data[idx + 3] !== pngB.data[idx + 3]
        ) {
          diffPixels++;
        }
      }
    }

    if (diffPixels === 0) {
      identicalCount++;
    } else {
      diffCount++;
      const ratio = diffPixels / totalPixels;
      if (ratio > worstDiffRatio) {
        worstDiffRatio = ratio;
        worstFrame = file;
      }
      diffList.push(file);
    }
  }

  console.log(`Total Frames: ${framesA.length}`);
  console.log(`Identical: ${identicalCount}`);
  console.log(`Different: ${diffCount}`);

  if (diffCount > 0) {
    console.log(`Worst Frame: ${worstFrame} (diff ratio: ${(worstDiffRatio * 100).toFixed(4)}%)`);
    const limit = 20;
    const showDiffs = diffList.slice(0, limit);
    console.log(`Different frames: ${showDiffs.join(', ')}`);
    if (diffList.length > limit) {
      console.log(`... and ${diffList.length - limit} more`);
    }
    process.exit(1);
  } else {
    console.log('All frames are identical. Determinism verified!');
    process.exit(0);
  }
}

verify().catch(e => {
  console.error(e);
  process.exit(1);
});

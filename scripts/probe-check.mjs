import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';

const framesDir = 'out/smoke/frames';
const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort();

console.log(`Checking ${frames.length} frames...`);

for (let i = 0; i < frames.length; i++) {
  const file = frames[i];
  const png = PNG.sync.read(fs.readFileSync(path.join(framesDir, file)));
  
  // Sample motion element (blue box, fading and moving)
  // Initially at x=-200, so center is around x=120. Eventually at x=320.
  // We'll just scan a horizontal line at y=540 from x=100 to x=400 to find the blue box.
  let maxBlue = 0;
  for (let x = 100; x <= 400; x++) {
    const idx = (540 * png.width + x) << 2;
    if (png.data[idx + 2] > maxBlue) { // B channel
      maxBlue = png.data[idx + 2];
    }
  }

  // Sample CSS rotation (red box) at center x=960, y=540
  // Since it rotates, its bounding box changes or corners move. Let's just sample a pixel near the edge (x=960, y=435)
  const topEdgeIdx = (435 * png.width + 960) << 2;
  const isRedTop = png.data[topEdgeIdx] > 100 && png.data[topEdgeIdx + 1] < 100;

  if (i === 0 || i === 5 || i === 10 || i === 15 || i === 20 || i === 45 || i === frames.length - 1) {
    console.log(`${file}: maxBlue (opacity proxy)=${maxBlue}, isRedTop=${isRedTop}`);
  }
}


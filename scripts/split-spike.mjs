// Split-screen spike: layouts switch via CLIP TIME WINDOWS (framework-owned),
// crops are STATIC CSS per shot element (object-position; no timeline, no tweens).
// 4s composition:
//   shot 1 [0 .. 2-1/30]: SOLO — one full-frame video, left-biased crop
//   shot 2 [2 .. 4]:      SPLIT — top pane (left-biased) + bottom pane (right-biased)
// Verify: frame 59 = solo, frame 60 = split, both panes advance 60→61, no ghost.
import { existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (!process.argv[2]) {
  console.error('usage: node scripts/split-spike.mjs <rundir>');
  process.exit(2);
}
const rundir = resolve(process.argv[2]);
const spikeDir = join(rundir, 'compose', 'spike-split');
// media = any 30fps CFR copy; per-clip proxies replaced the full normalize (reframe.md)
const proxy = join(rundir, 'compose', 'c1', 'assets', 'clip30.mp4');
const media = existsSync(proxy) ? proxy : join(rundir, 'compose', 'source-30fps.mp4');
const M = existsSync(proxy) ? 5 : 100; // media offset on that copy's clock
const SOLO_END = (2 - 1 / 30).toFixed(4); // inclusive clip end → last solo frame is 59

rmSync(spikeDir, { recursive: true, force: true });
mkdirSync(join(spikeDir, 'assets'), { recursive: true });
linkSync(media, join(spikeDir, 'assets', 'source.mp4'));

writeFileSync(join(spikeDir, 'index.html'), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <title>split spike</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      body { margin: 0; background: #000; }
      video { display: block; }
      #root { position: relative; width: 1080px; height: 1920px; overflow: hidden; background: #000; }
      /* shot 1 — solo, full frame, left-biased static crop */
      #solo-v { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 30% 40%; }
      /* shot 2 — split: static half-frame panes, each its own static crop */
      #split-top-v { position: absolute; top: 0; left: 0; width: 100%; height: 50%; object-fit: cover; object-position: 25% 35%; }
      #split-bottom-v { position: absolute; bottom: 0; left: 0; width: 100%; height: 50%; object-fit: cover; object-position: 75% 35%; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="spike-split" data-start="0" data-width="1080" data-height="1920" data-duration="4">
      <video id="solo-v" class="clip" src="assets/source.mp4" data-start="0" data-duration="${SOLO_END}" data-media-start="${M}" data-track-index="0" muted playsinline></video>
      <video id="split-top-v" class="clip" src="assets/source.mp4" data-start="2" data-duration="2" data-media-start="${M + 2}" data-track-index="1" muted playsinline></video>
      <video id="split-bottom-v" class="clip" src="assets/source.mp4" data-start="2" data-duration="2" data-media-start="${M + 2}" data-track-index="2" muted playsinline></video>
      <audio id="spike-a" src="assets/source.mp4" data-start="0" data-duration="4" data-media-start="${M}" data-track-index="10" data-volume="1"></audio>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["spike-split"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`);

console.log(`split spike → ${spikeDir}
run: cd ${spikeDir} && npx hyperframes check && npx hyperframes render --quality draft --fps 30 --output spike.mp4 && ffmpeg -v error -y -i spike.mp4 -vf "select='between(n,58,62)'" -vsync passthrough f_%d.png`);

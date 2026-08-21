// The reframe.md promotion spike: does HF's injected-frames render honor a
// zero-duration wrapper-transform switch FRAME-EXACTLY?
//
// Builds a tiny standalone HF project on the normalized 30fps working copy:
// 4s clip, hard framing switch at t=2.0 (exact 30fps boundary — frame 60):
//   frames 0-59  : left-biased crop  (scale 1.8, focus x=0.30)
//   frames 60-119: right-biased crop (scale 1.8, focus x=0.70)
// Then: render --fps 30 draft → extract frames 58..62 → eyeball: the framing must
// flip exactly between frame 59 and frame 60, no intermediate/ghost frame.
//
// Usage: node scripts/reframe-spike.mjs <rundir>   (then render+extract commands it prints)
import { existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (!process.argv[2]) {
  console.error('usage: node scripts/reframe-spike.mjs <rundir>');
  process.exit(2);
}
const rundir = resolve(process.argv[2]);
const spikeDir = join(rundir, 'compose', 'spike-reframe');
// media = any 30fps CFR copy; per-clip proxies replaced the full normalize (reframe.md)
const proxy = join(rundir, 'compose', 'c1', 'assets', 'clip30.mp4');
const normalized = join(rundir, 'compose', 'source-30fps.mp4');
const media = existsSync(proxy) ? proxy : normalized;
const MEDIA_START = existsSync(proxy) ? 5 : 100; // a talking stretch on that copy's clock

rmSync(spikeDir, { recursive: true, force: true });
mkdirSync(join(spikeDir, 'assets'), { recursive: true });
linkSync(media, join(spikeDir, 'assets', 'source.mp4'));

writeFileSync(join(spikeDir, 'index.html'), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <title>reframe spike</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      body { margin: 0; background: #000; }
      #root { position: relative; width: 1080px; height: 1920px; overflow: hidden; background: #000; }
      .clip { position: absolute; inset: 0; }
      /* non-timed wrapper owns the reframe transform; the timed video fills it */
      #cam { position: absolute; inset: 0; transform-origin: center center; }
      #cam video { width: 100%; height: 100%; object-fit: cover; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="spike" data-start="0" data-width="1080" data-height="1920" data-duration="4">
      <!-- non-timed wrappers only — hyperframes 0.8.4 lint forbids timed media nested
           inside a timed element (video_nested_in_timed_element: playback would freeze) -->
      <div id="stage" class="clip">
        <div id="cam">
          <video id="spike-v0" src="assets/source.mp4" data-start="0" data-duration="4" data-media-start="${MEDIA_START}" data-track-index="0" muted playsinline class="clip"></video>
        </div>
      </div>
      <audio id="spike-a0" src="assets/source.mp4" data-start="0" data-duration="4" data-media-start="${MEDIA_START}" data-track-index="10" data-volume="1"></audio>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      // initial state inside the timeline (gsap_css_transform_conflict rule)
      tl.set("#cam", { scale: 1.8, xPercent: 20 }, 0);   // left-biased framing
      tl.set("#cam", { xPercent: -20 }, 2);              // HARD switch at exactly frame 60
      window.__timelines["spike"] = tl;
    </script>
  </body>
</html>
`);

console.log(`spike project → ${spikeDir}
run:
  cd ${spikeDir} && npx hyperframes check && npx hyperframes render --quality draft --fps 30 --output spike.mp4
verify (frames 58..62; the flip must be exactly 59→60):
  cd ${spikeDir} && ffmpeg -y -i spike.mp4 -vf "select='between(n,58,62)'" -vsync passthrough -frame_pts 1 f_%d.png && open f_*.png`);

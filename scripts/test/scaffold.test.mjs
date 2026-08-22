import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldComposition } from '../scaffold.mjs';

const SCAFFOLD_CLI = fileURLToPath(new URL('../scaffold.mjs', import.meta.url));

const clip = () => ({
  id: 'c1',
  title: 'A haunted vending machine slid into the DMs',
  hook: '"I got a DM from a haunted vending machine"',
  segments: [{ src_in: 52.56, src_out: 89.46 }],
});

test('scaffoldComposition: standalone 9:16 root with framework-owned trimmed media', () => {
  const html = scaffoldComposition(clip(), { source: 'assets/source.mp4' });
  // root contract (hyperframes-core minimal composition)
  assert.match(html, /data-composition-id="c1"[^>]*data-start="0"[^>]*data-width="1080"[^>]*data-height="1920"[^>]*data-duration="36.9"/s);
  assert.ok(!html.includes('<template'), 'standalone root is never template-wrapped');
  // one muted inline video clip, trimmed into the source at src_in
  assert.match(html, /<video[^>]*src="assets\/source\.mp4"[^>]*data-start="0"[^>]*data-duration="36.9"[^>]*data-media-start="52.56"[^>]*data-track-index="0"[^>]*muted/s);
  // sound rides a separate audio element on its own track
  assert.match(html, /<audio[^>]*src="assets\/source\.mp4"[^>]*data-start="0"[^>]*data-duration="36.9"[^>]*data-media-start="52.56"[^>]*data-track-index="10"/s);
  // exactly one paused timeline registered under the composition id
  assert.match(html, /window\.__timelines\["c1"\]/);
  assert.match(html, /paused:\s*true/);
});

test('scaffoldComposition: multi-segment clips stack on one track with per-segment trims', () => {
  const c = { ...clip(), id: 'c9', segments: [{ src_in: 10, src_out: 15.5 }, { src_in: 100, src_out: 104.5 }] };
  const html = scaffoldComposition(c, { source: 'assets/source.mp4' });
  assert.match(html, /data-composition-id="c9"[^>]*data-duration="10"/s); // 5.5 + 4.5
  assert.match(html, /id="c9-v0"[^>]*data-start="0"[^>]*data-duration="5.5"[^>]*data-media-start="10"/s);
  assert.match(html, /id="c9-v1"[^>]*data-start="5.5"[^>]*data-duration="4.5"[^>]*data-media-start="100"/s);
  assert.match(html, /id="c9-a1"[^>]*data-start="5.5"[^>]*data-duration="4.5"[^>]*data-media-start="100"[^>]*data-track-index="10"/s);
});

test('scaffoldComposition: titles are HTML-escaped', () => {
  const c = { ...clip(), title: 'Duck <neck> & "sauce"' };
  const html = scaffoldComposition(c, { source: 'assets/source.mp4' });
  assert.ok(html.includes('Duck &lt;neck&gt; &amp; &quot;sauce&quot;'));
  assert.ok(!html.includes('<neck>'));
});

test('CLI build --dir: writes one project per proposed clip, links the source, stamps the plan', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'cr-scaffold-'));
  const rundir = join(workdir, 'cutting-room');
  mkdirSync(rundir, { recursive: true });
  writeFileSync(join(workdir, 'clip.mp4'), 'not really a video');
  writeFileSync(join(rundir, 'plan.json'), JSON.stringify({
    schema: 'cutting-room/plan@2',
    source: { path: 'clip.mp4', duration_s: 600, width: 1920, height: 1080, project_id: 'p-test' },
    analyses: {},
    clips: [
      { id: 'c1', title: 'One', hook: '"h1"', status: 'proposed', score: 0.8, reasons: [], segments: [{ src_in: 10, src_out: 40 }], composition: { status: 'none', path: null } },
      { id: 'c2', title: 'Two', hook: '"h2"', status: 'rejected', score: 0.5, reasons: [], segments: [{ src_in: 50, src_out: 60 }], composition: { status: 'none', path: null } },
    ],
  }, null, 2));
  const res = spawnSync('node', [SCAFFOLD_CLI, 'build', '--dir', rundir], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.scaffolded, ['c1']); // rejected clips are not scaffolded
  const html = readFileSync(join(rundir, 'compose', 'c1', 'index.html'), 'utf8');
  assert.match(html, /data-media-start="10"/);
  const link = join(rundir, 'compose', 'c1', 'assets', 'source.mp4');
  // the play/preview server 403s symlinks that escape the project root — must be a hardlink
  assert.ok(!lstatSync(link).isSymbolicLink(), 'hardlink, not symlink');
  assert.equal(lstatSync(link).ino, lstatSync(join(workdir, 'clip.mp4')).ino, 'same inode as the source');
  assert.equal(readFileSync(link, 'utf8'), 'not really a video');
  const plan = JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8'));
  assert.deepEqual(plan.clips[0].composition, { status: 'scaffolded', path: 'compose/c1' });
  assert.equal(plan.clips[1].composition.status, 'none');
  assert.ok(!existsSync(join(rundir, 'compose', 'c2')));
});

test('CLI build --dir: re-run is idempotent and refreshes the composition', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'cr-scaffold-re-'));
  const rundir = join(workdir, 'cutting-room');
  mkdirSync(rundir, { recursive: true });
  writeFileSync(join(workdir, 'clip.mp4'), 'x');
  writeFileSync(join(rundir, 'plan.json'), JSON.stringify({
    schema: 'cutting-room/plan@2',
    source: { path: 'clip.mp4', duration_s: 600, project_id: 'p' },
    clips: [{ id: 'c1', title: 'One', hook: '"h"', status: 'proposed', segments: [{ src_in: 1, src_out: 2 }], composition: { status: 'none', path: null } }],
  }));
  const r1 = spawnSync('node', [SCAFFOLD_CLI, 'build', '--dir', rundir], { encoding: 'utf8' });
  assert.equal(r1.status, 0);
  const r2 = spawnSync('node', [SCAFFOLD_CLI, 'build', '--dir', rundir], { encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(JSON.parse(r2.stdout).scaffolded, ['c1']);
  assert.ok(existsSync(join(rundir, 'compose', 'c1', 'assets', 'source.mp4')));
});

// ---- per-clip extract (reframe.md law #2): lock each clip window
// to a 30fps CFR proxy, then find cuts on the file just made — never on the source ----

// 29.97 NTSC source with a hard red→blue cut at exactly t=2.0, sine audio throughout.
const makeCutClip = (dir) => {
  const out = join(dir, 'clip.mp4');
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'color=red:d=2:s=320x240:r=30000/1001',
    '-f', 'lavfi', '-i', 'color=blue:d=2:s=320x240:r=30000/1001',
    '-f', 'lavfi', '-i', 'sine=duration=4',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]',
    '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', out,
  ], { stdio: 'pipe' });
  return out;
};

const probeStream = (file) => JSON.parse(execFileSync('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,nb_frames', '-of', 'json', file,
], { encoding: 'utf8' })).streams[0];

const seedExtractRundir = (prefix, segments) => {
  const workdir = mkdtempSync(join(tmpdir(), prefix));
  const rundir = join(workdir, 'cutting-room');
  mkdirSync(rundir, { recursive: true });
  makeCutClip(workdir);
  writeFileSync(join(rundir, 'plan.json'), JSON.stringify({
    schema: 'cutting-room/plan@2',
    source: { path: 'clip.mp4', duration_s: 4, project_id: 'p' },
    clips: [{ id: 'c1', title: 'One', hook: '"h"', status: 'proposed', segments, composition: { status: 'none', path: null } }],
  }));
  return rundir;
};

test('CLI extract --dir: clip window becomes an exact-30fps CFR proxy with its own cuts', () => {
  const rundir = seedExtractRundir('cr-ex-', [{ src_in: 1, src_out: 3 }]);
  const res = spawnSync('node', [SCAFFOLD_CLI, 'extract', '--dir', rundir, '--pad', '0.5'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.extracted.length, 1);
  const plan = JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8'));
  const ex = plan.clips[0].composition.extract;
  assert.equal(ex.file, 'assets/clip30.mp4');
  assert.equal(ex.start, 0.5);       // window [0.5, 3.5]
  assert.equal(ex.frames, 90);       // 3.0s × 30, exact
  const stream = probeStream(join(rundir, 'compose', 'c1', ex.file));
  assert.equal(stream.r_frame_rate, '30/1');
  assert.equal(Number(stream.nb_frames), 90);
  // the red→blue cut at source 2.0 lands at extract-time 1.5 → frame 45, found on the proxy
  assert.deepEqual(ex.cuts, [45]);
});

test('CLI extract: window clamps at t=0 and the EOF clone pad fills a window past the end', () => {
  const rundir = seedExtractRundir('cr-ex-edge-', [{ src_in: 0.2, src_out: 3.9 }]);
  const res = spawnSync('node', [SCAFFOLD_CLI, 'extract', '--dir', rundir, '--pad', '0.5'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const ex = JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8')).clips[0].composition.extract;
  assert.equal(ex.start, 0);         // clamped
  assert.equal(ex.frames, 120);      // window [0, 4.0] — EOF clamp
  assert.equal(Number(probeStream(join(rundir, 'compose', 'c1', ex.file)).nb_frames), 120);
});

test('CLI extract: skips while segments stay inside the window, re-extracts when they escape', () => {
  const rundir = seedExtractRundir('cr-ex-re-', [{ src_in: 1, src_out: 3 }]);
  execFileSync('node', [SCAFFOLD_CLI, 'extract', '--dir', rundir, '--pad', '0.5'], { stdio: 'pipe' });
  // nudge inside the pad → covered, skip
  let plan = JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8'));
  plan.clips[0].segments = [{ src_in: 0.8, src_out: 3.2 }];
  writeFileSync(join(rundir, 'plan.json'), JSON.stringify(plan));
  let res = spawnSync('node', [SCAFFOLD_CLI, 'extract', '--dir', rundir, '--pad', '0.5'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(res.stdout).extracted, []);
  // move beyond the window start → re-extract with a fresh window
  plan = JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8'));
  plan.clips[0].segments = [{ src_in: 0.2, src_out: 3 }];
  writeFileSync(join(rundir, 'plan.json'), JSON.stringify(plan));
  res = spawnSync('node', [SCAFFOLD_CLI, 'extract', '--dir', rundir, '--pad', '0.5'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(res.stdout).extracted, ['c1']);
  assert.equal(JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8')).clips[0].composition.extract.start, 0);
});

test('CLI build after extract: compositions ride the proxy with offset media-start', () => {
  const rundir = seedExtractRundir('cr-ex-build-', [{ src_in: 1, src_out: 3 }]);
  execFileSync('node', [SCAFFOLD_CLI, 'extract', '--dir', rundir, '--pad', '0.5'], { stdio: 'pipe' });
  const res = spawnSync('node', [SCAFFOLD_CLI, 'build', '--dir', rundir], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const html = readFileSync(join(rundir, 'compose', 'c1', 'index.html'), 'utf8');
  assert.match(html, /src="assets\/clip30\.mp4"[^>]*data-start="0"[^>]*data-duration="2"[^>]*data-media-start="0.5"/s);
  assert.ok(!existsSync(join(rundir, 'compose', 'c1', 'assets', 'source.mp4')), 'no source hardlink when a proxy exists');
});

test('scaffoldComposition: mediaOffset rebases media-start into extract time', () => {
  const html = scaffoldComposition(clip(), { source: 'assets/clip30.mp4', mediaOffset: 47.56 });
  assert.match(html, /data-media-start="5"/); // 52.56 - 47.56
});

// ---- per-shot reframe emission (references/reframe.md, split-spike pattern) ----

const reframedClip = () => ({
  id: 'c1',
  title: 'T',
  hook: '"h"',
  status: 'proposed',
  segments: [{ src_in: 100, src_out: 105 }],
  composition: { extract: { file: 'assets/clip30.mp4', start: 95, fps: 30, frames: 450, cuts: [195, 281] } },
  reframe: {
    mode: 'asd',
    // f0=45 divides the grid evenly, f0=131 does NOT (131/30 has no finite decimal) —
    // the second is the measured black-hole case boundary-exact emission fails on
    shots: [
      { f0: 0, f1: 45, layout: 'solo', panes: [{ person: 'p1', cx: 0.2, cy: 0.4, zoom: 1 }] },
      { f0: 45, f1: 131, layout: 'split', panes: [{ person: 'p1', cx: 0.2, cy: 0.4, zoom: 1 }, { person: 'p2', cx: 0.7, cy: 0.4, zoom: 1 }] },
      { f0: 131, f1: 150, layout: 'solo', panes: [{ person: 'p2', cx: 0.7, cy: 0.4, zoom: 1 }] },
    ],
  },
});

test('scaffoldComposition: shot windows leave no hole and tail two frames UNDER the successor', () => {
  const html = scaffoldComposition(reframedClip(), { source: 'assets/clip30.mp4', mediaOffset: 95 });
  // Two runtimes (reframe.md §The two-runtime law). The renderer samples t = k/30; the
  // live player samples at display rate (~60 Hz) and reveals a timed <video> in real
  // time. Windows are [f0-0.25, f1-0.25]/30 (no boundary on a render sample) and every
  // non-final window keeps a 2-frame TAIL past the successor's start: a hole between
  // windows is a black frame in the player (measured 11/13 switches), and a freshly
  // revealed video can paint transparent for one compositor frame (measured on
  // replays) — under the tail the previous frame shows instead of the background.
  // Later shots stack above earlier ones (pane z-index = shot order), so the render
  // sample at f1 — inside the tail — shows the successor, and tracks alternate so the
  // overlap never lands on one track (lint forbids same-track overlap).
  // shot 0: origin → (45-0.25)/30 + 2/30 = 46.75/30
  assert.match(html, /id="c1-s0"[^>]*data-start="0"[^>]*data-duration="1.5583333333333333"[^>]*data-media-start="5"[^>]*data-track-index="0"/s);
  // split shot: starts (45-0.25)/30, ends (131+1.75)/30, panes on tracks 2/3
  assert.match(html, /id="c1-s1a"[^>]*data-start="1.4916666666666667"[^>]*data-duration="2.933333333333333"[^>]*data-media-start="6.5"[^>]*data-track-index="2"/s);
  assert.match(html, /id="c1-s1b"[^>]*data-start="1.4916666666666667"[^>]*data-duration="2.933333333333333"[^>]*data-media-start="6.5"[^>]*data-track-index="3"/s);
  // final shot: (131-0.25)/30 start, plain (f1-f0)/30 — no tail, never outlives the root
  assert.match(html, /id="c1-s2"[^>]*data-start="4.358333333333333"[^>]*data-duration="0.6333333333333333"[^>]*data-media-start="9.366666666666667"[^>]*data-track-index="0"/s);
  // z-order = shot order, on the pane (a stacking context the runtime cannot override)
  assert.match(html, /<div class="pane" style="[^"]*z-index:1;[^"]*">\s*<video id="c1-s0"/s);
  assert.match(html, /<div class="pane" style="[^"]*z-index:2;[^"]*">\s*<video id="c1-s1a"/s);
  assert.match(html, /<div class="pane" style="[^"]*z-index:2;[^"]*">\s*<video id="c1-s1b"/s);
  assert.match(html, /<div class="pane" style="[^"]*z-index:3;[^"]*">\s*<video id="c1-s2"/s);
  const shots = [...html.matchAll(/<video[^>]*data-start="([\d.]+)" data-duration="([\d.]+)" data-media-start/g)]
    .map((m) => ({ start: Number(m[1]), end: Number(m[1]) + Number(m[2]) }));
  assert.equal(shots.length, 4); // s0, s1a, s1b, s2
  // tail: each non-final window ends exactly two frames after its successor starts
  assert.ok(Math.abs((shots[0].end - shots[1].start) - 2 / 30) < 1e-9, 's0 tails 2 frames under s1');
  assert.ok(Math.abs((shots[1].end - shots[3].start) - 2 / 30) < 1e-9, 's1 tails 2 frames under s2');
  // the switch sample points stay strictly inside the successor's window
  assert.ok(shots[1].start < 45 / 30 && shots[0].end > 45 / 30, 'frame 45: successor visible, predecessor tailing under it');
  assert.ok(shots[3].start < 131 / 30 && shots[1].end > 131 / 30, 'frame 131: successor visible, predecessor tailing under it');
  // exactly one continuous audio element per segment
  assert.match(html, /<audio[^>]*data-start="0"[^>]*data-duration="5"[^>]*data-media-start="5"[^>]*data-track-index="10"/s);
  assert.equal([...html.matchAll(/<audio/g)].length, 1);
  // hyperframes-core data-attributes.md: class="clip" is for div/img — OMIT on <video>
  // (framework manages video visibility directly)
  assert.ok(!/<video[^>]*class="clip"/s.test(html), 'videos carry no clip class');
});

test('scaffoldComposition: timed videos hold their first frame before their window (prime script)', () => {
  // The live player reveals a timed <video> and seeks it at the same instant — until
  // the seek lands (2-8 display frames, measured) the viewer sees whatever frame the
  // element held: file t=0. The baseline pre-seeks every timed video to its
  // data-media-start on load and re-arms it when its window closes, so reveal shows
  // the shot's own first frame and replays/scrub-backs stay clean. The renderer is
  // unaffected (it seeks in-window media per frame and waits for readiness).
  const html = scaffoldComposition(reframedClip(), { source: 'assets/clip30.mp4', mediaOffset: 95 });
  assert.match(html, /<script data-cutting-room="prime-media">/);
  assert.match(html, /video\[data-media-start\]/);
  assert.match(html, /addEventListener\('loadedmetadata'/);
  assert.match(html, /addEventListener\('pause'/);
  // the plain-segment path (no reframe) carries it too — multi-segment clips switch videos
  const plain = scaffoldComposition(clip(), { source: 'assets/source.mp4', mediaOffset: 0 });
  assert.match(plain, /<script data-cutting-room="prime-media">/);
});


test('scaffoldComposition: audio timing strips float noise back to the true 2dp values', () => {
  // word-grid inputs are 2dp; raw float differences carry noise (89.46-52.56 =
  // 36.89999...). Emission must recover the TRUE decimal — that is noise-stripping,
  // not precision loss (grid-valued 1/30 numbers are never rounded, see shots test).
  const c = { ...clip(), segments: [{ src_in: 52.56, src_out: 89.46 }, { src_in: 100.1, src_out: 110.13 }] };
  const html = scaffoldComposition(c, { source: 'assets/source.mp4' });
  assert.match(html, /id="c1-a0"[^>]*data-start="0"[^>]*data-duration="36.9"[^>]*data-media-start="52.56"/s);
  assert.match(html, /id="c1-a1"[^>]*data-start="36.9"[^>]*data-duration="10.03"[^>]*data-media-start="100.1"/s);
  assert.ok(!html.includes('36.89999'), 'no float noise in attributes');
});

// ---- caption block emission: cues from captions.mjs, mounted on the
// registered paused timeline — the same timeline the Composer extends ----

const captionedClip = () => ({
  ...clip(),
  captions: {
    enabled: true,
    style: 'caption-camera-follow',
    style_source: 'kit',
    cues: [
      { start: 0.16, end: 1.2, speaker: 1, words: [{ text: 'Vending', start: 0.16, end: 0.5 }, { text: 'Machine <b>', start: 0.5, end: 0.7 }] },
      { start: 2, end: 3, speaker: 2, rtl: true, words: [{ text: 'שלום', start: 2, end: 2.4 }] },
    ],
  },
});

test('scaffoldComposition: caption cues emit static markup mounted on the registered timeline', () => {
  const html = scaffoldComposition(captionedClip(), { source: 'assets/source.mp4' });
  // container carries the kit style name for the Composer to restyle
  assert.match(html, /id="c1-captions"[^>]*data-caption-style="caption-camera-follow"/s);
  // one static group per cue, words as spans, text escaped
  assert.match(html, /id="c1-cue0"[^>]*class="cap-cue"/s);
  assert.match(html, /id="c1-cue0w1"[^>]*>Machine &lt;b&gt;</s);
  assert.ok(!html.includes('Machine <b>'));
  // RTL cue renders right-to-left; Latin cue carries no dir
  assert.match(html, /id="c1-cue1"[^>]*dir="rtl"/s);
  assert.ok(!/id="c1-cue0"[^>]*dir=/s.test(html));
  // mounts land on the ONE registered paused timeline (composition-time seconds)
  assert.match(html, /window\.__timelines\["c1"\]/);
  assert.match(html, /paused:\s*true/);
  assert.match(html, /"start":0\.16/);
  assert.match(html, /tl\.set\(/);
  assert.equal([...html.matchAll(/gsap\.timeline\(/g)].length, 1, 'captions extend the registered timeline, never add a second one');
  // render advances the timeline monotonically — tweens overlapping on one property
  // clobber each other, so the rise must be clamped to the word window
  assert.match(html, /Math\.min\(0\.12, Math\.max\(w\.end - w\.start, 0\)\)/);
  // Composer-fed baseline (first Composer run): per-word scrim pill keeps contrast
  // over bright footage, highlights revert to the scrim (never to bare footage),
  // and the cue row is border-box so its side padding doesn't shove it off-center
  assert.match(html, /\.cap-cue \{[^}]*box-sizing: border-box/);
  assert.match(html, /\.cap-word \{[^}]*background-color: rgba\(8, 8, 10, 0\.72\)/);
  assert.match(html, /backgroundColor: "rgba\(8,8,10,0\.72\)", scale: 1, duration: 0\.06/);
});

test('scaffoldComposition: no cues, no caption block — timeline stays the empty mount point', () => {
  const html = scaffoldComposition(clip(), { source: 'assets/source.mp4' });
  assert.ok(!html.includes('-captions'));
  assert.ok(!html.includes('cap-cue'));
  assert.ok(!html.includes('tl.set'));
});

test('scaffoldComposition: shot crops are static px placement, no animation', () => {
  const html = scaffoldComposition(reframedClip(), { source: 'assets/clip30.mp4', mediaOffset: 95 });
  // solo pane: cropPx(0.2, 0.4, zoom 1) on 1080x1920 → sheet 3413x1920 at (-143, 0)
  assert.match(html, /id="c1-s0"[^>]*width:3413px;height:1920px;left:-143px;top:0px/s);
  // split panes clip to halves: top pane at 0, bottom pane at 960
  assert.match(html, /top:0;width:1080px;height:960px[^>]*>\s*<video id="c1-s1a"/s);
  assert.match(html, /top:960px;width:1080px;height:960px[^>]*>\s*<video id="c1-s1b"/s);
  // no gsap tween on shots — the timeline stays the Composer's empty mount point
  assert.ok(!html.includes('tl.set'), 'no timeline sets for reframe');
});

// switch-lab — semi/fully-automatic switch debugger:
// for EVERY shot switch pull frames f0-2..f0+2 from the rendered draft, compute
// HISTOGRAM DISTANCES between them, and classify the seam by its signature:
//   clean cut      d(-1,0) is the single big change
//   ghost/alien    d(-1,0) AND d(0,+1) both big  (frame 0 belongs to neither side)
//   displaced      the big change lands at d(-2,-1) or d(+1,+2), not on the seam
//   soft/jump-cut  d(-1,0) moderate — same scene re-cropped (reframe jump feel)
//   dead           no change anywhere near the seam (switch didn't happen)
// Fully automatic: JSON + exit code. Semi-automatic: a labeled contact sheet per
// switch under <rundir>/debug/switch-lab/<clip>/ for human eyeballing.
//   node scripts/switch-lab.mjs [<rundir>] [--clip c1] [--sheets all|flagged|none]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1]; };
if (!argv[0] || argv[0].startsWith('--')) {
  console.error('usage: node scripts/switch-lab.mjs <rundir> [--clip c1] [--sheets all|flagged|none]');
  process.exit(2);
}
const rundir = resolve(argv[0]);
const only = flag('clip');
const sheets = flag('sheets') ?? 'flagged';
const plan = JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8'));

const W = 48, H = 27, BYTES = W * H * 3;
// 8x8x8 joint RGB histogram, L1-normalized; distance = chi-square
const hist = (buf) => {
  const h = new Float64Array(512);
  for (let i = 0; i < BYTES; i += 3) h[((buf[i] >> 5) << 6) | ((buf[i + 1] >> 5) << 3) | (buf[i + 2] >> 5)] += 1;
  const n = BYTES / 3;
  for (let i = 0; i < 512; i++) h[i] /= n;
  return h;
};
const chi2 = (a, b) => {
  let d = 0;
  for (let i = 0; i < 512; i++) { const s = a[i] + b[i]; if (s > 0) d += ((a[i] - b[i]) ** 2) / s; }
  return Math.round(d * 1000) / 1000; // 0 = identical, ~2 = disjoint
};

// thresholds calibrated on real drafts: consecutive same-shot frames ~<0.05,
// true scene cuts ~>0.5; between = "moderate" (same scene, different crop/motion)
const CUT = 0.5, SAME = 0.12;

const results = {};
let flagged = 0;
for (const clip of plan.clips ?? []) {
  if (only && clip.id !== only) continue;
  if (!clip.reframe?.shots || !['proposed', 'approved'].includes(clip.status)) continue;
  const draft = join(rundir, 'compose', clip.id, `${clip.id}-draft.mp4`);
  const outDir = join(rundir, 'debug', 'switch-lab', clip.id);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // persons on each side of every seam: a moderate histogram change between
  // DIFFERENT people is an expected cross-cut (same room, similar palette), not a
  // jump-cut — SOFT is reserved for a same-person crop jolt (measured c2 f747 class)
  const shotsArr = clip.reframe.shots;
  const seamPersons = new Map(shotsArr.slice(1).map((s, i) => [s.f0, {
    prev: shotsArr[i].panes.map((p) => p.person).join(','),
    next: s.panes.map((p) => p.person).join(','),
  }]));
  const switches = shotsArr.slice(1).map((s) => s.f0);
  const rows = [];
  const lastF1 = clip.reframe.shots.at(-1).f1;
  for (const f0 of switches) {
    // clamp the window inside the rendered clip (a 1-frame final shot pushes past EOF)
    const a = Math.max(0, Math.min(f0 - 2, lastF1 - 5)), b = a + 4;
    // one decode pass: 5 tiny raw frames for math + 5 PNGs for the human
    const raw = execFileSync('ffmpeg', ['-nostdin', '-v', 'error',
      '-i', draft, '-vf', `select='between(n,${a},${b})',scale=${W}:${H}`,
      '-vsync', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { maxBuffer: 1 << 24 });
    if (raw.length < 5 * BYTES) { rows.push({ f0, error: 'short read' }); continue; }
    const hs = [0, 1, 2, 3, 4].map((i) => hist(raw.subarray(i * BYTES, (i + 1) * BYTES)));
    const d = [chi2(hs[0], hs[1]), chi2(hs[1], hs[2]), chi2(hs[2], hs[3]), chi2(hs[3], hs[4])];
    const straddle = chi2(hs[1], hs[3]); // -1 vs +1: is there a real scene change at all?
    let verdict;
    if (d[1] >= CUT && d[2] >= CUT) verdict = 'GHOST';           // frame 0 alien to both sides
    else if (d[1] >= CUT) verdict = 'clean';
    else if (d[0] >= CUT || d[2] >= CUT || d[3] >= CUT) verdict = 'DISPLACED';
    else if ((d[1] >= SAME || straddle >= SAME)
      && seamPersons.get(f0)?.prev !== seamPersons.get(f0)?.next) verdict = 'clean'; // cross-cut between different people
    else if (d[1] >= SAME || straddle >= SAME) verdict = 'SOFT'; // same person re-cropped — the jump-cut feel
    else verdict = 'DEAD';
    const bad = verdict !== 'clean';
    if (bad) flagged += 1;
    rows.push({ f0, t: Math.round((f0 / 30) * 100) / 100, d, straddle, verdict });
    if (sheets === 'all' || (sheets === 'flagged' && bad)) {
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y',
        '-i', draft, '-vf', `select='between(n,${a},${b})',scale=270:480`,
        '-vsync', 'passthrough', join(outDir, `f${f0}_%d.png`)]);
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y',
        '-i', join(outDir, `f${f0}_%d.png`), '-filter_complex', 'tile=5x1',
        join(outDir, `f${f0}.png`)]);
      for (let i = 1; i <= 5; i++) rmSync(join(outDir, `f${f0}_${i}.png`), { force: true });
    }
  }
  results[clip.id] = rows;
  const badRows = rows.filter((r) => r.verdict !== 'clean');
  console.error(`${clip.id}: ${rows.length} switches — ${badRows.length ? badRows.map((r) => `f${r.f0}:${r.verdict}`).join(' ') : 'all clean'}`);
}
writeFileSync(join(rundir, 'debug', 'switch-lab', 'report.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify({ flagged, report: 'debug/switch-lab/report.json' }));
process.exit(flagged ? 1 : 0);

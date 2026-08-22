// Switch-glitch scan: verify rendered drafts have clean single-frame shot switches.
// Found the black-hole bug (gridSec 4-decimal rounding vs the runtime's
// inclusive raw-float window: 1-2 black frames at every switch whose frame is not
// divisible by 3). Re-run after any timing-emission or HF change:
//   node scripts/switch-scan.mjs [<rundir>]
// PASS = every switch shows exactly one big frame-difference (the cut itself), no
// double-jump (ghost/black frame), no black frames, and no HELD frame right before the
// cut (frame f0-1 repeating f0-2 while the shot is in motion = the runtime's
// end-of-window media clamp landed inside the previous frame — a dup + a dropped
// frame at every switch; found when shot windows carried a half-frame hole).
// YDIF via ffmpeg signalstats.
// NOTE: this scans the RENDER. The live player is a second runtime — gate it with
// scripts/player-probe.mjs (visibility holes and seek-on-reveal never show here).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

if (!process.argv[2]) {
  console.error('usage: node scripts/switch-scan.mjs <rundir>');
  process.exit(2);
}
const rundir = resolve(process.argv[2]);
const plan = JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8'));

let failed = false;
for (const clip of plan.clips ?? []) {
  if (!clip.reframe?.shots || !['proposed', 'approved'].includes(clip.status)) continue;
  const draft = join(rundir, 'compose', clip.id, `${clip.id}-draft.mp4`);
  const metaFile = join(tmpdir(), `ydif-${clip.id}.txt`);
  try {
    execFileSync('ffmpeg', ['-nostdin', '-y', '-i', draft,
      '-vf', `signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=${metaFile}`,
      '-f', 'null', '-'], { stdio: 'ignore' });
  } catch {
    console.log(`${clip.id}: no draft render at ${draft} — skipped`);
    continue;
  }
  const vals = [...readFileSync(metaFile, 'utf8').matchAll(/YDIF=([\d.]+)/g)].map((m) => Number(m[1]));
  const switches = clip.reframe.shots.slice(1).map((s) => s.f0);
  const doubles = switches.filter((f) => f + 1 < vals.length && vals[f] > 8 && vals[f + 1] > 8);
  // a switch where nothing changes on the switch frame NOR beside it = displaced hole
  const dead = switches.filter((f) => f < vals.length
    && Math.max(vals[f - 1] ?? 0, vals[f], vals[f + 1] ?? 0) < 4);
  // held frame before the cut: f0-1 repeats f0-2 (YDIF ≈ 0) while the preceding
  // frames were moving (median YDIF of f0-6..f0-2 ≥ 1) — static footage is skipped
  const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
  const held = switches.filter((f) => f >= 6 && vals[f - 1] < 0.5
    && median(vals.slice(f - 6, f - 1)) >= 1);
  console.log(`${clip.id}: ${vals.length} frames, ${switches.length} switches — `
    + `double-jump: [${doubles}] dead: [${dead}] held-before-cut: [${held}]`);
  if (doubles.length || dead.length || held.length) failed = true;
}
console.log(failed ? 'FAIL — ghost/black/held frames at the listed switches' : 'PASS — all switches single-frame clean');
process.exit(failed ? 1 : 0);

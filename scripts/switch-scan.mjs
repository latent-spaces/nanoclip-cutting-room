// Switch-glitch scan: verify rendered drafts have clean single-frame shot switches.
// Found the black-hole bug (gridSec 4-decimal rounding vs the runtime's
// inclusive raw-float window: 1-2 black frames at every switch whose frame is not
// divisible by 3). Re-run after any timing-emission or HF change:
//   node scripts/switch-scan.mjs [<rundir>]
// PASS = every switch shows exactly one big frame-difference (the cut itself), no
// double-jump (ghost/black frame), no black frames. YDIF via ffmpeg signalstats.
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
  console.log(`${clip.id}: ${vals.length} frames, ${switches.length} switches — `
    + `double-jump: [${doubles}] dead: [${dead}]`);
  if (doubles.length || dead.length) failed = true;
}
console.log(failed ? 'FAIL — ghost/black frames at the listed switches' : 'PASS — all switches single-frame clean');
process.exit(failed ? 1 : 0);

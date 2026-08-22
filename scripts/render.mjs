// render.mjs — check-gated local render + plan stamping for the SHIP stage.
// Per proposed/approved scaffolded clip: `npx hyperframes check` gates (compose.md law),
// `npx hyperframes render --fps 30` produces <id>-draft.mp4 (draft) or <id>-final.mp4
// (high, delivery), the output is ffprobe-verified against the plan's frame count on
// the 30fps grid, and plan.clips[].render is stamped. Draft for iteration, high for
// delivery; failures leave the stamp untouched and exit 1.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exact2 } from './grid.mjs';

export const RENDER_FPS = 30;
// Product decision: pin the toolchain — npx floats broke reproducibility
// (0.8.3->0.8.4 changed lint + render behavior mid-project). Upgrades are deliberate:
// bump this constant, re-run the spikes + scripts/switch-scan.mjs (reframe.md).
export const HYPERFRAMES_PKG = 'hyperframes@0.8.4';
export const outputName = (id, quality) => `${id}-${quality === 'high' ? 'final' : 'draft'}.mp4`;


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const dir = flag('dir');
  const quality = flag('quality') ?? 'draft';
  if (!dir || !['draft', 'high'].includes(quality)) {
    console.error('usage: render.mjs --dir <workdir>/cutting-room [--clip <id>] [--quality draft|high]');
    process.exit(2);
  }
  const planPath = join(dir, 'plan.json');
  if (!existsSync(planPath)) {
    console.error(`no plan.json in ${dir}`);
    process.exit(1);
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const only = flag('clip');
  const rendered = {};
  for (const clip of plan.clips ?? []) {
    if (only && clip.id !== only) continue;
    if (!['proposed', 'approved'].includes(clip.status)) {
      console.error(`${clip.id}: skipped — status ${clip.status}`);
      continue;
    }
    // Any stamped composition renders ('scaffolded', or whatever a Composer wrote
    // after restyling) — only a clip with no composition project is skipped, aloud.
    const projectDir = join(dir, 'compose', clip.id);
    if (!clip.composition?.status || clip.composition.status === 'none') {
      console.error(`${clip.id}: skipped — no composition (scaffold it first)`);
      continue;
    }

    // the gate: check must pass before any render (compose.md §4)
    const check = spawnSync('npx', [HYPERFRAMES_PKG, 'check'], { cwd: projectDir, encoding: 'utf8' });
    if (check.status !== 0) {
      console.error(`${clip.id}: hyperframes check failed — fix the composition first`);
      console.error((check.stdout + check.stderr).split('\n').slice(-12).join('\n'));
      process.exit(1);
    }

    const out = outputName(clip.id, quality);
    const render = spawnSync('npx', [
      HYPERFRAMES_PKG, 'render', '--quality', quality, '--fps', String(RENDER_FPS), '--output', out,
    ], { cwd: projectDir, encoding: 'utf8' });
    const outPath = join(projectDir, out);
    if (render.status !== 0 || !existsSync(outPath)) {
      console.error(`${clip.id}: render failed`);
      console.error((render.stdout + render.stderr).split('\n').slice(-12).join('\n'));
      process.exit(1);
    }

    // verify against the plan on the 30fps grid: right file, right length, probes
    // clean. The renderer COVERS the full duration — frame count is ceil(total x fps)
    // (measured: 48.34s -> 1451 frames, not round()'s 1450); epsilon strips float
    // noise so exact multiples never ceil one frame up.
    const total = exact2(clip.segments.reduce((s, g) => s + (g.src_out - g.src_in), 0));
    const wantFrames = Math.ceil(total * RENDER_FPS - 1e-6);
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=nb_read_frames,r_frame_rate', '-of', 'json', outPath,
    ], { encoding: 'utf8' });
    const stream = probe.status === 0 ? JSON.parse(probe.stdout).streams?.[0] : null;
    const gotFrames = Number(stream?.nb_read_frames);
    if (!stream || gotFrames !== wantFrames) {
      console.error(`${clip.id}: rendered frames ${gotFrames || 'unreadable'} != plan's ${wantFrames} (${total}s @ ${RENDER_FPS}fps) — not stamping`);
      process.exit(1);
    }

    clip.render = {
      status: 'rendered',
      quality,
      path: `compose/${clip.id}/${out}`,
      fps: RENDER_FPS,
      frames: wantFrames,
      seconds: total,
      bytes: statSync(outPath).size,
      rendered_at: new Date().toISOString(),
    };
    rendered[clip.id] = { path: clip.render.path, frames: wantFrames, bytes: clip.render.bytes };
    console.error(`${clip.id}: rendered ${out} (${wantFrames} frames, ${(clip.render.bytes / 1e6).toFixed(1)}MB)`);
  }
  if (Object.keys(rendered).length === 0) {
    console.error('nothing rendered — no proposed/approved clip with a composition matched');
    process.exit(1);
  }
  writeFileSync(planPath + '.tmp', JSON.stringify(plan, null, 2) + '\n');
  renameSync(planPath + '.tmp', planPath);
  console.log(JSON.stringify({ quality, rendered }));
  process.exit(0);
}

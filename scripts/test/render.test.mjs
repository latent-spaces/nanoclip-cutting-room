import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputName } from '../render.mjs';

const RENDER_CLI = fileURLToPath(new URL('../render.mjs', import.meta.url));

// Fake `npx` on PATH: `hyperframes check` honors FAKE_CHECK_EXIT, `hyperframes render`
// writes a real 30fps mp4 (ffmpeg) of FAKE_RENDER_SECONDS at --output. render.mjs
// itself is what's under test: gate order, ffprobe verification, plan stamping.
const makeFakeBin = (dir) => {
  const bin = join(dir, 'fakebin');
  mkdirSync(bin, { recursive: true });
  const npx = join(bin, 'npx');
  writeFileSync(npx, `#!/bin/sh
echo "npx $@" >> "$FAKE_LOG"
if [ "$2" = "check" ]; then exit "\${FAKE_CHECK_EXIT:-0}"; fi
if [ "$2" = "render" ]; then
  out=""
  while [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then out="$2"; fi; shift; done
  ffmpeg -y -loglevel error -f lavfi -i "color=red:d=\${FAKE_RENDER_SECONDS:-5}:s=108x192:r=30" \
    -c:v libx264 -preset ultrafast "$out"
  exit $?
fi
exit 1
`);
  chmodSync(npx, 0o755);
  return bin;
};

const seedRundir = (prefix) => {
  const workdir = mkdtempSync(join(tmpdir(), prefix));
  const rundir = join(workdir, 'cutting-room');
  for (const id of ['c1', 'c2', 'c3']) mkdirSync(join(rundir, 'compose', id), { recursive: true });
  writeFileSync(join(rundir, 'plan.json'), JSON.stringify({
    schema: 'cutting-room/plan@2',
    source: { path: 'clip.mp4', duration_s: 600, project_id: 'p' },
    clips: [
      { id: 'c1', title: 'One', hook: '"h1"', status: 'proposed', segments: [{ src_in: 10, src_out: 15 }], composition: { status: 'scaffolded', path: 'compose/c1' }, render: { status: 'none', path: null } },
      { id: 'c2', title: 'Two', hook: '"h2"', status: 'rejected', segments: [{ src_in: 20, src_out: 25 }], composition: { status: 'scaffolded', path: 'compose/c2' }, render: { status: 'none', path: null } },
      { id: 'c3', title: 'Three', hook: '"h3"', status: 'proposed', segments: [{ src_in: 30, src_out: 35 }], composition: { status: 'none', path: null }, render: { status: 'none', path: null } },
    ],
  }, null, 2));
  return rundir;
};

const runCli = (rundir, args, env = {}) => {
  const fakeLog = join(rundir, 'fake.log');
  writeFileSync(fakeLog, '');
  const res = spawnSync('node', [RENDER_CLI, '--dir', rundir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: makeFakeBin(rundir) + delimiter + process.env.PATH, FAKE_LOG: fakeLog, ...env },
  });
  return { ...res, log: readFileSync(fakeLog, 'utf8') };
};

test('outputName: draft and delivery names', () => {
  assert.equal(outputName('c1', 'draft'), 'c1-draft.mp4');
  assert.equal(outputName('c1', 'high'), 'c1-final.mp4');
});

test('CLI: check gates the render, output is probed, plan is stamped', () => {
  const rundir = seedRundir('cr-render-');
  const res = runCli(rundir, []);
  assert.equal(res.status, 0, res.stderr);
  // check ran before render, per clip, only for proposed+scaffolded (c1)
  // product decision: every programmatic invocation pins hyperframes@0.8.4
  assert.match(res.log, /npx hyperframes@0\.8\.4 check[\s\S]*npx hyperframes@0\.8\.4 render/);
  assert.ok(!res.log.includes('compose/c2'), 'rejected clip untouched');
  const out = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(out.rendered), ['c1']);
  const plan = JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8'));
  const r = plan.clips[0].render;
  assert.equal(r.status, 'rendered');
  assert.equal(r.quality, 'draft');
  assert.equal(r.path, 'compose/c1/c1-draft.mp4');
  assert.equal(r.fps, 30);
  assert.equal(r.frames, 150); // 5s × 30, verified against the probed file
  assert.ok(r.bytes > 0);
  assert.ok(r.rendered_at);
  assert.equal(plan.clips[1].render.status, 'none', 'rejected clip not stamped');
  assert.equal(plan.clips[2].render.status, 'none', 'unscaffolded clip not stamped');
});

test('CLI: --quality high renders the delivery name, --clip filters', () => {
  const rundir = seedRundir('cr-render-hi-');
  const res = runCli(rundir, ['--quality', 'high', '--clip', 'c1']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.log, /--quality high/);
  const r = JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8')).clips[0].render;
  assert.equal(r.quality, 'high');
  assert.equal(r.path, 'compose/c1/c1-final.mp4');
});

test('CLI: a failing check blocks the render and the stamp', () => {
  const rundir = seedRundir('cr-render-gate-');
  const res = runCli(rundir, [], { FAKE_CHECK_EXIT: '1' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /check failed/i);
  assert.ok(!/hyperframes@0\.8\.4 render/.test(res.log), 'render never ran');
  assert.equal(JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8')).clips[0].render.status, 'none');
});

test('CLI: fractional-frame durations verify against the renderer\'s CEIL law', () => {
  // 5.07s x 30 = 152.1 -> the renderer covers the full duration with 153 frames
  // (measured on c3 48.34s -> 1451, not round()'s 1450); integer durations unchanged
  const rundir = seedRundir('cr-render-frac-');
  const plan = JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8'));
  plan.clips[0].segments = [{ src_in: 10, src_out: 15.07 }];
  writeFileSync(join(rundir, 'plan.json'), JSON.stringify(plan, null, 2));
  const res = runCli(rundir, ['--clip', 'c1'], { FAKE_RENDER_SECONDS: '5.1' }); // 153 frames
  assert.equal(res.status, 0, res.stderr);
  const r = JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8')).clips[0].render;
  assert.equal(r.frames, 153);
  assert.equal(r.seconds, 5.07);
});

test('CLI: a rendered file that does not match the plan duration fails verification', () => {
  const rundir = seedRundir('cr-render-len-');
  const res = runCli(rundir, [], { FAKE_RENDER_SECONDS: '3' }); // plan says 5s
  assert.equal(res.status, 1);
  assert.match(res.stderr, /frames/i);
  assert.equal(JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8')).clips[0].render.status, 'none');
});

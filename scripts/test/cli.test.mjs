import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFS_CLI = fileURLToPath(new URL('../prefs.mjs', import.meta.url));
const MEZZ_CLI = fileURLToPath(new URL('../mezzanine.mjs', import.meta.url));

const run = (cli, args, opts = {}) =>
  execFileSync('node', [cli, ...args], { encoding: 'utf8', ...opts });

const tmpPrefs = () => join(mkdtempSync(join(tmpdir(), 'cr-cli-')), 'prefs.json');

const makeClip = (dir) => {
  const out = join(dir, 'clip.mp4');
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', out,
  ], { stdio: 'pipe' });
  return out;
};

// A recorded real quote (nanoclip quote on a 10-minute 1080p source).
const QUOTE_JSON = '{"line_items":{"vision":55,"transcript":2,"diarization":1},"total_cents":58,'
  + '"total_usd":"0.58","duration_s":600.066133,"basis":"local_probe","estimate":true}';

test('prefs CLI: get prints defaults as JSON', () => {
  const out = JSON.parse(run(PREFS_CLI, ['get', '--file', tmpPrefs()]));
  assert.equal(out.schema, 'cutting-room/prefs@1');
});

test('prefs CLI: set language then get round-trips', () => {
  const f = tmpPrefs();
  run(PREFS_CLI, ['set', 'language', 'he', '--file', f]);
  assert.equal(JSON.parse(run(PREFS_CLI, ['get', '--file', f])).language, 'he');
});

test('prefs CLI: unknown command exits 2 with usage', () => {
  const r = spawnSync('node', [PREFS_CLI, 'frobnicate'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test('mezzanine CLI: split takes the quote JSON as an argument', () => {
  const out = JSON.parse(run(MEZZ_CLI, ['split', QUOTE_JSON]));
  assert.equal(out.transcript_approve_usd, '0.03');
  assert.equal(out.vision_approve_usd, '0.55');
  assert.equal(out.total_usd, '0.58');
});

test('mezzanine CLI: split reads dual-format CLI output from stdin', () => {
  const dual = QUOTE_JSON + '\nquote estimate: $0.58 for ~600.066133s (local probe)\n';
  const out = JSON.parse(run(MEZZ_CLI, ['split'], { input: dual }));
  assert.equal(out.total_usd, '0.58');
  assert.equal(out.diarize, true);
});

test('mezzanine CLI: probe on a file prints its stats', () => {
  const clip = makeClip(mkdtempSync(join(tmpdir(), 'cr-cli-probe-')));
  const out = JSON.parse(run(MEZZ_CLI, ['probe', clip]));
  assert.equal(out.width, 320);
  assert.equal(out.vcodec, 'h264');
});

test('mezzanine CLI: probe on a directory prints candidates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-cli-cand-'));
  makeClip(dir);
  const out = JSON.parse(run(MEZZ_CLI, ['probe', dir]));
  assert.equal(out.length, 1);
  assert.match(out[0].path, /clip\.mp4$/);
});

test('mezzanine CLI: decide reads prefs and prints the decision', () => {
  const clip = makeClip(mkdtempSync(join(tmpdir(), 'cr-cli-dec-')));
  const out = JSON.parse(run(MEZZ_CLI, ['decide', clip, '--prefs', tmpPrefs()]));
  assert.equal(out.decision, 'upload_original');
  assert.equal(out.basis, 'short_circuit');
  assert.ok(out.stats.duration_s > 0, 'decision carries the probed stats');
});

test('mezzanine CLI: unknown command exits 2 with usage', () => {
  const r = spawnSync('node', [MEZZ_CLI, 'frobnicate'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

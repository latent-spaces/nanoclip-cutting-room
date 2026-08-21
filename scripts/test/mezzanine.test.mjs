import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decide, ffmpegArgs, splitQuote, centsToUsd, parseUploadOutput,
  probeFile, listCandidates, transcodeFile,
  EST_MEZZ_BPS, PRIOR_UPLOAD_BPS, PRIOR_TRANSCODE_X,
} from '../mezzanine.mjs';
import { loadPrefs } from '../prefs.mjs';

// A real local source for probe tests: set CUTTING_ROOM_PLAYGROUND_SRC to any
// long recording to run them — they skip when it is unset.
const REAL_VIDEO = process.env.CUTTING_ROOM_PLAYGROUND_SRC ?? '';

const near = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} !~ ${expected}`);

// ---- decide: the upload-vs-transcode arithmetic ----

const MEASURED = { upload_Bps: 10_066_330, transcode_x: 8 };

test('decide: 1080p at mezzanine-grade bitrate short-circuits to upload_original', () => {
  const stats = { bytes: 201_326_592, duration_s: 600.066, width: 1920, height: 1080 };
  const d = decide(stats, MEASURED);
  assert.equal(d.decision, 'upload_original');
  assert.equal(d.basis, 'short_circuit');
  assert.equal(d.arithmetic, null);
});

test('decide: 4K original transcodes when the arithmetic clearly wins', () => {
  const stats = { bytes: 6_871_947_674, duration_s: 2536, width: 3840, height: 2160 };
  const d = decide(stats, MEASURED);
  assert.equal(d.decision, 'transcode_1080p');
  assert.equal(d.basis, 'measured');
  near(d.arithmetic.t_upload_original_s, 682.7, 0.5, 't_upload_original_s');
  near(d.arithmetic.t_transcode_s, 317, 0.01, 't_transcode_s');
  assert.equal(d.arithmetic.est_mezzanine_bytes, 1_268_000_000);
  near(d.arithmetic.t_upload_mezzanine_s, 126.0, 0.5, 't_upload_mezzanine_s');
});

test('decide: transcode inside the 20% margin stays upload_original', () => {
  const stats = { bytes: 1_500_000_000, duration_s: 600, width: 2560, height: 1440 };
  const d = decide(stats, { upload_Bps: 10_000_000, transcode_x: 6 });
  // t_orig=150s vs transcode 100s + upload 30s = 130s — faster, but not by 20%
  assert.equal(d.decision, 'upload_original');
  assert.equal(d.basis, 'measured');
  assert.match(d.reason, /margin/);
});

test('decide: missing speeds fall back to declared priors', () => {
  const stats = { bytes: 6_871_947_674, duration_s: 2536, width: 3840, height: 2160 };
  const d = decide(stats, { upload_Bps: null, transcode_x: null });
  assert.equal(d.basis, 'priors');
  assert.equal(d.decision, 'transcode_1080p');
  assert.equal(d.speeds_used.upload_Bps, PRIOR_UPLOAD_BPS);
  assert.equal(d.speeds_used.transcode_x, PRIOR_TRANSCODE_X);
});

test('decide: one missing speed still means priors basis', () => {
  const stats = { bytes: 6_871_947_674, duration_s: 2536, width: 3840, height: 2160 };
  const d = decide(stats, { upload_Bps: 10_066_330, transcode_x: null });
  assert.equal(d.basis, 'priors');
});

// ---- ffmpegArgs: the mezzanine encode contract ----

test('ffmpegArgs: default 1080p fast preset with downscale', () => {
  assert.deepEqual(ffmpegArgs({ input: 'in.mov', output: 'out.mp4', sourceHeight: 2160 }), [
    '-y', '-i', 'in.mov',
    '-vf', 'scale=-2:1080',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    'out.mp4',
  ]);
});

test('ffmpegArgs: economy mode is 720p', () => {
  const args = ffmpegArgs({ input: 'in.mov', output: 'out.mp4', sourceHeight: 2160, economy: true });
  assert.ok(args.includes('scale=-2:720'));
  assert.ok(args.includes('25'), 'economy uses crf 25');
});

test('ffmpegArgs: never upscales — fat-bitrate 1080p source keeps its size', () => {
  const args = ffmpegArgs({ input: 'in.mp4', output: 'out.mp4', sourceHeight: 1080 });
  assert.ok(!args.includes('-vf'), 'no scale filter when source height <= target');
});

// ---- splitQuote: exact --approve arithmetic ----

test('splitQuote: recorded real quote splits into per-command approvals', () => {
  const s = splitQuote({ line_items: { vision: 55, transcript: 2, diarization: 1 }, total_cents: 58 });
  assert.equal(s.diarize, true);
  assert.equal(s.transcript_approve_usd, '0.03');
  assert.equal(s.vision_approve_usd, '0.55');
  assert.equal(s.total_usd, '0.58');
});

test('splitQuote: without diarization the transcript approval is transcript alone', () => {
  const s = splitQuote({ line_items: { vision: 55, transcript: 2 }, total_cents: 57 });
  assert.equal(s.diarize, false);
  assert.equal(s.transcript_approve_usd, '0.02');
});

test('splitQuote: refuses a quote whose line items do not sum to the total', () => {
  assert.throws(
    () => splitQuote({ line_items: { vision: 55, transcript: 2, diarization: 1 }, total_cents: 59 }),
    /mismatch/,
  );
});

test('splitQuote: refuses a quote missing a required line item', () => {
  assert.throws(() => splitQuote({ line_items: { vision: 55 }, total_cents: 55 }), /transcript/);
});

test('centsToUsd renders exact two-decimal strings', () => {
  assert.equal(centsToUsd(5), '0.05');
  assert.equal(centsToUsd(58), '0.58');
  assert.equal(centsToUsd(220), '2.20');
  assert.equal(centsToUsd(100), '1.00');
});

// ---- parseUploadOutput: project id from the CLI's dual-format output ----

test('parseUploadOutput: prefers the JSON line', () => {
  const id = '2026-01-05_072407Z_api_h264-aac-1080p-10min-mp4_0044';
  const out = JSON.stringify({ project_id: id, bytes: 201326592 })
    + `\nuploaded 192 MB · project ${id}\n`;
  assert.deepEqual(parseUploadOutput(out), { project_id: id, bytes: 201326592 });
});

test('parseUploadOutput: falls back to the id pattern in human output', () => {
  const id = '2026-01-05_072407Z_api_h264-aac-1080p-10min-mp4_0044';
  const p = parseUploadOutput(`created project ${id} (192 MB)`);
  assert.equal(p.project_id, id);
  assert.equal(p.bytes, null);
});

test('parseUploadOutput: returns null when no project id is present', () => {
  assert.equal(parseUploadOutput('something went wrong\n'), null);
});

// ---- probe & candidates — real ffprobe, tiny generated fixtures ----

const makeClip = (dir, name, mtimeSecondsAgo) => {
  const out = join(dir, name);
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', out,
  ], { stdio: 'pipe' });
  const t = (Date.now() - mtimeSecondsAgo * 1000) / 1000;
  utimesSync(out, t, t);
  return out;
};

test('listCandidates: finds videos, newest first, with probe metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-cand-'));
  makeClip(dir, 'older.mp4', 3600);
  makeClip(dir, 'newer.mp4', 60);
  const c = await listCandidates(dir);
  assert.equal(c.length, 2);
  assert.match(c[0].path, /newer\.mp4$/);
  assert.match(c[1].path, /older\.mp4$/);
  assert.equal(c[0].width, 320);
  assert.equal(c[0].height, 240);
  near(c[0].duration_s, 1, 0.2, 'duration_s');
  assert.ok(c[0].bytes > 0);
  assert.equal(c[0].vcodec, 'h264');
});

test('probeFile: reads the recorded real source', { skip: !existsSync(REAL_VIDEO) }, async () => {
  const s = await probeFile(REAL_VIDEO);
  assert.equal(s.width, 1920);
  assert.equal(s.height, 1080);
  near(s.duration_s, 600.066, 0.01, 'duration_s');
  assert.equal(s.bytes, statSync(REAL_VIDEO).size);
  assert.equal(s.vcodec, 'h264');
  assert.equal(s.acodec, 'aac');
});

test('decide on the real source: upload the original (already mezzanine-grade)',
  { skip: !existsSync(REAL_VIDEO) }, async () => {
    const d = decide(await probeFile(REAL_VIDEO), MEASURED);
    assert.equal(d.decision, 'upload_original');
    assert.equal(d.basis, 'short_circuit');
  });

// ---- transcodeFile: runs ffmpeg, measures, records the speed ----

test('transcodeFile: produces the mezzanine and records transcode speed in prefs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-tc-'));
  const input = makeClip(dir, 'src.mp4', 60);
  const output = join(dir, 'mezzanine.mp4');
  const prefsPath = join(dir, 'prefs.json');
  const r = await transcodeFile(input, output, { prefsPath });
  assert.ok(existsSync(output));
  assert.ok(r.seconds > 0);
  assert.equal(r.bytes, statSync(output).size);
  const p = loadPrefs(prefsPath);
  assert.ok(p.speeds.transcode_x > 0, 'transcode_x recorded');
});

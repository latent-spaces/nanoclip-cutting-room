import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractTranscriptSummary, extractVisionSummary, extractVisionStrip, initState, watchAnalyses,
  pickAsdMoment, pickFaceCropSpecs,
} from '../watcher.mjs';

const FIXTURES = fileURLToPath(new URL('../../fixtures', import.meta.url));

// ---- extractors: real recorded payloads are the contract ----

test('extractTranscriptSummary reads the recorded payload', () => {
  const payload = JSON.parse(readFileSync(join(FIXTURES, 'transcript_v2.json'), 'utf8'));
  const s = extractTranscriptSummary(payload, { duration_s: 600.066 });
  assert.equal(s.speakers, 6);
  assert.equal(s.utterances, 151);
  assert.equal(s.words, 1210);
  assert.equal(s.words_head.length, 12);
  assert.equal(s.words_head[0], 'I');
  assert.equal(s.word_ticks.length, 48);
  assert.equal(Math.max(...s.word_ticks), 1);
  assert.ok(s.word_ticks.every((v) => v >= 0 && v <= 1));
});

test('extractVisionStrip picks evenly spaced real frames with their face boxes', () => {
  const payload = JSON.parse(readFileSync(join(FIXTURES, 'vision_v2.json'), 'utf8'));
  const strip = extractVisionStrip(payload, { duration_s: 600.066 });
  assert.equal(strip.length, 6);
  for (const f of strip) {
    assert.ok(f.t > 0 && f.t < 600.066);
    assert.ok(Array.isArray(f.boxes));
    // [x0, y0, x1, y1] plus an optional trailing cluster id — additive, so
    // existing 4-tuple destructuring keeps working.
    for (const b of f.boxes) {
      assert.ok(b.length === 4 || b.length === 5);
      if (b.length === 5) assert.ok(Number.isInteger(b[4]));
    }
  }
  assert.ok(strip.some((f) => f.boxes.length > 0), 'this footage has faces on screen');
  assert.ok(strip.some((f) => f.boxes.some((b) => b.length === 5)), 'clustered faces carry their cluster id');
});

test('extractVisionSummary reads the recorded payload', () => {
  const payload = JSON.parse(readFileSync(join(FIXTURES, 'vision_v2.json'), 'utf8'));
  const s = extractVisionSummary(payload, { duration_s: 600.066 });
  assert.equal(s.scene_cuts, 252);
  assert.equal(s.asd_ran, true);
  assert.equal(s.face_clusters, 24);
  assert.equal(s.scene_ticks.length, 48);
  assert.ok(s.scene_ticks.every((v) => v >= 0 && v <= 1));
  assert.equal(Math.max(...s.scene_ticks), 1);
});

test('speaker_rows: real diarization rows, longest talker first, shares of talk time', () => {
  const payload = JSON.parse(readFileSync(join(FIXTURES, 'transcript_v2.json'), 'utf8'));
  const rows = extractTranscriptSummary(payload, { duration_s: 600.066 }).speaker_rows;
  assert.equal(rows.length, 6);
  assert.equal(rows[0].speaker, 0); // the host talks most in the demo footage
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].seconds >= rows[i].seconds);
  const shares = rows.reduce((s, r) => s + r.share, 0);
  assert.ok(Math.abs(shares - 1) < 0.05, `shares sum to ~1, got ${shares}`);
});

test('pickAsdMoment finds the detection the model is most sure is speaking', () => {
  const payload = JSON.parse(readFileSync(join(FIXTURES, 'vision_v2.json'), 'utf8'));
  const m = pickAsdMoment(payload);
  assert.ok(m.speak_conf > 0.9);
  assert.equal(m.box.length, 4);
  assert.ok(m.t > 0 && m.t < 600.066);
  // tolerates detections with no speak_conf at all
  assert.equal(pickAsdMoment({ faces: [{ t: 1, detections: [{ box: [0, 0, 1, 1], score: 0.9 }] }] }), null);
});

test('pickFaceCropSpecs samples the top clusters across their own time spans', () => {
  const payload = JSON.parse(readFileSync(join(FIXTURES, 'vision_v2.json'), 'utf8'));
  const rows = pickFaceCropSpecs(payload);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].cluster, 0); // cluster 0 is on screen most in the recorded run
  for (const { picks } of rows) {
    assert.ok(picks.length >= 1 && picks.length <= 4);
    for (let i = 1; i < picks.length; i++) assert.ok(picks[i].t > picks[i - 1].t, 'picks read left-to-right in time');
    for (const p of picks) assert.equal(p.box.length, 4);
  }
});

// ---- state init from plan ----

const PLAN = {
  schema: 'cutting-room/plan@2',
  source: {
    path: 'h264_aac_1080p_10min.mp4', duration_s: 600.066, width: 1920, height: 1080,
    mezzanine_path: null, project_id: 'proj_x',
  },
  analyses: {
    transcript: { status: 'running', path: null, cost_usd: '0.03' },
    vision: { status: 'running', path: null, cost_usd: '0.55' },
  },
};

test('initState seeds state@1 from plan.json', () => {
  const st = initState(PLAN);
  assert.equal(st.schema, 'cutting-room/state@1');
  assert.equal(st.project_id, 'proj_x');
  assert.equal(st.video.duration_s, 600.066);
  assert.equal(st.stages.upload.status, 'completed');
  assert.equal(st.stages.transcript.status, 'running');
  assert.ok(st.stages.transcript.expected_s > 0);
  assert.equal(st.stages.vision.status, 'running');
  assert.equal(st.stages.cast.status, 'waiting');
  assert.equal(st.stages.cut.status, 'waiting');
  assert.equal(st.stages.clips.status, 'waiting');
});

// ---- watchAnalyses: real spawn path against a fake nanoclip on PATH ----

const TINY_TRANSCRIPT = JSON.stringify({
  status: 'completed',
  words: [{ text: 'hey', start: 0, end: 0.2, speaker: 0 }, { text: 'there', start: 0.2, end: 0.4, speaker: 1 }],
  utterances: [{ speaker: 0, start: 0, end: 0.4, text: 'hey there' }],
  speakers: [{ speaker: 0 }, { speaker: 1 }],
});
const TINY_VISION = JSON.stringify({
  status: 'completed',
  faces: [
    { t: 0.2, detections: [{ box: [0.1, 0.1, 0.4, 0.5] }] },
    { t: 0.8, detections: [] },
  ],
  face_tracks: [{ cluster_id: 0, track_id: 0 }, { cluster_id: 1, track_id: 1 }],
  scenes: [{ after_frame: { timestamp: 1.0 } }, { after_frame: { timestamp: 2.0 } }],
  asd: { ran: true, reason: null },
});

// A fake `nanoclip` that mimics `nanoclip <analysis> get -p <id> --wait -o <file>`:
// short sleep, write the payload, JSON line on stdout. `vision` can be told to fail.
const makeFakeNanoclip = (dir, { failVision = false } = {}) => {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'transcript.json'), TINY_TRANSCRIPT);
  writeFileSync(join(binDir, 'vision.json'), TINY_VISION);
  const script = `#!/bin/sh
analysis="$1"
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ] || [ "$1" = "--output" ]; then out="$2"; shift; fi
  shift
done
sleep 0.15
if [ "$analysis" = "vision" ] && [ "${failVision ? 1 : 0}" = "1" ]; then
  echo "vision analysis failed: quota exhausted" >&2
  exit 3
fi
cp "${binDir}/$analysis.json" "$out"
echo "{\\"analysis\\":\\"$analysis\\",\\"status\\":\\"completed\\"}"
`;
  writeFileSync(join(binDir, 'nanoclip'), script);
  chmodSync(join(binDir, 'nanoclip'), 0o755);
  return binDir;
};

const makeSourceClip = (root) => {
  const out = join(root, 'src.mp4');
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', out,
  ], { stdio: 'pipe' });
  return out;
};

const setupRun = (opts) => {
  const root = mkdtempSync(join(tmpdir(), 'cr-watch-'));
  const dir = join(root, 'cutting-room');
  mkdirSync(dir, { recursive: true });
  makeSourceClip(root);
  const plan = { ...PLAN, source: { ...PLAN.source, path: 'src.mp4', duration_s: 1 } };
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
  const binDir = makeFakeNanoclip(root, opts);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  return { dir, env };
};

test('watchAnalyses: both analyses land, state and plan updated', async () => {
  const { dir, env } = setupRun({});
  const summary = await watchAnalyses({ dir, env });
  assert.equal(summary.failed, 0);
  const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(st.stages.transcript.status, 'completed');
  assert.equal(st.stages.vision.status, 'completed');
  assert.ok(st.stages.transcript.seconds > 0);
  assert.ok(st.stages.transcript.ended_at);
  assert.equal(st.artifacts.transcript.speakers, 2);
  assert.equal(st.artifacts.vision.scene_cuts, 2);
  assert.equal(st.facts.speakers, 2);
  assert.equal(st.facts.scene_cuts, 2);
  assert.equal(st.artifacts.vision.strip.length, 6);
  for (const f of st.artifacts.vision.strip) {
    assert.match(f.thumb, /^thumbs\/strip-\d\.jpg$/);
    assert.ok(existsSync(join(dir, f.thumb)), `${f.thumb} extracted`);
  }
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  assert.equal(plan.analyses.transcript.status, 'completed');
  assert.equal(plan.analyses.transcript.path, 'data/transcript.json');
  assert.ok(existsSync(join(dir, 'data', 'transcript.json')));
  assert.ok(existsSync(join(dir, 'data', 'vision.json')));
});

test('watchAnalyses: a failing analysis is recorded, the other still completes', async () => {
  const { dir, env } = setupRun({ failVision: true });
  const summary = await watchAnalyses({ dir, env });
  assert.equal(summary.failed, 1);
  const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(st.stages.transcript.status, 'completed');
  assert.equal(st.stages.vision.status, 'failed');
  assert.match(st.stages.vision.error, /quota exhausted/);
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  assert.equal(plan.analyses.vision.status, 'failed');
});

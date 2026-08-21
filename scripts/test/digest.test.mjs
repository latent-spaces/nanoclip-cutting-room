import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDigest, fuseCast, pickCastThumbSpecs, pickGapFrameSpecs, serializeDigest, shardDigest, shardRowBytes, snapClip, TIMELINE_COLUMNS,
} from '../digest.mjs';

const FIXTURES = fileURLToPath(new URL('../../fixtures', import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

// ---- hand-built payloads with hand-computed ground truth ----
// Two speakers, two face clusters. Speaker 0 talks [0,2], speaker 1 talks [2,4].
// Cluster 0 is on screen (and scored speaking) during speaker 0's turn; cluster 1
// during speaker 1's turn, with one low-conf cluster-0 detection as noise.

const transcript = () => ({
  speakers: [
    { speaker: 0, total_duration: 2, utterance_count: 1 },
    { speaker: 1, total_duration: 2, utterance_count: 1 },
  ],
  utterances: [
    { speaker: 0, start: 0, end: 2, text: 'hello there', word_start_idx: 0, word_end_idx: 2 },
    { speaker: 1, start: 2, end: 4, text: 'hi back', word_start_idx: 2, word_end_idx: 4 },
  ],
  words: [
    { text: 'hello', start: 0, end: 0.5, speaker: 0 }, { text: 'there', start: 0.6, end: 1.9, speaker: 0 },
    { text: 'hi', start: 2.1, end: 2.4, speaker: 1 }, { text: 'back', start: 2.5, end: 3.9, speaker: 1 },
  ],
});

const det = (cluster_id, extra = {}) => ({ box: [0, 0, 0.1, 0.1], cluster_id, score: 0.9, track_id: cluster_id, ...extra });

const visionAsd = () => ({
  asd: { ran: true, reason: null, assigned: 4, carried: 4 },
  faces: [
    { t: 0.5, detections: [det(0, { speak_conf: 0.9 })] },
    { t: 1.0, detections: [det(0, { speak_conf: 0.8 }), det(1)] },
    { t: 2.5, detections: [det(1, { speak_conf: 0.95 })] },
    { t: 3.5, detections: [det(1, { speak_conf: 0.9 }), det(0, { speak_conf: 0.1 })] },
  ],
  face_tracks: [
    { cluster_id: 0, track_id: 0, start_t: 0, end_t: 1.0, frame_count: 3, median_box_area: 0.01 },
    { cluster_id: 1, track_id: 1, start_t: 1.0, end_t: 3.5, frame_count: 3, median_box_area: 0.01 },
  ],
  scenes: [],
});

test('fuseCast: ASD votes weighted by speak_conf pick each speaker\'s cluster', () => {
  const rows = fuseCast(transcript(), visionAsd());
  const s0 = rows.find((r) => r.speaker === 0);
  const s1 = rows.find((r) => r.speaker === 1);
  // s0 window holds conf 0.9 + 0.8 for cluster 0 and nothing else → unanimous.
  assert.equal(s0.cluster, 0);
  assert.equal(s0.confidence, 1);
  assert.equal(s0.method, 'asd');
  assert.deepEqual(s0.votes, [[0, 1.7]]);
  // s1 window: cluster 1 gets 0.95+0.9=1.85, cluster 0 the noise 0.1 → 1.85/1.95.
  assert.equal(s1.cluster, 1);
  assert.equal(s1.confidence, 0.95);
  assert.deepEqual(s1.votes, [[1, 1.85], [0, 0.1]]);
});

test('fuseCast: rows carry speaker rollups and assigned-cluster onscreen time', () => {
  const rows = fuseCast(transcript(), visionAsd());
  const s1 = rows.find((r) => r.speaker === 1);
  assert.equal(s1.speaking_s, 2);
  assert.equal(s1.utterance_count, 1);
  assert.equal(s1.onscreen_s, 2.5); // cluster 1 track: 1.0 → 3.5
});

test('fuseCast: rows expose who was on screen while this speaker spoke, both methods', () => {
  const rows = fuseCast(transcript(), visionAsd());
  // ASD may vote one cluster while the speaker's own close-up is another (solo shots
  // never earn speak_conf) — the naming session needs both signals side by side.
  const s0 = rows.find((r) => r.speaker === 0);
  const s1 = rows.find((r) => r.speaker === 1);
  assert.deepEqual(s0.onscreen_top, [[0, 0.4], [1, 0.2]]);
  assert.deepEqual(s1.onscreen_top, [[1, 0.4], [0, 0.2]]);
});

test('fuseCast: global onscreen fallback when ASD structurally could not run', () => {
  const v = visionAsd();
  v.asd = { ran: false, reason: 'requires at least two simultaneously tracked faces', assigned: 0, carried: 0 };
  for (const f of v.faces) for (const d of f.detections) delete d.speak_conf;
  const rows = fuseCast(transcript(), v);
  const s0 = rows.find((r) => r.speaker === 0);
  // Presence votes at 5fps sampling: s0 saw cluster 0 twice (0.4s), cluster 1 once (0.2s).
  assert.equal(s0.method, 'onscreen_fallback');
  assert.equal(s0.cluster, 0);
  assert.equal(s0.confidence, 0.67);
  assert.deepEqual(s0.votes, [[0, 0.4], [1, 0.2]]);
});

test('fuseCast: ran-but-scored-nothing (carried 0) also falls back to onscreen overlap', () => {
  const v = visionAsd();
  v.asd = { ran: true, reason: null, assigned: 0, carried: 0 };
  for (const f of v.faces) for (const d of f.detections) delete d.speak_conf;
  const rows = fuseCast(transcript(), v);
  assert.ok(rows.every((r) => r.method === 'onscreen_fallback'));
});

test('fuseCast: a speaker with zero ASD votes falls back alone, others stay on asd', () => {
  const v = visionAsd();
  delete v.faces[2].detections[0].speak_conf; // strip conf from s1's window only
  v.faces[3].detections = [det(1)];
  const rows = fuseCast(transcript(), v);
  const s0 = rows.find((r) => r.speaker === 0);
  const s1 = rows.find((r) => r.speaker === 1);
  assert.equal(s0.method, 'asd');
  assert.equal(s0.cluster, 0);
  assert.equal(s1.method, 'onscreen_fallback');
  assert.equal(s1.cluster, 1);
  assert.equal(s1.confidence, 1); // only cluster 1 was on screen while s1 spoke
});

test('fuseCast: a speaker whose windows hold no face samples gets a null cluster', () => {
  const t = transcript();
  t.utterances[1].start = 100; t.utterances[1].end = 102; // no faces sampled out there
  const rows = fuseCast(t, visionAsd());
  const s1 = rows.find((r) => r.speaker === 1);
  assert.equal(s1.cluster, null);
  assert.equal(s1.confidence, 0);
});

// ---- buildDigest: the compact file itself ----

test('buildDigest: timeline rows follow TIMELINE_COLUMNS with majority-onscreen clusters', () => {
  const t = transcript();
  const v = visionAsd();
  // Third sample inside s0's window makes cluster 1 a minority (1 of 3 samples).
  v.faces.splice(2, 0, { t: 1.5, detections: [det(0, { speak_conf: 0.7 })] });
  const d = buildDigest(t, v);
  assert.deepEqual(TIMELINE_COLUMNS, ['start', 'end', 'speaker', 'word_idx', 'onscreen', 'text']);
  assert.deepEqual(d.timeline_columns, TIMELINE_COLUMNS);
  const [start, end, speaker, wordIdx, onscreen, text] = d.timeline[0];
  assert.equal(start, 0);
  assert.equal(end, 2);
  assert.equal(speaker, 0);
  assert.equal(wordIdx, 0);
  assert.deepEqual(onscreen, [0]); // cluster 0 in 3/3 samples, cluster 1 only 1/3
  assert.equal(text, 'hello there');
});

test('buildDigest: consecutive same-speaker utterances merge into one turn row', () => {
  const t = transcript();
  t.utterances = [
    { speaker: 0, start: 0, end: 2, text: 'hello there.', word_start_idx: 0, word_end_idx: 2 },
    { speaker: 0, start: 2.2, end: 3, text: 'still me.', word_start_idx: 2, word_end_idx: 4 },
    { speaker: 1, start: 3.2, end: 4, text: 'hi back', word_start_idx: 4, word_end_idx: 6 },
  ];
  const d = buildDigest(t, visionAsd());
  assert.equal(d.timeline.length, 2);
  const [start, end, speaker, wordIdx, , text] = d.timeline[0];
  assert.equal(start, 0);
  assert.equal(end, 3); // the merged turn runs to its last utterance's end
  assert.equal(speaker, 0);
  assert.equal(wordIdx, 0);
  assert.equal(text, 'hello there. still me.');
});

test('buildDigest: dead air of 2s+ breaks a turn even for the same speaker', () => {
  const t = transcript();
  t.utterances = [
    { speaker: 0, start: 0, end: 2, text: 'before the pause.', word_start_idx: 0, word_end_idx: 2 },
    { speaker: 0, start: 4.5, end: 6, text: 'after the pause.', word_start_idx: 2, word_end_idx: 4 },
  ];
  const d = buildDigest(t, visionAsd());
  assert.equal(d.timeline.length, 2);
  assert.equal(d.timeline[1][0], 4.5);
});

test('buildDigest: an utterance window without face samples shows nobody onscreen', () => {
  const t = transcript();
  t.utterances[1].start = 100; t.utterances[1].end = 102;
  const d = buildDigest(t, visionAsd());
  assert.deepEqual(d.timeline[1][4], []);
});

test('buildDigest: silence gaps over 2s between words are reported, duration derived', () => {
  const t = transcript();
  t.words = [
    { text: 'hello', start: 0, end: 0.5, speaker: 0 }, { text: 'there', start: 0.6, end: 1.9, speaker: 0 },
    { text: 'hi', start: 4.9, end: 5.2, speaker: 1 }, { text: 'back', start: 5.3, end: 6.7, speaker: 1 },
  ];
  const d = buildDigest(t, visionAsd());
  assert.deepEqual(d.density.silence_gaps, [[1.9, 3]]); // 1.9 → 4.9
  assert.equal(d.duration_s, 6.7); // no plan: last word end wins
  assert.deepEqual(d.density.words_per_min, [4]);
});

test('buildDigest on the recorded fixtures: counts, defect row, scene cuts, asd passthrough', () => {
  const d = buildDigest(fixture('transcript_v2.json'), fixture('vision_v2.json'), { duration_s: 600.066133 });
  assert.equal(d.schema, 'cutting-room/digest@1');
  assert.equal(d.duration_s, 600.07);
  assert.equal(d.language, 'en');
  assert.deepEqual(d.counts, {
    speakers: 6, utterances: 151, words: 1210, face_clusters: 24, face_tracks: 181, scene_cuts: 252,
  });
  // 151 utterances fold into speaker turns (speaker changes + dead-air breaks).
  assert.ok(d.timeline.length >= 50 && d.timeline.length <= 90, `${d.timeline.length} turns`);
  const [start, , speaker, wordIdx, , text] = d.timeline[0];
  assert.equal(start, 3.1);
  assert.equal(speaker, 2);
  assert.equal(wordIdx, 0);
  assert.ok(text.startsWith('I did my Marlo Vane for some reason.')); // canonical transcript_edits defect (invented name, misheard on purpose)
  const wordTotal = d.timeline.reduce((n, r) => n + r[5].split(' ').length, 0);
  assert.equal(wordTotal, 1210, 'turn texts carry every word exactly once');
  assert.equal(d.scene_cuts.length, 252);
  assert.equal(d.scene_cuts[0], 3.12);
  assert.equal(d.asd.ran, true);
  assert.equal(d.asd.assigned, 1637);
  assert.equal(d.asd.conf_coverage, 0.51); // just over half the detections scored
  assert.equal(d.cast_candidates.length, 6);
  assert.ok(d.cast_candidates.every((r) => r.method === 'asd'), 'ASD ran on this footage');
  assert.equal(d.cast_candidates[0].speaking_s, 144.1, 'rows ordered by speaking time');
  const minutes = d.density.words_per_min;
  assert.equal(minutes.length, 11);
  assert.equal(minutes.reduce((a, b) => a + b, 0), 1210);
});

// ---- serializeDigest: readable, valid, inside the token-firewall budget ----

test('serializeDigest: output parses back to the exact same object', () => {
  const d = buildDigest(fixture('transcript_v2.json'), fixture('vision_v2.json'), { duration_s: 600.066133 });
  assert.deepEqual(JSON.parse(serializeDigest(d)), d);
});

test('serializeDigest: fixtures digest lands inside the 10-20KB budget', () => {
  const d = buildDigest(fixture('transcript_v2.json'), fixture('vision_v2.json'), { duration_s: 600.066133 });
  const bytes = Buffer.byteLength(serializeDigest(d));
  assert.ok(bytes <= 20 * 1024, `digest is ${bytes}B — over the 20KB ceiling`);
  assert.ok(bytes >= 8 * 1024, `digest is ${bytes}B — suspiciously empty`);
});

// ---- CLI: build + locate (JSON on stdout, human line on stderr) ----

const DIGEST_CLI = fileURLToPath(new URL('../digest.mjs', import.meta.url));

test('CLI build: explicit fixture paths write a parseable digest and a JSON summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-digest-'));
  const out = join(dir, 'digest.json');
  const res = spawnSync('node', [
    DIGEST_CLI, 'build',
    '--transcript', join(FIXTURES, 'transcript_v2.json'),
    '--vision', join(FIXTURES, 'vision_v2.json'),
    '--duration', '600.066133',
    '--out', out,
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  const summary = JSON.parse(res.stdout);
  assert.equal(summary.digest_path, out);
  assert.ok(summary.bytes > 8 * 1024 && summary.bytes <= 20 * 1024);
  assert.equal(summary.turns, 62);
  assert.deepEqual(summary.cast, [
    [0, 0, 0.99, 'asd'], [2, 2, 0.98, 'asd'], [1, 1, 0.98, 'asd'],
    [5, 1, 0.98, 'asd'], [3, 14, 0.37, 'asd'], [4, 11, 0.33, 'asd'],
  ]);
  assert.match(res.stderr, /digest/i);
  const digest = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(digest.schema, 'cutting-room/digest@1');
});

test('CLI build --dir: reads the run layout, writes data/digest.json, stamps the plan', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'cr-digest-run-'));
  const rundir = join(workdir, 'cutting-room');
  mkdirSync(join(rundir, 'data'), { recursive: true });
  copyFileSync(join(FIXTURES, 'transcript_v2.json'), join(rundir, 'data', 'transcript.json'));
  copyFileSync(join(FIXTURES, 'vision_v2.json'), join(rundir, 'data', 'vision.json'));
  writeFileSync(join(rundir, 'plan.json'), JSON.stringify({
    schema: 'cutting-room/plan@2',
    source: { path: 'clip.mp4', duration_s: 600.066133, project_id: 'p-test' },
    analyses: {},
  }, null, 2));
  const res = spawnSync('node', [DIGEST_CLI, 'build', '--dir', rundir], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  const digest = JSON.parse(readFileSync(join(rundir, 'data', 'digest.json'), 'utf8'));
  assert.equal(digest.duration_s, 600.07);
  const plan = JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8'));
  assert.equal(plan.digest_path, 'data/digest.json');
  assert.equal(plan.source.project_id, 'p-test', 'plan fields untouched beyond digest_path');
});

test('CLI locate: resolves a word index range to exact source times', () => {
  const res = spawnSync('node', [
    DIGEST_CLI, 'locate',
    '--transcript', join(FIXTURES, 'transcript_v2.json'),
    '--words', '3..5',
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  const loc = JSON.parse(res.stdout);
  // words[3] = "Marlo" (the canonical defect), words[4] = "Vane"; end exclusive.
  assert.deepEqual(loc, { word_start_idx: 3, word_end_idx: 5, start: 4.05, end: 4.8, text: 'Marlo Vane' });
});

test('CLI: unknown command exits 2 with usage on stderr', () => {
  const res = spawnSync('node', [DIGEST_CLI, 'nonsense'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage/);
});

// ---- cast thumbnails (the CAST strip is a committed surface, so they are used) ----

test('pickCastThumbSpecs: biggest confident detection wins per requested cluster', () => {
  const v = visionAsd();
  // Cluster 0 appears small at t=0.5 and big at t=1.0 — the big one makes the thumb.
  v.faces[0].detections = [{ box: [0, 0, 0.05, 0.05], cluster_id: 0, score: 0.95, track_id: 0 }];
  v.faces[1].detections = [{ box: [0.1, 0.1, 0.4, 0.5], cluster_id: 0, score: 0.9, track_id: 0 }];
  const specs = pickCastThumbSpecs(v, [0, 1, 99]);
  assert.deepEqual(specs.map((s) => s.cluster), [0, 1]); // 99 never appears on screen
  assert.equal(specs[0].t, 1.0);
  assert.deepEqual(specs[0].box, [0.1, 0.1, 0.4, 0.5]);
});

test('CLI thumbs: tolerant exit when the local source video is missing', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'cr-thumbs-'));
  const rundir = join(workdir, 'cutting-room');
  mkdirSync(join(rundir, 'data'), { recursive: true });
  copyFileSync(join(FIXTURES, 'transcript_v2.json'), join(rundir, 'data', 'transcript.json'));
  copyFileSync(join(FIXTURES, 'vision_v2.json'), join(rundir, 'data', 'vision.json'));
  writeFileSync(join(rundir, 'plan.json'), JSON.stringify({
    schema: 'cutting-room/plan@2',
    source: { path: 'gone.mp4', duration_s: 600.066133, project_id: 'p-test' },
    analyses: {},
  }));
  execFileSync('node', [DIGEST_CLI, 'build', '--dir', rundir], { stdio: 'pipe' });
  const res = spawnSync('node', [DIGEST_CLI, 'thumbs', '--dir', rundir], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.thumbs, []);
  assert.equal(out.reason, 'no_source');
});

// Crop real cast thumbs from a local source video when one is provided — set
// CUTTING_ROOM_PLAYGROUND_SRC (same skip rule as mezzanine's probe tests).
const PLAYGROUND_SRC = process.env.CUTTING_ROOM_PLAYGROUND_SRC ?? '';

test('CLI thumbs: crops one jpg per cast-referenced cluster from the real source', { skip: !existsSync(PLAYGROUND_SRC) }, () => {
  const workdir = mkdtempSync(join(tmpdir(), 'cr-thumbs-real-'));
  const rundir = join(workdir, 'cutting-room');
  mkdirSync(join(rundir, 'data'), { recursive: true });
  copyFileSync(join(FIXTURES, 'transcript_v2.json'), join(rundir, 'data', 'transcript.json'));
  copyFileSync(join(FIXTURES, 'vision_v2.json'), join(rundir, 'data', 'vision.json'));
  writeFileSync(join(rundir, 'plan.json'), JSON.stringify({
    schema: 'cutting-room/plan@2',
    source: { path: PLAYGROUND_SRC, duration_s: 600.066133, project_id: 'p-test' },
    analyses: {},
  }));
  execFileSync('node', [DIGEST_CLI, 'build', '--dir', rundir], { stdio: 'pipe' });
  const res = spawnSync('node', [DIGEST_CLI, 'thumbs', '--dir', rundir], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.ok(out.thumbs.length >= 2, 'at least the two anchor clusters');
  for (const th of out.thumbs) {
    assert.match(th.path, /^cast\/c\d+\.jpg$/);
    assert.ok(existsSync(join(rundir, th.path)), `${th.path} written`);
  }
});

// ---- the golden file: byte-exact digest of the recorded run ----
// Regenerate deliberately (never by accident) with:
//   node scripts/digest.mjs build --transcript fixtures/transcript_v2.json \
//     --vision fixtures/vision_v2.json --duration 600.066133 --out fixtures/digest_golden.json

test('golden: serialized fixtures digest matches fixtures/digest_golden.json byte for byte', () => {
  const d = buildDigest(fixture('transcript_v2.json'), fixture('vision_v2.json'), { duration_s: 600.066133 });
  const golden = readFileSync(join(FIXTURES, 'digest_golden.json'), 'utf8');
  assert.equal(serializeDigest(d), golden);
});

test('CLI build: missing payloads exit 1 with a clean line, no stack trace', () => {
  const rundir = join(mkdtempSync(join(tmpdir(), 'cr-empty-')), 'cutting-room');
  mkdirSync(join(rundir, 'data'), { recursive: true });
  const res = spawnSync('node', [DIGEST_CLI, 'build', '--dir', rundir], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /missing analysis payload/);
  assert.doesNotMatch(res.stderr, /at .*digest\.mjs/);
});

// ---- sharding: long footage splits the READING layer, never the join ----

// n utterances alternating speakers 0/1 (so each is its own turn), 2s each, two
// words each. gapsBefore: utterance indices preceded by 3s of dead air (seam bait).
const longTranscript = (n, { textLen = 24, gapsBefore = [] } = {}) => {
  const utterances = [];
  const words = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    if (gapsBefore.includes(i)) t += 3;
    const text = `${String.fromCharCode(97 + (i % 26))}`.repeat(textLen);
    utterances.push({ speaker: i % 2, start: t, end: t + 2, text, word_start_idx: i * 2, word_end_idx: i * 2 + 2 });
    words.push(
      { text: text.slice(0, 12), start: t, end: t + 0.5, speaker: i % 2 },
      { text: text.slice(12), start: t + 1, end: t + 2, speaker: i % 2 },
    );
    t += 2;
  }
  return {
    language: 'en',
    speakers: [
      { speaker: 0, total_duration: n, utterance_count: Math.ceil(n / 2) },
      { speaker: 1, total_duration: n, utterance_count: Math.floor(n / 2) },
    ],
    utterances,
    words,
  };
};

const emptyVision = (sceneTimes = []) => ({
  asd: { ran: false, reason: 'solo', assigned: 0, carried: 0 },
  faces: [],
  face_tracks: [],
  scenes: sceneTimes.map((ts) => ({ before_frame: { timestamp: ts - 0.03 }, after_frame: { timestamp: ts } })),
});

test('shardDigest: shards are contiguous turn slices that reassemble the timeline', () => {
  const t = longTranscript(12);
  const digest = buildDigest(t, emptyVision());
  const target = shardRowBytes(digest.timeline[0]) * 3 + 10;
  const { index, shards } = shardDigest(digest, t, { targetBytes: target });
  assert.ok(shards.length >= 3);
  const reassembled = shards.flatMap((s) => s.data.timeline);
  assert.deepEqual(reassembled, digest.timeline);
  for (const s of shards) {
    const bytes = s.data.timeline.reduce((sum, r) => sum + shardRowBytes(r), 0);
    assert.ok(s.data.timeline.length === 1 || bytes <= target, `shard over target: ${bytes}`);
  }
  assert.equal(index.shards.length, shards.length);
  assert.ok(!index.timeline, 'index carries no timeline');
});

test('shardDigest: a dead-air seam near the cut point wins over the byte boundary', () => {
  const noGaps = longTranscript(8);
  const withGap = longTranscript(8, { gapsBefore: [2] });
  const digestA = buildDigest(noGaps, emptyVision());
  const digestB = buildDigest(withGap, emptyVision());
  const target = shardRowBytes(digestA.timeline[0]) * 3 + 10;
  const cutsA = shardDigest(digestA, noGaps, { targetBytes: target }).shards.map((s) => s.data.timeline.length);
  const cutsB = shardDigest(digestB, withGap, { targetBytes: target }).shards.map((s) => s.data.timeline.length);
  assert.equal(cutsA[0], 3); // pure byte greed
  assert.equal(cutsB[0], 2); // the 3s gap before turn 2 pulls the seam earlier
});

test('shardDigest: scene cuts partition across shards with no loss and no duplicates', () => {
  const t = longTranscript(12);
  const digest = buildDigest(t, emptyVision([1, 5, 9, 13, 17, 21]));
  const { shards } = shardDigest(digest, t, { targetBytes: shardRowBytes(digest.timeline[0]) * 4 + 10 });
  const all = shards.flatMap((s) => s.data.scene_cuts);
  assert.deepEqual(all, digest.scene_cuts);
});

test('shardDigest: index keeps the global sections and true per-shard stats', () => {
  const t = longTranscript(10, { gapsBefore: [4] });
  const digest = buildDigest(t, emptyVision());
  const { index, shards } = shardDigest(digest, t, { targetBytes: shardRowBytes(digest.timeline[0]) * 3 + 10 });
  assert.equal(index.schema, 'cutting-room/digest@1');
  assert.deepEqual(index.cast_candidates, digest.cast_candidates);
  assert.deepEqual(index.counts, digest.counts);
  assert.equal(index.shards.reduce((n, s) => n + s.turns, 0), digest.timeline.length);
  assert.equal(index.shards.reduce((n, s) => n + s.words, 0), t.words.length);
  for (const [i, stat] of index.shards.entries()) {
    assert.equal(stat.file, `digest.d/seg-${String(i).padStart(2, '0')}.json`);
    assert.equal(stat.turns, shards[i].data.timeline.length);
    assert.equal(stat.t0, shards[i].data.timeline[0][0]);
    assert.equal(stat.t1, shards[i].data.timeline.at(-1)[1]);
    assert.deepEqual(stat.speakers_present, [...new Set(shards[i].data.timeline.map((r) => r[2]))].sort());
  }
  assert.ok(index.notes.some((n) => n.includes('digest.d/')), 'notes explain the sharded layout');
});

test('shardDigest: each shard carries its own region\'s silence gaps, uncapped by the global 20', () => {
  const t = longTranscript(9, { gapsBefore: [3, 6] });
  const digest = buildDigest(t, emptyVision());
  const { shards } = shardDigest(digest, t, { targetBytes: shardRowBytes(digest.timeline[0]) * 3 + 10 });
  const gapShard = (ti) => shards.findIndex((s) => s.data.timeline[0][3] <= ti * 2 && ti * 2 <= s.data.timeline.at(-1)[3]);
  // Both 3s gaps exist, each exactly once, in the shard owning the turn after it.
  const allGaps = shards.flatMap((s) => s.data.silence_gaps);
  assert.equal(allGaps.length, 2);
  assert.ok(allGaps.every(([, dur]) => dur === 3));
  assert.equal(shards.flatMap((s, i) => s.data.silence_gaps.map(() => i)).length, 2);
  assert.ok(gapShard(3) >= 0);
});

test('shardDigest: shard files declare their schema and range', () => {
  const t = longTranscript(8);
  const digest = buildDigest(t, emptyVision());
  const { shards } = shardDigest(digest, t, { targetBytes: shardRowBytes(digest.timeline[0]) * 3 + 10 });
  for (const [i, s] of shards.entries()) {
    assert.equal(s.data.schema, 'cutting-room/digest-shard@1');
    assert.equal(s.data.seg, i);
    assert.deepEqual(s.data.timeline_columns, TIMELINE_COLUMNS);
  }
});

// ---- the long-footage golden: recorded payloads tiled ×8 (a synthetic 80-minute episode) ----

const D8 = 600.066133;
const tile = (t, v, n) => {
  const tt = {
    ...t,
    speakers: t.speakers.map((s) => ({ ...s, total_duration: s.total_duration * n, utterance_count: s.utterance_count * n })),
    utterances: [], words: [],
  };
  const vv = { ...v, faces: [], face_tracks: [], scenes: [] };
  for (let k = 0; k < n; k++) {
    const dt = k * D8;
    const dw = k * t.words.length;
    tt.utterances.push(...t.utterances.map((u) => ({
      ...u, start: u.start + dt, end: u.end + dt, word_start_idx: u.word_start_idx + dw, word_end_idx: u.word_end_idx + dw,
    })));
    tt.words.push(...t.words.map((w) => ({ ...w, start: w.start + dt, end: w.end + dt })));
    vv.faces.push(...v.faces.map((f) => ({ t: f.t + dt, detections: f.detections })));
    vv.face_tracks.push(...v.face_tracks.map((tr) => ({ ...tr, start_t: tr.start_t + dt, end_t: tr.end_t + dt })));
    vv.scenes.push(...v.scenes.map((s) => ({
      before_frame: { timestamp: s.before_frame.timestamp + dt },
      after_frame: { timestamp: s.after_frame.timestamp + dt },
    })));
  }
  return { tt, vv };
};

test('long footage: an 80-minute digest overflows the budget and shards cleanly', () => {
  const { tt, vv } = tile(fixture('transcript_v2.json'), fixture('vision_v2.json'), 8);
  const digest = buildDigest(tt, vv, { duration_s: D8 * 8 });
  assert.ok(Buffer.byteLength(serializeDigest(digest)) > 20 * 1024, 'tiled digest must overflow');
  const { index, shards } = shardDigest(digest, tt);
  assert.ok(shards.length >= 4 && shards.length <= 16, `${shards.length} shards`);
  // every shard file and the index itself fit a single context read
  for (const s of shards) assert.ok(Buffer.byteLength(serializeDigest(s.data)) <= 20 * 1024);
  assert.ok(Buffer.byteLength(serializeDigest(index)) <= 20 * 1024, 'index over one read');
  // nothing lost, nothing duplicated
  assert.deepEqual(shards.flatMap((s) => s.data.timeline), digest.timeline);
  assert.equal(shards.flatMap((s) => s.data.scene_cuts).length, 252 * 8);
  assert.equal(index.shards.reduce((a, s) => a + s.turns, 0), digest.timeline.length);
  assert.equal(index.shards.reduce((a, s) => a + s.words, 0), 1210 * 8);
  // shard files round-trip through the serializer
  assert.deepEqual(JSON.parse(serializeDigest(shards[0].data)), shards[0].data);
});

// ---- CLI sharding wiring ----

const seedRundir = (prefix) => {
  const rundir = join(mkdtempSync(join(tmpdir(), prefix)), 'cutting-room');
  mkdirSync(join(rundir, 'data'), { recursive: true });
  copyFileSync(join(FIXTURES, 'transcript_v2.json'), join(rundir, 'data', 'transcript.json'));
  copyFileSync(join(FIXTURES, 'vision_v2.json'), join(rundir, 'data', 'vision.json'));
  writeFileSync(join(rundir, 'plan.json'), JSON.stringify({
    schema: 'cutting-room/plan@2',
    source: { path: 'clip.mp4', duration_s: 600.066133, project_id: 'p-test' },
    analyses: {},
  }, null, 2));
  return rundir;
};

test('CLI build: over budget writes the index plus digest.d shard files', () => {
  const rundir = seedRundir('cr-shard-cli-');
  const res = spawnSync('node', [DIGEST_CLI, 'build', '--dir', rundir, '--max-bytes', '6000'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  const summary = JSON.parse(res.stdout);
  assert.ok(summary.shards >= 3, `expected shards, got ${JSON.stringify(summary)}`);
  const index = JSON.parse(readFileSync(join(rundir, 'data', 'digest.json'), 'utf8'));
  assert.ok(Array.isArray(index.shards) && !index.timeline);
  for (const s of index.shards) {
    const onDisk = JSON.parse(readFileSync(join(rundir, 'data', s.file), 'utf8'));
    assert.equal(onDisk.schema, 'cutting-room/digest-shard@1');
    assert.ok(Buffer.byteLength(JSON.stringify(onDisk)) <= 6000 * 1.1);
  }
});

test('CLI build: dropping back under budget cleans stale shard files', () => {
  const rundir = seedRundir('cr-shard-stale-');
  execFileSync('node', [DIGEST_CLI, 'build', '--dir', rundir, '--max-bytes', '8000'], { stdio: 'pipe' });
  assert.ok(existsSync(join(rundir, 'data', 'digest.d')));
  const res = spawnSync('node', [DIGEST_CLI, 'build', '--dir', rundir], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  const digest = JSON.parse(readFileSync(join(rundir, 'data', 'digest.json'), 'utf8'));
  assert.ok(digest.timeline && !digest.shards, 'single-file mode again');
  assert.ok(!existsSync(join(rundir, 'data', 'digest.d')), 'stale digest.d removed');
});

// ---- clip boundary snapping: editorial.md §3 made deterministic ----

test('snapClip: boundaries snap to scene cuts within 1.5s, never mid-word', () => {
  const words = [
    { text: 'setup', start: 10, end: 10.8 },
    { text: 'hook', start: 12, end: 12.4 },   // clip starts here
    { text: 'body', start: 12.5, end: 13 },
    { text: 'payoff', start: 13.2, end: 14 },  // clip ends here
    { text: 'trail', start: 15.5, end: 16 },
  ];
  // cut at 11.2 sits in the word gap, 0.8s before the hook → snap in
  // cut at 14.6 sits before the next word, 0.6s after the payoff → snap out
  const scenes = [11.2, 14.6];
  const c = snapClip(words, scenes, 1, 4);
  assert.equal(c.start, 12);
  assert.equal(c.end, 14);
  assert.equal(c.src_in, 11.2);
  assert.equal(c.src_out, 14.6);
  assert.deepEqual([c.snapped_in, c.snapped_out], ['scene_cut', 'scene_cut']);
});

test('snapClip: a cut that would swallow the previous word is refused', () => {
  const words = [
    { text: 'setup', start: 10, end: 11.5 },
    { text: 'hook', start: 12, end: 12.4 },
    { text: 'payoff', start: 12.5, end: 13 },
  ];
  // 11.4 is mid-setup-word; 10.9 is too far (>1.5s) — neither is legal
  const c = snapClip(words, [10.9, 11.4], 1, 3);
  assert.equal(c.snapped_in, 'word_gap');
  // fallback: a small pre-roll inside the word gap, never touching the setup word
  assert.ok(c.src_in > 11.5 && c.src_in < 12);
});

test('snapClip: without cuts, boundaries get a small pad inside the word gaps', () => {
  const words = [
    { text: 'hook', start: 5, end: 5.5 },
    { text: 'payoff', start: 5.6, end: 6.2 },
    { text: 'next', start: 6.3, end: 7 },
  ];
  const c = snapClip(words, [], 0, 2);
  assert.equal(c.src_in, Math.max(0, 5 - 0.2));
  assert.ok(c.src_out > 6.2 && c.src_out <= 6.3);
  assert.deepEqual([c.snapped_in, c.snapped_out], ['word_gap', 'word_gap']);
});

test('CLI clip: resolves and snaps a word range against the recorded payloads', () => {
  const res = spawnSync('node', [
    DIGEST_CLI, 'clip',
    '--transcript', join(FIXTURES, 'transcript_v2.json'),
    '--vision', join(FIXTURES, 'vision_v2.json'),
    '--words', '121..130',
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  const c = JSON.parse(res.stdout);
  assert.equal(c.text, 'I got a DM from a haunted vending machine.');
  assert.ok(c.src_in <= c.start && c.end <= c.src_out);
  assert.ok(['scene_cut', 'word_gap'].includes(c.snapped_in));
});

// ---- visual gap enrichment: bounded frame extraction for scouts ----

test('pickGapFrameSpecs: >=min only, top-N per region by length, chronological', () => {
  const regions = [
    { seg: 0, gaps: [[10, 2.5], [40, 8], [100, 5], [200, 6.1], [300, 12]] },
    { seg: 1, gaps: [[500, 4.9], [600, 5.4]] },
  ];
  const specs = pickGapFrameSpecs(regions, { minGapS: 5, perRegion: 3, framesPerGap: 2 });
  // region 0: qualifying 8 / 5 / 6.1 / 12 → top 3 by length = 12, 8, 6.1 → by time: 40, 200, 300
  // region 1: 4.9 misses the bar, 5.4 stays
  assert.deepEqual(specs.map((s) => [s.seg, s.t, s.seconds]), [
    [0, 40, 8], [0, 200, 6.1], [0, 300, 12], [1, 600, 5.4],
  ]);
  // frames sit inside the gap at (i+0.5)/n
  assert.deepEqual(specs[0].times, [42, 46]);
  assert.deepEqual(specs[3].times, [600 + 5.4 * 0.25, 600 + 5.4 * 0.75]);
});

test('pickGapFrameSpecs: framesPerGap 1 lands mid-gap; empty regions are fine', () => {
  const specs = pickGapFrameSpecs([{ seg: 0, gaps: [[20, 6]] }, { seg: 1, gaps: [] }], { framesPerGap: 1 });
  assert.deepEqual(specs, [{ seg: 0, t: 20, seconds: 6, times: [23] }]);
  assert.deepEqual(pickGapFrameSpecs([], {}), []);
});

test('CLI gapframes: no local source is a clean skip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-gapframes-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'digest.json'), JSON.stringify({
    schema: 'cutting-room/digest@1', density: { silence_gaps: [[40, 8]] },
  }));
  const res = spawnSync('node', [DIGEST_CLI, 'gapframes', '--dir', dir], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), { gaps: [], reason: 'no_source' });
});

test('CLI gapframes: extracts downscaled frames per gap + manifest, idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-gapframes-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  // a 20s synthetic source next to the run dir, referenced relatively (plan.source.path law)
  const src = join(dir, '..', 'gap-src.mp4');
  const gen = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=20', src], { encoding: 'utf8' });
  assert.equal(gen.status, 0, 'ffmpeg must generate the synthetic source');
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ source: { path: 'gap-src.mp4' } }));
  writeFileSync(join(dir, 'data', 'digest.json'), JSON.stringify({
    schema: 'cutting-room/digest@1',
    density: { silence_gaps: [[2, 3], [6, 6]] }, // only the 6s gap qualifies
  }));
  const res = spawnSync('node', [DIGEST_CLI, 'gapframes', '--dir', dir], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.gaps.length, 1);
  assert.deepEqual(out.gaps[0], { seg: 0, t: 6, seconds: 6, frames: ['thumbs/gaps/s0-6-0.jpg', 'thumbs/gaps/s0-6-1.jpg'] });
  for (const rel of out.gaps[0].frames) assert.ok(existsSync(join(dir, rel)), `${rel} written`);
  const manifest = JSON.parse(readFileSync(join(dir, 'data', 'gap_frames.json'), 'utf8'));
  assert.equal(manifest.schema, 'cutting-room/gap-frames@1');
  assert.equal(manifest.gaps.length, 1);
  // second run reuses the files on disk (byte-identical manifest)
  const again = spawnSync('node', [DIGEST_CLI, 'gapframes', '--dir', dir], { encoding: 'utf8' });
  assert.equal(again.status, 0);
  assert.deepEqual(JSON.parse(again.stdout), out);
});

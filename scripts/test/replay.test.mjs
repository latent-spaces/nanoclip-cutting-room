import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayRun } from '../replay.mjs';

// Optional real local source for the replay (set CUTTING_ROOM_PLAYGROUND_SRC);
// the replay itself runs fine without one.
const REAL_VIDEO = process.env.CUTTING_ROOM_PLAYGROUND_SRC ?? '';

test('replayRun: recorded run replays from fixtures into a live run dir', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cr-replay-')), 'cutting-room');
  await replayRun({ dir, speed: 400, finale: true, source: existsSync(REAL_VIDEO) ? REAL_VIDEO : null });
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(state.stages.transcript.status, 'completed');
  assert.equal(state.stages.vision.status, 'completed');
  assert.equal(state.facts.speakers, 6);
  assert.equal(state.facts.scene_cuts, 252);
  assert.equal(state.artifacts.transcript.words_head[0], 'I');
  assert.equal(state.stages.clips.status, 'completed');
  assert.equal(state.artifacts.clips.length, 3);
  assert.ok(existsSync(join(dir, 'data', 'transcript.json')));
  assert.ok(existsSync(join(dir, 'data', 'vision.json')));
});

test('replayRun finale: seeds the synthetic cast row with portraits', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cr-replay-cast-')), 'cutting-room');
  await replayRun({ dir, speed: 400, finale: true, source: null });
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  const cast = state.artifacts.cast;
  assert.equal(cast.length, 3);
  assert.deepEqual(cast.map((p) => p.label), ['Rio', 'Juno', 'Mars']);
  assert.equal(cast[0].role, 'host');
  const near = (a, b) => Math.abs(a - b) < 0.011;
  assert.ok(near(cast[0].speaking_s, 144.14), `Rio rides speaker 0 (${cast[0].speaking_s})`);
  assert.ok(near(cast[1].speaking_s, 135.01), `Juno fuses the split speakers 1+5 (${cast[1].speaking_s})`);
  assert.ok(near(cast[2].speaking_s, 113.73), `Mars rides speaker 2 (${cast[2].speaking_s})`);
  for (const p of cast) {
    assert.match(p.thumb, /^cast\/[a-z]+\.jpg$/);
    assert.ok(existsSync(join(dir, p.thumb)), `portrait on disk: ${p.thumb}`);
  }
});

test('replayRun: seeds synthetic vision surfaces when no source is given', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cr-replay-vis-')), 'cutting-room');
  const state = await replayRun({ dir, speed: 400, finale: true, source: null });
  assert.equal(state.frames.length, 6, 'chase-light frames');
  for (const f of state.frames) {
    assert.ok(existsSync(join(dir, f.thumb)), `frame on disk: ${f.thumb}`);
    assert.deepEqual(f.boxes, [], 'plain frames carry no boxes yet');
  }
  const v = state.artifacts.vision;
  assert.equal(v.strip.length, 6);
  assert.equal(v.strip[0].boxes.length, 3, 'wide opener holds the whole panel');
  assert.equal(v.strip[0].boxes[0].length, 5, 'boxes carry the cluster id');
  assert.deepEqual(v.faces_by_cluster.map((r) => r.cluster), [0, 1, 2]);
  for (const row of v.faces_by_cluster) {
    assert.ok(row.crops.length >= 3);
    for (const c of row.crops) assert.ok(existsSync(join(dir, c)), `crop on disk: ${c}`);
  }
  assert.equal(v.asd_moment.cluster, 0);
  assert.ok(v.asd_moment.speak_conf > 0.9);
  assert.ok(existsSync(join(dir, v.asd_moment.thumb)), 'asd frame on disk');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { announceClips } from '../announce.mjs';

const ANNOUNCE_CLI = fileURLToPath(new URL('../announce.mjs', import.meta.url));

const plan = () => ({
  schema: 'cutting-room/plan@2',
  source: { path: 'clip.mp4', duration_s: 600, width: 1920, height: 1080, project_id: 'p-test' },
  analyses: { transcript: { usd: '0.20' }, vision: { usd: '0.38' } },
  cast: [
    { person_id: 'p1', label: 'Rio', role: 'guest', thumb: 'cast/c3.jpg', speaking_s: 154.5, cluster_ids: [3] },
    { person_id: 'p2', label: 'Juno', role: 'host', thumb: 'cast/c1.jpg', speaking_s: 138.7, cluster_ids: [1] },
  ],
  clips: [
    { id: 'c1', title: 'One', hook: '"h1"', status: 'proposed', score: 0.86, segments: [{ src_in: 52.56, src_out: 89.46 }] },
    { id: 'c2', title: 'Two', hook: '"h2"', status: 'rejected', score: 0.5, segments: [{ src_in: 10, src_out: 20 }] },
    { id: 'c3', title: 'Three', hook: '"h3"', status: 'approved', score: 0.76, segments: [{ src_in: 100, src_out: 115 }, { src_in: 200, src_out: 216.7 }] },
  ],
});

const baseState = () => ({
  schema: 'cutting-room/state@1',
  updated_at: '2026-01-01T10:00:00.000Z',
  project_id: 'p-test',
  stages: {
    upload: { status: 'completed', ended_at: 't0', seconds: 23.7 },
    transcript: { status: 'completed', ended_at: 't1', seconds: 112 },
    vision: { status: 'completed', ended_at: 't2', seconds: 196 },
    cast: { status: 'waiting' },
    cut: { status: 'waiting' },
    clips: { status: 'waiting' },
  },
  artifacts: { transcript: { words: 3501 }, vision: null },
});

test('announceClips: flips the tail stages and lands cast + clips artifacts', () => {
  const now = '2026-01-01T22:00:00.000Z';
  const st = announceClips(baseState(), plan(), { previewUrl: 'http://localhost:3003', now });
  assert.equal(st.stages.cast.status, 'completed');
  assert.equal(st.stages.cut.status, 'completed');
  assert.equal(st.stages.clips.status, 'completed');
  assert.equal(st.stages.clips.ended_at, now);
  assert.equal(st.preview_url, 'http://localhost:3003');
  assert.equal(st.updated_at, now);
  // cast rides plan.cast verbatim where the page needs it
  assert.deepEqual(st.artifacts.cast[0], {
    person_id: 'p1', label: 'Rio', role: 'guest', thumb: 'cast/c3.jpg', speaking_s: 154.5,
  });
  // rejected clips never reach the band; durations come from the segments
  assert.deepEqual(st.artifacts.clips.map((c) => c.id), ['c1', 'c3']);
  assert.equal(st.artifacts.clips[0].hook, '"h1"');
  assert.equal(st.artifacts.clips[0].duration_s, 37);   // 36.9 rounded
  assert.equal(st.artifacts.clips[1].duration_s, 32);   // 15 + 16.7 rounded
});

test('announceClips: per-clip player urls land on the cards (clips embed in-page, not own-tab)', () => {
  const st = announceClips(baseState(), plan(), {
    previewUrl: 'http://localhost:3009',
    urls: ['http://localhost:3009', 'http://localhost:3011'],
    now: 'now',
  });
  assert.equal(st.artifacts.clips[0].url, 'http://localhost:3009');
  assert.equal(st.artifacts.clips[1].url, 'http://localhost:3011');
  // fewer urls than clips → the tail simply has none
  const st2 = announceClips(baseState(), plan(), { urls: ['http://localhost:3009'], now: 'now' });
  assert.equal(st2.artifacts.clips[0].url, 'http://localhost:3009');
  assert.ok(!('url' in st2.artifacts.clips[1]));
});

test('announceClips: additive — earlier stages, artifacts, and stamped fields survive', () => {
  const prior = baseState();
  prior.stages.cast = { status: 'completed', ended_at: 'earlier', seconds: 8 };
  const st = announceClips(prior, plan(), { now: 'later' });
  assert.equal(st.stages.upload.seconds, 23.7);
  assert.deepEqual(st.artifacts.transcript, { words: 3501 });
  // an already-completed stage keeps its own timestamps
  assert.equal(st.stages.cast.ended_at, 'earlier');
  assert.equal(st.stages.cast.seconds, 8);
  assert.ok(!('preview_url' in st), 'no preview url unless given');
});

test('CLI announce --dir: seeds state.json when the screen never ran, then is idempotent', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'cr-announce-'));
  const rundir = join(workdir, 'cutting-room');
  mkdirSync(rundir, { recursive: true });
  writeFileSync(join(rundir, 'plan.json'), JSON.stringify(plan(), null, 2));
  const res = spawnSync('node', [ANNOUNCE_CLI, '--dir', rundir, '--preview-url', 'http://localhost:3003'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const st = JSON.parse(readFileSync(join(rundir, 'state.json'), 'utf8'));
  assert.equal(st.schema, 'cutting-room/state@1');
  // analyses really did land (payloads exist) — a seeded state must not show them running
  assert.equal(st.stages.transcript.status, 'completed');
  assert.equal(st.stages.vision.status, 'completed');
  assert.equal(st.stages.clips.status, 'completed');
  assert.equal(st.artifacts.clips.length, 2);
  assert.equal(st.preview_url, 'http://localhost:3003');
  const out = JSON.parse(res.stdout);
  assert.equal(out.clips, 2);
  assert.equal(out.cast, 2);
  // re-run: still fine, band data refreshed in place
  const res2 = spawnSync('node', [ANNOUNCE_CLI, '--dir', rundir], { encoding: 'utf8' });
  assert.equal(res2.status, 0, res2.stderr);
  const st2 = JSON.parse(readFileSync(join(rundir, 'state.json'), 'utf8'));
  assert.equal(st2.stages.clips.status, 'completed');
  assert.equal(st2.preview_url, 'http://localhost:3003', 'stamped preview url survives a flagless re-run');
});

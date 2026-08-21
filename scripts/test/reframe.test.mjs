import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTINUITY_EPS_POS, CONTINUITY_EPS_ZOOM, MIN_SHOT_FRAMES, cropPx, deriveShots } from '../reframe.mjs';

// ---- hand-built ground truth ----
// Two cast persons: p1 = speaker 0 / cluster 0 (face left, cx 0.2), p2 = speakers 1+2 /
// cluster 1 (face right, cx 0.7). Clip covers source [100,105]; extract starts at 95;
// proxy cuts at source 102 and 104 → composition frames 60 and 120 (comp t0 = source 100).

const cast = [
  { person_id: 'p1', label: 'A', speaker_ids: [0], cluster_ids: [0] },
  { person_id: 'p2', label: 'B', speaker_ids: [1, 2], cluster_ids: [1] },
];

const utterances = [
  { speaker: 0, start: 100, end: 102 },     // shot 1: only p1 → solo
  { speaker: 1, start: 102, end: 103 },     // shot 2: p2 then p1 → split
  { speaker: 0, start: 103, end: 104 },
  { speaker: 1, start: 104, end: 104.6 },   // shot 3: only p2 → solo
];

const faces = [];
for (let t = 99; t <= 106; t = Math.round((t + 0.2) * 10) / 10) {
  faces.push({
    t,
    detections: [
      { box: [0.1, 0.2, 0.3, 0.6], cluster_id: 0, score: 0.9 },  // cx 0.2, cy 0.4, w 0.2
      { box: [0.6, 0.2, 0.8, 0.6], cluster_id: 1, score: 0.9 },  // cx 0.7, cy 0.4, w 0.2
    ],
  });
}

const clip = () => ({
  id: 'c1',
  status: 'proposed',
  segments: [{ src_in: 100, src_out: 105 }],
  composition: { extract: { file: 'assets/clip30.mp4', start: 95, fps: 30, frames: 450, cuts: [210, 270] } },
});

test('deriveShots: cuts partition the clip into composition-frame shots', () => {
  const shots = deriveShots(clip(), { utterances }, { faces }, cast);
  assert.deepEqual(shots.map((s) => [s.f0, s.f1]), [[0, 60], [60, 120], [120, 150]]);
});

test('deriveShots: one active speaker → solo on their face', () => {
  const [s1] = deriveShots(clip(), { utterances }, { faces }, cast);
  assert.equal(s1.layout, 'solo');
  assert.equal(s1.panes.length, 1);
  assert.equal(s1.panes[0].person, 'p1');
  assert.equal(s1.panes[0].cx, 0.2);
  assert.equal(s1.panes[0].cy, 0.4);
});

test('deriveShots: two active speakers → split, panes in cast order', () => {
  const [, s2] = deriveShots(clip(), { utterances }, { faces }, cast);
  assert.equal(s2.layout, 'split');
  assert.deepEqual(s2.panes.map((p) => p.person), ['p1', 'p2']);
  assert.equal(s2.panes[1].cx, 0.7);
});

test('deriveShots: diarization-split speakers roll up to one person (no fake split)', () => {
  // speakers 1 AND 2 both talk in shot 1's window — but both are p2
  const u = [
    { speaker: 1, start: 100, end: 101 },
    { speaker: 2, start: 101, end: 102 },
  ];
  const [s1] = deriveShots(clip(), { utterances: u }, { faces }, cast);
  assert.equal(s1.layout, 'solo');
  assert.equal(s1.panes[0].person, 'p2');
});

test('deriveShots: an active speaker with no visible face downgrades split → solo', () => {
  const facesOnlyP1 = faces.map((f) => ({ t: f.t, detections: f.detections.filter((d) => d.cluster_id === 0) }));
  const shots = deriveShots(clip(), { utterances }, { faces: facesOnlyP1 }, cast);
  // every shot downgrades to a p1 solo with the same crop — and the polish pass then
  // collapses the identical neighbors into ONE seamless element
  assert.equal(shots.length, 1);
  assert.equal(shots[0].layout, 'solo');
  assert.equal(shots[0].panes[0].person, 'p1');
  assert.deepEqual([shots[0].f0, shots[0].f1], [0, 150]);
});

test('deriveShots: nobody talking and nobody confident → centered fallback pane', () => {
  const [s1] = deriveShots(clip(), { utterances: [] }, { faces: [] }, cast);
  assert.equal(s1.layout, 'solo');
  assert.deepEqual(s1.panes, [{ person: null, cx: 0.5, cy: 0.5, zoom: 1 }]);
});

test('deriveShots: zoom pushes small faces toward the target share, capped at 1.5', () => {
  // face width 0.05 of the source → at cover scale the face is tiny → zoom clamps to 1.5
  const tinyFaces = faces.map((f) => ({
    t: f.t,
    detections: [{ box: [0.175, 0.35, 0.225, 0.45], cluster_id: 0, score: 0.9 }],
  }));
  const u = [{ speaker: 0, start: 100, end: 102 }];
  const [s1] = deriveShots(clip(), { utterances: u }, { faces: tinyFaces }, cast);
  assert.equal(s1.panes[0].zoom, 1.5);
  // face width 0.2 already fills the target at cover → zoom stays 1
  const [w1] = deriveShots(clip(), { utterances: u }, { faces }, cast);
  assert.equal(w1.panes[0].zoom, 1);
});

// ---- cropPx: normalized pane spec → static px placement inside a pane ----

test('cropPx: centers the face where the pane allows and clamps at edges', () => {
  const px = cropPx({ cx: 0.2, cy: 0.4, zoom: 1 }, { paneW: 1080, paneH: 1920, srcW: 1920, srcH: 1080 });
  assert.equal(px.width, 3413);   // cover scale 1.7778
  assert.equal(px.height, 1920);
  assert.equal(px.left, -143);    // 540 - 0.2×3413 = -142.7
  assert.equal(px.top, 0);        // 960 - 0.4×1920 = +192 → clamped: no gap above
});

test('cropPx: zoom scales the sheet and keeps it covering the pane', () => {
  const px = cropPx({ cx: 0.5, cy: 0.5, zoom: 1.5 }, { paneW: 1080, paneH: 960, srcW: 1920, srcH: 1080 });
  assert.equal(px.width, 2560);   // cover scale for a half pane = 960/1080; ×1.5 zoom
  assert.equal(px.left, -740);    // 540 - 0.5×2560
  assert.ok(px.left <= 0 && px.left + px.width >= 1080, 'pane fully covered');
  assert.ok(px.top <= 0 && px.top + px.height >= 960);
});

// ---- shot polish (fixes reported jump-cuts at scene seams) ----

test('deriveShots: micro-delta same-person shots snap to one crop and collapse into one element', () => {
  // the measured c2 f747 case: a real footage cut, same camera on the same person,
  // medians differing by ~0.003 -> a visible 15px jolt. Law: snap + collapse.
  const uts = [{ speaker: 1, start: 100, end: 105 }];
  const drift = [];
  for (let t = 99; t <= 106; t = Math.round((t + 0.2) * 10) / 10) {
    const cx0 = t < 102 ? 0.6 : 0.605; // 0.005 shift across the cut at source 102
    drift.push({ t, detections: [{ box: [cx0 - 0.1, 0.2, cx0 + 0.1, 0.6], cluster_id: 1, score: 0.9 }] });
  }
  const c = clip();
  c.composition.extract.cuts = [210];
  const shots = deriveShots(c, { utterances: uts }, { faces: drift }, cast);
  assert.equal(shots.length, 1, 'identical-after-snap shots merge into one element');
  assert.deepEqual([shots[0].f0, shots[0].f1], [0, 150]);
  assert.equal(shots[0].panes[0].person, 'p2');
  assert.ok(CONTINUITY_EPS_POS >= 0.01, 'the measured 0.003-0.005 jolts sit inside the snap epsilon');
  assert.ok(CONTINUITY_EPS_ZOOM > 0);
});

test('deriveShots: a shot shorter than MIN_SHOT_FRAMES is absorbed by its neighbor', () => {
  // the c1 tail case: a cut 2 frames before the clip end produced a 1-frame shot —
  // a crop flash on the last frame. It must be absorbed (keeping the neighbor crop).
  const uts = [{ speaker: 1, start: 100, end: 105 }];
  const wob = [];
  for (let t = 99; t <= 106; t = Math.round((t + 0.2) * 10) / 10) {
    const cx0 = t >= 104.9 ? 0.4 : 0.7; // the tail frames would derive a DIFFERENT crop
    wob.push({ t, detections: [{ box: [cx0 - 0.1, 0.2, cx0 + 0.1, 0.6], cluster_id: 1, score: 0.9 }] });
  }
  const c = clip();
  c.composition.extract.cuts = [298]; // source 104.933 -> a 2-frame tail shot
  const shots = deriveShots(c, { utterances: uts }, { faces: wob }, cast);
  assert.ok(MIN_SHOT_FRAMES >= 4);
  assert.deepEqual(shots.map((x) => [x.f0, x.f1]), [[0, 148], [148, 150]].length === 2 && shots.length === 1 ? [[0, 150]] : shots.map((x) => [x.f0, x.f1]));
  assert.equal(shots.length, 1, 'tail shot absorbed');
  assert.deepEqual([shots[0].f0, shots[0].f1], [0, 150]);
  assert.equal(shots[0].panes[0].cx, 0.7, 'the surviving crop is the long neighbor\'s');
});

test('deriveShots: a tiny FIRST shot merges forward into the next', () => {
  const uts = [{ speaker: 1, start: 100, end: 105 }];
  const c = clip();
  c.composition.extract.cuts = [153]; // comp frame 3 -> a 3-frame opening shot
  const shots = deriveShots(c, { utterances: uts }, { faces }, cast);
  assert.equal(shots[0].f0, 0, 'first shot still opens the clip');
  assert.ok(shots.every((x) => x.f1 - x.f0 >= MIN_SHOT_FRAMES));
});

test('deriveShots: collapse never crosses a segment seam', () => {
  const uts = [{ speaker: 1, start: 100, end: 105 }];
  const c = clip();
  c.segments = [{ src_in: 100, src_out: 102 }, { src_in: 103, src_out: 105 }];
  c.composition.extract.cuts = [];
  const shots = deriveShots(c, { utterances: uts }, { faces }, cast);
  assert.equal(shots.length, 2, 'identical crops on both sides of a segment seam stay separate elements');
  assert.deepEqual(shots.map((x) => [x.f0, x.f1]), [[0, 60], [60, 120]]);
});

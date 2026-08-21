// make-demo-fixtures.mjs — deterministic SYNTHETIC fixtures in the exact NanoClip
// payload schemas. Zero real people, zero real transcripts: an invented panel show
// ("The Prototype Hour") engineered to exercise the same structures the recorded
// run did — 6 speakers, 24 face clusters, 252 scene cuts, 600.066s, a name-defect
// word at idx 3 (the canonical transcript_edits case), a quotable hook, a
// diarization split (two speakers → one cluster), voice-only speakers whose ASD
// votes leak to the on-screen cluster, and one ≥5s silence gap (gapframes).
// Usage: node scripts/make-demo-fixtures.mjs [--out fixtures]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DURATION_S = 600.066;
const SEED = 20260821;

// mulberry32 — tiny deterministic PRNG
const rng = (() => {
  let a = SEED >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const between = (a, b) => a + rng() * (b - a);
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;

// ---- the invented show ----
// s0 Rio (host, cluster 0) · s1 Juno (cluster 1) · s2 Mars (cluster 2)
// s5 = Juno's diarization split (also cluster 1) · s3 producer (voice-only)
// s4 = a clip's audio (voice-only). Clusters 3..23 are the long tail (audience,
// on-screen video faces, one-frame strangers).
const LEX = (
  'so okay right well look honestly basically the a this that we you they it '
  + 'built tested wired soldered printed measured dropped launched broke fixed '
  + 'prototype gadget sensor battery antenna magnet spring lever circuit board '
  + 'toaster kettle drone rover pedal whistle lantern compass turbine gearbox '
  + 'tiny huge weird brilliant terrible glorious wobbly rusty shiny stubborn '
  + 'yesterday today somehow suddenly finally almost barely definitely maybe '
  + 'works fails spins hums beeps rattles glows leaks floats sinks bounces '
  + 'and but because then while until unless obviously seriously literally '
  + 'garage workshop basement rooftop kitchen hallway warehouse backyard'
).split(' ');

const sentence = (n) => {
  const words = [];
  for (let i = 0; i < n; i++) words.push(pick(LEX));
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return `${words.join(' ')}.`;
};

// Anchor lines (word-exact, placed at known times):
// - the defect: invented celebrity "Marla Vane" misheard as "Marlo Vane" —
//   utterance 0, word idx 3, the transcript_edits canonical case.
// - the hook for the CLI clip test (absurd, cold-open quotable).
// - two more quotables for replay's finale cards.
// - the gap bracket: a watch-the-clip beat around the 5.4s silence at 333.1s.
const ANCHORS = {
  defect: { t: 3.1, speaker: 2, text: 'I did my Marlo Vane for some reason.' },
  hook: { t: 52.0, speaker: 0, text: 'I got a DM from a haunted vending machine.' },
  quote2: { t: 210.0, speaker: 1, text: 'We built the worst toaster in recorded history.' },
  quote3: { t: 471.0, speaker: 2, text: 'That is the saddest robot I have ever seen.' },
  gapIn: { t: 331.0, speaker: 0, text: 'Wait, play that clip again.' },
  gapOut: { t: 338.5, speaker: 1, text: 'No way, that thing is real?' },
};

// ---- build the spoken timeline: turns → utterances → words ----
export function buildTranscript() {
  const words = [];
  const utterances = [];
  const anchorQueue = Object.values(ANCHORS).sort((a, b) => a.t - b.t);

  const pushUtterance = (speaker, startAt, text) => {
    const tokens = text.split(' ');
    const wStart = words.length;
    let t = startAt;
    for (const tok of tokens) {
      const dur = between(0.12, 0.42);
      words.push({ text: tok, start: r2(t), end: r2(t + dur), speaker, confidence: 1 });
      t += dur + between(0.04, 0.16);
    }
    utterances.push({
      speaker,
      start: words[wStart].start,
      end: words[words.length - 1].end,
      text: tokens.join(' '),
      word_start_idx: wStart,
      word_end_idx: words.length, // exclusive, per agent_context
    });
    return t;
  };

  // speaker rotation with a mid-show diarization split: after 300s Juno's turns
  // arrive labeled s5 (same face cluster 1) — the split the digest must catch.
  const turnSpeaker = (t) => {
    const roll = rng();
    if (roll < 0.34) return 0;
    if (roll < 0.62) return t < 300 ? 1 : 5;
    if (roll < 0.9) return 2;
    return roll < 0.95 ? 3 : 4; // producer / clip audio, rare
  };

  let t = ANCHORS.defect.t;
  t = pushUtterance(ANCHORS.defect.speaker, t, ANCHORS.defect.text) + between(0.4, 1.0);
  while (t < DURATION_S - 6) {
    // anchor due? place it exactly
    if (anchorQueue.length && t >= anchorQueue[0].t - 2) {
      const a = anchorQueue.shift();
      if (a.text !== ANCHORS.defect.text) {
        t = Math.max(t, a.t);
        t = pushUtterance(a.speaker, t, a.text) + between(0.4, 1.0);
        if (a === ANCHORS.gapIn) t = 331.0 + (333.1 - 331.0); // land the gap start
        if (a.text === ANCHORS.gapIn.text) t = 338.5; // the 5.4s watch-the-clip gap → 333.1..338.5
      }
      continue;
    }
    const speaker = turnSpeaker(t);
    const utts = 1 + Math.floor(rng() * 3);
    for (let u = 0; u < utts && t < DURATION_S - 6; u++) {
      t = pushUtterance(speaker, t, sentence(4 + Math.floor(rng() * 9)));
      t += rng() < 0.12 ? between(2.0, 3.4) : between(0.25, 1.1); // some ≥2s dead air
    }
  }

  const speakers = [];
  for (let s = 0; s <= 5; s++) {
    const su = utterances.filter((u) => u.speaker === s);
    speakers.push({
      speaker: s,
      total_duration: r2(su.reduce((n, u) => n + (u.end - u.start), 0)),
      utterance_count: su.length,
    });
  }

  return {
    project_id: 'demo_prototype_hour_0000',
    analysis: 'transcript',
    status: 'completed',
    language: 'en',
    error: null,
    agent_context: {
      time_unit: 'seconds',
      time_origin: 'start of source video',
      speaker_ids: 'stable within this transcript response',
      word_indices: 'word_start_idx is inclusive; word_end_idx is exclusive',
    },
    text: utterances.map((u) => u.text).join(' '),
    words,
    utterances,
    speakers,
  };
}

// ---- vision: shots from 252 cuts, detections per 5fps sample ----
const CLUSTER_BOX = (c) => {
  // stable home position per cluster, jittered per sample
  const cx = 0.18 + ((c * 0.37) % 0.6);
  const cy = 0.24 + ((c * 0.23) % 0.3);
  const w = 0.09 + ((c % 5) * 0.01);
  const h = w * 1.8;
  return [cx, cy, w, h];
};

export function buildVision(transcript) {
  // 252 cuts: jittered around an even grid, none in the first 2s
  const cuts = [];
  for (let i = 0; i < 252; i++) {
    const ts = ((i + 1) / 253) * DURATION_S + between(-0.8, 0.8);
    cuts.push(Math.min(DURATION_S - 0.5, Math.max(2, ts)));
  }
  cuts.sort((a, b) => a - b);

  const speakerAt = (t) => {
    const u = transcript.utterances.find((x) => x.start <= t && t <= x.end);
    return u ? u.speaker : null;
  };
  const CLUSTER_OF = { 0: 0, 1: 1, 2: 2, 5: 1 }; // s5 shares Juno's face

  // per shot: a layout keyed to who talks at the shot's start
  const shotLayouts = [];
  let prev = 0;
  for (const cut of [...cuts, DURATION_S]) {
    const mid = prev + (cut - prev) / 2;
    const sp = speakerAt(mid);
    const face = CLUSTER_OF[sp];
    const roll = rng();
    let layout;
    if (face === undefined) {
      layout = roll < 0.5 ? { kind: 'broll', clusters: [] } : { kind: 'tail', clusters: [3 + Math.floor(rng() * 21)] };
    } else if (roll < 0.55) layout = { kind: 'solo', clusters: [face] };
    else if (roll < 0.78) layout = { kind: 'two', clusters: [face, pick([0, 1, 2].filter((c) => c !== face))] };
    else if (roll < 0.9) layout = { kind: 'react', clusters: [pick([0, 1, 2].filter((c) => c !== face))] };
    else layout = { kind: 'tail', clusters: [face, 3 + Math.floor(rng() * 21)] };
    shotLayouts.push({ t0: prev, t1: cut, ...layout });
    prev = cut;
  }
  // guarantee every tail cluster 3..23 appears at least once
  for (let c = 3; c <= 23; c++) {
    const shot = shotLayouts[(c * 11) % shotLayouts.length];
    if (!shot.clusters.includes(c)) shot.clusters.push(c);
  }

  const faces = [];
  let trackId = 0;
  const openTracks = new Map(); // cluster → {track_id, start_t, last_t, samples, areas}
  const tracks = [];
  const closeTrack = (c, tr) => {
    tracks.push({
      cluster_id: c,
      track_id: tr.track_id,
      start_t: r4(tr.start_t),
      end_t: r4(tr.last_t),
      frame_count: tr.samples,
      median_box_area: r4(tr.areas.sort((a, b) => a - b)[Math.floor(tr.areas.length / 2)]),
    });
  };

  let shotIdx = 0;
  let assigned = 0;
  for (let k = 0; k < Math.round(DURATION_S * 5) - 2; k++) {
    const t = r4(0.1 + k * 0.2);
    while (shotIdx < shotLayouts.length - 1 && t >= shotLayouts[shotIdx].t1) shotIdx++;
    const shot = shotLayouts[shotIdx];
    const sp = speakerAt(t);
    const spCluster = CLUSTER_OF[sp];
    const detections = [];
    for (const c of shot.clusters) {
      const [cx, cy, w, h] = CLUSTER_BOX(c);
      const jx = between(-0.012, 0.012);
      const jy = between(-0.01, 0.01);
      const box = [r4(cx + jx), r4(cy + jy), r4(cx + jx + w), r4(cy + jy + h)];
      const det = { box, cluster_id: c, score: r4(between(0.86, 0.98)), track_id: -1 };
      // ASD: the speaker's on-screen face scores high; two-shot listeners low.
      // Voice-only speakers (s3/s4) leak a low-confidence vote onto whoever is
      // on screen while they talk — the measured real-world crosstalk shape.
      if (sp !== null) {
        if (c === spCluster) { det.speak_conf = r4(between(0.6, 0.97)); assigned++; }
        else if (spCluster === undefined && shot.clusters[0] === c) { det.speak_conf = r4(between(0.35, 0.7)); assigned++; }
        else if (shot.kind === 'two' && rng() < 0.5) { det.speak_conf = r4(between(0.03, 0.22)); assigned++; }
      }
      // track bookkeeping
      let tr = openTracks.get(c);
      if (!tr || t - tr.last_t > 0.25) {
        if (tr) closeTrack(c, tr);
        tr = { track_id: trackId++, start_t: t, last_t: t, samples: 0, areas: [] };
        openTracks.set(c, tr);
      }
      tr.last_t = t;
      tr.samples++;
      tr.areas.push(r4(w * h));
      det.track_id = tr.track_id;
      detections.push(det);
    }
    // close tracks for clusters that left the frame
    for (const [c, tr] of [...openTracks]) {
      if (!shot.clusters.includes(c) && t - tr.last_t > 0.25) { closeTrack(c, tr); openTracks.delete(c); }
    }
    faces.push({ t, detections });
  }
  for (const [c, tr] of openTracks) closeTrack(c, tr);
  tracks.sort((a, b) => a.start_t - b.start_t || a.track_id - b.track_id);

  const scenes = cuts.map((ts) => ({
    before_frame: { pts: Math.round((ts - 1 / 29.97) * 30000), timestamp: r4(ts - 1 / 29.97) },
    after_frame: { pts: Math.round(ts * 30000), timestamp: r4(ts) },
  }));

  return {
    project_id: 'demo_prototype_hour_0000',
    analysis: 'vision',
    status: 'completed',
    error: null,
    agent_context: {
      time_unit: 'seconds',
      time_origin: 'start of source video',
      boxes: 'normalized [x0, y0, x1, y1]',
      scenes: 'hard cuts — use as edit cut points',
    },
    faces,
    face_tracks: tracks,
    scenes,
    asd: { ran: true, reason: null, assigned, carried: assigned },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'fixtures';
  mkdirSync(outDir, { recursive: true });
  const transcript = buildTranscript();
  const vision = buildVision(transcript);
  writeFileSync(join(outDir, 'transcript_v2.json'), JSON.stringify(transcript, null, 1) + '\n');
  writeFileSync(join(outDir, 'vision_v2.json'), JSON.stringify(vision, null, 1) + '\n');
  const hook = ANCHORS.hook.text.split(' ');
  const hookStart = transcript.words.findIndex((w, i) => w.text === 'I'
    && transcript.words.slice(i, i + hook.length).map((x) => x.text).join(' ') === hook.join(' '));
  console.error(JSON.stringify({
    words: transcript.words.length,
    utterances: transcript.utterances.length,
    speakers: transcript.speakers.map((s) => [s.speaker, s.total_duration, s.utterance_count]),
    faces: vision.faces.length,
    tracks: vision.face_tracks.length,
    scenes: vision.scenes.length,
    clusters: [...new Set(vision.faces.flatMap((f) => f.detections.map((d) => d.cluster_id)))].length,
    asd: vision.asd,
    defect_word_idx: 3,
    hook_word_range: [hookStart, hookStart + hook.length],
    gap: 'silence 333.1..338.5 (5.4s)',
  }, null, 2));
}

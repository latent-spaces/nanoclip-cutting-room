// replay.mjs — replays the recorded run from fixtures on a compressed
// timeline, into a live run dir the server/page consume. Development + demo tool:
// the full arc (upload → transcript → vision → cut → clips) with zero API spend.
// Clip hooks in the finale are quotes from the demo transcript; the cut itself
// is simulated — the real editorial pass owns real runs.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  initState, extractTranscriptSummary, extractVisionSummary, extractStripThumbs,
  extractFaceCrops, extractAsdFrame,
} from './watcher.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

// Measured rhythm of the recorded run.
const RECORDED = { upload_s: 23.7, transcript_s: 112, vision_s: 196 };

// Synthetic "footage" for the keyless demo: studio frames and face crops
// composed from the generated cast portraits in fixtures/cast. Box coords are
// normalized and match where the compositions place each face; cluster ids
// mirror the demo cast (Rio=0, Juno=1, Mars=2).
const SYN_BOX = {
  wide: [
    [0.144, 0.321, 0.239, 0.524, 0],
    [0.452, 0.321, 0.548, 0.524, 1],
    [0.761, 0.321, 0.856, 0.524, 2],
  ],
  solo: (cluster) => [[0.32, 0.02, 0.68, 0.79, cluster]],
  duo: [
    [0.202, 0.247, 0.337, 0.533, 0],
    [0.663, 0.247, 0.798, 0.533, 1],
  ],
};
const SYN_STRIP = [
  { file: 'wide.jpg', boxes: SYN_BOX.wide },
  { file: 'solo-rio.jpg', boxes: SYN_BOX.solo(0) },
  { file: 'solo-juno.jpg', boxes: SYN_BOX.solo(1) },
  { file: 'duo.jpg', boxes: SYN_BOX.duo },
  { file: 'solo-mars.jpg', boxes: SYN_BOX.solo(2) },
  { file: 'wide.jpg', boxes: SYN_BOX.wide },
];

function seedSyntheticVision(dir, duration_s) {
  const frames = join(FIXTURES, 'cast', 'frames');
  if (!existsSync(frames)) return null;
  mkdirSync(join(dir, 'thumbs'), { recursive: true });
  const strip = SYN_STRIP.map((s, i) => {
    const rel = `thumbs/strip-${i}.jpg`;
    copyFileSync(join(frames, s.file), join(dir, rel));
    return { t: Math.round(((i + 0.5) / 6) * duration_s * 100) / 100, boxes: s.boxes, thumb: rel };
  });
  const faces_by_cluster = ['rio', 'juno', 'mars'].map((name, cluster) => {
    const crops = [];
    for (let i = 0; i < 3; i++) {
      const from = join(FIXTURES, 'cast', 'crops', `cl-${name}-${i}.jpg`);
      if (!existsSync(from)) continue;
      const rel = `thumbs/face-${cluster}-${i}.jpg`;
      copyFileSync(from, join(dir, rel));
      crops.push(rel);
    }
    return { cluster, crops };
  });
  copyFileSync(join(frames, 'duo.jpg'), join(dir, 'thumbs', 'asd.jpg'));
  const asd_moment = { t: 222, box: SYN_BOX.duo[0].slice(0, 4), speak_conf: 0.94, cluster: 0, thumb: 'thumbs/asd.jpg' };
  return { strip, faces_by_cluster, asd_moment };
}

const writeJsonAtomic = (path, obj) => {
  writeFileSync(path + '.tmp', JSON.stringify(obj, null, 2) + '\n');
  renameSync(path + '.tmp', path);
};

export async function replayRun({ dir, speed = 8, finale = false, source = null } = {}) {
  mkdirSync(join(dir, 'data'), { recursive: true });
  const plan = {
    schema: 'cutting-room/plan@2',
    source: {
      path: source ?? 'h264_aac_1080p_10min.mp4',
      duration_s: 600.066, width: 1920, height: 1080,
      mezzanine_path: null,
      project_id: '2026-01-12_093000Z_api_demo-panel-10min-mp4_0000',
    },
    analyses: {
      transcript: { status: 'running', path: null, cost_usd: '0.03' },
      vision: { status: 'running', path: null, cost_usd: '0.55' },
    },
  };
  writeJsonAtomic(join(dir, 'plan.json'), plan);

  const state = initState(plan);
  state.video.bytes = 192384833;
  state.stages.upload.seconds = RECORDED.upload_s;
  const flush = () => {
    state.updated_at = new Date().toISOString();
    writeJsonAtomic(join(dir, 'state.json'), state);
  };
  flush();

  const tick = (s) => sleep((s * 1000) / speed);

  // plain frames of the source up front — the chase-light's reveal material
  // (real source when given, the composed studio frames otherwise)
  const syn = source ? null : seedSyntheticVision(dir, plan.source.duration_s);
  if (source) {
    state.frames = await extractStripThumbs(dir, state);
    flush();
  } else if (syn) {
    state.frames = syn.strip.map(({ t, thumb }) => ({ t, boxes: [], thumb }));
    flush();
  }

  // transcript lands
  await tick(RECORDED.transcript_s);
  copyFileSync(join(FIXTURES, 'transcript_v2.json'), join(dir, 'data', 'transcript.json'));
  const transcript = JSON.parse(readFileSync(join(dir, 'data', 'transcript.json'), 'utf8'));
  state.stages.transcript = {
    ...state.stages.transcript, status: 'completed',
    ended_at: new Date().toISOString(), seconds: RECORDED.transcript_s,
  };
  state.artifacts.transcript = extractTranscriptSummary(transcript, state.video);
  state.facts.speakers = state.artifacts.transcript.speakers;
  flush();

  // vision lands (strip thumbs only when a real local source is provided)
  await tick(RECORDED.vision_s - RECORDED.transcript_s);
  copyFileSync(join(FIXTURES, 'vision_v2.json'), join(dir, 'data', 'vision.json'));
  const vision = JSON.parse(readFileSync(join(dir, 'data', 'vision.json'), 'utf8'));
  state.stages.vision = {
    ...state.stages.vision, status: 'completed',
    ended_at: new Date().toISOString(), seconds: RECORDED.vision_s,
  };
  state.artifacts.vision = extractVisionSummary(vision, state.video);
  if (source) {
    state.artifacts.vision.strip = await extractStripThumbs(dir, state, vision);
    state.artifacts.vision.faces_by_cluster = await extractFaceCrops(dir, state, vision);
    state.artifacts.vision.asd_moment = await extractAsdFrame(dir, state, vision);
  } else if (syn) {
    state.artifacts.vision.strip = syn.strip;
    state.artifacts.vision.faces_by_cluster = syn.faces_by_cluster;
    state.artifacts.vision.asd_moment = syn.asd_moment;
  }
  state.facts.scene_cuts = state.artifacts.vision.scene_cuts;
  flush();

  if (!finale) return state;

  // the finale arc, simulated: cut runs, three clips land, the foot band commits
  state.stages.cast = { status: 'running', started_at: new Date().toISOString(), expected_s: 8 };
  flush();
  await tick(8);
  state.stages.cast = { ...state.stages.cast, status: 'completed', ended_at: new Date().toISOString(), seconds: 8 };
  // The fused cast lands with the stage — the demo panel from the fixtures:
  // Rio hosts (speaker 0), Juno arrives split across two speaker ids (1 + 5,
  // the diarization-split case), Mars is speaker 2. Portraits are synthetic
  // generated stills shipped in fixtures/cast.
  const rollup = new Map((transcript.speakers ?? []).map((s) => [s.speaker, s.total_duration]));
  const round2 = (v) => Math.round(v * 100) / 100;
  mkdirSync(join(dir, 'cast'), { recursive: true });
  state.artifacts.cast = [
    { person_id: 'p0', label: 'Rio', role: 'host', speakers: [0], file: 'rio.jpg' },
    { person_id: 'p1', label: 'Juno', role: 'panelist', speakers: [1, 5], file: 'juno.jpg' },
    { person_id: 'p2', label: 'Mars', role: 'panelist', speakers: [2], file: 'mars.jpg' },
  ].map((m) => {
    const src = join(FIXTURES, 'cast', m.file);
    let thumb = null;
    if (existsSync(src)) {
      copyFileSync(src, join(dir, 'cast', m.file));
      thumb = `cast/${m.file}`;
    }
    return {
      person_id: m.person_id, label: m.label, role: m.role, thumb,
      speaking_s: round2(m.speakers.reduce((acc, s) => acc + (rollup.get(s) ?? 0), 0)),
    };
  });
  state.stages.cut = { status: 'running', started_at: new Date().toISOString(), expected_s: 20 };
  flush();
  await tick(20);
  state.stages.cut = { ...state.stages.cut, status: 'completed', ended_at: new Date().toISOString(), seconds: 20 };
  state.stages.clips = { status: 'completed', ended_at: new Date().toISOString() };
  // Quotes from the demo transcript; the cut around them is simulated.
  state.artifacts.clips = [
    { hook: '"I got a DM from a haunted vending machine"', duration_s: 32 },
    { hook: '"We built the worst toaster in recorded history"', duration_s: 27 },
    { hook: '"That is the saddest robot I have ever seen"', duration_s: 41 },
  ];
  state.preview_url = '#clips-zone'; // the page's own clips anchor
  flush();
  return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const dir = flag('dir');
  if (!dir) {
    console.error('usage: replay.mjs --dir <rundir> [--speed 8] [--source <video>] [--finale]');
    process.exit(2);
  }
  const state = await replayRun({
    dir,
    speed: Number(flag('speed') ?? 8),
    source: flag('source') ?? null,
    finale: argv.includes('--finale'),
  });
  console.log(JSON.stringify({ done: true, stages: Object.fromEntries(Object.entries(state.stages).map(([k, v]) => [k, v.status])) }));
  console.error('replay finished');
}

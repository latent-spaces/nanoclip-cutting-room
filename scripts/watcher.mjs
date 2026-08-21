// watcher.mjs — per-analysis `nanoclip <analysis> get --wait` → state.json events.
// Zero agent tokens while analyses cook: this process owns the wait, extracts small
// real summaries from landed payloads (full payloads never enter chat context — note
// that `get` echoes the payload to stdout even with -o, so stdout is ignored here),
// and keeps state.json + plan.json current for the screen's SSE push.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const STATE_SCHEMA = 'cutting-room/state@1';
// Measured on the recorded 10-min run: transcript+diarize 112s, vision 196s.
export const EXPECTED_RATIO = { transcript: 112 / 600, vision: 196 / 600 };
const SCENE_TICK_BUCKETS = 48;

const nowIso = () => new Date().toISOString();

const writeJsonAtomic = (path, obj) => {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path); // readers (server SSE, the page) never see a torn file
};

const centsFromUsd = (usd) => Math.round(Number(usd) * 100);

const totalUsd = (plan) => {
  const cents = Object.values(plan.analyses ?? {})
    .reduce((sum, a) => sum + (a.cost_usd ? centsFromUsd(a.cost_usd) : 0), 0);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
};

// Bucket a list of timestamps into a normalized 0..1 density row (rail/strip ticks).
const bucketize = (times, duration_s, buckets = SCENE_TICK_BUCKETS) => {
  const ticks = new Array(buckets).fill(0);
  for (const t of times) {
    const b = Math.min(buckets - 1, Math.max(0, Math.floor((t / duration_s) * buckets)));
    ticks[b] += 1;
  }
  const max = Math.max(1, ...ticks);
  return ticks.map((v) => Math.round((v / max) * 100) / 100);
};

export function extractTranscriptSummary(payload, { duration_s } = {}) {
  const words = payload.words ?? [];
  const spk = [...(payload.speakers ?? [])].sort((a, b) => b.total_duration - a.total_duration);
  const talkTotal = spk.reduce((s, r) => s + r.total_duration, 0) || 1;
  return {
    speakers: (payload.speakers ?? []).length,
    utterances: (payload.utterances ?? []).length,
    words: words.length,
    words_head: words.slice(0, 12).map((w) => w.text),
    word_ticks: bucketize(words.map((w) => w.start), duration_s ?? 1),
    // Real diarization rows for the hero card: who talked, for how long.
    speaker_rows: spk.slice(0, 6).map((r) => ({
      speaker: r.speaker,
      seconds: Math.round(r.total_duration),
      share: Math.round((r.total_duration / talkTotal) * 100) / 100,
    })),
    path: 'data/transcript.json',
  };
}

export function extractVisionSummary(payload, { duration_s }) {
  const clusters = new Set((payload.face_tracks ?? []).map((t) => t.cluster_id));
  return {
    face_clusters: clusters.size,
    face_tracks: (payload.face_tracks ?? []).length,
    scene_cuts: (payload.scenes ?? []).length,
    asd_ran: Boolean(payload.asd?.ran),
    scene_ticks: bucketize((payload.scenes ?? []).map((s) => s.after_frame?.timestamp ?? 0), duration_s),
    path: 'data/vision.json',
  };
}

// Evenly spaced real frames for the vision strip: each carries the face boxes of
// the nearest 5fps sample, so the page can overlay real detections on real frames.
export function extractVisionStrip(payload, { duration_s, n = 6 }) {
  const faces = payload.faces ?? [];
  return Array.from({ length: n }, (_, i) => {
    const t = ((i + 0.5) / n) * duration_s;
    let nearest = null;
    for (const f of faces) {
      if (!nearest || Math.abs(f.t - t) < Math.abs(nearest.t - t)) nearest = f;
    }
    // Each box is [x0, y0, x1, y1] plus the detection's cluster id when it has
    // one — the page colors boxes per person with it (additive 5th element).
    return {
      t: Math.round(t * 100) / 100,
      boxes: (nearest?.detections ?? []).map((d) => (
        Number.isInteger(d.cluster_id) ? [...d.box, d.cluster_id] : [...d.box]
      )),
    };
  });
}

// The ASD hero moment: the single detection the model is most sure is speaking.
export function pickAsdMoment(payload) {
  let best = null;
  for (const sample of payload.faces ?? []) {
    for (const d of sample.detections ?? []) {
      if (typeof d.speak_conf !== 'number' || (d.score ?? 0) <= 0.85) continue;
      if (!best || d.speak_conf > best.speak_conf) {
        best = { t: sample.t, box: d.box, speak_conf: d.speak_conf, cluster: d.cluster_id };
      }
    }
  }
  return best;
}

// Face-crop specs for the hero clustering card: the top clusters by presence,
// each sampled across its own time span so the row reads "same person, whole video".
export function pickFaceCropSpecs(payload, { clusters = 3, perCluster = 4 } = {}) {
  const byCluster = new Map();
  for (const sample of payload.faces ?? []) {
    for (const d of sample.detections ?? []) {
      if ((d.score ?? 0) <= 0.85 || d.cluster_id === undefined) continue;
      if (!byCluster.has(d.cluster_id)) byCluster.set(d.cluster_id, []);
      byCluster.get(d.cluster_id).push({ t: sample.t, box: d.box });
    }
  }
  const top = [...byCluster.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, clusters);
  return top.map(([cluster, dets]) => {
    dets.sort((a, b) => a.t - b.t);
    const span = dets[dets.length - 1].t - dets[0].t || 1;
    const picks = [];
    for (let i = 0; i < perCluster; i++) {
      const bucket = dets.filter((d) => {
        const rel = (d.t - dets[0].t) / span;
        return rel >= i / perCluster && rel <= (i + 1) / perCluster;
      });
      if (!bucket.length) continue;
      const area = (d) => (d.box[2] - d.box[0]) * (d.box[3] - d.box[1]);
      picks.push(bucket.reduce((m, d) => (area(d) > area(m) ? d : m)));
    }
    return { cluster, picks };
  });
}

export function initState(plan) {
  const d = plan.source.duration_s;
  const t = nowIso();
  return {
    schema: STATE_SCHEMA,
    updated_at: t,
    project_id: plan.source.project_id,
    video: {
      name: plan.source.path,
      duration_s: d,
      width: plan.source.width,
      height: plan.source.height,
    },
    facts: { speakers: null, scene_cuts: null, total_usd: totalUsd(plan) },
    stages: {
      upload: { status: 'completed', ended_at: t },
      transcript: { status: 'running', started_at: t, expected_s: Math.round(d * EXPECTED_RATIO.transcript) },
      vision: { status: 'running', started_at: t, expected_s: Math.round(d * EXPECTED_RATIO.vision) },
      cast: { status: 'waiting' },
      cut: { status: 'waiting' },
      clips: { status: 'waiting' },
    },
    artifacts: { transcript: null, vision: null },
  };
}

const EXTRACTORS = {
  transcript: (payload, video) => extractTranscriptSummary(payload, video),
  vision: (payload, video) => extractVisionSummary(payload, video),
};

const sourcePath = async (dir, state) => {
  const { isAbsolute, resolve } = await import('node:path');
  const src = isAbsolute(state.video.name) ? state.video.name : resolve(dir, '..', state.video.name);
  return existsSync(src) ? src : null;
};

const grabFrame = (src, t, out, vf = 'scale=320:-2') => new Promise((resolveFfmpeg, rejectFfmpeg) => {
  const ff = spawn('ffmpeg', [
    '-y', '-ss', String(t), '-i', src,
    '-frames:v', '1', '-vf', vf, '-q:v', '5', out,
  ], { stdio: 'ignore' });
  ff.on('error', rejectFfmpeg);
  ff.on('close', (code) => (code === 0 ? resolveFfmpeg() : rejectFfmpeg(new Error(`ffmpeg exit ${code}`))));
});

// A seek past the last frame yields no output — step back and take what exists.
const grabFrameSafe = async (src, t, out, vf) => {
  try { await grabFrame(src, t, out, vf); } catch { /* fall through to the step-back retry */ }
  if (!existsSync(out)) {
    try { await grabFrame(src, Math.max(0, t - 0.5), out, vf); } catch { /* skip this frame */ }
  }
  return existsSync(out);
};

// Extract real strip frames from the local source with ffmpeg (analysis-decoupled:
// the render reads the same local original later). With no payload it takes evenly
// spaced plain frames — the pre-vision reveal material. Idempotent: the timestamps
// are the same either way, so frames already on disk are reused. Tolerant: no source
// or no ffmpeg simply means no strip — the page falls back to its tick rows.
export async function extractStripThumbs(dir, state, payload = null) {
  const src = await sourcePath(dir, state);
  if (!src) return null;
  const d = state.video.duration_s;
  const specs = payload
    ? extractVisionStrip(payload, { duration_s: d })
    : Array.from({ length: 6 }, (_, i) => ({ t: Math.round(((i + 0.5) / 6) * d * 100) / 100, boxes: [] }));
  mkdirSync(join(dir, 'thumbs'), { recursive: true });
  const strip = [];
  for (const [i, spec] of specs.entries()) {
    const rel = `thumbs/strip-${i}.jpg`;
    const out = join(dir, rel);
    if (existsSync(out) || await grabFrameSafe(src, spec.t, out)) strip.push({ ...spec, thumb: rel });
  }
  return strip.length ? strip : null;
}

// Real face crops for the hero clustering card, one row per top cluster.
export async function extractFaceCrops(dir, state, payload) {
  const src = await sourcePath(dir, state);
  if (!src) return null;
  mkdirSync(join(dir, 'thumbs'), { recursive: true });
  const rows = [];
  for (const { cluster, picks } of pickFaceCropSpecs(payload)) {
    const crops = [];
    for (const [i, pick] of picks.entries()) {
      const [x0, y0, x1, y1] = pick.box;
      const padX = (x1 - x0) * 0.35;
      const padY = (y1 - y0) * 0.35;
      const cx = Math.max(0, x0 - padX);
      const cy = Math.max(0, y0 - padY);
      const cw = Math.min(1, x1 + padX) - cx;
      const ch = Math.min(1, y1 + padY) - cy;
      const vf = `crop=iw*${cw.toFixed(4)}:ih*${ch.toFixed(4)}:iw*${cx.toFixed(4)}:ih*${cy.toFixed(4)},scale=120:-2`;
      const rel = `thumbs/face-${cluster}-${i}.jpg`;
      if (await grabFrameSafe(src, pick.t, join(dir, rel), vf)) crops.push(rel);
    }
    if (crops.length) rows.push({ cluster, crops });
  }
  return rows.length ? rows : null;
}

// The ASD hero moment as a real frame the page can draw the speaking box on.
export async function extractAsdFrame(dir, state, payload) {
  const src = await sourcePath(dir, state);
  const moment = src && pickAsdMoment(payload);
  if (!moment) return null;
  mkdirSync(join(dir, 'thumbs'), { recursive: true });
  const rel = 'thumbs/asd.jpg';
  if (!(await grabFrameSafe(src, moment.t, join(dir, rel)))) return null;
  return { ...moment, thumb: rel };
}

// Watch one dispatched project: a `get --wait` child per analysis, state/plan kept
// current on every terminal event. Resolves when every analysis is terminal.
export async function watchAnalyses({
  dir,
  analyses = ['transcript', 'vision'],
  bin = 'nanoclip',
  env = process.env,
} = {}) {
  const planPath = join(dir, 'plan.json');
  const statePath = join(dir, 'state.json');
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : initState(plan);
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeJsonAtomic(statePath, state);

  const flush = () => {
    state.updated_at = nowIso();
    writeJsonAtomic(statePath, state);
    writeJsonAtomic(planPath, plan);
  };

  // Plain frames of the user's own footage, extracted up front: the chase-light
  // has something real to reveal while vision cooks (boxes join on completion).
  if (!state.frames) {
    state.frames = await extractStripThumbs(dir, state);
    if (state.frames) flush();
  }

  const runOne = (analysis) => new Promise((resolve) => {
    const outPath = join(dir, 'data', `${analysis}.json`);
    const stage = state.stages[analysis];
    const finish = async (ok, error) => {
      stage.ended_at = nowIso();
      stage.seconds = Math.round((Date.parse(stage.ended_at) - Date.parse(stage.started_at)) / 10) / 100;
      if (ok) {
        stage.status = 'completed';
        const payload = JSON.parse(readFileSync(outPath, 'utf8'));
        const summary = EXTRACTORS[analysis](payload, state.video);
        if (analysis === 'vision') {
          summary.strip = await extractStripThumbs(dir, state, payload);
          summary.faces_by_cluster = await extractFaceCrops(dir, state, payload);
          summary.asd_moment = await extractAsdFrame(dir, state, payload);
        }
        state.artifacts[analysis] = summary;
        if (analysis === 'transcript') state.facts.speakers = summary.speakers;
        if (analysis === 'vision') state.facts.scene_cuts = summary.scene_cuts;
        plan.analyses[analysis] = { ...plan.analyses[analysis], status: 'completed', path: summary.path };
      } else {
        stage.status = 'failed';
        stage.error = error;
        plan.analyses[analysis] = { ...plan.analyses[analysis], status: 'failed' };
      }
      flush();
      resolve(ok);
    };
    stage.status = 'running';
    stage.started_at ??= nowIso();
    let stderr = '';
    const child = spawn(bin, [analysis, 'get', '-p', state.project_id, '--wait', '-o', outPath], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'], // stdout carries the full payload echo — never read it
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    child.on('error', (err) => finish(false, err.message));
    child.on('close', (code) => {
      if (code === 0 && existsSync(outPath)) return finish(true);
      const tail = stderr.trim().split('\n').filter(Boolean).pop() ?? `exit code ${code}`;
      return finish(false, tail.slice(0, 300));
    });
  });

  const results = await Promise.all(analyses.map(runOne));
  return {
    completed: results.filter(Boolean).length,
    failed: results.filter((r) => !r).length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const dir = flag('dir');
  if (!dir) {
    console.error('usage: watcher.mjs --dir <workdir>/cutting-room [--analyses transcript,vision] [--bin nanoclip]');
    process.exit(2);
  }
  const analyses = (flag('analyses') ?? 'transcript,vision').split(',').filter(Boolean);
  const summary = await watchAnalyses({ dir, analyses, bin: flag('bin') ?? 'nanoclip' });
  console.log(JSON.stringify(summary));
  console.error(`watcher done — ${summary.completed} completed, ${summary.failed} failed`);
  process.exit(summary.failed ? 1 : 0);
}

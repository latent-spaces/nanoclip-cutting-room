// reframe.mjs — camera state from faces (references/reframe.md).
// Deterministic: extract cuts + transcript turns + face boxes + plan.cast →
// plan.clips[].reframe.shots. Piecewise-constant framing, switches only at cuts;
// split when two cast persons talk inside a shot; downgrades honestly when a
// speaker has no visible face. All frame math lives on the clip proxy's 30fps grid.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const COMPOSE_W = 1080;
export const COMPOSE_H = 1920;
export const TARGET_FACE_SHARE = 0.28; // face width vs pane width a solo crop aims for
export const ZOOM_MAX = 1.5;
// Shot polish (fixes reported jump-cuts at scene seams):
// a shot shorter than this is a crop flash, absorbed by its neighbor
export const MIN_SHOT_FRAMES = 8;
// same person, same layout, crop within these deltas -> reuse the previous crop
// verbatim (the measured jolts were 0.003-0.005 -> 15px); identical adjacent shots
// then collapse into ONE element so the seam cannot exist at all
export const CONTINUITY_EPS_POS = 0.02;
export const CONTINUITY_EPS_ZOOM = 0.1;

const median = (values) => {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? v[(v.length - 1) >> 1] : null;
};
const round3 = (x) => Math.round(x * 1000) / 1000;

// Normalized pane spec → static px placement of the source sheet inside a pane.
// The sheet always covers the pane (cover scale × zoom); the face lands as close
// to the pane center as the clamps allow — never a gap at any edge.
export function cropPx({ cx, cy, zoom }, { paneW, paneH, srcW = 1920, srcH = 1080 }) {
  const scale = zoom * Math.max(paneW / srcW, paneH / srcH);
  const width = Math.round(srcW * scale);
  const height = Math.round(srcH * scale);
  const left = Math.round(Math.min(0, Math.max(paneW - width, paneW / 2 - cx * width)));
  const top = Math.round(Math.min(0, Math.max(paneH - height, paneH / 2 - cy * height)));
  return { width, height, left, top };
}

const paneZoom = (faceW, layout, srcW, srcH) => {
  const paneH = layout === 'split' ? COMPOSE_H / 2 : COMPOSE_H;
  const dispW = srcW * Math.max(COMPOSE_W / srcW, paneH / srcH);
  const raw = (TARGET_FACE_SHARE * COMPOSE_W) / (faceW * dispW);
  return Math.round(Math.min(ZOOM_MAX, Math.max(1, raw)) * 100) / 100;
};

export function deriveShots(clip, transcript, vision, cast, { srcW = 1920, srcH = 1080 } = {}) {
  const ex = clip.composition.extract;
  const personOf = new Map();
  for (const p of cast) for (const s of p.speaker_ids ?? []) personOf.set(s, p);
  const castIndex = new Map(cast.map((p, i) => [p.person_id, i]));

  // median face (cx, cy, w) of a person inside a source-time window
  const faceIn = (person, t0, t1) => {
    const clusters = new Set(person.cluster_ids ?? []);
    const xs = []; const ys = []; const ws = [];
    for (const f of vision.faces ?? []) {
      if (f.t < t0 || f.t > t1) continue;
      for (const d of f.detections ?? []) {
        if (!clusters.has(d.cluster_id)) continue;
        xs.push((d.box[0] + d.box[2]) / 2);
        ys.push((d.box[1] + d.box[3]) / 2);
        ws.push(d.box[2] - d.box[0]);
      }
    }
    return xs.length ? { cx: round3(median(xs)), cy: round3(median(ys)), w: median(ws) } : null;
  };

  const mostVisible = (t0, t1) => {
    let best = null;
    for (const p of cast) {
      const clusters = new Set(p.cluster_ids ?? []);
      let n = 0;
      for (const f of vision.faces ?? []) {
        if (f.t < t0 || f.t > t1) continue;
        if ((f.detections ?? []).some((d) => clusters.has(d.cluster_id))) n += 1;
      }
      if (n > 0 && (!best || n > best.n)) best = { p, n };
    }
    return best?.p ?? null;
  };

  const shots = [];
  let base = 0;
  for (const seg of clip.segments) {
    const segShots = [];
    const segFrames = Math.round((seg.src_out - seg.src_in) * ex.fps);
    const proxyIn = Math.round((seg.src_in - ex.start) * ex.fps);
    const proxyOut = proxyIn + segFrames;
    const bounds = [proxyIn, ...ex.cuts.filter((f) => f > proxyIn && f < proxyOut), proxyOut];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const t0 = ex.start + bounds[i] / ex.fps;
      const t1 = ex.start + bounds[i + 1] / ex.fps;
      // speech seconds per cast person inside this shot
      const speech = new Map();
      for (const u of transcript.utterances ?? []) {
        const person = personOf.get(u.speaker);
        if (!person) continue;
        const overlap = Math.min(u.end, t1) - Math.max(u.start, t0);
        if (overlap > 0) speech.set(person.person_id, (speech.get(person.person_id) ?? 0) + overlap);
      }
      const minSpeech = Math.min(0.5, (t1 - t0) / 2);
      const active = [...speech.entries()]
        .filter(([, s]) => s >= minSpeech)
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => cast[castIndex.get(id)]);
      const faced = active.map((p) => ({ p, face: faceIn(p, t0, t1) })).filter((x) => x.face);

      let layout; let picks;
      if (faced.length >= 2) {
        layout = 'split';
        picks = faced.slice(0, 2).sort((a, b) => castIndex.get(a.p.person_id) - castIndex.get(b.p.person_id));
      } else if (faced.length === 1) {
        layout = 'solo';
        picks = faced;
      } else {
        const vis = mostVisible(t0, t1);
        const face = vis && faceIn(vis, t0, t1);
        layout = 'solo';
        picks = face ? [{ p: vis, face }] : null;
      }
      const panes = picks
        ? picks.map(({ p, face }) => ({
          person: p.person_id,
          cx: face.cx,
          cy: face.cy,
          zoom: paneZoom(face.w, layout, srcW, srcH),
        }))
        : [{ person: null, cx: 0.5, cy: 0.5, zoom: 1 }];
      segShots.push({ f0: base + bounds[i] - proxyIn, f1: base + bounds[i + 1] - proxyIn, layout, panes });
    }
    shots.push(...polishShots(segShots));
    base += segFrames;
  }
  return shots;
}

// The polish pass, per segment (never across a segment seam — media time is only
// continuous inside one segment): absorb tiny shots, snap micro-delta crops to the
// previous shot's panes, collapse identical neighbors into one element.
const samePeople = (a, b) => a.layout === b.layout && a.panes.length === b.panes.length
  && a.panes.every((p, i) => p.person === b.panes[i].person);
const nearPanes = (a, b) => a.panes.every((p, i) => {
  const q = b.panes[i];
  return Math.abs(p.cx - q.cx) <= CONTINUITY_EPS_POS
    && Math.abs(p.cy - q.cy) <= CONTINUITY_EPS_POS
    && Math.abs(p.zoom - q.zoom) <= CONTINUITY_EPS_ZOOM;
});
function polishShots(list) {
  const out = list.map((s) => ({ ...s, panes: s.panes.map((p) => ({ ...p })) }));
  // 1 · tiny shots: merge into the previous (the first merges forward instead)
  for (let i = 0; i < out.length;) {
    if (out.length > 1 && out[i].f1 - out[i].f0 < MIN_SHOT_FRAMES) {
      if (i > 0) { out[i - 1].f1 = out[i].f1; out.splice(i, 1); }
      else { out[1].f0 = out[0].f0; out.splice(0, 1); }
    } else i += 1;
  }
  // 2 · continuity snap: micro-delta same-person crops reuse the previous crop
  for (let i = 1; i < out.length; i++) {
    if (samePeople(out[i - 1], out[i]) && nearPanes(out[i - 1], out[i])) {
      out[i].panes = out[i - 1].panes.map((p) => ({ ...p }));
    }
  }
  // 3 · collapse: identical adjacent shots become one element (no seam at all)
  for (let i = 1; i < out.length;) {
    if (samePeople(out[i - 1], out[i])
      && out[i - 1].panes.every((p, j) => ['cx', 'cy', 'zoom'].every((k) => p[k] === out[i].panes[j][k]))) {
      out[i - 1].f1 = out[i].f1;
      out.splice(i, 1);
    } else i += 1;
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const [cmd] = argv;
  const dir = flag('dir');
  if (cmd !== 'shots' || !dir) {
    console.error('usage: reframe.mjs shots --dir <workdir>/cutting-room [--clip <id>]');
    process.exit(2);
  }
  const planPath = join(dir, 'plan.json');
  const tPath = join(dir, 'data', 'transcript.json');
  const vPath = join(dir, 'data', 'vision.json');
  for (const [p, what] of [[planPath, 'plan.json'], [tPath, 'transcript payload'], [vPath, 'vision payload']]) {
    if (!existsSync(p)) {
      console.error(`missing ${what} at ${p}`);
      process.exit(1);
    }
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const transcript = JSON.parse(readFileSync(tPath, 'utf8'));
  const vision = JSON.parse(readFileSync(vPath, 'utf8'));
  const cast = plan.cast ?? [];
  const srcW = plan.source?.width ?? 1920;
  const srcH = plan.source?.height ?? 1080;
  const only = flag('clip');
  const summary = {};
  for (const clip of plan.clips ?? []) {
    if (only && clip.id !== only) continue;
    if (!['proposed', 'approved'].includes(clip.status)) continue;
    if (!clip.composition?.extract) {
      console.error(`${clip.id}: no extract — run scaffold.mjs extract first`);
      continue;
    }
    const shots = deriveShots(clip, transcript, vision, cast, { srcW, srcH });
    clip.reframe = { mode: 'asd', shots };
    summary[clip.id] = {
      shots: shots.length,
      splits: shots.filter((s) => s.layout === 'split').length,
      centered: shots.filter((s) => !s.panes[0].person).length,
    };
  }
  writeFileSync(planPath + '.tmp', JSON.stringify(plan, null, 2) + '\n');
  renameSync(planPath + '.tmp', planPath);
  console.log(JSON.stringify(summary));
  console.error(`reframe shots derived for ${Object.keys(summary).length} clip(s)`);
  process.exit(0);
}

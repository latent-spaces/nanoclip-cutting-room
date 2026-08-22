// digest.mjs — the token firewall: unify transcript + vision payloads
// into ONE compact, readable digest.json. The deterministic speaker×cluster join lives
// here; naming and judgment stay with Claude (references/digest.md). Full payloads
// (1.4MB measured) never enter chat context.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DIGEST_SCHEMA = 'cutting-room/digest@1';
export const SAMPLE_DT = 0.2; // faces[] documented at 5fps — one sample ≈ 0.2s on screen
export const TIMELINE_COLUMNS = ['start', 'end', 'speaker', 'word_idx', 'onscreen', 'text'];
const SILENCE_GAP_MIN_S = 2;
const SILENCE_GAPS_MAX = 20;

const round = (v, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;

// First faces[] index with t >= start (faces arrive sorted by t).
const lowerBound = (faces, start) => {
  let lo = 0;
  let hi = faces.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (faces[mid].t < start) lo = mid + 1; else hi = mid;
  }
  return lo;
};

function* samplesIn(faces, start, end) {
  for (let i = lowerBound(faces, start); i < faces.length && faces[i].t <= end; i++) yield faces[i];
}

// Speaker×cluster fusion join: per utterance of each speaker, vote over the face
// samples inside the window — weighted by speak_conf when ASD scored the footage,
// by on-screen presence time when it structurally couldn't (solo speaker) or left
// a speaker without a single scored detection. Method is flagged per speaker, as
// plan@2 cast entries expect (asd | onscreen_fallback).
export function fuseCast(transcript, vision) {
  const faces = vision.faces ?? [];
  const bySpeaker = new Map();
  for (const u of transcript.utterances ?? []) {
    if (!bySpeaker.has(u.speaker)) bySpeaker.set(u.speaker, []);
    bySpeaker.get(u.speaker).push(u);
  }
  const onscreenByCluster = new Map();
  for (const tr of vision.face_tracks ?? []) {
    onscreenByCluster.set(tr.cluster_id, (onscreenByCluster.get(tr.cluster_id) ?? 0) + (tr.end_t - tr.start_t));
  }
  const anyConf = faces.some((f) => (f.detections ?? []).some((d) => typeof d.speak_conf === 'number'));
  const asdUsable = Boolean(vision.asd?.ran) && anyConf;

  const rows = (transcript.speakers ?? []).map((s) => {
    const asdVotes = new Map();
    const seenVotes = new Map();
    for (const u of bySpeaker.get(s.speaker) ?? []) {
      for (const f of samplesIn(faces, u.start, u.end)) {
        for (const d of f.detections ?? []) {
          if (d.cluster_id === undefined) continue;
          seenVotes.set(d.cluster_id, (seenVotes.get(d.cluster_id) ?? 0) + SAMPLE_DT);
          if (typeof d.speak_conf === 'number') {
            asdVotes.set(d.cluster_id, (asdVotes.get(d.cluster_id) ?? 0) + d.speak_conf);
          }
        }
      }
    }
    const useAsd = asdUsable && asdVotes.size > 0;
    const ranked = [...(useAsd ? asdVotes : seenVotes).entries()].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((sum, [, w]) => sum + w, 0);
    const winner = ranked[0];
    return {
      speaker: s.speaker,
      speaking_s: round(s.total_duration, 1),
      utterance_count: s.utterance_count,
      cluster: winner ? winner[0] : null,
      confidence: winner ? round(winner[1] / total, 2) : 0,
      method: useAsd ? 'asd' : 'onscreen_fallback',
      votes: ranked.slice(0, 4).map(([c, w]) => [c, round(w, 2)]),
      // Presence during this speaker's own speech, regardless of method — ASD can
      // vote a two-shot face while the speaker's solo close-up is a different
      // cluster (solo shots structurally never earn speak_conf).
      onscreen_top: [...seenVotes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([c, w]) => [c, round(w, 1)]),
      onscreen_s: winner ? round(onscreenByCluster.get(winner[0]) ?? 0, 1) : 0,
    };
  });
  return rows.sort((a, b) => b.speaking_s - a.speaking_s);
}

// Face clusters visible for at least half of an utterance's face samples — the
// timeline's "who is on screen" column.
const majorityOnscreen = (faces, start, end) => {
  const counts = new Map();
  let samples = 0;
  for (const f of samplesIn(faces, start, end)) {
    samples += 1;
    for (const d of f.detections ?? []) {
      if (d.cluster_id === undefined) continue;
      counts.set(d.cluster_id, (counts.get(d.cluster_id) ?? 0) + 1);
    }
  }
  if (!samples) return [];
  return [...counts.entries()]
    .filter(([, n]) => n >= samples / 2)
    .map(([c]) => c)
    .sort((a, b) => a - b);
};

// Silence gaps between consecutive words (dead air ≥ 2s) — pacing hints for the
// editorial pass. allSilenceGaps is uncapped (sharding hands each region its own
// complete list); the digest's global density row keeps only the longest 20.
const allSilenceGaps = (words) => {
  const gaps = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap >= SILENCE_GAP_MIN_S) gaps.push([round(words[i - 1].end, 1), round(gap, 1)]);
  }
  return gaps;
};

const capGaps = (gaps) => gaps.sort((a, b) => b[1] - a[1]).slice(0, SILENCE_GAPS_MAX).sort((a, b) => a[0] - b[0]);

const silenceGaps = (words) => capGaps(allSilenceGaps(words));

// Visual gap enrichment, the bounded selection: which silence gaps earn
// frames. ≥ minGapS only, top perRegion by length per region (a region = one shard,
// or the whole digest unsharded), frame times at the gap's interior points
// (i+0.5)/n. The bounds are the point — a 4h podcast must not turn into hundreds
// of image reads; there is no global vision pass, ever.
export function pickGapFrameSpecs(regions, { minGapS = 5, perRegion = 3, framesPerGap = 2 } = {}) {
  const specs = [];
  for (const region of regions) {
    const picked = (region.gaps ?? [])
      .filter(([, seconds]) => seconds >= minGapS)
      .sort((a, b) => b[1] - a[1]).slice(0, perRegion)
      .sort((a, b) => a[0] - b[0]);
    for (const [t, seconds] of picked) {
      specs.push({
        seg: region.seg, t, seconds,
        times: Array.from({ length: framesPerGap }, (_, i) => t + seconds * ((i + 0.5) / framesPerGap)),
      });
    }
  }
  return specs;
}

// Fold utterances into speaker turns: consecutive same-speaker utterances merge
// (turn text = utterance texts joined — verified an exact words[] round-trip on the
// recorded payloads), dead air of SILENCE_GAP_MIN_S+ breaks a turn even mid-speaker.
// Sub-turn precision is not lost: every turn carries word_idx, and `locate` resolves
// any word range back to exact times from the full payload.
export function foldTurns(utterances) {
  const turns = [];
  for (const u of utterances) {
    const last = turns.at(-1);
    if (last && last.speaker === u.speaker && u.start - last.end < SILENCE_GAP_MIN_S) {
      last.end = u.end;
      last.text += ` ${u.text}`;
    } else {
      turns.push({ start: u.start, end: u.end, speaker: u.speaker, word_idx: u.word_start_idx, text: u.text });
    }
  }
  return turns;
}

export function buildDigest(transcript, vision, { duration_s } = {}) {
  const words = transcript.words ?? [];
  const faces = vision.faces ?? [];
  const dets = faces.flatMap((f) => f.detections ?? []);
  const withConf = dets.filter((d) => typeof d.speak_conf === 'number').length;
  const duration = round(duration_s ?? Math.max(
    words.at(-1)?.end ?? 0,
    faces.at(-1)?.t ?? 0,
    ...(vision.face_tracks ?? []).map((t) => t.end_t),
  ), 2);
  const minutes = Math.max(1, Math.ceil(duration / 60));
  const wordsPerMin = new Array(minutes).fill(0);
  for (const w of words) wordsPerMin[Math.min(minutes - 1, Math.floor(w.start / 60))] += 1;
  return {
    schema: DIGEST_SCHEMA,
    project_id: transcript.project_id ?? vision.project_id ?? null,
    language: transcript.language ?? null,
    duration_s: duration,
    counts: {
      speakers: (transcript.speakers ?? []).length,
      utterances: (transcript.utterances ?? []).length,
      words: words.length,
      face_clusters: new Set((vision.face_tracks ?? []).map((t) => t.cluster_id)).size,
      face_tracks: (vision.face_tracks ?? []).length,
      scene_cuts: (vision.scenes ?? []).length,
    },
    asd: {
      ran: Boolean(vision.asd?.ran),
      reason: vision.asd?.reason ?? null,
      assigned: vision.asd?.assigned ?? 0,
      carried: vision.asd?.carried ?? 0,
      conf_coverage: dets.length ? round(withConf / dets.length, 2) : 0,
    },
    cast_candidates: fuseCast(transcript, vision),
    timeline_columns: TIMELINE_COLUMNS,
    timeline: foldTurns(transcript.utterances ?? []).map((turn) => [
      round(turn.start, 2), round(turn.end, 2), turn.speaker, turn.word_idx,
      majorityOnscreen(faces, turn.start, turn.end), turn.text,
    ]),
    scene_cuts: (vision.scenes ?? []).map((s) => round(s.after_frame?.timestamp ?? 0, 2)),
    density: { words_per_min: wordsPerMin, silence_gaps: silenceGaps(words) },
    notes: [
      'times are seconds on the source-video timeline',
      'timeline rows follow timeline_columns; onscreen = face clusters visible for at least half the utterance',
      'word_idx = index of the utterance\'s first word in the transcript words[] — cite word indices in plan.transcript_edits',
      'votes are [cluster, weight]: weight = summed speak_conf (method asd) or on-screen seconds during the speaker\'s utterances (method onscreen_fallback); one voice splitting votes across clusters usually means one person seen from different shots',
      'scene_cuts are hard cuts ("use as edit cut points") — snap clip boundaries to them or to utterance edges, never mid-word',
      'density.silence_gaps rows are [t, seconds] of dead air >= 2s (longest 20)',
    ],
  };
}

// Clip boundaries, editorial.md §3 made deterministic: enter/exit on the picked
// words; snap to a scene cut when one sits within 1.5s AND inside the word gap
// (never mid-word by construction); otherwise a small pad inside the gap.
export function snapClip(words, sceneCuts, a, b) {
  const first = words[a];
  const last = words[b - 1];
  const prevEnd = a > 0 ? words[a - 1].end : 0;
  const nextStart = b < words.length ? words[b].start : Infinity;
  const cutIn = sceneCuts
    .filter((t) => t >= Math.max(prevEnd, first.start - 1.5) && t <= first.start).at(-1);
  const cutOut = sceneCuts
    .find((t) => t >= last.end && t <= Math.min(nextStart, last.end + 1.5));
  const padIn = Math.min(0.2, a > 0 ? (first.start - prevEnd) / 2 : first.start);
  const padOut = nextStart === Infinity ? 0.25 : Math.min(0.25, (nextStart - last.end) / 2);
  return {
    word_start_idx: a,
    word_end_idx: b,
    start: round(first.start),
    end: round(last.end),
    src_in: round(cutIn ?? Math.max(0, first.start - padIn)),
    src_out: round(cutOut ?? last.end + padOut),
    snapped_in: cutIn !== undefined ? 'scene_cut' : 'word_gap',
    snapped_out: cutOut !== undefined ? 'scene_cut' : 'word_gap',
  };
}

// ---- sharding — long footage splits the READING layer only. The video
// is never chunked before analysis (speaker/cluster ids are per-response) and the
// join stays global; when the serialized digest outgrows its budget, the timeline
// and scene cuts move into digest.d/seg-NN.json slices and digest.json becomes a
// small index the naming session still reads whole.

export const DIGEST_BUDGET_BYTES = 20 * 1024; // one-context-read ceiling (golden-tested)
export const SHARD_TARGET_BYTES = 15 * 1024;

// Serialized weight of one timeline row in a shard file (JSON + line overhead).
export const shardRowBytes = (row) => JSON.stringify(row).length + 6;

export function shardDigest(digest, transcript, { targetBytes = SHARD_TARGET_BYTES } = {}) {
  const rows = digest.timeline;
  const prefix = [0];
  for (const r of rows) prefix.push(prefix.at(-1) + shardRowBytes(r));
  const bytesBetween = (a, b) => prefix[b] - prefix[a];
  // A seam before row i = dead air between turns — the natural place to cut.
  const seamBefore = rows.map((r, i) => i > 0 && r[0] - rows[i - 1][1] >= SILENCE_GAP_MIN_S);

  const boundaries = [0];
  let start = 0;
  while (start < rows.length) {
    let end = start + 1; // a single over-budget turn still gets its own shard
    while (end < rows.length && bytesBetween(start, end + 1) <= targetBytes) end += 1;
    if (end < rows.length) {
      for (let b = end; b > start; b--) {
        if (seamBefore[b] && bytesBetween(start, b) >= targetBytes / 2) { end = b; break; }
      }
    }
    boundaries.push(end);
    start = end;
  }

  const gaps = allSilenceGaps(transcript.words ?? []);
  const shards = [];
  for (let k = 0; k + 1 < boundaries.length; k++) {
    const [lo, hi] = [boundaries[k], boundaries[k + 1]];
    const timeline = rows.slice(lo, hi);
    // Half-open time ranges pinned to shard-start turns partition cuts and gaps
    // exactly once across shards.
    const rangeStart = k === 0 ? -Infinity : rows[lo][0];
    const rangeEnd = hi === rows.length ? Infinity : rows[hi][0];
    const inRange = (t) => t >= rangeStart && t < rangeEnd;
    shards.push({
      file: `digest.d/seg-${String(k).padStart(2, '0')}.json`,
      data: {
        schema: 'cutting-room/digest-shard@1',
        seg: k,
        t0: timeline[0][0],
        t1: timeline.at(-1)[1],
        timeline_columns: digest.timeline_columns,
        timeline,
        scene_cuts: digest.scene_cuts.filter(inRange),
        silence_gaps: capGaps(gaps.filter(([t]) => inRange(t))),
      },
    });
  }

  const totalWords = digest.counts?.words ?? (transcript.words ?? []).length;
  const index = {};
  for (const [k, v] of Object.entries(digest)) {
    if (k === 'timeline' || k === 'scene_cuts' || k === 'notes') continue;
    index[k] = v;
  }
  index.shards = shards.map(({ file, data }, k) => ({
    file,
    t0: data.t0,
    t1: data.t1,
    turns: data.timeline.length,
    words: (k + 1 < shards.length ? shards[k + 1].data.timeline[0][3] : totalWords) - data.timeline[0][3],
    speakers_present: [...new Set(data.timeline.map((r) => r[2]))].sort((a, b) => a - b),
  }));
  index.notes = [
    ...digest.notes,
    'timeline and scene_cuts live in the shard files listed under shards (digest.d/seg-NN.json), one contiguous turn slice each — cut at turn boundaries, preferring dead-air seams',
    'each shard carries its own region\'s scene_cuts and silence_gaps; cast_candidates and counts here stay global (one analysis, one join)',
  ];
  return { index, shards };
}

// Readable-but-compact writer: pretty JSON everywhere a human scans (cast table,
// counts, notes), one line per row where bulk lives (timeline, scene cuts). The
// output parses back to the exact digest object.
export function serializeDigest(digest) {
  const indent = (v) => JSON.stringify(v, null, 2).split('\n').map((l, i) => (i ? '  ' + l : l)).join('\n');
  const parts = Object.entries(digest).map(([k, v]) => {
    if (k === 'timeline' || k === 'cast_candidates') {
      return `  ${JSON.stringify(k)}: [\n${v.map((r) => '    ' + JSON.stringify(r)).join(',\n')}\n  ]`;
    }
    if (k === 'scene_cuts') {
      const lines = [];
      for (let i = 0; i < v.length; i += 20) lines.push('    ' + v.slice(i, i + 20).join(', '));
      return `  "scene_cuts": [\n${lines.join(',\n')}\n  ]`;
    }
    return `  ${JSON.stringify(k)}: ${indent(v)}`;
  });
  return `{\n${parts.join(',\n')}\n}\n`;
}

// Thumb spec per requested cluster: the biggest confident detection wins (score
// gate 0.85 as elsewhere; among confident ones a readable headshot beats a
// marginally higher score, so box area decides).
export function pickCastThumbSpecs(vision, clusters) {
  const wanted = new Set(clusters);
  const best = new Map();
  for (const f of vision.faces ?? []) {
    for (const d of f.detections ?? []) {
      if (!wanted.has(d.cluster_id)) continue;
      const area = (d.box[2] - d.box[0]) * (d.box[3] - d.box[1]);
      const confident = (d.score ?? 0) >= 0.85;
      const cur = best.get(d.cluster_id);
      if (!cur || (confident && !cur.confident) || (confident === cur.confident && area > cur.area)) {
        best.set(d.cluster_id, { cluster: d.cluster_id, t: f.t, box: d.box, area, confident });
      }
    }
  }
  return clusters.filter((c) => best.has(c))
    .map((c) => ({ cluster: c, t: best.get(c).t, box: best.get(c).box }));
}

// One padded face crop via ffmpeg (watcher's crop recipe, cast-card size). Tolerant:
// a failed grab just means no thumb for that cluster.
const grabThumb = (src, { t, box }, out) => new Promise((resolveGrab) => {
  const [x0, y0, x1, y1] = box;
  const padX = (x1 - x0) * 0.35;
  const padY = (y1 - y0) * 0.35;
  const cx = Math.max(0, x0 - padX);
  const cy = Math.max(0, y0 - padY);
  const cw = Math.min(1, x1 + padX) - cx;
  const ch = Math.min(1, y1 + padY) - cy;
  const vf = `crop=iw*${cw.toFixed(4)}:ih*${ch.toFixed(4)}:iw*${cx.toFixed(4)}:ih*${cy.toFixed(4)},scale=240:-2`;
  const ff = spawn('ffmpeg', ['-y', '-ss', String(t), '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '4', out], { stdio: 'ignore' });
  ff.on('error', () => resolveGrab(false));
  ff.on('close', () => resolveGrab(existsSync(out)));
});

// One downscaled full frame from inside a silence gap. Tolerant like grabThumb:
// a failed grab just means that frame is skipped.
const grabGapFrame = (src, t, out, width) => new Promise((resolveGrab) => {
  const ff = spawn('ffmpeg', ['-y', '-ss', String(t), '-i', src, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '5', out], { stdio: 'ignore' });
  ff.on('error', () => resolveGrab(false));
  ff.on('close', () => resolveGrab(existsSync(out)));
});

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeAtomic = (path, text) => {
  writeFileSync(path + '.tmp', text);
  renameSync(path + '.tmp', path); // readers never see a torn file
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const usage = () => {
    console.error('usage: digest.mjs build --dir <workdir>/cutting-room [--max-bytes <n>]'
      + ' | build --transcript <json> --vision <json> [--duration <s>] --out <path>'
      + ' | thumbs --dir <rundir> [--source <video>]'
      + ' | gapframes --dir <rundir> [--source <video>] [--min-gap 5] [--per-region 3] [--frames 2] [--width 480]'
      + ' | locate (--dir <rundir> | --transcript <json>) --words <a>..<b>'
      + ' | clip (--dir <rundir> | --transcript <json> --vision <json>) --words <a>..<b>'
      + '\n  --words a..b is END-EXCLUSIVE (array slice): words a … b-1. To end ON word 840, pass ..841.');
    process.exit(2);
  };
  const [cmd] = argv;
  const dir = flag('dir');

  if (cmd === 'build') {
    const tPath = flag('transcript') ?? (dir && join(dir, 'data', 'transcript.json'));
    const vPath = flag('vision') ?? (dir && join(dir, 'data', 'vision.json'));
    const outPath = flag('out') ?? (dir && join(dir, 'data', 'digest.json'));
    if (!tPath || !vPath || !outPath) usage();
    const missing = [tPath, vPath].filter((p) => !existsSync(p));
    if (missing.length) {
      console.error(`missing analysis payload${missing.length > 1 ? 's' : ''}: ${missing.join(', ')} — run the watcher first`);
      process.exit(1);
    }
    const planPath = dir && join(dir, 'plan.json');
    const plan = planPath && existsSync(planPath) ? readJson(planPath) : null;
    const duration = flag('duration') ? Number(flag('duration')) : plan?.source?.duration_s;
    const transcriptPayload = readJson(tPath);
    const digest = buildDigest(transcriptPayload, readJson(vPath), { duration_s: duration });
    const budget = flag('max-bytes') ? Number(flag('max-bytes')) : DIGEST_BUDGET_BYTES;
    const shardDir = join(dirname(outPath), 'digest.d');
    let text = serializeDigest(digest);
    let shardCount = 0;
    if (Buffer.byteLength(text) > budget) {
      // Long footage: digest.json becomes the index, the timeline moves into slices.
      const { index, shards } = shardDigest(digest, transcriptPayload, { targetBytes: Math.floor(budget * 0.75) });
      rmSync(shardDir, { recursive: true, force: true }); // no stale segs from a prior layout
      mkdirSync(shardDir, { recursive: true });
      for (const shard of shards) writeAtomic(join(dirname(outPath), shard.file), serializeDigest(shard.data));
      text = serializeDigest(index);
      shardCount = shards.length;
    } else {
      rmSync(shardDir, { recursive: true, force: true }); // back under budget → single file again
    }
    writeAtomic(outPath, text);
    if (plan) {
      plan.digest_path = 'data/digest.json';
      writeAtomic(planPath, JSON.stringify(plan, null, 2) + '\n');
    }
    const summary = {
      digest_path: outPath,
      bytes: Buffer.byteLength(text),
      turns: digest.timeline.length,
      shards: shardCount,
      cast: digest.cast_candidates.map((r) => [r.speaker, r.cluster, r.confidence, r.method]),
    };
    console.log(JSON.stringify(summary));
    const layout = shardCount ? `index ${summary.bytes}B + ${shardCount} shards in digest.d/` : `${summary.bytes}B single file`;
    console.error(`digest built — ${digest.cast_candidates.length} speakers × ${digest.counts.face_clusters} face clusters, ${summary.turns} turns, ${layout} → ${outPath}`);
    process.exit(0);
  }

  if (cmd === 'thumbs') {
    if (!dir) usage();
    const plan = existsSync(join(dir, 'plan.json')) ? readJson(join(dir, 'plan.json')) : null;
    const srcName = flag('source') ?? plan?.source?.path;
    const src = srcName && (isAbsolute(srcName) ? srcName : resolve(dir, '..', srcName));
    if (!src || !existsSync(src)) {
      console.log(JSON.stringify({ thumbs: [], reason: 'no_source' }));
      console.error('no local source video — cast thumbs skipped');
      process.exit(0);
    }
    const digest = readJson(flag('digest') ?? join(dir, 'data', 'digest.json'));
    const vision = readJson(flag('vision') ?? join(dir, 'data', 'vision.json'));
    // Every cluster the cast table points at: assignments plus the on-screen-while-
    // speaking anchors the naming session compares against.
    const clusters = [...new Set(digest.cast_candidates.flatMap(
      (r) => [r.cluster, ...(r.onscreen_top ?? []).map(([c]) => c)],
    ))].filter((c) => c !== null && c !== undefined);
    mkdirSync(join(dir, 'cast'), { recursive: true });
    const thumbs = [];
    for (const spec of pickCastThumbSpecs(vision, clusters)) {
      const rel = `cast/c${spec.cluster}.jpg`;
      const out = join(dir, rel);
      if (existsSync(out) || await grabThumb(src, spec, out)) thumbs.push({ cluster: spec.cluster, path: rel });
    }
    console.log(JSON.stringify({ thumbs }));
    console.error(`cast thumbs — ${thumbs.length} written under ${join(dir, 'cast')}`);
    process.exit(0);
  }

  // Visual gap enrichment: frames from inside the big silence gaps, so
  // scouts can say what HAPPENS where the transcript goes quiet. Bounded by
  // design; the manifest routes each region's frames to that region's scout only.
  if (cmd === 'gapframes') {
    if (!dir) usage();
    const minGapS = Number(flag('min-gap') ?? 5);
    const perRegion = Number(flag('per-region') ?? 3);
    const framesPerGap = Number(flag('frames') ?? 2);
    const width = Number(flag('width') ?? 480);
    const plan = existsSync(join(dir, 'plan.json')) ? readJson(join(dir, 'plan.json')) : null;
    const srcName = flag('source') ?? plan?.source?.path;
    const src = srcName && (isAbsolute(srcName) ? srcName : resolve(dir, '..', srcName));
    if (!src || !existsSync(src)) {
      console.log(JSON.stringify({ gaps: [], reason: 'no_source' }));
      console.error('no local source video — gap frames skipped');
      process.exit(0);
    }
    const digest = readJson(flag('digest') ?? join(dir, 'data', 'digest.json'));
    const regions = digest.shards
      ? digest.shards.map((s) => {
          const shard = readJson(join(dir, 'data', s.file));
          return { seg: shard.seg, gaps: shard.silence_gaps ?? [] };
        })
      : [{ seg: 0, gaps: digest.density?.silence_gaps ?? [] }];
    const specs = pickGapFrameSpecs(regions, { minGapS, perRegion, framesPerGap });
    mkdirSync(join(dir, 'thumbs', 'gaps'), { recursive: true });
    const rows = [];
    for (const spec of specs) {
      const frames = [];
      for (const [i, t] of spec.times.entries()) {
        const rel = `thumbs/gaps/s${spec.seg}-${String(spec.t).replace('.', '_')}-${i}.jpg`;
        const out = join(dir, rel);
        if (existsSync(out) || await grabGapFrame(src, t, out, width)) frames.push(rel);
      }
      if (frames.length) rows.push({ seg: spec.seg, t: spec.t, seconds: spec.seconds, frames });
    }
    const manifest = {
      schema: 'cutting-room/gap-frames@1',
      min_gap_s: minGapS, per_region: perRegion, frames_per_gap: framesPerGap,
      gaps: rows,
    };
    writeAtomic(join(dir, 'data', 'gap_frames.json'), JSON.stringify(manifest, null, 1));
    console.log(JSON.stringify(manifest));
    console.error(`gap frames — ${rows.length} gaps, ${rows.reduce((n, r) => n + r.frames.length, 0)} frames under ${join(dir, 'thumbs', 'gaps')}`);
    process.exit(0);
  }

  if (cmd === 'clip') {
    const tPath = flag('transcript') ?? (dir && join(dir, 'data', 'transcript.json'));
    const vPath = flag('vision') ?? (dir && join(dir, 'data', 'vision.json'));
    const m = /^(\d+)\.\.(\d+)$/.exec(flag('words') ?? '');
    if (!tPath || !vPath || !m) usage();
    const words = readJson(tPath).words ?? [];
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (!words.slice(a, b).length) {
      console.error(`no words in range ${a}..${b} (transcript has ${words.length})`);
      process.exit(1);
    }
    const scenes = (readJson(vPath).scenes ?? []).map((s) => s.after_frame?.timestamp ?? 0);
    const clip = snapClip(words, scenes, a, b);
    clip.text = words.slice(a, b).map((w) => w.text).join(' ');
    console.log(JSON.stringify(clip));
    console.error(`clip words ${a}..${b} → src ${clip.src_in}-${clip.src_out} (in:${clip.snapped_in} out:${clip.snapped_out})`);
    process.exit(0);
  }

  if (cmd === 'locate') {
    const tPath = flag('transcript') ?? (dir && join(dir, 'data', 'transcript.json'));
    const m = /^(\d+)\.\.(\d+)$/.exec(flag('words') ?? '');
    if (!tPath || !m) usage();
    const words = readJson(tPath).words ?? [];
    const [a, b] = [Number(m[1]), Number(m[2])];
    const slice = words.slice(a, b);
    if (!slice.length) {
      console.error(`no words in range ${a}..${b} (transcript has ${words.length})`);
      process.exit(1);
    }
    console.log(JSON.stringify({
      word_start_idx: a,
      word_end_idx: b,
      start: slice[0].start,
      end: slice.at(-1).end,
      text: slice.map((w) => w.text).join(' '),
    }));
    console.error(`words ${a}..${b} → ${slice[0].start}s-${slice.at(-1).end}s`);
    process.exit(0);
  }

  usage();
}

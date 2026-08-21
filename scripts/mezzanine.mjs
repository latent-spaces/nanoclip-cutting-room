// mezzanine.mjs — intake media mechanics: probe candidate
// footage, run the upload-vs-transcode mezzanine rule (arithmetic, not vibes),
// execute the mezzanine transcode, wrap `nanoclip upload` with timing, and split
// a server quote into the exact per-command --approve amounts.
// Zero-dep node; ffprobe/ffmpeg and the nanoclip CLI are the only external tools.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPrefs, recordTranscodeSpeed, recordUploadSpeed, defaultPrefsPath } from './prefs.mjs';

const execFileP = promisify(execFile);

// Planning constants for the mezzanine arithmetic.
export const EST_MEZZ_BPS = 4_000_000;      // assumed mezzanine bitrate: 1080p fast/crf23 incl. audio
export const MEZZ_GRADE_FACTOR = 1.5;       // source ≤ 1.5× target bitrate: a transcode can't shrink it enough
export const TRANSCODE_MARGIN = 0.8;        // the transcode path must beat direct upload by ≥20%
export const PRIOR_UPLOAD_BPS = 5_000_000;  // first-run priors — replaced by measured speeds in prefs
export const PRIOR_TRANSCODE_X = 6;

const fmtDur = (s) => `${Math.round(s)}s`;

export function centsToUsd(cents) {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`bad cents value: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// The spend gate's arithmetic: a server quote (integer cents per line item) becomes
// the exact USD strings passed to `transcript start --approve` and `vision start --approve`.
export function splitQuote(quote) {
  const li = quote?.line_items ?? {};
  for (const k of ['transcript', 'vision']) {
    if (!Number.isInteger(li[k])) throw new Error(`quote missing line item: ${k}`);
  }
  const diarize = Number.isInteger(li.diarization);
  const sum = Object.values(li).reduce((a, b) => a + b, 0);
  if (sum !== quote.total_cents) {
    throw new Error(`quote mismatch: line items sum to ${sum} cents but total_cents is ${quote.total_cents}`);
  }
  return {
    diarize,
    transcript_approve_usd: centsToUsd(li.transcript + (diarize ? li.diarization : 0)),
    vision_approve_usd: centsToUsd(li.vision),
    total_usd: centsToUsd(quote.total_cents),
  };
}

// The mezzanine rule. stats from probeFile(); speeds from prefs (nulls on first run).
export function decide(stats, speeds = {}) {
  const { bytes, duration_s, height } = stats;
  const src_bps = (bytes * 8) / duration_s;
  if (height <= 1080 && src_bps <= MEZZ_GRADE_FACTOR * EST_MEZZ_BPS) {
    return {
      decision: 'upload_original',
      basis: 'short_circuit',
      reason: `already mezzanine-grade (${height}p at ${(src_bps / 1e6).toFixed(1)} Mbps) — `
        + 'a transcode cannot shrink it enough to matter',
      arithmetic: null,
      speeds_used: null,
    };
  }
  const measured = Number.isFinite(speeds.upload_Bps) && Number.isFinite(speeds.transcode_x);
  const upload_Bps = speeds.upload_Bps ?? PRIOR_UPLOAD_BPS;
  const transcode_x = speeds.transcode_x ?? PRIOR_TRANSCODE_X;
  const t_upload_original_s = bytes / upload_Bps;
  const t_transcode_s = duration_s / transcode_x;
  const est_mezzanine_bytes = (EST_MEZZ_BPS / 8) * duration_s;
  const t_upload_mezzanine_s = est_mezzanine_bytes / upload_Bps;
  const t_transcode_path_s = t_transcode_s + t_upload_mezzanine_s;
  const wins = t_transcode_path_s < TRANSCODE_MARGIN * t_upload_original_s;
  return {
    decision: wins ? 'transcode_1080p' : 'upload_original',
    basis: measured ? 'measured' : 'priors',
    reason: wins
      ? `transcode + upload ≈ ${fmtDur(t_transcode_path_s)} beats uploading the original ≈ ${fmtDur(t_upload_original_s)}`
      : `the transcode path ≈ ${fmtDur(t_transcode_path_s)} does not clear the 20% margin `
        + `over direct upload ≈ ${fmtDur(t_upload_original_s)}`,
    arithmetic: { t_upload_original_s, t_transcode_s, t_upload_mezzanine_s, est_mezzanine_bytes },
    speeds_used: { upload_Bps, transcode_x },
  };
}

// The mezzanine encode contract: 1080p fast preset by default, 720p economy on request,
// never upscaling. The uploaded copy is analysis-only — the render reads the local original.
export function ffmpegArgs({ input, output, sourceHeight, economy = false }) {
  const target = economy ? 720 : 1080;
  const crf = economy ? '25' : '23';
  return [
    '-y', '-i', input,
    ...(sourceHeight > target ? ['-vf', `scale=-2:${target}`] : []),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', crf,
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ];
}

const PROJECT_ID_RE = /\b(\d{4}-\d{2}-\d{2}_\d{6}Z_[A-Za-z0-9._-]+)\b/;

// nanoclip prints a JSON line plus a human line; prefer the JSON, fall back to the id pattern.
export function parseUploadOutput(text) {
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t);
      const id = o.project_id ?? o.project ?? o.id;
      if (typeof id === 'string' && PROJECT_ID_RE.test(id)) {
        return { project_id: id, bytes: Number.isFinite(o.bytes) ? o.bytes : null };
      }
    } catch { /* not a JSON line */ }
  }
  const m = String(text).match(PROJECT_ID_RE);
  return m ? { project_id: m[1], bytes: null } : null;
}

export async function probeFile(path) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', path,
  ]);
  const probed = JSON.parse(stdout);
  const v = (probed.streams ?? []).find((s) => s.codec_type === 'video' && !Number(s.disposition?.attached_pic));
  if (!v) throw new Error(`no video stream in ${path}`);
  const a = (probed.streams ?? []).find((s) => s.codec_type === 'audio');
  const st = statSync(path);
  const duration_s = Number(probed.format?.duration ?? v.duration);
  return {
    path,
    bytes: st.size,
    mtime_ms: st.mtimeMs,
    duration_s,
    width: v.width,
    height: v.height,
    vcodec: v.codec_name,
    acodec: a ? a.codec_name : null,
    bit_rate_bps: Number(probed.format?.bit_rate) || Math.round((st.size * 8) / duration_s),
  };
}

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);
export const MAX_PROBED = 8;

// Candidate detection for the footage card: newest first, capped, unprobeable files dropped.
export async function listCandidates(dir) {
  const newest = readdirSync(dir)
    .filter((n) => !n.startsWith('.') && VIDEO_EXT.has(extname(n).toLowerCase()))
    .map((n) => {
      const p = join(dir, n);
      return { path: p, mtime_ms: statSync(p).mtimeMs };
    })
    .sort((x, y) => y.mtime_ms - x.mtime_ms)
    .slice(0, MAX_PROBED);
  const candidates = [];
  for (const f of newest) {
    try {
      candidates.push(await probeFile(f.path));
    } catch { /* not readable as video — drop it */ }
  }
  return candidates;
}

export async function transcodeFile(input, output, { economy = false, prefsPath = defaultPrefsPath() } = {}) {
  const src = await probeFile(input);
  const args = ffmpegArgs({ input, output, sourceHeight: src.height, economy });
  const t0 = process.hrtime.bigint();
  await execFileP('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 });
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  const bytes = statSync(output).size;
  recordTranscodeSpeed(prefsPath, { duration_s: src.duration_s, seconds });
  return { output, seconds, bytes, transcode_x: Math.round((src.duration_s / seconds) * 100) / 100 };
}

// Timed `nanoclip upload` — the first-run speed measurement rides on the real upload.
export async function uploadAndMeasure(file, { prefsPath = defaultPrefsPath() } = {}) {
  const bytes = statSync(file).size;
  const t0 = process.hrtime.bigint();
  const { stdout, stderr } = await execFileP('nanoclip', ['upload', file], { maxBuffer: 16 * 1024 * 1024 });
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  const parsed = parseUploadOutput(`${stdout}\n${stderr}`);
  if (!parsed) {
    throw new Error(`could not find a project id in nanoclip upload output:\n${stdout}\n${stderr}`);
  }
  recordUploadSpeed(prefsPath, { bytes, seconds });
  return { project_id: parsed.project_id, bytes, seconds, upload_Bps: Math.round(bytes / seconds) };
}

// First line of `text` that parses as a JSON object — the CLI's dual-format output convention.
function firstJsonObject(text) {
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      return JSON.parse(t);
    } catch { /* keep scanning */ }
  }
  throw new Error('no JSON object found in input');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const prefsPath = flag('prefs') || defaultPrefsPath();
  const [cmd, arg1, arg2] = argv;
  let result;
  if (cmd === 'probe' && arg1) {
    result = statSync(arg1).isDirectory() ? await listCandidates(arg1) : await probeFile(arg1);
  } else if (cmd === 'decide' && arg1) {
    const stats = await probeFile(arg1);
    result = { stats, ...decide(stats, loadPrefs(prefsPath).speeds) };
  } else if (cmd === 'transcode' && arg1 && arg2) {
    result = await transcodeFile(arg1, arg2, { economy: argv.includes('--eco'), prefsPath });
  } else if (cmd === 'upload' && arg1) {
    result = await uploadAndMeasure(arg1, { prefsPath });
  } else if (cmd === 'split') {
    result = splitQuote(firstJsonObject(arg1 ?? readFileSync(0, 'utf8')));
  } else {
    console.error('usage: mezzanine.mjs probe <file|dir> | decide <file> | transcode <in> <out> [--eco] | upload <file> | split [<quote-json>]  [--prefs <path>]');
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
}

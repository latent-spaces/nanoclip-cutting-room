// captions.mjs — NanoClip words → caption cues on the composition clock.
// Deterministic adapter: transcript words inside each clip segment are rebased to
// composition time (0 = clip start; NOT the proxy's padded start — the proxy shift
// t−extract.start lives in data-media-start, references/reframe.md), grouped into
// short cues, and stamped into plan.clips[].captions. scaffold.mjs build emits the
// block; the style name comes from the Kit's style.json (screen.md) or the default.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CUE_MAX_WORDS = 4;   // shorts convention: 3-4 word lines
export const CUE_GAP_S = 0.8;     // dead air that starts a fresh cue
export const CUE_HOLD_S = 0.5;    // how long a cue lingers after its last word
export const CUE_YIELD_S = 0.05;  // clearance before the next cue takes over (out of the hold only)
export const CUE_MIN_WORD_S = 0.08; // a word's highlight window never collapses (zero-length words)
export const DEFAULT_CAPTION_STYLE = 'caption-highlight';

const round2 = (v) => Math.round(v * 100) / 100;
// Hebrew + Arabic ranges incl. presentation forms — a cue with any strong RTL run renders RTL
const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

// Clip segments + source-time words → composition-time cues. A cue breaks at a
// speaker change, at dead air >= CUE_GAP_S, at the word cap, and at segment seams.
export function deriveCues(clip, words) {
  const cues = [];
  let base = 0;
  for (const seg of clip.segments) {
    let cue = null;
    for (const w of words) {
      if (w.start < seg.src_in || w.start >= seg.src_out) continue;
      const start = round2(base + (w.start - seg.src_in));
      // zero/near-zero-length words (NanoClip emits them on punctuation) would never
      // highlight: floor the window, never past the segment end
      const end = round2(base + (Math.min(Math.max(w.end, w.start + CUE_MIN_WORD_S), seg.src_out) - seg.src_in));
      const fresh = !cue
        || w.speaker !== cue.speaker
        || start - cue.words.at(-1).end >= CUE_GAP_S - 1e-9
        || cue.words.length >= CUE_MAX_WORDS;
      if (fresh) {
        cue = { start, end: 0, speaker: w.speaker, words: [] };
        cues.push(cue);
      }
      cue.words.push({ text: w.text, start, end });
    }
    base = round2(base + (seg.src_out - seg.src_in));
  }
  const total = base;
  cues.forEach((cue, i) => {
    const next = cues[i + 1];
    // the yield comes out of the hold, never out of the last word: a cue that
    // hides before its own last word ends clips the punchline's highlight
    const lastEnd = cue.words.at(-1).end;
    cue.end = round2(Math.min(
      lastEnd + CUE_HOLD_S,
      next ? Math.max(next.start - CUE_YIELD_S, lastEnd) : Infinity,
      total,
    ));
    if (RTL_RE.test(cue.words.map((w) => w.text).join(' '))) cue.rtl = true;
  });
  return cues;
}

// The Kit's pick (screen.md style@1) — nothing picked is a valid state; fall back
// to the default and say so (the caller reports style_source).
export function resolveStyle(dir) {
  const path = join(dir, 'style.json');
  if (existsSync(path)) {
    const style = JSON.parse(readFileSync(path, 'utf8'))?.caption_block;
    if (style) return { style, source: 'kit' };
  }
  return { style: DEFAULT_CAPTION_STYLE, source: 'default' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const [cmd] = argv;
  const dir = flag('dir');
  if (cmd !== 'cues' || !dir) {
    console.error('usage: captions.mjs cues --dir <workdir>/cutting-room [--clip <id>]');
    process.exit(2);
  }
  const planPath = join(dir, 'plan.json');
  const tPath = join(dir, 'data', 'transcript.json');
  for (const [p, what] of [[planPath, 'plan.json'], [tPath, 'transcript payload']]) {
    if (!existsSync(p)) {
      console.error(`missing ${what} at ${p}`);
      process.exit(1);
    }
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const words = JSON.parse(readFileSync(tPath, 'utf8')).words ?? [];
  const { style, source } = resolveStyle(dir);
  const only = flag('clip');
  const clips = {};
  for (const clip of plan.clips ?? []) {
    if (only && clip.id !== only) continue;
    if (!['proposed', 'approved'].includes(clip.status)) continue;
    if (clip.captions?.enabled === false) continue;
    const cues = deriveCues(clip, words);
    clip.captions = { enabled: true, style, style_source: source, cues };
    clips[clip.id] = {
      cues: cues.length,
      words: cues.reduce((n, c) => n + c.words.length, 0),
      rtl: cues.filter((c) => c.rtl).length,
    };
  }
  writeFileSync(planPath + '.tmp', JSON.stringify(plan, null, 2) + '\n');
  renameSync(planPath + '.tmp', planPath);
  console.log(JSON.stringify({ style, style_source: source, clips }));
  console.error(`caption cues derived for ${Object.keys(clips).length} clip(s), style ${style} (${source})`);
  process.exit(0);
}

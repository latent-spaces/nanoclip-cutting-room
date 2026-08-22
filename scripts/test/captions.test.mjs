import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CUE_GAP_S, CUE_HOLD_S, CUE_MAX_WORDS, CUE_MIN_WORD_S, DEFAULT_CAPTION_STYLE,
  deriveCues, resolveStyle,
} from '../captions.mjs';

const CAPTIONS_CLI = fileURLToPath(new URL('../captions.mjs', import.meta.url));

// words are NanoClip transcript words: source-time {text, start, end, speaker}
const w = (text, start, end, speaker = 1) => ({ text, start, end, speaker, confidence: 1 });

const clip = (segments = [{ src_in: 52.56, src_out: 89.46 }]) => ({
  id: 'c1', title: 'T', hook: '"h"', status: 'proposed', segments,
});

test('deriveCues: words inside the segment land on composition time (t - src_in)', () => {
  const words = [
    w('I', 52.72, 52.8), w('got', 52.8, 52.96), w('a', 52.96, 53.04), w('DM', 53.04, 53.36),
  ];
  const cues = deriveCues(clip(), words);
  assert.equal(cues.length, 1);
  assert.deepEqual(cues[0].words.map((x) => x.text), ['I', 'got', 'a', 'DM']);
  // composition clock: 0 = clip start = source 52.56 (NOT the proxy's padded start)
  assert.equal(cues[0].words[0].start, 0.16);
  assert.equal(cues[0].words[0].end, 0.24);
  assert.equal(cues[0].words[3].start, 0.48);
  assert.equal(cues[0].start, 0.16);
  assert.equal(cues[0].speaker, 1);
});

test('deriveCues: words outside every segment are dropped', () => {
  const words = [w('before', 50.0, 50.2), w('in', 53.0, 53.2), w('after', 90.0, 90.3)];
  const cues = deriveCues(clip(), words);
  assert.equal(cues.length, 1);
  assert.deepEqual(cues[0].words.map((x) => x.text), ['in']);
});

test('deriveCues: second segment rebases onto stacked composition time', () => {
  const c = clip([{ src_in: 10, src_out: 15.5 }, { src_in: 100, src_out: 104.5 }]);
  const words = [w('one', 10.2, 10.5), w('two', 100.5, 100.9)];
  const cues = deriveCues(c, words);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].words[0].start, 0.2);
  assert.equal(cues[1].words[0].start, 6); // 5.5 (seg 1 dur) + 0.5
  assert.equal(cues[1].words[0].end, 6.4);
});

test('deriveCues: cues break at speaker change, dead air, and the word cap', () => {
  const c = clip([{ src_in: 0, src_out: 30 }]);
  const words = [
    // 5 same-speaker words back to back → cap at CUE_MAX_WORDS splits 4+1
    w('a', 1.0, 1.2), w('b', 1.2, 1.4), w('c', 1.4, 1.6), w('d', 1.6, 1.8), w('e', 1.8, 2.0),
    // speaker change → new cue
    w('f', 2.0, 2.2, 2),
    // dead air ≥ CUE_GAP_S → new cue
    w('g', 2.2 + CUE_GAP_S, 3.4, 2),
  ];
  const cues = deriveCues(c, words);
  assert.deepEqual(cues.map((cue) => cue.words.map((x) => x.text)), [
    ['a', 'b', 'c', 'd'], ['e'], ['f'], ['g'],
  ]);
  assert.equal(CUE_MAX_WORDS, 4);
  assert.deepEqual(cues.map((cue) => cue.speaker), [1, 1, 2, 2]);
});

test('deriveCues: a cue holds after its last word but yields to the next cue and the clip end', () => {
  const c = clip([{ src_in: 0, src_out: 10 }]);
  const words = [
    w('held', 1.0, 1.4),            // next cue starts 3.0 → end = 1.4 + hold
    w('yields', 3.0, 3.2, 2),       // next cue starts 3.3 → end = 3.3 - 0.05
    w('tail', 3.3, 9.8, 1),         // last cue → clamps to clip duration 10
  ];
  const cues = deriveCues(c, words);
  assert.equal(cues[0].end, 1.4 + CUE_HOLD_S);
  assert.equal(cues[1].end, 3.25);
  assert.equal(cues[2].end, 10);
});

test('deriveCues: a cue never ends before its last word — the yield only eats into the hold', () => {
  const c = clip([{ src_in: 0, src_out: 10 }]);
  const words = [
    w('one', 1.0, 1.2), w('two', 1.2, 1.4), w('three', 1.4, 1.6), w('four', 1.6, 2.0),
    w('five', 2.0, 2.3), // word cap: next cue starts exactly on 'four'.end
  ];
  const cues = deriveCues(c, words);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].end, 2.0, 'ends ON the last word, not 50ms before it');
  assert.equal(cues[1].start, 2.0);
});

test('deriveCues: a zero-length word gets a minimum highlight window', () => {
  const c = clip([{ src_in: 0, src_out: 10 }]);
  const words = [w('it.', 4.64, 4.64), w('Next', 6.0, 6.3)]; // >0.8s gap: a fresh cue
  const cues = deriveCues(c, words);
  const it = cues[0].words[0];
  assert.equal(it.start, 4.64);
  assert.equal(it.end, 4.64 + CUE_MIN_WORD_S);
  assert.equal(cues[0].end, 4.64 + CUE_MIN_WORD_S + CUE_HOLD_S);
});

test('deriveCues: the minimum window never crosses the segment end', () => {
  const c = clip([{ src_in: 0, src_out: 5 }]);
  const cues = deriveCues(c, [w('end', 4.98, 4.98)]);
  assert.equal(cues[0].words[0].end, 5);
  assert.equal(cues[0].end, 5);
});

test('deriveCues: Hebrew cues carry rtl, Latin cues do not', () => {
  const c = clip([{ src_in: 0, src_out: 10 }]);
  const words = [
    w('שלום', 1.0, 1.3), w('עולם', 1.3, 1.6),
    w('hello', 3.0, 3.3), w('world', 3.3, 3.6),
  ];
  const cues = deriveCues(c, words);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].rtl, true);
  assert.deepEqual(cues[0].words.map((x) => x.text), ['שלום', 'עולם']);
  assert.ok(!cues[1].rtl, 'Latin cue must not be flagged rtl');
});

test('resolveStyle: kit pick from style.json, default (and said so) when absent or empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-style-'));
  assert.deepEqual(resolveStyle(dir), { style: DEFAULT_CAPTION_STYLE, source: 'default' });
  writeFileSync(join(dir, 'style.json'), JSON.stringify({
    schema: 'cutting-room/style@1', aspect: '9:16', caption_block: 'caption-camera-follow',
    palette: { transitions: [], blocks: [] }, locked: false,
  }));
  assert.deepEqual(resolveStyle(dir), { style: 'caption-camera-follow', source: 'kit' });
  writeFileSync(join(dir, 'style.json'), JSON.stringify({ schema: 'cutting-room/style@1', caption_block: null }));
  assert.deepEqual(resolveStyle(dir), { style: DEFAULT_CAPTION_STYLE, source: 'default' });
});

test('CLI cues --dir: stamps captions per proposed clip, honors enabled:false, leaves rejected alone', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'cr-captions-'));
  const rundir = join(workdir, 'cutting-room');
  mkdirSync(join(rundir, 'data'), { recursive: true });
  writeFileSync(join(rundir, 'plan.json'), JSON.stringify({
    schema: 'cutting-room/plan@2',
    source: { path: 'clip.mp4', duration_s: 600, project_id: 'p' },
    clips: [
      { id: 'c1', title: 'One', hook: '"h"', status: 'proposed', captions: { enabled: true }, segments: [{ src_in: 10, src_out: 20 }] },
      { id: 'c2', title: 'Two', hook: '"h"', status: 'proposed', captions: { enabled: false }, segments: [{ src_in: 30, src_out: 40 }] },
      { id: 'c3', title: 'Three', hook: '"h"', status: 'rejected', captions: { enabled: true }, segments: [{ src_in: 50, src_out: 60 }] },
    ],
  }, null, 2));
  writeFileSync(join(rundir, 'data', 'transcript.json'), JSON.stringify({
    words: [w('inside', 11, 11.4), w('שלום', 12.5, 12.9, 2), w('c2word', 31, 31.4), w('c3word', 51, 51.4)],
  }));
  writeFileSync(join(rundir, 'style.json'), JSON.stringify({
    schema: 'cutting-room/style@1', caption_block: 'caption-camera-follow', palette: { transitions: [], blocks: [] },
  }));
  const res = spawnSync('node', [CAPTIONS_CLI, 'cues', '--dir', rundir], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.style, 'caption-camera-follow');
  assert.equal(out.style_source, 'kit');
  assert.deepEqual(Object.keys(out.clips), ['c1']);
  assert.equal(out.clips.c1.cues, 2);
  assert.equal(out.clips.c1.words, 2);
  assert.equal(out.clips.c1.rtl, 1);
  const plan = JSON.parse(readFileSync(join(rundir, 'plan.json'), 'utf8'));
  const cap = plan.clips[0].captions;
  assert.equal(cap.enabled, true);
  assert.equal(cap.style, 'caption-camera-follow');
  assert.equal(cap.style_source, 'kit');
  assert.equal(cap.cues.length, 2);
  assert.equal(cap.cues[0].words[0].start, 1); // 11 - 10, composition clock
  assert.equal(cap.cues[1].rtl, true);
  assert.deepEqual(plan.clips[1].captions, { enabled: false }, 'disabled clip untouched');
  assert.deepEqual(plan.clips[2].captions, { enabled: true }, 'rejected clip untouched');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPrefs, recordUsage, recordUploadSpeed, recordTranscodeSpeed, setLanguage,
} from '../prefs.mjs';

const tmpPrefs = () => join(mkdtempSync(join(tmpdir(), 'cr-prefs-')), 'prefs.json');

test('loadPrefs returns v1 defaults when the file does not exist', () => {
  const p = loadPrefs(tmpPrefs());
  assert.equal(p.schema, 'cutting-room/prefs@1');
  assert.equal(p.language, null);
  assert.deepEqual(p.speeds, { upload_Bps: null, transcode_x: null, measured_at: null });
});

test('setLanguage persists and loads back', () => {
  const f = tmpPrefs();
  setLanguage(f, 'he');
  assert.equal(loadPrefs(f).language, 'he');
});

test('recordUploadSpeed stores rounded bytes-per-second and a timestamp', () => {
  const f = tmpPrefs();
  recordUploadSpeed(f, { bytes: 201326592, seconds: 20 });
  const p = loadPrefs(f);
  assert.equal(p.speeds.upload_Bps, 10066330);
  assert.ok(p.speeds.measured_at);
});

test('recordTranscodeSpeed stores the realtime multiple', () => {
  const f = tmpPrefs();
  recordTranscodeSpeed(f, { duration_s: 600, seconds: 75 });
  assert.equal(loadPrefs(f).speeds.transcode_x, 8);
});

test('recording one speed does not clobber the other', () => {
  const f = tmpPrefs();
  recordUploadSpeed(f, { bytes: 100_000_000, seconds: 10 });
  recordTranscodeSpeed(f, { duration_s: 600, seconds: 100 });
  const p = loadPrefs(f);
  assert.equal(p.speeds.upload_Bps, 10_000_000);
  assert.equal(p.speeds.transcode_x, 6);
});

test('recordUsage bumps per-family counters and remembers the clip count (catalog sort shape)', () => {
  const f = tmpPrefs();
  recordUsage(f, { captions: 'caption-highlight', transitions: ['directional-wipe', 'fade-through'], blocks: [], clips: 3 });
  let p = loadPrefs(f);
  // shape = catalog.mjs sortByUsage input: usage[family] is {name: count}
  assert.deepEqual(p.usage, {
    captions: { 'caption-highlight': 1 },
    transitions: { 'directional-wipe': 1, 'fade-through': 1 },
    blocks: {},
  });
  assert.equal(p.clip_count, 3);
  // a second ship increments, never resets; unnamed families untouched
  recordUsage(f, { captions: 'caption-highlight', transitions: ['directional-wipe'] });
  p = loadPrefs(f);
  assert.equal(p.usage.captions['caption-highlight'], 2);
  assert.equal(p.usage.transitions['directional-wipe'], 2);
  assert.equal(p.usage.transitions['fade-through'], 1);
  assert.equal(p.clip_count, 3, 'clip count kept when not given');
  assert.equal(p.schema, 'cutting-room/prefs@1', 'usage is additive to prefs@1');
});

test('unknown schema is backed up and replaced with defaults', () => {
  const f = tmpPrefs();
  writeFileSync(f, JSON.stringify({ schema: 'cutting-room/prefs@999', junk: true }));
  const p = loadPrefs(f);
  assert.equal(p.schema, 'cutting-room/prefs@1');
  assert.equal(p.junk, undefined);
  assert.ok(existsSync(f + '.bak'));
});

test('corrupt JSON is backed up and replaced with defaults', () => {
  const f = tmpPrefs();
  writeFileSync(f, '{this is not json');
  const p = loadPrefs(f);
  assert.equal(p.schema, 'cutting-room/prefs@1');
  assert.ok(existsSync(f + '.bak'));
});

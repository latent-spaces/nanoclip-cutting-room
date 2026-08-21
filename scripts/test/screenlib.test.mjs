import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyKit, kitAdd, kitRemove, kitCount, kitToChoices, kitFromStyle, PALETTE_FAMILIES,
  project, fmtTimer, fmtSize,
} from '../../screen/lib.mjs';

test('kit: caption is a single slot — adding a second style replaces it', () => {
  let kit = kitAdd(emptyKit(), 'caption', 'caption-pill-karaoke');
  kit = kitAdd(kit, 'caption', 'caption-weight-shift');
  assert.equal(kit.caption, 'caption-weight-shift');
  assert.equal(kitCount(kit), 1);
});

test('kit: palette accumulates without duplicates', () => {
  let kit = kitAdd(emptyKit(), 'transitions', 'fade-through');
  kit = kitAdd(kit, 'transitions', 'directional-wipe');
  kit = kitAdd(kit, 'transitions', 'fade-through');
  kit = kitAdd(kit, 'blocks', 'beat-accent');
  assert.deepEqual(kit.transitions, ['fade-through', 'directional-wipe']);
  assert.deepEqual(kit.blocks, ['beat-accent']);
  assert.equal(kitCount(kit), 3);
});

test('kit: remove clears a caption slot and a palette item', () => {
  let kit = kitAdd(kitAdd(emptyKit(), 'caption', 'caption-texture'), 'blocks', 'cta-lockup');
  kit = kitRemove(kit, 'caption', 'caption-texture');
  kit = kitRemove(kit, 'blocks', 'cta-lockup');
  assert.equal(kit.caption, null);
  assert.equal(kitCount(kit), 0);
});

test('kit: round-trips through the choices payload and style.json (style@2)', () => {
  const kit = kitAdd(kitAdd(emptyKit(), 'caption', 'caption-highlight'), 'transitions', 'fade-through');
  const choices = kitToChoices(kit);
  assert.equal(choices.caption_block, 'caption-highlight');
  assert.deepEqual(choices.palette, { transitions: ['fade-through'], blocks: [], treatments: [], titles: [] });
  const back = kitFromStyle({
    schema: 'cutting-room/style@2', caption_block: 'caption-highlight',
    palette: { transitions: ['fade-through'], blocks: [], treatments: [], titles: [] }, locked: false,
  });
  assert.deepEqual(back, kit);
  // a style@1 file (no treatments/titles arrays) still round-trips — missing = []
  const fromV1 = kitFromStyle({
    schema: 'cutting-room/style@1', caption_block: 'caption-highlight',
    palette: { transitions: ['fade-through'], blocks: [] }, locked: false,
  });
  assert.deepEqual(fromV1, kit);
});

test('project: honest chase-light — eased, monotonic, capped short of the end', () => {
  assert.equal(project(0, 112), 0);
  const quarter = project(28, 112);
  const half = project(56, 112);
  const full = project(112, 112);
  const over = project(1120, 112);
  assert.ok(quarter > 0 && quarter < half && half < full, 'monotonic');
  assert.ok(full < 0.92, 'never claims completion');
  assert.ok(over <= 0.92, 'capped even far past expectation');
});

test('fmtTimer renders m:ss', () => {
  assert.equal(fmtTimer(0), '0:00');
  assert.equal(fmtTimer(20), '0:20');
  assert.equal(fmtTimer(112), '1:52');
  assert.equal(fmtTimer(600.4), '10:00');
});

test('fmtSize renders human bytes like the cards do', () => {
  assert.equal(fmtSize(192384833), '192 MB');
  assert.equal(fmtSize(6871947674), '6.9 GB');
  assert.equal(fmtSize(900_000), '0.9 MB');
});

// ---- the style@2 palette families ----

test('kit: style@2 palette families accumulate; caption stays a single slot', () => {
  assert.deepEqual(PALETTE_FAMILIES, ['transitions', 'blocks', 'treatments', 'titles']);
  let kit = emptyKit();
  assert.deepEqual(kit, { caption: null, transitions: [], blocks: [], treatments: [], titles: [] });
  kit = kitAdd(kit, 'caption', 'caption-a');
  kit = kitAdd(kit, 'caption', 'caption-b'); // replace-on-add
  kit = kitAdd(kit, 'treatments', 'grain-overlay');
  kit = kitAdd(kit, 'treatments', 'grain-overlay'); // no dupes
  kit = kitAdd(kit, 'titles', 'weight-wave');
  assert.equal(kit.caption, 'caption-b');
  assert.deepEqual(kit.treatments, ['grain-overlay']);
  assert.equal(kitCount(kit), 3);
  kit = kitRemove(kit, 'treatments', 'grain-overlay');
  assert.equal(kitCount(kit), 2);
});

test('kitToChoices emits every style@2 family; kitFromStyle tolerates style@1 files', () => {
  const kit = kitAdd(kitAdd(emptyKit(), 'titles', 'weight-wave'), 'transitions', 'fade-through');
  assert.deepEqual(kitToChoices(kit).palette, {
    transitions: ['fade-through'], blocks: [], treatments: [], titles: ['weight-wave'],
  });
  // a style@1 file has no treatments/titles arrays — they read as empty
  const v1 = { schema: 'cutting-room/style@1', caption_block: 'caption-kinetic-slam', palette: { transitions: ['transitions-3d'], blocks: [] }, locked: true };
  assert.deepEqual(kitFromStyle(v1), {
    caption: 'caption-kinetic-slam', transitions: ['transitions-3d'], blocks: [], treatments: [], titles: [],
  });
});

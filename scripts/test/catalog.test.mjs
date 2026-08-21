import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shelveCatalog, sortByUsage, curate, buildCatalogFile, CURATED } from '../catalog.mjs';

const FIXTURE = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../fixtures/catalog_sample.json', import.meta.url)), 'utf8',
));

test('shelveCatalog: caption styles, transitions and shorts blocks from real registry items', () => {
  const s = shelveCatalog(FIXTURE);
  assert.equal(s.captions.length, 16);
  const trNames = s.transitions.map((i) => i.name);
  assert.ok(trNames.includes('fade-through'), 'transition tag');
  assert.ok(trNames.includes('directional-wipe'), 'transition-primitive tag counts as a transition');
  const blockNames = s.blocks.map((i) => i.name);
  assert.ok(blockNames.includes('beat-accent'));
  assert.ok(blockNames.includes('cta-lockup'));
  assert.ok(blockNames.includes('avatar-cloud'));
  const everywhere = [...s.captions, ...s.transitions, ...s.blocks].map((i) => i.name);
  assert.ok(!everywhere.some((n) => n.startsWith('code-')), 'developer items stay off the shelves');
});

test('curate: with no usage history the house picks lead the palette', () => {
  const cur = curate(shelveCatalog(FIXTURE), {});
  assert.deepEqual(cur.transitions.slice(0, 2), ['directional-wipe', 'fade-through']);
  assert.deepEqual(cur.blocks.slice(0, 2), ['beat-accent', 'cta-lockup']);
});

test('shelveCatalog: caption-style wins over other family tags', () => {
  const s = shelveCatalog([{ name: 'x', title: 'X', tags: ['caption-style', 'transition', 'cta'] }]);
  assert.equal(s.captions.length, 1);
  assert.equal(s.transitions.length, 0);
  assert.equal(s.blocks.length, 0);
});

test('sortByUsage: usage desc, ties alphabetical by title, missing counts as zero', () => {
  const items = [
    { name: 'a', title: 'Zeta' },
    { name: 'b', title: 'Alpha' },
    { name: 'c', title: 'Mid' },
  ];
  const sorted = sortByUsage(items, { c: 3 });
  assert.deepEqual(sorted.map((i) => i.name), ['c', 'b', 'a']);
});

test('curate: picks the top names per family', () => {
  const shelves = shelveCatalog(FIXTURE);
  const cur = curate(shelves, {});
  assert.equal(cur.captions.length, CURATED.captions);
  assert.equal(cur.transitions.length, CURATED.transitions);
  assert.ok(cur.blocks.length <= CURATED.blocks);
  assert.ok(cur.captions.every((n) => shelves.captions.some((i) => i.name === n)));
});

test('curate: prefs usage boosts an item to the front', () => {
  const shelves = shelveCatalog(FIXTURE);
  const cur = curate(shelves, { captions: { 'caption-weight-shift': 9 } });
  assert.equal(cur.captions[0], 'caption-weight-shift');
});

test('buildCatalogFile: catalog@1 with trimmed items and curated lists', () => {
  const file = buildCatalogFile(FIXTURE, {});
  assert.equal(file.schema, 'cutting-room/catalog@1');
  assert.ok(file.generated_at);
  assert.deepEqual(
    Object.keys(file.captions[0]).sort(),
    ['description', 'duration', 'name', 'tags', 'title', 'type'],
  );
  assert.ok(file.curated.captions.length > 0);
  assert.equal(file.error, null);
});

// ---- the style@2 families (treatments / titles) ----

test('shelveCatalog: treatments and titles shelve by tag, after the original three', () => {
  const items = [
    { name: 'a-caption', tags: ['caption-style', 'texture'] },      // captions wins
    { name: 'a-transition', tags: ['transition', 'grain'] },        // transitions wins
    { name: 'an-accent', tags: ['cta', 'typography'] },             // blocks wins
    { name: 'a-grain', tags: ['grain', 'typography'] },             // treatments beats titles
    { name: 'a-title', tags: ['typography'] },
    { name: 'unshelved', tags: ['showcase'] },
  ];
  const shelves = shelveCatalog(items);
  assert.deepEqual(shelves.captions.map((i) => i.name), ['a-caption']);
  assert.deepEqual(shelves.transitions.map((i) => i.name), ['a-transition']);
  assert.deepEqual(shelves.blocks.map((i) => i.name), ['an-accent']);
  assert.deepEqual(shelves.treatments.map((i) => i.name), ['a-grain']);
  assert.deepEqual(shelves.titles.map((i) => i.name), ['a-title']);
});

test('buildCatalogFile: carries all five families + curated keys (additive catalog@1)', () => {
  const file = buildCatalogFile([
    { name: 'grain-overlay', tags: ['grain'] },
    { name: 'weight-wave', tags: ['typography'] },
  ]);
  assert.equal(file.schema, 'cutting-room/catalog@1');
  assert.deepEqual(file.treatments.map((i) => i.name), ['grain-overlay']);
  assert.deepEqual(file.titles.map((i) => i.name), ['weight-wave']);
  assert.deepEqual(file.curated.treatments, ['grain-overlay']);
  assert.deepEqual(file.curated.titles, ['weight-wave']);
  assert.ok(Array.isArray(file.curated.captions));
});

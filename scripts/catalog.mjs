// catalog.mjs — hyperframes registry → the screen's shelves.
// Filters `hyperframes catalog --json` to shorts-relevant families, sorts by prefs
// usage, and emits catalog.json for the page: curated shelf + browse-all overlay.
// The tag filter deliberately curates rather than mirroring the live registry
// (373 items on hyperframes@0.8.3): `caption-style` is the caption family's own tag;
// `transition` marks transitions; the blocks family is the shorts-accent tag set below.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, renameSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadPrefs, defaultPrefsPath } from './prefs.mjs';
import { HYPERFRAMES_PKG } from './render.mjs';

const execFileP = promisify(execFile);

// All shelvable families in shelf order. style@2 opened treatments
// (a full-frame look layer) and titles (type moments) beyond the original three.
export const FAMILIES = ['captions', 'transitions', 'blocks', 'treatments', 'titles'];

export const CURATED = { captions: 5, transitions: 4, blocks: 4, treatments: 3, titles: 3 };

// Shorts-relevant accent/cta blocks (palette "blocks" family).
export const BLOCK_TAGS = new Set([
  'cta', 'end-card', 'title-card', 'lower-third', 'social-proof', 'social-overlay',
  'emphasize', 'impact', 'sting', 'beat', 'counter', 'badge', 'celebration',
  'payoff', 'intro', 'outro', 'countdown',
]);

// Full-frame look layers (grain, film, grade, vignette…) — the "treatments" family.
export const TREATMENT_TAGS = new Set([
  'media-treatment-overlay', 'texture', 'grain', 'film', 'light-leak', 'color-grading',
  'grade', 'camcorder', 'retro', 'halftone', 'vignette', 'vhs', 'dither', 'pixelate',
]);

// Type moments (hooks, openers, kinetic type) — the "titles" family.
export const TITLE_TAGS = new Set([
  'typography', 'kinetic-type', 'text-effect', 'text-effects', 'headline', 'title',
  'wordmark', 'variable-font', 'kinetic',
]);

const hasTag = (item, tag) => (item.tags ?? []).includes(tag);

// First-run house picks: palette exemplars per family. They lead the shelf only
// until real usage history exists.
export const HOUSE_USAGE = {
  transitions: { 'directional-wipe': 2, 'fade-through': 1 },
  blocks: { 'beat-accent': 2, 'cta-lockup': 1 },
  treatments: { 'grain-overlay': 2, 'vignette': 1 },
  titles: { 'weight-wave': 2, 'blur-in': 1 },
};

// Families are mutually exclusive, priority: caption-style > transitions > blocks
// > treatments > titles. The original three keep their exact membership (style@2
// is additive — usage counters and user familiarity must not reshuffle).
export function shelveCatalog(items) {
  const shelves = Object.fromEntries(FAMILIES.map((f) => [f, []]));
  for (const item of items) {
    if (hasTag(item, 'caption-style')) shelves.captions.push(item);
    else if (hasTag(item, 'transition') || hasTag(item, 'transition-primitive')) shelves.transitions.push(item);
    else if ((item.tags ?? []).some((t) => BLOCK_TAGS.has(t))) shelves.blocks.push(item);
    else if ((item.tags ?? []).some((t) => TREATMENT_TAGS.has(t))) shelves.treatments.push(item);
    else if ((item.tags ?? []).some((t) => TITLE_TAGS.has(t))) shelves.titles.push(item);
  }
  return shelves;
}

const effectiveUsage = (usage, family) =>
  (usage[family] && Object.keys(usage[family]).length ? usage[family] : HOUSE_USAGE[family] ?? {});

export function sortByUsage(items, usage = {}) {
  return [...items].sort((a, b) => (usage[b.name] ?? 0) - (usage[a.name] ?? 0)
    || String(a.title ?? a.name).localeCompare(String(b.title ?? b.name)));
}

// usage shape (prefs, recorded at ship time): { captions: {name: n}, transitions: {...}, ... }
export function curate(shelves, usage = {}) {
  const pick = (family) => sortByUsage(shelves[family], effectiveUsage(usage, family))
    .slice(0, CURATED[family])
    .map((i) => i.name);
  return Object.fromEntries(FAMILIES.map((f) => [f, pick(f)]));
}

const trimItem = ({ name, type, title, description, tags, duration }) => ({
  name, type: type ?? null, title: title ?? name, description: description ?? '', tags: tags ?? [], duration: duration ?? null,
});

// catalog@1 with additive family arrays (treatments/titles) — existing readers
// that only know the first three keep working untouched.
export function buildCatalogFile(items, usage = {}) {
  const shelves = shelveCatalog(items);
  const sorted = Object.fromEntries(FAMILIES.map((f) => [
    f, sortByUsage(shelves[f], effectiveUsage(usage, f)).map(trimItem),
  ]));
  return {
    schema: 'cutting-room/catalog@1',
    generated_at: new Date().toISOString(),
    error: null,
    ...sorted,
    curated: curate(shelves, usage),
  };
}

export const emptyCatalogFile = (error) => ({
  schema: 'cutting-room/catalog@1',
  generated_at: new Date().toISOString(),
  error,
  ...Object.fromEntries(FAMILIES.map((f) => [f, []])),
  curated: Object.fromEntries(FAMILIES.map((f) => [f, []])),
});

const writeJsonAtomic = (path, obj) => {
  writeFileSync(path + '.tmp', JSON.stringify(obj, null, 2) + '\n');
  renameSync(path + '.tmp', path);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const out = flag('out');
  if (argv[0] !== 'build' || !out) {
    console.error('usage: catalog.mjs build --out <dir>/catalog.json [--prefs <path>]');
    process.exit(2);
  }
  const usage = loadPrefs(flag('prefs') || defaultPrefsPath()).usage ?? {};
  let file;
  try {
    const { stdout } = await execFileP('npx', [HYPERFRAMES_PKG, 'catalog', '--json'], { maxBuffer: 32 * 1024 * 1024 });
    file = buildCatalogFile(JSON.parse(stdout), usage);
  } catch (err) {
    // Designed failure state: registry unreachable → the page shows a text fallback.
    file = emptyCatalogFile(String(err.message ?? err).slice(0, 200));
  }
  writeJsonAtomic(out, file);
  const counts = Object.fromEntries(FAMILIES.map((f) => [f, file[f].length]));
  console.log(JSON.stringify({ out, error: file.error, counts }));
  console.error(file.error
    ? `catalog degraded — registry unreachable (${file.error}); the screen will show its text fallback`
    : `catalog built — ${FAMILIES.map((f) => `${counts[f]} ${f}`).join(', ')}`);
}

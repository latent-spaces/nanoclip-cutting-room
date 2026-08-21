// lib.mjs — the screen's pure logic. Runs in the browser (ES module) and under
// node --test; no DOM, no fetch, no globals.

// ---- The Kit: slots, not quantities ----
// caption is a single slot (replace-on-add); every palette family accumulates.
// PALETTE_FAMILIES is the style@2 palette contract: treatments = a
// full-frame look layer, titles = type moments — both permission, like the rest.

export const PALETTE_FAMILIES = ['transitions', 'blocks', 'treatments', 'titles'];

export const emptyKit = () => ({
  caption: null,
  ...Object.fromEntries(PALETTE_FAMILIES.map((f) => [f, []])),
});

export function kitAdd(kit, family, name) {
  if (family === 'caption') return { ...kit, caption: name };
  if (kit[family].includes(name)) return kit;
  return { ...kit, [family]: [...kit[family], name] };
}

export function kitRemove(kit, family, name) {
  if (family === 'caption') return kit.caption === name ? { ...kit, caption: null } : kit;
  return { ...kit, [family]: kit[family].filter((n) => n !== name) };
}

export const kitCount = (kit) => (kit.caption ? 1 : 0)
  + PALETTE_FAMILIES.reduce((n, f) => n + (kit[f]?.length ?? 0), 0);

// The cart IS style.json rendered — POST body for /choices.
export const kitToChoices = (kit) => ({
  caption_block: kit.caption,
  palette: Object.fromEntries(PALETTE_FAMILIES.map((f) => [f, [...(kit[f] ?? [])]])),
});

// Tolerant of style@1 files (no treatments/titles arrays): missing families = [].
export const kitFromStyle = (style) => ({
  caption: style?.caption_block ?? null,
  ...Object.fromEntries(PALETTE_FAMILIES.map((f) => [f, [...(style?.palette?.[f] ?? [])]])),
});

// ---- Honest chase-light projection ----
// The API emits no fine progress signal: position is a projection of elapsed vs
// expected duration — eased, monotonic, and capped short of the end. The timer is
// the truth; completion is the only thing that finishes the sweep.

export const PROJECTION_CAP = 0.92;

export function project(elapsedS, expectedS) {
  if (!(expectedS > 0) || elapsedS <= 0) return 0;
  return Math.round(PROJECTION_CAP * (1 - Math.exp(-1.6 * (elapsedS / expectedS))) * 1000) / 1000;
}

// ---- Formatters ----

export function fmtTimer(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtSize(bytes) {
  const GB = 1_000_000_000;
  const MB = 1_000_000;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return bytes >= 100 * MB
    ? `${Math.round(bytes / MB)} MB`
    : `${(bytes / MB).toFixed(1)} MB`;
}

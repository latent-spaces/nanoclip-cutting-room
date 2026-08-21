// prefs.mjs — versioned per-user preference store (cutting-room/prefs@1).
// The mezzanine rule reads measured speeds from here; language is remembered
// across runs. Unknown or corrupt files are backed up and replaced, never fatal.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const PREFS_SCHEMA = 'cutting-room/prefs@1';

export const defaultPrefs = () => ({
  schema: PREFS_SCHEMA,
  language: null,
  speeds: { upload_Bps: null, transcode_x: null, measured_at: null },
});

export const defaultPrefsPath = () =>
  process.env.CUTTING_ROOM_PREFS
  || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cutting-room', 'prefs.json');

export function loadPrefs(path = defaultPrefsPath()) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return defaultPrefs();
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch { /* corrupt — handled below */ }
  if (parsed && parsed.schema === PREFS_SCHEMA) return parsed;
  renameSync(path, path + '.bak'); // preserve the unreadable file before anything overwrites it
  return defaultPrefs();
}

export function savePrefs(path, prefs) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(prefs, null, 2) + '\n');
  return prefs;
}

export function setLanguage(path, tag) {
  const p = loadPrefs(path);
  p.language = tag;
  return savePrefs(path, p);
}

export function recordUploadSpeed(path, { bytes, seconds }) {
  const p = loadPrefs(path);
  p.speeds.upload_Bps = Math.round(bytes / seconds);
  p.speeds.measured_at = new Date().toISOString();
  return savePrefs(path, p);
}

// Ship-time usage history: per-family {name: count} in the exact
// shape catalog.mjs sortByUsage reads, so the next run's shelves lead with what this
// user actually ships. clip_count remembers the batch size for the next default.
export function recordUsage(path, { captions = null, transitions = [], blocks = [], clips = null } = {}) {
  const prefs = loadPrefs(path);
  prefs.usage = prefs.usage ?? { captions: {}, transitions: {}, blocks: {} };
  const bump = (family, name) => {
    prefs.usage[family] = prefs.usage[family] ?? {};
    prefs.usage[family][name] = (prefs.usage[family][name] ?? 0) + 1;
  };
  if (captions) bump('captions', captions);
  for (const t of transitions) bump('transitions', t);
  for (const b of blocks) bump('blocks', b);
  if (clips !== null && Number.isFinite(clips)) prefs.clip_count = clips;
  return savePrefs(path, prefs);
}

export function recordTranscodeSpeed(path, { duration_s, seconds }) {
  const p = loadPrefs(path);
  p.speeds.transcode_x = Math.round((duration_s / seconds) * 100) / 100;
  p.speeds.measured_at = new Date().toISOString();
  return savePrefs(path, p);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const file = flag('file') || defaultPrefsPath();
  const cmd = argv[0];
  let result;
  if (cmd === 'get') {
    result = loadPrefs(file);
  } else if (cmd === 'set' && argv[1] === 'language' && argv[2]) {
    result = setLanguage(file, argv[2]);
  } else if (cmd === 'record-upload') {
    result = recordUploadSpeed(file, { bytes: Number(flag('bytes')), seconds: Number(flag('seconds')) });
  } else if (cmd === 'record-transcode') {
    result = recordTranscodeSpeed(file, { duration_s: Number(flag('duration')), seconds: Number(flag('seconds')) });
  } else if (cmd === 'record-usage') {
    const list = (name) => (flag(name) ? flag(name).split(',').filter(Boolean) : []);
    result = recordUsage(file, {
      captions: flag('captions') ?? null,
      transitions: list('transitions'),
      blocks: list('blocks'),
      clips: flag('clips') !== undefined ? Number(flag('clips')) : null,
    });
  } else {
    console.error('usage: prefs.mjs get | set language <tag> | record-upload --bytes <n> --seconds <s> | record-transcode --duration <s> --seconds <s> | record-usage [--captions <name>] [--transitions a,b] [--blocks x,y] [--clips <n>]  [--file <path>]');
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
}

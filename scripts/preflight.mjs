// preflight.mjs — run once at the start of a session, before intake: makes sure
// the machine can actually run the flow. Checks node, ffmpeg/ffprobe, installs
// the NanoClip CLI from npm when missing, reports its auth state, and warms the
// pinned HyperFrames version so the first render doesn't stall on a download.
// Human report on stderr, JSON verdict on stdout; exit 0 = ready, 1 = not yet.
// Usage: node scripts/preflight.mjs
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { HYPERFRAMES_PKG } from './render.mjs';

export const MIN_NODE_MAJOR = 20;

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0 && !r.error, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

// nanoclip prints one JSON line on stdout ({"name":…,"version":…}); report just the version.
const nanoVersion = (out) => {
  const first = (out ?? '').split('\n')[0].trim();
  try { return JSON.parse(first).version ?? first; } catch { return first; }
};

export function checkNode(version = process.versions.node) {
  const major = Number(version.split('.')[0]);
  return { ok: major >= MIN_NODE_MAJOR, version, min: `${MIN_NODE_MAJOR}.x` };
}

export function preflight({ exec = run } = {}) {
  const report = { node: checkNode() };

  for (const tool of ['ffmpeg', 'ffprobe']) {
    report[tool] = { ok: exec(tool, ['-version']).ok };
  }

  // NanoClip CLI: install from npm when missing (the one setup step the flow
  // owns), then report the cached auth state — auth itself stays a human step.
  let nano = exec('nanoclip', ['--version']);
  let installedNow = false;
  if (!nano.ok) {
    const install = exec('npm', ['install', '-g', 'nanoclip']);
    installedNow = install.ok;
    nano = exec('nanoclip', ['--version']);
  }
  const auth = nano.ok ? exec('nanoclip', ['auth', 'status']) : { ok: false, out: '' };
  report.nanoclip = {
    ok: nano.ok,
    version: nano.ok ? nanoVersion(nano.out) : null,
    installed_now: installedNow,
    authed: auth.ok,
  };

  // HyperFrames: never floating — warm the pinned version's npx cache so the
  // first check/render is instant and deterministic.
  const hf = exec('npx', ['--yes', HYPERFRAMES_PKG, '--version']);
  report.hyperframes = { ok: hf.ok, pinned: HYPERFRAMES_PKG };

  report.ready = report.node.ok && report.ffmpeg.ok && report.ffprobe.ok
    && report.nanoclip.ok && report.nanoclip.authed && report.hyperframes.ok;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = preflight();
  const line = (label, ok, extra = '') => console.error(`${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  line(`node ${r.node.version}`, r.node.ok, r.node.ok ? '' : `need ${r.node.min}+`);
  line('ffmpeg', r.ffmpeg.ok, r.ffmpeg.ok ? '' : 'install ffmpeg (brew install ffmpeg / apt install ffmpeg)');
  line('ffprobe', r.ffprobe.ok, r.ffprobe.ok ? '' : 'ships with ffmpeg');
  line(`nanoclip ${r.nanoclip.version ?? ''}`, r.nanoclip.ok,
    r.nanoclip.installed_now ? 'installed from npm just now' : (r.nanoclip.ok ? '' : 'npm install -g nanoclip failed'));
  line('nanoclip auth', r.nanoclip.authed, r.nanoclip.authed ? '' : 'run: nanoclip auth login');
  line(HYPERFRAMES_PKG, r.hyperframes.ok, r.hyperframes.ok ? 'npx cache warm' : 'npx could not fetch it (network?)');
  console.log(JSON.stringify(r));
  process.exit(r.ready ? 0 : 1);
}

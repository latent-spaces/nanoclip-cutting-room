// announce.mjs — the clips-ready tail on the Screen: plan.json's cast and clips land
// in state.json, so the page's CAST strip fills with the real fused cast and the fixed
// footer morphs into the pink "Open preview →" band (the finale replay.mjs simulates, now real).
// The server's SSE push does the rest; run this at the "clips ready" moment.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initState } from './watcher.mjs';

// Pure and additive: only the tail stages flip, already-completed stages keep their
// own timestamps, everything else in state survives untouched.
export function announceClips(state, plan, { previewUrl = null, urls = [], now = new Date().toISOString() } = {}) {
  const done = (prev) => (prev?.status === 'completed' ? prev : { ...(prev ?? {}), status: 'completed', ended_at: now });
  const clips = (plan.clips ?? []).filter((c) => ['proposed', 'approved'].includes(c.status));
  return {
    ...state,
    updated_at: now,
    stages: {
      ...state.stages,
      cast: done(state.stages?.cast),
      cut: done(state.stages?.cut),
      clips: done(state.stages?.clips),
    },
    artifacts: {
      ...state.artifacts,
      cast: (plan.cast ?? []).map((p) => ({
        person_id: p.person_id, label: p.label, role: p.role, thumb: p.thumb ?? null, speaking_s: p.speaking_s ?? null,
      })),
      clips: clips.map((c, i) => ({
        id: c.id,
        title: c.title,
        hook: c.hook,
        duration_s: Math.round(c.segments.reduce((s, g) => s + (g.src_out - g.src_in), 0)),
        score: c.score ?? null,
        // product decision: clips embed IN the page (spike-proven player
        // component against the play server) — one player url per card
        ...(urls[i] ? { url: urls[i] } : {}),
      })),
    },
    ...(previewUrl ? { preview_url: previewUrl } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const dir = flag('dir');
  if (!dir) {
    console.error('usage: announce.mjs --dir <workdir>/cutting-room [--preview-url <url>] [--urls <u1,u2,...>]');
    process.exit(2);
  }
  const planPath = join(dir, 'plan.json');
  if (!existsSync(planPath)) {
    console.error(`no plan.json in ${dir}`);
    process.exit(1);
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const statePath = join(dir, 'state.json');
  let state;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } else {
    // the screen never ran on this dir — seed, and the analyses whose payloads got us
    // here are not "running": mark them landed
    state = initState(plan);
    const t = state.updated_at;
    for (const k of ['transcript', 'vision']) state.stages[k] = { status: 'completed', ended_at: t };
  }
  state = announceClips(state, plan, {
    previewUrl: flag('preview-url') ?? null,
    urls: (flag('urls') ?? '').split(',').filter(Boolean),
  });
  writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2) + '\n');
  renameSync(statePath + '.tmp', statePath);
  console.log(JSON.stringify({
    cast: state.artifacts.cast.length,
    clips: state.artifacts.clips.length,
    preview_url: state.preview_url ?? null,
  }));
  console.error(`announced ${state.artifacts.clips.length} clip(s) + ${state.artifacts.cast.length} cast member(s) to the screen`);
  process.exit(0);
}

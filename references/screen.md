# The Screen — server, watcher, catalog

**Stage boundary:** from dispatch (intake done) to both payloads landed and the user's
look picked. The browser does the showing; the watcher does the waiting; Claude spends
**zero tokens** while analyses cook. UI language is English; the page's design law:
everything shown is real run data — real frames, real timers, real costs — no mockups,
no hype.

**Outputs:** `cutting-room/data/transcript.json` + `vision.json` on disk · `state.json`
final (stages completed, artifacts summarized) · `style.json` = the user's kit ·
real strip thumbs under `cutting-room/thumbs/`.

## Wiring (immediately after intake's dispatch)

All paths relative to the working folder; the run dir is `cutting-room/`.

```
node scripts/catalog.mjs build --out cutting-room/catalog.json
node scripts/server.mjs --dir cutting-room
node scripts/watcher.mjs --dir cutting-room
```

- **catalog** queries `hyperframes catalog --json`, filters to the shorts families
  (caption-style / transitions incl. transition-primitive / accent blocks), sorts by
  prefs usage (house picks lead a first run: directional-wipe, fade-through, beat-accent,
  cta-lockup), and writes `catalog.json`. Registry unreachable → it writes an `error`
  catalog and the page shows its text fallback; not fatal, continue.
- **server** (background task): static page + SSE push of `state/style/catalog.json` +
  `POST /choices` → `style.json`. Prints `{"url":...}` on stdout — open that URL for the
  user (binds 127.0.0.1; default port 4816, auto-increments if busy).
- **watcher** (background task): one `nanoclip <analysis> get --wait -o …` child per
  analysis, stdout discarded (it echoes the full payload — never read it). At start it
  extracts six plain frames of the source into `state.frames` (the chase-light's
  reveal material while vision cooks). On each landing it extracts a small real
  summary into `state.json` — word chips, tick rows, scene counts, `speaker_rows`
  (who talked, how long — the hero diarization card), and for vision the boxed strip
  frames plus `faces_by_cluster` (real face crops per top cluster) and `asd_moment`
  (the frame the model is most sure someone is speaking in) — updates `plan.json`,
  and exits when everything is terminal (exit 1 if anything failed).

One chat line once the screen is up, e.g.:

`The Screen is live at http://127.0.0.1:4816 — pick a caption style while the analyses
cook (~3–4 minutes on a 10-minute video). I'll pick up the moment the data lands.`

Then wait on the watcher task — no polling, no status calls.

## Seeding state.json (intake does this, right after dispatch)

The watcher initializes `state.json` from `plan.json` when it's missing, but intake
knows two things the watcher can't: the measured upload seconds and the dispatch moment.
Seed `cutting-room/state.json` (schema `cutting-room/state@1`) at dispatch:

```jsonc
{
  "schema": "cutting-room/state@1",
  "updated_at": "<now>",
  "project_id": "<id>",
  "video": { "name": "<source as picked>", "duration_s": 600.07, "width": 1920, "height": 1080, "bytes": 192384833 },
  "facts": { "speakers": null, "scene_cuts": null, "total_usd": "0.58" },
  "stages": {
    "upload":     { "status": "completed", "ended_at": "<now>", "seconds": 23.7 },
    "transcript": { "status": "running", "started_at": "<now>", "expected_s": 114 },
    "vision":     { "status": "running", "started_at": "<now>", "expected_s": 196 },
    "cast": { "status": "waiting" }, "cut": { "status": "waiting" }, "clips": { "status": "waiting" }
  },
  "artifacts": { "transcript": null, "vision": null }
}
```

`expected_s` ≈ duration × 0.19 for transcript+diarize and × 0.33 for vision (measured
ratios); it feeds the chase-light's honest projection — the light's position is eased
and capped so it never overpromises; the visible timer is the truth. `facts.total_usd`
is rendered on the upload strip (`analysis $0.58`) — showing the run's real cost is part
of the page's proof that the machinery is real.

Fields the watcher adds as data lands (all additive, still `state@1`; every image is
a real extraction from the user's own source under `cutting-room/thumbs/`):

- `frames`: `[{ t, boxes: [], thumb }]` — six plain frames, extracted up front.
- `artifacts.transcript.speaker_rows`: `[{ speaker, seconds, share }]` — longest
  talker first; drives the hero diarization card.
- `artifacts.vision.strip`: the same six timestamps with real face boxes. Each
  box is `[x0, y0, x1, y1]` plus an optional trailing cluster id (additive 5th
  element — 4-tuple destructuring keeps working); the page colors boxes per
  person with it, on the same candy cycle as the clustering card's rings.
- `artifacts.vision.faces_by_cluster`: `[{ cluster, crops: [paths] }]` — top three
  clusters, sampled across each cluster's own time span (hero clustering card).
- `artifacts.vision.asd_moment`: `{ t, box, speak_conf, cluster, thumb }` — the
  highest-confidence speaking detection (hero ASD card, "ON AIR").

## The page (what the user sees)

Five beats, one story: `01 WHAT NANOCLIP SEES → 02 WORKING ON YOUR FOOTAGE → 03 YOU
CHOOSE THE LOOK → 04 FINDING THE MOMENTS → 05 YOUR CLIPS`. The right rail is the source
of truth (one popped tab, live timers); the pink chase-light is the reveal boundary in
the running strip; the Kit cart in the header IS `style.json` rendered — caption style
is a single replace-on-add slot, palette accumulates, every change POSTs, no submit.
The fixed footer morphs into the pink "Open preview →" band when clips land, and the
CAST strip fills with the fused cast (real crops + role + on-mic time) — both driven
by `scripts/announce.mjs --dir <rundir> [--preview-url <url>]` at the clips-ready
moment: it lands `artifacts.cast` (from plan.cast) + `artifacts.clips`
(hook/duration/score) + `preview_url`, flips `stages.cast/cut/clips`, additive to
state@1, and seeds state.json when the screen never ran on that dir.

## style.json (read at compose)

```jsonc
{ "schema": "cutting-room/style@2", "aspect": "9:16",
  "caption_block": "caption-camera-follow",
  "palette": { "transitions": [], "blocks": [], "treatments": [], "titles": [] },
  "locked": false }
```

style@2 added the `treatments` (full-frame look layer) and `titles`
(type moments) palette families — additive: readers treat a missing family array
as empty, so style@1 files on disk stay valid; the server writes @2. The catalog
file gained matching `treatments`/`titles` item arrays + curated keys (additive,
still catalog@1).

- Claude reads it when composing starts and then sets `"locked": true` (writes the
  file); the server refuses further POSTs (409) and the page shows the locked kit.
  Later changes go through chat only (checkout = compose start).
- Nothing picked is a valid state — the composer falls back to defaults and says so.

## Failure paths

- Watcher exits 1 → the failed stage carries `error` (stderr tail) in state.json; the
  strip and rail already show it. In chat: report the error verbatim, offer a re-quote →
  NEW spend-gate card → re-dispatch (never re-`start` without a fresh card).
- Server port busy → it auto-tries +9; read the printed JSON line for the real URL.
- SSE drops → the page shows "connection lost — reconnecting" and recovers on its own.
- Restarting server or watcher is always safe: state.json persists, `get --wait` on a
  completed analysis returns immediately, extraction is idempotent.

## Dev & demo

`node scripts/replay.mjs --dir <rundir> [--speed 8] [--source <video>] [--finale]`
replays the recorded fixture run from `fixtures/` on a compressed timeline — the full
arc with zero API spend (real strip thumbs when `--source` points at a local video;
`--finale` simulates the compose tail: cut → three clips → the pink band).

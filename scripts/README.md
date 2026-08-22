# scripts/ — deterministic work, zero dependencies

Zero-dep node only (one exception: the live-player gate `player-probe.mjs` drives real Chrome through `playwright-core`). Judgment belongs to Claude; anything deterministic belongs here so it
costs no tokens. Unit tests ride with each script: `node --test 'scripts/test/*.test.mjs'`
(needs ffmpeg/ffprobe; a few tests probe a real local video — set
`CUTTING_ROOM_PLAYGROUND_SRC` to any long recording to run them, they skip when it is unset).

| Script | What |
|---|---|
| `prefs.mjs` | versioned per-user store (`cutting-room/prefs@1`): language, measured upload/transcode speeds, ship-time usage history (per-family counters in catalog sort shape + last clip count). CLI: `get` · `set language <tag>` · `record-upload` · `record-transcode` · `record-usage` |
| `mezzanine.mjs` | intake media mechanics: `probe` candidates · `decide` (upload-vs-transcode arithmetic) · `transcode` (timed) · `upload` (timed `nanoclip upload` wrapper) · `split` (quote → exact per-command `--approve`) |
| `watcher.mjs` | per-analysis `get --wait` → `state.json` events (stdout discarded — it echoes payloads); extracts real summaries + strip frames (ffmpeg) on landing |
| `server.mjs` | the Screen's entire API: static page + SSE (`state/style/catalog.json`) + `POST /choices` → `style.json`; loopback only |
| `catalog.mjs` | `hyperframes catalog --json` → shorts shelves (caption-style / transitions / accent blocks), prefs-usage sort, house picks, `catalog.json` |
| `replay.mjs` | replays the recorded run from `fixtures/` on a compressed timeline (dev/demo; `--finale` simulates the clips-ready finale) |
| `grid.mjs` | `exact2` — the one rounding rule for plan times: strip float noise off 2dp-true values, pass 1/30-grid values through as the exact double (float law) |
| `demo.mjs` | the keyless demo in one command: server + replay + opens the browser (`--no-open`, `--dir`, `--speed`) |
| `reframe.mjs` | `shots`: deterministic camera-state derivation — extract cuts × transcript turns × face boxes × plan.cast → `plan.clips[].reframe.shots` (solo/split/centered per shot, normalized face crops + zoom) |
| `scaffold.mjs` | `extract`: per-clip 30fps CFR proxy + scene cuts detected on it (reference pipeline) · `build`: one 9:16 HF project per clip riding its proxy (framework-owned media, rebased `data-media-start` trims), Composer-ready paused timeline |
| `digest.mjs` | the token firewall: `build` (speaker×cluster fusion join + turn timeline → `data/digest.json`, ≤20KB golden-tested; long footage auto-shards to an index + `digest.d/seg-NN.json` slices) · `thumbs` (cast face crops via ffmpeg, tolerant) · `locate` (word range → exact source times) |
| `captions.mjs` | `cues`: NanoClip words → composition-clock caption cues (per-segment rebase, speaker/dead-air/word-cap grouping, RTL flag) + Kit style from `style.json` (default when nothing picked) → `plan.clips[].captions`; `scaffold.mjs build` emits the block |
| `announce.mjs` | the clips-ready moment on the Screen: plan.cast + clips → `state.json` (`artifacts.cast/clips`, `preview_url`, tail stages flipped; additive, seeds state if the screen never ran) — fills the CAST strip and morphs the pink band |
| `switch-scan.mjs` · `switch-lab.mjs` · `player-probe.mjs` | switch verification on BOTH runtimes: `switch-scan` = YDIF profile of each draft (double-jump / dead / held-before-cut), `switch-lab` = histogram signatures + contact sheets for flagged seams, `player-probe` = real Chrome against the play server (visibility holes, seek-on-reveal, compositor luma dips; `--replay` covers scrub-backs). `player-probe` is the one script with a dependency: Chrome + `playwright-core` (global install or the `@playwright/cli` bundle) |
| `render.mjs` | check-gated local render: `hyperframes check` must pass per clip, then `render --fps 30` (draft → `<id>-draft.mp4`, high → `<id>-final.mp4`), output ffprobe-verified against the plan's frame count, `plan.clips[].render` stamped |

The page itself lives in `screen/` (index.html + style.css + app.js + lib.mjs; lib is
node-testable pure logic). Agent definitions (Composer, Finisher) live in `agents/`.

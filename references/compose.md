# Compose — plan to compositions, preview, iteration

Stage 6→8 of the flow. The scaffolder, player handoff and captions adapter are real,
shipped machinery; the Composer agent lands on top of this contract.

## 1 · Extract + scaffold (deterministic)

```
node scripts/scaffold.mjs extract --dir <workdir>/cutting-room [--pad 5]
node scripts/scaffold.mjs build   --dir <workdir>/cutting-room [--clip <id>]
```

`extract` first: each proposed/approved clip's window (±pad handles) becomes
`compose/<id>/assets/clip30.mp4` — exact-frame-count 30fps CFR (setpts→fps→tpad
clone→trim chain, `-fps_mode cfr`) — plus its local cut list at threshold 0.12.
Idempotent while segments stay inside the window; boundary tweaks within the pad need
no re-extract. **Segment edges snap to the local cuts:** an in/out point exactly ONE
frame off a cut on the proxy (NanoClip's scene time and the proxy's scdet disagree by a
frame now and then) carried a stray frame of the neighbouring scene — a flash at the
seam. `extract` moves such an edge onto the cut (also on covered re-runs, so chat
boundary edits get it too), says so on stderr, and stamps `snapped_in/out: "local_cut"`.
Exact hits and ≥2-frame overruns are left alone — those are choices.

One standalone HyperFrames project per `proposed`/`approved` clip → `compose/<id>/`:
9:16 root (1080×1920) per the hyperframes-core minimal-composition contract, one muted
inline `<video>` clip + separate `<audio>` per segment (framework-owned playback — never
call play/seek), `data-media-start` trims each segment into the source, consecutive
segments stack on track 0, and one empty **paused** timeline is registered under the clip
id — that timeline is the Composer's mount point. v1 reframe = static center crop
(`object-fit: cover`); ASD-driven keyframes are the Composer's job. Idempotent; stamps
`plan.clips[].composition = { status: "scaffolded", path: "compose/<id>" }`.

## 2 · The HyperFrames boundary — measured facts (hyperframes@0.8.3–0.8.4)

- `npx hyperframes@0.8.4 check` passes the scaffold output with **0 findings** (lint + browser
  audit). Run it before any render; `lint` alone is the fast loop while editing.
- **Hardlink the local source, never symlink:** the play/preview static server returns
  403 on symlinks that resolve outside the project root (path-traversal guard). The
  scaffolder hardlinks `assets/source.mp4` (zero extra bytes; cross-volume falls back to
  a copy with a warning).
- The upload/render decoupling law holds end-to-end: preview and render read LOCAL files
  only; the compressed upload copy is analysis-only. **Locked product decision: the media
  each composition rides is its own per-clip 30fps CFR proxy** (`scaffold.mjs extract`,
  references/reframe.md law #2 and its reference pipeline) — HF records an HTML page to
  frames at k/fps, so the source grid must equal the render grid exactly (the original
  here is 29.97 NTSC), and per-clip extraction keeps the cost independent of source
  length (~80s for 3 clips; a 4h podcast costs the same). The extract also detects that
  clip's scene cuts ON the proxy (`composition.extract.cuts`, frame numbers) — the
  authority for reframe shot switching. Original-source hardlinks remain only as the
  no-proxy fallback.
- Codecs: render decodes via FFmpeg (HEVC fine); live preview auto-proxies
  browser-hostile assets on first use. Our h264/aac mezzanine chain needs no proxy.
- `doctor --json` flags MusicGen and Docker on this machine — both optional, neither
  blocks play/check/local render. Gate on the specific checks you need, not `.ok`.
- **hyperframes 0.8.4 facts:** (a) new lint error
  `video_nested_in_timed_element` — a timed `<video>` inside a timed wrapper is
  forbidden (playback would freeze in renders); wrappers around timed media must be
  non-timed (our scaffold already complies; the old reframe spike needed updating).
  (b) Both spikes re-ran green on 0.8.4 — flip exactly at frame 60, PSNR 9.3–9.8 at
  the switch vs 35–49 elsewhere. (c) Draft render is much faster now: 36.9s clip in
  ~43s (~1.2× realtime; was ~3× on 0.8.3).
- **Render drives the timeline MONOTONICALLY, frame by frame — snapshot/preview seek
  in one jump. They disagree when two tweens overlap on one property of one target:**
  under monotonic stepping the longer tween's later ticks clobber the shorter one
  (a zero-duration `tl.set` inside a running tween's window loses), while a single
  seek resolves by insertion order and hides the bug. Law: never overlap two tweens
  on the same property; and ALWAYS verify overlay motion on rendered frames
  (`render` + ffmpeg frame extraction), not just `snapshot`. Found the hard way on
  caption word highlights (0.08s words vs a 0.12s rise tween).
- **Two runtimes, two clocks (reframe.md §The two-runtime law).** The renderer samples
  t = k/30 and waits for media readiness; the live player (play server +
  `<hyperframes-player>` — the Screen's beat-05 embeds) evaluates visibility at display
  rate and reveals + seeks a timed `<video>` in the same instant. Measured on the
  package E2E drafts: a half-frame hole between consecutive shot windows = a BLACK
  frame in the player at 11/13 switches (never in the render); seek-on-reveal = 2–8
  display frames of the proxy's frame 0; and the same hole made the RENDER repeat the
  frame before every cut and drop the shot's last one. Laws: no hole between shot
  windows — each non-final shot tails half a frame UNDER its successor (pane z-index =
  shot order, tracks alternate 0/1 ↔ 2/3), which also masks the one-frame transparent
  first paint a re-revealed video can show on replays; every timed `<video>` holds its
  own first frame before its window opens (`<script data-cutting-room="prime-media">`,
  scaffold-emitted, Composers keep it); verification runs on BOTH runtimes —
  `switch-scan` (+ `held-before-cut`) on drafts, `player-probe --replay` against the
  play server.

## 3 · Player handoff (flow stage 7)

```
cd <rundir>/compose/<id> && npx hyperframes@0.8.4 play --port 300N --no-open
```

One lightweight player per clip (ports 3003/3004/3005…), long-running background
processes. Hand the user the plain `http://localhost:<port>` URL — `play` has NO
`#project/<name>` fragment (that is a Studio-only routing convention). The player is the
embeddable `<hyperframes-player>`: play/pause, scrub, rate 0.1–5×. **Studio never opens
in v1** — HF stays invisible machinery (design decision); `hyperframes preview` (full
Studio + selection context for agents) exists as a power surface but is not handed out.

**The "clips ready" moment** = `node scripts/announce.mjs --dir <rundir> --preview-url
http://localhost:3009 --urls http://localhost:3009,http://localhost:3010,...` (plan's cast + clips land in state.json → the screen's CAST
strip fills and the fixed footer morphs into the pink band — the screen's finale
behavior; SSE pushes it live, seeds state.json if the screen never ran) + one chat
message with the three URLs, hook + score + reasons per clip.

**Embed spike facts (measured on 0.8.4 — scripts/embed-spike.mjs):**
`<hyperframes-player>` embeds from another origin and WORKS FULLY when `src` points at
a play server (`http://localhost:300N/composition/index.html` + its `/player.js`) —
the play server injects the HF runtime into the composition page and the component
bridges to it (media seeks per data-media-start, captions run, controls/duration
correct). Pointing `src` at the RAW composition file (e.g. the screen server's
`/run/compose/<id>/index.html`) is NOT viable: the timeline runs but media stays at
file t=0 (no runtime, nothing manages media). So the embed surface = the play server
(component src, or an iframe of its page). **A locked product decision reversed the
earlier own-tab-only plan: the clips now embed IN the screen's beat 05** — `announce.mjs --urls
<u1,u2,...>` lands a player url per clip card and the page mounts
`<hyperframes-player src="<url>/composition/index.html">` (loading `<url>/player.js`
once). The pink band's "Open preview" own-tab CTA remains as the secondary path.
Verified live: three embedded players with correct durations and controls on a
real production run.

## 4 · Iteration (chat is the editor)

- **Boundary change** ("start c2 two seconds earlier"): update `plan.clips[].segments`
  (via `digest.mjs clip --words` when re-anchoring to words) → re-run the scaffolder
  (idempotent, regenerates index.html) → tell the user to refresh the player tab.
  `play` serves from disk and does not promise hot reload — refresh after every edit.
- **Composition change** (Composer motion, captions, accents): edit
  `compose/<id>/index.html` → `npx hyperframes@0.8.4 lint` (fast) → refresh the tab.
  Keep the contract: framework owns `.clip` visibility and media playback; animate only
  the allowlist; the single paused timeline under the clip id.
- **Full re-cut** ("different clip instead of c3"): editorial pool first
  (references/editorial.md §0b) → new segments → scaffold → same player port picks up
  the new composition on refresh.
- `npx hyperframes@0.8.4 check` gates every render; render itself belongs to the ship
  stage (draft for iteration, `--quality high` for delivery, verify the output file
  exists and probes).
- **After any timing change (boundary, reframe, rescaffold) or HF bump:** re-render
  the drafts, then `node scripts/switch-scan.mjs <rundir>` (render) AND
  `node scripts/player-probe.mjs --port <play port> --clip <id> --plan <rundir>/plan.json
  --replay` (live player) — the two runtimes fail differently (§2).

## 5 · Captions

```
node scripts/captions.mjs cues --dir <workdir>/cutting-room [--clip <id>]
node scripts/scaffold.mjs build --dir <rundir>        # emits the block
```

`captions.mjs cues` turns NanoClip words into `plan.clips[].captions.cues` and the
scaffolder emits the block; re-scaffolding never loses captions because plan.json is the
only source. The laws:

- **Composition clock, not proxy clock.** A word at source time t inside segment i lands
  at `segBase + (t − seg.src_in)` — composition 0 = clip start. The proxy shift
  (t − extract.start, reframe.md) belongs ONLY in `data-media-start`; word mounts on the
  timeline use composition seconds. (Getting this wrong shows as captions late by
  exactly the extract pad.)
- **Grouping is deterministic:** a cue breaks at a speaker change, at dead air
  ≥ 0.8s, at 4 words, and at segment seams. Cue end = last word end + 0.5s hold,
  yielding 0.05s before the next cue, clamped to the clip end. Constants exported from
  captions.mjs.
- **RTL is per-cue:** any strong Hebrew/Arabic run flags the cue `rtl: true` → the
  emitted group carries `dir="rtl"` and lays out right-to-left. VERIFIED visually:
  pure-Hebrew and mixed Hebrew+Latin cues render in correct bidi order,
  punctuation on the correct side, active-word highlight intact.
- **Style comes from the Kit:** `resolveStyle` reads `style.json` `caption_block`
  (screen.md); nothing picked → `caption-highlight` default with
  `style_source: "default"` — say so in chat. The scaffold's emitted block is the
  highlight archetype (static cue/word markup, word-timed mounts, instant revert so
  exactly one word is ever highlighted); the chosen style name rides
  `data-caption-style` for the Composer to restyle with full fidelity.
- **Mounts land on the ONE registered paused timeline** (`window.__timelines[<clip id>]`)
  — captions never add a second timeline; the Composer's other motion extends the same
  one. Per-clip disable: `captions.enabled: false` in the plan is honored.
- Known cosmetic: white text over bright frames can dip below 3:1 contrast between
  highlights (`check` warns, does not fail) — a styling concern for the Composer pass.

## 6 · Composer

One agent per scaffolded clip (agents/composer.md has the spawn prompt, steering, and
degraded path): restyles the §5 caption block toward the Kit pick, wires the style.json
palette blocks, resolves check warnings, loops lint → check → snapshot → render-probe.
Each Composer reads ONLY references/compose-short.md — the distilled composition
contract (root/media ownership, the one registered timeline, determinism laws incl.
the monotonic-render overlap rule, palette wiring, the loop, hard boundaries). It owns
`compose/<id>/` + `plan.clips[i].composition` and nothing else; boundary/timing needs
come back as report items. **Compose start = Kit checkout:** if style.json exists,
set `"locked": true` before spawning (server 409s further edits); nothing picked →
defaults, said in chat. Parallelism ≤3 concurrent Composers.

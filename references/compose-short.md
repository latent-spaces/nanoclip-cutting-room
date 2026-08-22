# compose-short — the Composer's distilled reference

You are a Composer working ONE scaffolded HyperFrames project (`compose/<id>/`). This
file is your ONLY HyperFrames reference — do not load the hyperframes-* skills; the
contract below is complete for your job. Everything was measured on hyperframes@0.8.4.

## The project you open

One standalone 9:16 composition, `index.html` at the project root:

- Root: `<div id="root" data-composition-id="<id>" data-start="0" data-width="1080"
  data-height="1920" data-duration="...">`. Never change these.
- **Media is framework-owned.** Timed elements carry `class="clip"` +
  `data-start`/`data-duration`/`data-media-start`/`data-track-index`. The per-shot
  `<video>` elements (inside `.pane` divs, static px crops) implement the reframe;
  `<audio>` elements (track 10) carry the sound. NEVER: touch their timing attributes,
  animate their geometry, nest a timed element inside another timed element (0.8.4
  lint error `video_nested_in_timed_element`), or call play/pause/seek on media.
- **`<script data-cutting-room="prime-media">`** (emitted by the scaffolder, right
  after the media): pre-seeks every timed `<video>` to its own first frame before its
  window opens and re-arms it on window exit. The live player reveals and seeks a
  video in the same instant — without this block viewers see the proxy's frame 0 for
  2–8 display frames at every shot switch. Keep it verbatim; never add your own
  play/pause/seek calls.
- **One registered paused timeline**: `window.__timelines["<id>"] = tl` (GSAP,
  `paused: true`, built inside an IIFE). ALL motion mounts on this timeline at
  composition-time seconds. Never create a second timeline for the composition, never
  autoplay, never `gsap.to()` outside the timeline — the framework seeks `tl` to
  render; anything not on it does not exist at render time.
- **Captions block** (emitted by the scaffolder, driven by `plan.clips[].captions.cues`):
  `<div id="<id>-captions" class="captions" data-caption-style="<kit style name>">` →
  `.cap-cue` divs (RTL cues carry `dir="rtl"` — keep it) → `.cap-word` spans, plus a
  `CUES` array + mounts inside the timeline IIFE. You may restyle ALL of this (CSS,
  colors, fonts, mount easings/durations) toward the style named in
  `data-caption-style`; you may NOT change cue/word text or their timing data (that
  belongs to scripts/captions.mjs — if timing is wrong, report, don't patch).

## Determinism laws (renders are HTML recorded frame by frame)

1. **Seek-safe only.** Every visual state must be a pure function of timeline position:
   initial states via CSS or `tl.set(..., 0)`, changes via tweens at explicit times.
   No `Date.now()`, no `Math.random()`, no rAF-driven motion, no CSS animations that
   free-run outside the timeline, no transitions on properties the timeline drives.
2. **Render advances the timeline MONOTONICALLY frame by frame; snapshot/preview seek
   in one jump. Two tweens overlapping on one property of one target disagree between
   the two modes** (the longer tween's later ticks clobber the shorter/set; a single
   seek hides it). Never overlap two tweens on the same property of the same target —
   clamp a rise so it ends before its revert starts (see the caption mounts for the
   pattern). Verify overlay motion on RENDERED frames, never only on snapshots.
3. Fonts: declare the family by name and let the renderer resolve it — it maps
   Google Fonts families during compile/render (the scaffold's `"Montserrat"` stack
   is the model). Do NOT add a `<link>`/`@import` to fonts.googleapis.com: lint flags it
   (`google_fonts_import`) and the raw request can fail before canonicalization. A
   registry component that ships its own link is exempt from the lint. Custom
   files: `@font-face { src: url('…woff2') }`. Always keep a system fallback stack.
4. Allowlist for animation: transform / opacity / color / background-color / filter /
   clip-path on NON-media elements. Nothing else, nothing on media.
5. **Two runtimes.** The renderer samples t = k/30 and waits for media; the live
   player (what the user watches in the Screen) samples at display rate in real time.
   Anything you add on top of the media must be true at EVERY instant, not only on
   the 30 fps grid: no holes between consecutive timed windows (a hole is a black
   frame in the player, invisible to the renderer), nothing that depends on a seek
   having landed. The per-shot `<video>` windows deliberately overlap by half a
   frame (each shot tails UNDER its successor; pane `z-index` = shot order; tracks
   alternate 0/1 ↔ 2/3) — do not "fix" that overlap, do not re-time the windows or
   change pane z-index to cure something you see in a snapshot. Shot switches are
   verified on both runtimes by the main thread (`switch-scan` on drafts,
   `player-probe` on the play server).

## Palette blocks (the Kit's picks: style.json@2 `palette.{transitions, blocks, treatments, titles}`)

Install a registry item into THIS project dir:

```
npx hyperframes@0.8.4 add <name> --no-clipboard --json
```

- **Components** land in `compositions/components/<name>.html` — a standalone demo
  page. Wire by MERGING: its HTML into `#root`, its CSS into the `<style>` block, its
  JS into the timeline IIFE (mount its tweens on the registered `tl`, at composition
  times you choose). Strip the demo's own root/timeline registration — the composition
  already has both. Respect law 2 when adapting its tweens.
- **Blocks** land in `compositions/<name>.html` — include via
  `<div data-composition-id="<block id>" data-composition-src="compositions/<name>.html"
  data-start=".." data-duration=".." data-width=".." data-height=".."
  data-track-index="15"></div>` (block id = the id inside the block file).
- **Treatments** (style@2) are a FULL-FRAME look layer (grain, vignette, grade…):
  mount ONE treatment spanning the whole clip, layered above media and below
  captions. Never stack treatments, never let one dim the captions below contrast.
- **Titles** (style@2) are type moments: at most one, only where a natural beat
  exists (an opener before the first word, a beat gap) — never delay or cover the
  spoken hook, never overlap caption words.
- Layering: media tracks 0–1 · block includes ~15 · treatments between media and
  captions · audio 10 (sound, not layered) · captions z-index 20 (CSS). Keep
  captions on top unless the style demands otherwise.
- Nothing picked in the Kit is a valid state: apply defaults, and say so in your report.
- Palette stays PERMISSION, all four families: skip any pick that fights the footage,
  and say why in your report.

## The loop

```
edit index.html
npx hyperframes@0.8.4 lint      # fast, after every edit
npx hyperframes@0.8.4 check     # the gate: must pass; drive errors to zero
npx hyperframes@0.8.4 snapshot --at <t1,t2,...> --no-end -o snapshots   # look at your work
npx hyperframes@0.8.4 render --quality draft --fps 30 --output <id>-draft.mp4   # overlay-motion proof
ffmpeg -v error -y -i <id>-draft.mp4 -ss <t> -frames:v 1 probe.png        # rendered-frame check
```

Contrast warnings from `check` are real (white text over bright footage between
highlights) — fixing them within the caption block's styling is your job; a subtle
per-word scrim/stroke/shadow is the usual answer. Delete `snapshots/` and probe PNGs
before finishing.

**Caption placement law (found by the Finisher pass on rendered output):** the word band never sits in
the face zone. Reframe crops center faces around 40–55% height, so vertically
centered captions occlude the speaker for the whole clip. Default: band center at
~70% (lower third, above platform-UI space). Split layouts may use the pane seam
instead (faces clear on both sides); verify on rendered frames, not snapshots.

## Boundaries (hard)

- You own: `compose/<id>/index.html` (+ files you install under `compose/<id>/`).
  **Never write `plan.json`** — Composers run in parallel and a read-modify-write
  races the others (observed: stamps lost). Your status goes in your report; the
  main thread stamps `plan.clips[<yours>].composition.status = "composed"` on PASS.
- Boundary/timing changes (clip in/out, cue times, shot framing) are NOT yours:
  report the need back; the main thread re-runs the owning script.
- Do not start players/servers; do not touch other clips' dirs; do not upgrade or
  reconfigure hyperframes.

## Report back (your final message)

1. What you changed (one line per change) and why.
2. `check` result (must be passing; list remaining warnings if any and why they stay).
3. Rendered-frame verification: which times you probed and what they proved.
4. Anything you needed but couldn't touch (boundary requests for the main thread).

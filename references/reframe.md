# Reframe — camera state from faces

These rules come from prior production experience with frame-accurate reframe pipelines,
captured as law before any reframe code existed, then verified by spikes.
**Law #2 is a locked product decision: the render source MUST be the 30fps transcode.**
The mechanism: HyperFrames is an HTML page recorded to frames — render samples the
timeline at k/fps and seeks media to continuous time. Source grid == render grid means
sample k maps 1:1 to source frame k; a 29.97 source under a 30fps sampler drifts a frame
somewhere every ~33s (duplicate/skip), and at a cut boundary the wrong side shows.
**Spike PASSED (scripts/reframe-spike.mjs):** a zero-duration wrapper
`tl.set()` at t=2.0 on the 30fps working copy rendered frame-exact — frames 58≡59 (old
framing), 60≡61 (new framing), exactly one flip, no ghost/blend, media advancing 1:1.
Law #3's control surface is verified on hyperframes@0.8.3. Draft render ≈ 3× realtime
(4s in 11.2s). The battle-tested reference pipeline is recorded in §"Reference pipeline"
below. THIS DOCUMENT IS NOW LAW.

## The three laws

1. **Camera state changes ONLY at scene cuts.** Piecewise-constant framing: hard switch
   on the cut frame, static between cuts. No continuous pan, no smoothing, no drift.

2. **Normalize the working copy to exactly 30fps and re-detect cuts on it. Never map
   frames across timebases.** Measured why: the source is 29.97fps (30000/1001 NTSC —
   ffprobe verified; the payload's PTS deltas of 1001 said so). NanoClip's scene PTS live
   on that grid; HF renders on a clean 24/30/60 grid (`data-fps` hint + `render --fps`,
   default 30). Any mapping between the two timebases lands a cut mid-frame somewhere —
   an off-by-one frame that shows as a visible glitch at the switch — one frame too
   early on one side of the cut, one frame too late on the other. So:
   - Transcode ONCE per input to a 30fps-exact local working copy (wall-clock times
     preserved — word/face timestamps stay valid; reuse the intake stage's mezzanine
     transcode machinery).
   - Re-run scene detection with ffmpeg ON that copy — its cuts are native to the render
     grid. The battle-tested reference pipeline below covers this step (use it, do not
     reinvent thresholds).
   - Author reframe switches at exact k/30 times from THAT list; render `--fps 30`.
   - **Two cut lists, two jobs:** NanoClip's `scenes[]` stays the editorial signal in the
     digest (clip snapping, energy). The locally re-detected 30fps list is the ONLY
     authority for reframe switch times and render-side frame math. Never mix them.

3. **SPLIT-SCREEN IS A REQUIREMENT (locked product decision) — and the chosen mechanism gives
   it free.** Verified by a second spike (scripts/split-spike.mjs, check 0 findings,
   frames 59/60 inspected): **shots are separate video elements with STATIC CSS crops
   (`object-fit: cover` + `object-position` + pane geometry), and layout switching is the
   framework's own clip timing** — each shot's element(s) carry `data-start`/`data-duration`
   for exactly that shot (solo = one full-frame element; split = two static half-pane
   elements on separate tracks), with the earlier shot ending one frame short (end = next
   start − 1/30; clip windows are inclusive at both ends). No reframe animation code at
   all; the registered paused timeline stays empty for the Composer's other motion. Cost
   measured: render time scales with total pane-seconds (4s solo 11.2s vs solo+split
   21.4s, draft). Current HF (0.8.3) ships NO native reframe/crop primitive (checked:
   registry catalog 373 items, media-use = offline file ops) — this composition-level
   pattern IS the mechanism. plan@2 reframe extends additively to
   `shots: [{t, layout: "solo"|"split", panes: [{person, x, y, zoom}]}]`.

   *(Also verified, as fallback for continuous-transform needs:* HyperFrames owns
   the composition and media playback; the reframe must not fight it. The allowed control
   path: a **non-timed wrapper** around the timed `<video>` (never animate the timed
   media element's own dimensions — core contract), transform-only changes
   (translate/scale in normalized coords → px), applied as **zero-duration `tl.set()`
   steps at the cut times** on the clip's single registered paused timeline. Seek-safe by
   construction; the framework keeps owning `.clip` visibility and playback.
   *a non-timed wrapper + zero-duration `tl.set()` renders frame-exact too — first spike.)*

## The float law (found via a real glitch report — LAW)

**Never emit boundary-exact grid times into `data-start`/`data-duration`.** The runtime
shows a clip while `start ≤ t ≤ start+duration` (inclusive both ends, hyperframes-core
data-attributes.md) with RAW float comparison, sampling t = k/30 — and 1/30 has no
finite decimal. A 4-decimal-rounded start lands a hair above its own frame's sample
time (or the end a hair below its last frame's) and the element misses boundary
frames: **1-2 fully black frames at shot switches**, measured on all three drafts.
The tell: switches at frames divisible by 3 (exact decimal — 45→"1.5") were clean;
every other switch glitched. Both spikes passed because their switch sat at t=2.0
exactly — spikes at representable times DO NOT cover this law.

**LOCKED DECISIONS: (a) the toolchain is PINNED — every programmatic and
documented invocation is `npx hyperframes@0.8.4` (constant `HYPERFRAMES_PKG` in
render.mjs; an upgrade = bump it deliberately, re-run both spikes + switch-scan).
(b) Never round grid-valued (1/30) numbers — attributes carry the exact double
(shortest round-trip). `round2` remains ONLY for 2dp-true values (the NanoClip word
grid), where it recovers the exact decimal from float noise — that is noise-stripping,
not precision loss. (c) `<video>` elements carry NO `class="clip"` (hyperframes-core
data-attributes.md: clip class is for div/img; the framework manages video visibility
directly) — verified: check passes, all switches scan clean, zero black intervals.**

The fix (scaffold.mjs `gridStart`/`gridDur`): windows carry **quarter-frame margins** —
start = (f0−0.25)/30, non-final end = (f1−0.75)/30 (duration durFrames+0.5), final end
= (f1−0.25)/30 — so the intended frames f0..f1−1 stay covered and no window edge ever
sits on a sample point, immune to rounding/ulp/comparison semantics. Bonus: media
seeks now land mid-frame-interval instead of on a PTS boundary — the classic
"one frame less, one frame more" media flip can't trigger either.

**Verification is render-level, not preview-level:** `node scripts/switch-scan.mjs
[<rundir>]` — YDIF profile of each draft; PASS = every switch is a single big
frame-difference, no double-jump (ghost/black), no dead switch. Re-run after any
timing-emission change or HF upgrade (alongside the two spikes).

Per shot (between consecutive local cuts inside the clip window): the active speaker =
plan cast person speaking during the shot (digest turns); their face box = the payload's
detections for that person's cluster_ids within the shot, median box. Crop window: cover
the face box with headroom margin, `zoom = clamp(target_face_share / face_share)`,
centered on the box center, clamped to frame edges. One `{t, cx, cy, zoom}` per shot,
`t` = the shot's first frame (k/30). Shots with no confident face (b-roll, graphics):
fall back to center crop, zoom 1. Output → `plan.clips[].reframe.keyframes` (plan@2
contract, normalized 0–1), consumed by the scaffolder's transform adapter.

## Shot polish (second real glitch report — jump-cuts at scene seams, LAW)

Real review still surfaced seam jumps after the float law. The harness that found them:
`scripts/switch-lab.mjs` — for every switch, frames f0−2..f0+2 from the RENDERED
draft, 8×8×8 RGB histogram chi-square distances between neighbors, signature classify
(clean / GHOST / DISPLACED / SOFT / DEAD) + a labeled contact sheet per flagged seam.
Semi-automatic (sheets for eyeballing) and fully automatic (exit code). It caught what
the YDIF switch-scan missed:

- **SOFT seam (c2 f747):** a real footage cut between near-identical takes of the same
  person; the derived medians differed by Δcx 0.003 → the crop jolted 15px. Law:
  consecutive shots with the same layout+persons whose crop deltas are within
  `CONTINUITY_EPS_POS` (0.02) / `CONTINUITY_EPS_ZOOM` (0.1) REUSE the previous crop
  verbatim, and identical adjacent shots then COLLAPSE into one element — the seam
  cannot exist at all.
- **1-frame shot (c1 f1106):** a cut 1 frame before the clip end made a crop-flash
  final shot. Law: shots shorter than `MIN_SHOT_FRAMES` (8) are absorbed by their
  neighbor (a tiny first shot merges forward), keeping the neighbor's crop.

Both live in reframe.mjs `polishShots` (per segment — never across a segment seam,
media time is only continuous inside one). Verified: both scanners clean on all three
re-rendered drafts (switch-scan YDIF + switch-lab histograms, 0 flagged), shot counts
dropped c1 14→13, c2 12→11.

## The spike (before building the full path)

One clip, two framings, one hard switch at a known local cut: scaffold → `render
--quality draft --fps 30` → extract ±3 frames around the switch with ffmpeg → eyeball:
the framing change and the shot change land on the SAME frame, no ghost frame.
**Ran and PASSED — see the header. Re-run via scripts/reframe-spike.mjs after any
HF upgrade or fps-pipeline change.**

## Reference pipeline — frame-accurate extraction (use as-is)

**Scope decision (locked + measured):** the 30fps lock runs PER CLIP, not on the full
source — extraction cost stays ~seconds regardless of source length (a 4h podcast would
cost ~an hour to normalize whole), and the prior production pipeline these rules come
from built bounded proxies the same way (`trim=end_frame`). Extract each clip window with ±pad handles (default 5s) so
small boundary tweaks need no re-extract.

**1 · Transcode — lock to 30fps CFR (`CANONICAL_EDIT_FPS = 30`):**

```
[0:v]setpts=PTS-STARTPTS,fps=30,tpad=stop_mode=clone:stop_duration=<eof_pad>,trim=end_frame=<frames>,setpts=PTS-STARTPTS
```

reinforced on the encode side so the container can't disagree with the filter graph:
`-r 30 -fps_mode cfr`. Clone-pads EOF and trims to an EXACT frame count — bit-for-bit
predictable duration, frame index ≡ wall clock (frame 90 is always second 3.000).

**2 · Scene detect — on the file just produced, never the source:**

```
ffmpeg -nostdin -i <extract> -an -vf "select='gt(scene,0.12)',showinfo" -f null -
```

Threshold **0.12** (calibrated in prior production use — keep). Parse `pts_time:` lines from stderr,
`frame = round_half_up(pts_time * 30)`. The two ffmpeg calls run back to back and the
second's `-i` is the first's output path — no intermediate hop, no re-timestamping
across frame rates. "Frame 214" means the identical image in proxy, player, and export.

**3 · Historical note — canvas reframe on an older HF build (NOT today's path):**
an earlier production pipeline shipped reframe as a custom compositor: invisible 1×1 `<video>` feeding
pixels, same-size `<canvas>` drawing blurred cover backdrop + sharp `drawImage` crop
rects (multi-rect = split-screen), dual clocks (rVFC live / decode-hook on HF's injected
`<img>` in export) with a heartbeat-during-export ghost-paint bug. It is recorded here
only as how it worked at the time, on an old HF version. Today's verified path is the wrapper
`tl.set()` (spike above) through documented primitives — no custom compositor, no dual
clocks. Revisit the canvas approach ONLY if v2 wants split-screen panes or a blurred
backdrop (zoom ≥ cover needs none).

## Implemented

`scripts/reframe.mjs shots --dir` derives `plan.clips[].reframe.shots` exactly per this
document; `scripts/scaffold.mjs build` emits the per-shot elements (split-spike pattern:
static px crops via `cropPx`, non-final shots one frame short). Verified on a real
three-clip run: 15/14/18 shots, B-roll shots honestly centered, `check` 0 findings, player
crops track the speaking face. Note for the calibration-debt pass (editorial.md §8):
those three clips produced 0 splits —
split requires BOTH faces in-frame (the wide two-shot) while both speak ≥min(0.5s,
shot/2); this footage cuts to solo cams during exchanges. Loosen thresholds there if
real usage under-splits.

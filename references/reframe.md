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
   - Segment edges are then reconciled with the PROXY's cuts, not NanoClip's: an edge
     one frame off a local cut is a stray frame, and `extract` snaps it (compose.md).
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
   elements on separate tracks), windows on the quarter-frame grid with NO hole between
   them — each shot tails half a frame under its successor (see the two-runtime law
   below). No reframe animation code at all; the registered paused timeline stays empty for the Composer's other motion. Cost
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
directly) — verified: check passes, all switches scan clean, zero black intervals.
(d) The same rule holds INSIDE plan.json: a segment edge snapped onto a local cut
(`scaffold.mjs extract`, compose.md) is stored as the exact grid double
(`89.42666666666668`), never its 2dp neighbour — and every consumer goes through
`exact2` (scripts/grid.mjs): noise-strip a 2dp-true value, pass a grid value
untouched. Measured: the 2dp neighbour (89.43) re-admitted the stray frame
(ceil(1106.1) = 1107 render frames); the exact double renders 1106.**

The fix (scaffold.mjs `gridStart`/`gridEnd`/`shotWindow`): every shot window starts at
**(f0−0.25)/30** (shot 0 at the origin) and its render-relevant end is **(f1−0.25)/30**
— the intended frames f0..f1−1 stay covered and no window edge ever sits on a render
sample point, immune to rounding/ulp/comparison semantics. Media seeks at a shot start
land mid-frame-interval (quarter frame in), so the classic "one frame less, one frame
more" flip can't trigger. Non-final windows then run half a frame longer, UNDER the
successor — the two-runtime law below says why.

## The two-runtime law (third real glitch report — black frames in the player, LAW)

A composition runs on TWO runtimes and they disagree exactly at shot switches:

- **The renderer** samples t = k/30 on the grid and waits for media readiness
  (`readyState ≥ HAVE_CURRENT_DATA`) before every capture.
- **The live player** (play server + `<hyperframes-player>`, i.e. the Screen's beat-05
  embeds and the owner's tab) evaluates visibility at DISPLAY rate (rAF ≈ 60 Hz, off
  the grid) and reveals a timed `<video>` and seeks it in the same instant, in real time.

Measured on the first version of the margins (start −0.25, non-final end −0.75 = a
16.7 ms hole between consecutive windows), with scripts/player-probe.mjs:

1. **Hole → black frame.** A 60 Hz sample landed inside the hole at 11/13 switches:
   no video element visible for one tick, the root background paints — one fully black
   display frame per switch. The render never samples the hole (k/30 is never inside
   it), so switch-scan/switch-lab/blackdetect were all clean. **Law: no hole between
   consecutive shot windows, on any clock.** (Contiguous windows — end = next start —
   were measured clean on first play, 76/76 reveals; HF's own idiom for sequential
   clips is the same: `data-start="<prev-id>"`, hyperframes-core tracks-and-clips.md.)
2. **Seek-on-reveal → wrong frame.** Before its window opens a timed video sits at
   file t=0 (the runtime seeks only in-window media). At reveal it is shown AND seeked
   to `data-media-start`; the seek takes 33–139 ms (2–8 display frames, not GOP-bound —
   the proxies already carry a keyframe at every cut) during which the viewer sees the
   frame the element held: the proxy's frame 0 (the pad, whoever was on camera 5 s
   before the clip). **Law: every timed `<video>` holds its own first frame before its
   window opens.** scaffold.mjs emits `<script data-cutting-room="prime-media">`: on
   `loadedmetadata` each video pre-seeks to its `data-media-start`; when the runtime
   pauses it outside its window (window exit, composition end) it re-arms to the same
   frame, so replays and scrub-backs reveal correctly too. Measured after the fix: the
   incoming element is `readyState 4`, not seeking, at `media-start + 1 ms` on every
   reveal, and the runtime does not re-seek (the delta is under its tolerance). The
   renderer is unaffected — it seeks in-window media per frame and waits. **Composers
   keep this block; a rescaffold re-emits it.**
3. **The hole also broke the RENDER, silently.** The runtime clamps a window's media
   time at `duration − 1/fps` on its last sampled frame; with the −0.75 end that clamp
   landed inside the previous frame → frame f0−1 REPEATED f0−2 and the shot's true last
   frame was dropped: a 1-frame freeze + skip at every cut (c1 11/13, c2 3/11, c3
   13/24 on the package E2E drafts). YDIF/histogram scanners read "held frame, then one
   clean jump" as clean. With the end at (f1−0.25)/30 (+ tail) the last fully-visible
   sample is no longer clamped and shows the shot's true last frame (verified against
   the proxy frames: 580, 581, 582 — not 580, 580, 582).
4. **Transparent first paint on re-reveal → the half-frame TAIL.** With holes closed
   and videos primed, first play measured clean (76/76 reveals across four
   compositions). On REPLAY (seek back after a window had played and closed) the
   freshly revealed element occasionally paints nothing for ONE compositor frame
   (4/89 reveals): JS already sees the right frame (`readyState 4`, canvas luma of the
   shot's first frame) but the compositor has no surface yet — with the root painted
   magenta the blank frame was magenta, i.e. the element is transparent, not black.
   **Law: every non-final shot window keeps a 0.5-frame tail past its successor's start,
   UNDER it** — pane `z-index` = shot order (a stacking context the runtime's track
   z-ordering cannot override), `data-track-index` alternates 0/1 ↔ 2/3 per shot
   because lint forbids same-track overlap (overlap on different tracks is the
   sanctioned crossfade idiom). A transparent first paint now shows the previous
   shot's last frame for 16 ms (a one-display-frame-late cut, invisible) instead of
   the background. Render sample f1 falls inside the tail and shows the successor on
   top — pixels identical to no tail; one extra decoded frame per switch.

**Verification is render-level AND player-level — both, every time the timing emission
or HF changes:**

- `node scripts/switch-scan.mjs <rundir>` — YDIF profile of each draft; PASS = every
  switch is a single big frame-difference, no double-jump (ghost/black), no dead
  switch, **and no held frame before the cut** (`held-before-cut`: f0−1 repeats f0−2
  while the preceding frames move). Then `switch-lab` for the flagged seams.
- `node scripts/player-probe.mjs --port <play port> --clip <id> --plan <rundir>/plan.json
  --replay` — real Chrome against the play server: per switch, no sample with zero
  visible videos, incoming element ready (not seeking) at first reveal, no luma dip in
  the compositor screencast; `--replay` repeats the pass after `seek(0)` to cover the
  re-arm path. Needs Chrome + playwright-core on the machine.

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

# Editorial — what makes a clip

**Consumer:** the main-thread editorial pass, reading `digest.json`, writing `plan.json` `clips[]`.
This playbook is a locked product decision. Examples come from the recorded fixture run —
the synthetic panel show *The Prototype Hour* (see `fixtures/README.md`).

## 0. The job

Read the digest. Propose 3 clips (prefs knob; "more clips" appends). For each, write `segments`,
`hook`, `title`, `score`, `reasons` into plan.json and say the same three things in chat.
This document is the judgment; the scaffolder enforces the mechanics.

## 0b. Running the pass — one context or many

`data/digest.json` decides the shape. **It has `timeline`** (short footage): read it whole,
apply §1–§6, write `plan.clips` — AND `data/candidates.json` with everything you
considered (the pool below is the iteration contract on short footage too; "swap c2"
must never re-read the timeline). **It has `shards`** (long footage): map-reduce — the full
timeline never enters one context.

- **Scouts, one agent per shard, parallel.** Each scout reads the index (cast + notes) and
  its ONE `digest.d/seg-NN.json`, applies §1–§5 to its region only, and returns STRICT
  JSON, nothing else: `{ "candidates": [{ "word_range": [a, b], "hook": "…", "title": "…",
  "score": 0.87, "reasons": ["…"] }], "region": { "title": "…", "summary": "…" } }` — at
  most 5 candidates, disqualified moments (§2) omitted entirely. Word math: a turn row's
  `word_idx` is its first word; a hook starting k words into the turn text is word
  `word_idx + k`. Scouts write no files and never open the payloads.
- **Visual gap notes (bounded by design).** Before spawning scouts, run
  `node scripts/digest.mjs gapframes --dir <rundir>` — it extracts downscaled frames from
  inside the big silence gaps (defaults: gaps ≥5s, top 3 per region by length, 2 frames per
  gap at the 25%/75% interior points, 480px wide) into `thumbs/gaps/` +
  `data/gap_frames.json`. Each scout's prompt lists ITS region's rows only; the scout Reads
  those images (≤6 per scout by the bounds) and adds `"gap_notes": [{ "t": 332.9, "note":
  "…one line: what happens on screen" }]` to its JSON — a note per gap that SHOWS something
  (a title card, a physical bit, something being watched); gaps showing nothing are omitted.
  Measured examples: the fixtures' 5.6s gap at 332.9s = a host plays a clip and the panel
  watches it (the visual punchline a text scout can't see); a production run's 7.1s gap at
  31.7s = the show's title card — branding, not content, and naming evidence the transcript
  never said. This is an
  annotation layer on top of ASD/vision data, never a scout replacement, and never a
  global vision pass — the bounds hold on a 4h podcast. `no_source` output = skip the layer,
  say so.
- **One judge head.** Collects all scout JSON (a few KB), applies §6 globally — diversity,
  spread across the runtime, ties to the stronger hook — picks the batch, then resolves
  each pick deterministically: `node scripts/digest.mjs clip --dir <rundir> --words a..b`
  → `src_in/src_out` (snapped per §3). `a..b` is end-exclusive: b = the index AFTER the
  last word you want. Read back the returned `text` — its last word must be the punchline. Reads the scouts' `gap_notes` alongside candidates —
  a visual moment can boost or seed a candidate (a physical bit is clip material; a title
  card warns "don't cut into this") — and merges all notes into the pool file as a top-level
  `gap_notes: [{ seg, t, note }]` (additive to candidates@1). Writes `plan.clips`
  (`status: "proposed"`) and says hook · score · reasons per clip in chat (§6 is contractual).
- **Chapters, free byproduct:** the judge stitches the scouts' region titles/summaries into
  `plan.chapters` `[{ title, t0, t1, summary }]`. v1 surface = plan.json + chat only.
- **The pool.** EVERYTHING the scouts returned lands in `data/candidates.json`
  (`cutting-room/candidates@1`: `{ schema, source, candidates: [{ …scout fields, seg,
  status: "pooled" | "proposed" | "rejected" }], chapters }`). Iteration law: "more clips" /
  "find better" reads the pool FIRST and only re-scouts a targeted chapter when the pool is
  dry. Iteration never re-reads the whole timeline.

## 1. The three tests

Every proposed clip passes all three. A clip that fails one is not "weaker" — it is not a clip.

**1. The hook — the clip opens ON the moment.**
Cold open: the first utterance IS the hook, never context leading to it.
Real example: `60s · "I got a DM from a haunted vending machine."` — absurd concrete claim,
zero setup needed.
Hook types, strongest first: named entity in an absurd situation · claim that demands defense ·
open conflict between speakers · confession mid-story · question the viewer can't answer.
The caption test: the first ≤8 words must work as an on-screen overlay. "I got a DM from a
haunted vending machine" passes — the absurdity is on screen by word eight. "So anyway, we
were talking about" fails.

**2. The arc — setup, turn, payoff, all inside.**
The clip ends within ~2 seconds after the payoff. Never trail out.
The antecedent rule (checkable against the transcript): every pronoun and reference resolves
*inside* the clip. Real borderline: `3s · "I did my Marlo Vane for some reason."` — intriguing
alone, but "did" resolves only if the impression that follows is in the clip. Intrigue with a
payoff inside is a hook; intrigue without one is confusion.

**3. Standalone comprehension.**
A viewer who has never heard of the show understands the clip. No episode context, no
earlier-clip dependency, no inside references that carry the weight of the joke.

## 2. Hard disqualifiers

Not scored low — dropped.

- **Ad reads, merch plugs, housekeeping.** The classic trap: an episode that opens on the
  merch plug (first ~20s, "Go to our merch store…") — high energy, zero clip value.
- Unresolved antecedent (§1.2).
- Boundary mid-word or mid-sentence (plan contract; should never survive snapping).
- Under ~12s (no arc fits) or over ~90s (not a short).
- The joke is the show's inside lore.

## 3. Boundaries — mechanical rules

- **Snap:** always to an utterance boundary; when a scene cut (`vision.scenes[]`, documented
  "use as edit cut points") sits within ~1.5s of it, snap to the cut.
- **Enter:** on the hook utterance. One earlier setup utterance is allowed only when the
  antecedent rule demands it.
- **Exit:** end of the payoff utterance, plus at most one reaction beat (~2s), scene cut
  preferred on the way out.
- **Multi-segment:** use to excise a dead digression (≥8s that serves no beat of the arc).
  Max 2 segments in v1; joins land on scene cuts or clean utterance gaps so the seam is invisible.

## 4. Length

Target **20–60s**. Working sweet spots: one-liner + reaction 15–30s · story 35–60s ·
take/rant 30–75s.

## 5. Scoring — `clips[].score` and `reasons`

Weighted sum, 0–1. Signals must be readable from the digest alone.

| Component | Weight | Digest signals |
|---|---|---|
| Hook strength | 0.35 | hook type rank · caption test · named entities in first utterance |
| Arc closure | 0.25 | payoff present · clean exit · no trail-off |
| Standalone comprehension | 0.15 | antecedents resolved · no lore dependency |
| Energy | 0.15 | speaker overlap · short-gap word bursts (laughter proxy) · pace |
| Visual variety | 0.10 | scene-cut density · speaker/on-screen changes (reframe will move) |

- Calibration: **≥0.80** = would post as-is · **0.60–0.79** = propose, name the weakness ·
  **<0.60** = don't propose.
- `reasons`: 2–4 short tags naming actual signals — `"celebrity hook"`, `"self-contained arc"`.
  Never generic praise.
- A disqualifier is never a low score. Dropped is dropped.

## 6. Picking the batch

Default 3. Diversity first: no two clips on the same beat or topic unless both score ≥0.85.
Spread across the runtime when quality allows. Ties break toward the stronger hook.
Transparency is contractual: hook, score, and reasons are stated in chat per clip, and
`status: "proposed"` waits for the user.

## 7. What the digest cannot see

Sarcasm and tone at the edges, purely visual gags, room energy beyond the laughter proxy.
When a pick leans on an uncertain read, say so in `reasons` (`"tone read, verify"`) — chat
iteration is the editor.

## 8. Calibration debt — revisit on real footage

This playbook's defaults were locked in without prior-iteration calibration. As the
editorial pass accumulates real end-to-end runs, re-examine against actual output:

(a) which of the three tests bad picks actually fail most · (b) which hook types land or flop
in practice · (c) the 20–60s bounds and per-type sweet spots · (d) the rubric weights and the
disqualifier list · (e) multi-segment tolerance (seam quality in stitched cuts) · (f) how far
transcript-only judgment can be trusted without watching.

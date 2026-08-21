# Digest — the token firewall

Stage 5 of the flow: both analyses have landed (the watcher wrote `data/transcript.json`
and `data/vision.json` under the run dir). This stage unifies them into ONE compact file
Claude actually reads, then puts names on the cast in chat.

**The firewall law (non-negotiable):** full payloads never enter chat context. Measured:
1.4MB of payloads → ≤20KB digest (golden-tested ceiling). Never Read `data/transcript.json`
or `data/vision.json`; everything Claude needs is in `data/digest.json`, and anything else
is resolved deterministically by `scripts/digest.mjs` subcommands.

## 1 · Build (deterministic, zero tokens)

```
node scripts/digest.mjs build --dir <workdir>/cutting-room
```

Reads the run layout, writes `data/digest.json` (atomic), stamps `digest_path` into
`plan.json`. JSON summary on stdout (`digest_path`, `bytes`, `turns`, `cast` tuples
`[speaker, cluster, confidence, method]`), human line on stderr. Missing payloads → clean
one-line error, exit 1. Fixture mode for tests/demos: explicit `--transcript/--vision/
--duration/--out` (no plan.json touched).

## 2 · What the digest holds (schema `cutting-room/digest@1`)

- `cast_candidates` — the speaker×cluster fusion join, one row per diarized speaker,
  ordered by speaking time:
  - `method: "asd"` — votes are summed `speak_conf` over face samples inside the
    speaker's utterance windows. `method: "onscreen_fallback"` — ASD structurally
    couldn't score (solo-speaker footage needs two simultaneously tracked faces; see
    `asd.ran/reason`), scored nothing (`carried: 0`), or left THIS speaker with zero
    scored detections — then votes are on-screen seconds during the speaker's speech.
  - `confidence` = winning cluster's share of that speaker's votes. `cluster: null` +
    `confidence: 0` = a voice that never overlaps a face sample (off-camera).
  - `votes` (top 4) and `onscreen_top` (top 3 clusters visible while this speaker
    spoke) are BOTH there on purpose: ASD can only score two-shots, so a speaker's solo
    close-up is often a different cluster than their ASD-voted face. Votes split across
    clusters + an `onscreen_top` leader missing from `votes` ⇒ same person, different
    shots — plan@2 cast entries carry multiple `cluster_ids` for exactly this.
- `timeline` — speaker TURNS (consecutive same-speaker utterances merged; dead air ≥2s
  breaks a turn). Columns per `timeline_columns`: start, end, speaker, word_idx,
  onscreen (clusters visible ≥half the turn), text. Turn text is an exact join of the
  utterance texts (verified round-trip of `words[]` on the recorded payloads).
- `scene_cuts` — hard-cut timestamps ("use as edit cut points").
- `density` — words per minute + silence gaps (dead air ≥2s, longest 20).
- `asd`, `counts`, `notes` — run facts and the encoding legend, self-describing.

**Long footage (sharded layout).** A 10-min episode digests to ~20KB, but ~2KB/min means
an hour ≈ 115KB — too big for one read. `build` handles this alone: when the serialized
digest exceeds the budget (20KB; `--max-bytes` overrides), `data/digest.json` becomes an
**index** — cast_candidates, counts, asd, density, all still global — plus a `shards`
list, and the timeline moves into `data/digest.d/seg-NN.json` slices (~15KB each, cut at
turn boundaries, preferring dead-air seams; each slice carries its own region's
scene_cuts and silence gaps, uncapped by the global top-20). Laws: the VIDEO is never
chunked before analysis (speaker/cluster ids are per-response — one upload, one analysis,
one global join); the index and every shard each fit a single context read (golden-tested
on the recorded payloads tiled ×8). The naming session reads the index + seg-00 +
first-appearance regions; the editorial pass fans scouts over shards (editorial.md §0b). Under
budget nothing changes — single digest@1 file, `digest.d/` removed if stale.

Sub-turn precision is never lost: any word range resolves to exact source times without
touching the payload in chat:

```
node scripts/digest.mjs locate --dir <rundir> --words 812..840
```

→ `{ word_start_idx, word_end_idx, start, end, text }`. This is how picked hooks and
`transcript_edits` word indices become `plan.clips[].segments` numbers at compose time.

## 3 · Cast thumbnails (feeds the screen's CAST strip — a locked part of the design)

```
node scripts/digest.mjs thumbs --dir <rundir> [--source <video>]
```

Crops one padded face per cast-referenced cluster (assignments + `onscreen_top` anchors)
from the LOCAL source at its biggest confident detection → `cast/c<cluster>.jpg`,
idempotent. Tolerant: no local source or no ffmpeg → `{"thumbs":[],"reason":"no_source"}`,
exit 0 — the flow continues without pictures.

## 3b · Gap frames (run before the editorial pass)

```
node scripts/digest.mjs gapframes --dir <rundir> [--source <video>] [--min-gap 5] [--per-region 3] [--frames 2] [--width 480]
```

Downscaled full frames from inside the big silence gaps → `thumbs/gaps/s<seg>-<t>-<i>.jpg`
+ `data/gap_frames.json` (`cutting-room/gap-frames@1`), so scouts can say what HAPPENS
where the transcript goes quiet (editorial.md §0b: each scout reads only its own region's
frames, returns one `gap_notes` line per gap). Bounded by design — gaps ≥5s, top 3 per
region by length, 2 interior frames each, 480px — a 4h podcast stays a handful of image
reads; there is no global vision pass. Idempotent; same `no_source` tolerance as thumbs.

## 4 · The naming session (judgment — this part is Claude's)

Read `data/digest.json` (ONE Read, ~20KB). Then:

1. **Name from the words.** Self-introductions, hosts addressing each other, show
   openers, sponsor reads. The timeline text is flowing turns — names usually surface in
   the first minutes and at handoffs.
2. **Group people.** A person = 1+ `speaker_ids` + 1+ `cluster_ids`. Merge clusters via
   the votes/onscreen_top split signal; sanity-check against `cast/c*.jpg` thumbs before
   asserting two clusters are one face.
3. **Arbitrate honestly.** `confidence` below ~0.6, `onscreen_fallback` rows, and
   null-cluster voices get hedged wording ("probably", "off-camera voice"), never
   invented names. Speakers with seconds of speech can stay "Voice 4".
4. **Write `plan.json` cast** (plan@2): `person_id: "p1"…`, `label`, `role`
   (host/guest/producer/voice), `speaker_ids`, `cluster_ids`, `confidence`, `method`,
   `thumb` (that cluster's `cast/c<id>.jpg` when it exists), `speaking_s`, `onscreen_s`.
5. **Narrate in chat:** one line per person (name, role, talk share, how sure), then a
   3-line video summary from the timeline. This narration is the cast reveal the user
   sees; keep it Machine Voice, no hype.

The screen's cast section consumes `plan.cast` + thumbs when the compose arc starts —
`scripts/announce.mjs` wires state@1's cast stage live at that moment (replay `--finale`
simulates it).

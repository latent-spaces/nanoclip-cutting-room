# Fixtures — synthetic demo payloads

Golden-test inputs for the digest and editorial stages, plus the replay demo's data.
**Everything here is synthetic**: an invented panel show ("The Prototype Hour" — hosts
Rio, Juno and Mars talking about ridiculous prototypes), generated deterministically by
`scripts/make-demo-fixtures.mjs` in the exact NanoClip payload schemas. No real people,
no real transcripts, no real footage.

The generator engineers the same structures a real recording produces:

- 6 speakers × 24 face clusters × 252 scene cuts over 600.066s
- a **diarization split** (Juno arrives as two speaker ids, one face cluster — the
  case the digest's fusion join must catch)
- two voice-only speakers whose ASD votes leak onto whoever is on screen (the
  real-world crosstalk shape)
- the canonical `transcript_edits` defect at word idx 3: invented celebrity
  "Marla Vane" misheard as **"Marlo Vane"**
- a quotable cold-open hook at words 121..130: *"I got a DM from a haunted vending
  machine."*
- one big silence gap (5.6s at 332.9s — the panel watches a clip) for the visual
  gap-enrichment pass

| File | What |
|---|---|
| `transcript_v2.json` | word-level timestamps (start/end/speaker/confidence), utterances (151) with word indices, speaker rollups, `agent_context` |
| `vision_v2.json` | `faces[]` @5fps (normalized boxes, cluster/track ids, `speak_conf`), `face_tracks[]`, `scenes[]` (hard cuts), `asd` status, `agent_context` |
| `digest_golden.json` | byte-exact golden of `digest.mjs build` over the two payloads (`--duration 600.066`); regenerate ONLY deliberately via that command |
| `catalog_sample.json` | a registry catalog snapshot for catalog tests |
| `cast/*.jpg` | AI-generated portraits of the invented hosts (Rio, Juno, Mars) — synthetic faces of people who do not exist; the replay demo's cast row |
| `cast/frames/*.jpg` | studio "footage" frames composed from the portraits (wide / solo / two-up) — the demo's film strip, chase-light and ASD material; face boxes in `replay.mjs` match these compositions |
| `cast/crops/*.jpg` | per-host face crops (three each) — the demo's cluster rows |

Regenerate everything:

```
node scripts/make-demo-fixtures.mjs --out fixtures
node scripts/digest.mjs build --transcript fixtures/transcript_v2.json --vision fixtures/vision_v2.json --duration 600.066 --out fixtures/digest_golden.json
```

The generator is seeded — same output every run. If you change it, regenerate the
golden with the command above and re-pin the content assertions the test suite
carries (counts, cast rows, the defect line, the hook range).

No video file ships with the repo (see `.gitignore`); tests that need real frames
(cast thumbs from a source file) skip cleanly when no local source exists — point
`CUTTING_ROOM_PLAYGROUND_SRC` at any local video to run them.

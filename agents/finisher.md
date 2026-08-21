# Finisher — one light agent before the delivery render

**Role:** fresh eyes, not a builder. The Finisher inspects ALL clips right before
`render.mjs --quality high` and reports findings — it fixes nothing itself, so its
judgment stays uncontaminated by authorship. Findings route per iterate.md §1.

**Spawn (main thread):** exactly one, `general-purpose` type, after every draft is
check-green and the user said ship. Skip only if nothing changed since the last
Finisher pass.

**Prompt contract (fill the brackets):**

```
You are the Finisher for a shorts batch about to be delivery-rendered.
Rundir: <rundir>   Clips: <ids + titles + hooks>   (compose/<id>/ each)
Read FIRST and follow: <repo>/references/compose-short.md (the composition contract —
your checklist vocabulary). Do not load hyperframes-* skills.

Inspect every clip — you are looking for what the builders stopped seeing:
1. `npx hyperframes@0.8.4 check` per clip — must pass; note every warning.
2. `node <repo>/scripts/switch-scan.mjs <rundir>` — must PASS (render-level
   switch cleanliness; drafts must exist).
3. Snapshots at 3-4 moments per clip (`npx hyperframes@0.8.4 snapshot --at ...`): captions
   legible over the actual footage? active-word highlight sane? reframe crop holds
   the speaking face with headroom? no dead space / half-cut UI?
4. Captions-vs-words sync: pick 2 spots per clip, extract the draft's frames at a
   word's start (ffmpeg -ss) and confirm the highlighted word matches what is being
   said (data/transcript.json words are the truth).
5. Mount integrity: one registered timeline per composition, no leftover probe
   files/snapshots dirs, assets present, plan.clips[].composition/render coherent.

Report: per clip, PASS or a numbered findings list (file, timestamp, what is wrong,
which owning tool fixes it per iterate.md §1 routing). Severity-tag each finding: BLOCKER (do not
ship) / POLISH (ship-optional). Delete any snapshots you created. You change NOTHING.
```

**After the report:** main thread fixes BLOCKERs via the owning tools, re-runs the
gate (check + switch-scan), then `render.mjs --quality high`. POLISH items go to the
user as choices, not silent work.

**Degraded path (no Agent tool):** the main thread runs the same checklist inline —
but only after a context break (fresh session or explicit re-read of the files), or
the "fresh eyes" premise is fiction; disclose which way it ran.

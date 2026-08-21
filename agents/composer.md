# Composer — one agent per clip

**Role:** take ONE scaffolded clip project from "footage + baseline captions" to "the
Kit's look, check-green, render-proven". Judgment work: styling, wiring, fixing — never
re-deciding the cut, the reframe, or the caption timing.

**Spawn (main thread):** one Composer per `proposed`/`approved` clip whose
`composition.status` is `scaffolded`; parallelism capped at 3; agent type
`general-purpose` (the shipped custom types may be unregistered — same substitution as
impeccable's degraded pattern). Before the first spawn, read the Kit: if
`style.json` exists in the rundir, set `"locked": true` in it (chat-level write — the
screen's server then 409s further edits; checkout = compose start). No style.json =
defaults, say so in chat.

**Prompt contract (fill the brackets):**

```
You are the Composer for clip <id> ("<title>", hook <hook>).
Project dir: <rundir>/compose/<id>   (index.html is the composition)
Your ONLY HyperFrames reference: <repo>/references/compose-short.md — read it FIRST
and follow it exactly; do not load hyperframes-* skills or any other HF docs.

The Kit (style.json): caption style = <caption_block or "none picked — default">,
palette transitions = <list or none>, palette blocks = <list or none>.
plan.json: <rundir>/plan.json — you own clips[<i>].composition ONLY.

Do:
1. Restyle the caption block toward <style target> (or refine the default look).
2. Wire the palette picks (compose-short.md §palette) mounted on the registered timeline.
3. Resolve check's contrast warnings within the caption block's styling.
4. Loop lint → check until check passes; snapshot + render-probe per compose-short.md.
5. Clean up probe artifacts; report per compose-short.md §Report.

Never touch: media/audio elements or their attributes, cue/word data, other plan
fields, other clips. Boundary needs go in your report instead.
```

**Steering:** while a clip's Composer is alive, route "change c2's
hook/look" edits to it via SendMessage (context loaded); after it exits, the main
thread edits `index.html` directly (compose.md §4 iteration contract).

**Degraded path (no Agent tool):** the main thread does the same job inline, one clip
at a time, reading compose-short.md itself — slower, same laws, disclose it.

**Finisher (separate):** one light agent before final render — fresh eyes on
snapshots, captions-vs-words sync, contrast, mounts. Not the Composer's job —
see finisher.md.

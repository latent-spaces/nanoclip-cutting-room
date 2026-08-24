# Iterate & ship — chat is the editor

Stage 9 of the flow. Everything here operates on a rundir whose clips are scaffolded
and playing (compose.md); the loop is: user says a thing in chat → the edit lands in
the right file via the OWNING tool → refresh/re-render → the user looks again.

## 1 · Routing a chat edit (who owns what)

| The user says | Owning tool | Path |
|---|---|---|
| "start c2 two seconds earlier" / boundary moves | main thread | edit `plan.clips[].segments` (word-anchored via `digest.mjs locate`/`clip`) → `scaffold.mjs extract` (re-extracts only if the window escaped the pad) → `reframe.mjs shots` → `captions.mjs cues` → `scaffold.mjs build` → refresh. `build` REWRITES `index.html` — a Composer-styled clip loses its look (every rebuild keeps the old file as `index.html.prev`; a composed clip's status flips back to `scaffolded`): re-run the Composer pass on that clip (SendMessage if its Composer is alive) before showing it again |
| "different clip instead of c3" / new clips | main thread | pool first (editorial.md §0b): promote from `data/candidates.json` or re-run scouts; then the same chain as above |
| look/motion/caption styling on one clip | that clip's Composer if still alive (SendMessage — context loaded), else main thread | edit `compose/<id>/index.html` per compose-short.md laws → `lint` → refresh |
| "the transcript says X, it's Y" | main thread | record in `plan.transcript_edits` (additive: `{t, from, to}`), re-run `captions.mjs cues` on affected clips → `scaffold.mjs build` |
| caption style / palette change | main thread | update `style.json` (it is locked — chat IS the change surface now), re-run the Composer pass on each clip |
| "ship it" / final render | main thread | Finisher gate (§3) → `render.mjs --quality high` |

Every deterministic step above is idempotent — re-running the chain is always safe.
`play` has no hot reload: after any edit, tell the user to refresh the player tab.

## 2 · Re-render loop (drafts)

```
node scripts/render.mjs --dir <rundir> [--clip <id>] [--quality draft]
```

check-gated (a failing check stops before any render), ffprobe-verified against the
plan's frame count on the 30fps grid, stamps `plan.clips[].render`. Draft = iteration
copy (`<id>-draft.mp4`). After a reframe/timing change, also run BOTH switch gates —
the two runtimes fail differently (reframe.md §The two-runtime law):
`node scripts/switch-scan.mjs <rundir>` (render: ghost/black/held frames) and
`node scripts/player-probe.mjs --port <play port> --clip <id> --plan <rundir>/plan.json --replay`
(live player: visibility holes, seek-on-reveal; needs Chrome + playwright-core).

## 3 · Ship

1. **Finisher** — agent type `finisher`, a registered subagent (`agents/finisher.md`)
   when the skill is installed as a plugin or from `~/.claude/skills/`; if that type is
   not registered in this session, spawn `general-purpose` and paste the file's body
   into the prompt. Exactly one, after every draft is check-green and the user said
   ship; skip only if nothing changed since the last Finisher pass. Fresh eyes across
   ALL clips before the delivery render — snapshots at caption/switch moments,
   captions-vs-words sync, contrast, mount integrity, switch-scan + player-probe.
   Spawn prompt gives it the rundir, the skill folder, and every clip's id/title/hook.
   It reports and fixes nothing. The main thread fixes BLOCKERs via the owning tools
   (§1 routing), re-runs the gate (check + switch-scan + player-probe), then renders.
   POLISH items go to the user as choices, not silent work.
2. `node scripts/render.mjs --dir <rundir> --quality high` → `<id>-final.mp4` per
   clip, stamped `render.quality: "high"`.
3. Deliver: hand the user the three files (chat message with paths/attachments +
   hook per clip). The screen's band already points at the players; renders live next
   to their compositions.
4. **Prefs update (script-only — prefs are only ever written through `prefs.mjs`,
   never edited by hand):** record real usage via `prefs.mjs` (caption style used,
   blocks used, clip count) so the next run's screen pre-selects from history; surface
   every auto-applied pref in chat (`prefs_applied` transparency line).

## 4 · Degraded paths

No Agent tool → the main thread runs the Composer/Finisher playbooks inline, one clip
at a time (disclose it). For the Finisher that only counts after a context break — a
fresh session, or an explicit re-read of the files — or the "fresh eyes" premise is
fiction; say which way it ran. No live player (headless) → snapshots + drafts are the review
surface. A dead player process (machine restart) → relaunch per compose.md §3; check
liveness before handing a URL.

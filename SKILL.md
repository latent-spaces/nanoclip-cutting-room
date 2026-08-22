---
name: nanoclip-cutting-room
description: Turn long footage (podcast, interview, stream, recording) into ready-to-post vertical shorts. Use when the user points at a long video and wants short clips — "cut this into shorts", "make clips from this recording", "turn this podcast into verticals". Needs the NanoClip CLI (analysis) and HyperFrames (rendering). NOT for editing an existing short, generating footage, or plain transcription.
---

# nanoclip-cutting-room — router

## What this is

NanoClip is the intelligence (transcript, diarization, face clustering, active-speaker
detection, scene cuts). HyperFrames is the rendering engine (HTML compositions → render).
This skill is the editor between them. The promise: point it at a recording, approve a
quote measured in cents, get three shorts you'd actually post, ask for more in plain
language.

## Where things live

- **Skill folder** — the directory holding this `SKILL.md` (typically
  `~/.claude/skills/nanoclip-cutting-room`). Every `node scripts/<x>.mjs` in this file and
  in `references/` is relative to it: run `node <skill folder>/scripts/<x>.mjs` from wherever
  you are. Never copy the scripts next to the footage.
- **Working folder** — the folder holding the user's footage (usually the cwd). All run
  output goes to `<working folder>/cutting-room/` (`plan.json`, data, drafts, renders).

## The flow

```
0 PREFLIGHT  node scripts/preflight.mjs — node/ffmpeg, installs the NanoClip CLI
             from npm when missing, warms the pinned HyperFrames version
1 CARDS      pick video · language · key check (conditional)
2 INTAKE     mezzanine rule → upload → server quote
3 SPEND GATE card with exact USD → start --approve (CLI refuses overruns)
4 THE SCREEN opens in browser; watcher waits — zero agent tokens
5 DATA LANDS digest.mjs unifies payloads; cast narrated in chat
6 CUT        editorial pass (references/editorial.md) → plan.json → scaffold
7 PREVIEW    the clips embed in the Screen (hyperframes play behind them)
8 ITERATE    all steering happens in chat
9 SHIP       Finisher gate → local render → vertical .mp4s · prefs updated
```

Run the preflight before anything else in a fresh session: it verifies node and
ffmpeg/ffprobe, installs `nanoclip` from npm when the CLI is missing, reports its auth
state (auth itself is the user's step — see Non-negotiables), and warms the pinned
`hyperframes` version so the first render never stalls on a download.

## Stage playbooks (load lazily, one at a time)

| Stage | Reference |
|---|---|
| Cards + upload + spend gate | [references/intake.md](references/intake.md) |
| The Screen (server, SSE, catalog) | [references/screen.md](references/screen.md) |
| Digest (fusion join, cast naming, thumbs, gap frames) | [references/digest.md](references/digest.md) |
| Editorial pass (what makes a clip) | [references/editorial.md](references/editorial.md) |
| Compose (extract, reframe, scaffold, captions, players) | [references/compose.md](references/compose.md) |
| Iterate & ship (chat loop, Finisher, render) | [references/iterate.md](references/iterate.md) |

Every stage above is built and has run end-to-end on real footage — intake through
delivery renders. Do not improvise around a playbook; when something is out of scope,
say so.

## Non-negotiables (locked product decisions)

- Money moves only through the spend gate: exact USD per line item, dispatch with
  `--approve <exact>`, the CLI refuses live overruns. Every auto-decision gets one chat line.
- Zero agent tokens while analyses cook: the watcher uses `get --wait` per analysis
  (`status` returns a very large payload — rare fallback only).
- `plan.json` (schema `cutting-room/plan@2`) is the contract: pointers, never payloads;
  caption block singular, palette plural; Claude edits plan and compositions, the screen never does.
- The agent never handles the NanoClip key; the user runs `nanoclip auth login` themselves.
- Chat is the editor — no in-browser editing tools.

`fixtures/README.md` documents the synthetic demo payloads the tests and the replay
demo run on.

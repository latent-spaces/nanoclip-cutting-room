# Intake — cards, upload, spend gate

**Stage boundary:** from skill invocation to both analyses dispatched. Four cards, one
upload, one moment where money moves. Card copy below is the locked content contract —
render it with the native card tool (AskUserQuestion), don't rewrite it. Every
auto-decision gets exactly one chat line and is reversible by reply.

**Outputs:** an uploaded project with transcript(+diarization) and vision dispatched ·
`cutting-room/plan.json` seeded · prefs updated (language, measured speeds).

## Resume rule (check first)

If `cutting-room/plan.json` already exists in the working folder:
- analyses show `running`/`completed` → intake is done; do not redo it. Hand off to the
  next stage (see Handoff below).
- it has a `project_id` but no dispatched analyses (the user said "Not now") → skip to
  step 6: fresh `quote -p`, then the spend gate. The upload keeps; never re-upload.

## 0 · Preflight

```
node <skill folder>/scripts/preflight.mjs
```

Run this first in a fresh session, from the working folder (every `node scripts/…` in
this playbook is relative to the skill folder — see SKILL.md · Where things live). It verifies node (20+) and ffmpeg/ffprobe, installs
the `nanoclip` CLI from npm when it is missing, reports the cached auth state, and warms
the pinned `hyperframes` version so the first render never stalls on a download. JSON
verdict on stdout, human report on stderr; exit 0 = ready.

Remember whether an auth profile exists (`nanoclip.authed` in the JSON); card 3 appears
only when none does — the login itself is the user's step, never the agent's. If
anything else is off, `nanoclip doctor` diagnoses config, key, API reachability and
ffmpeg in one shot.

## 1 · Card — pick the footage

```
node scripts/mezzanine.mjs probe <working-folder>
```

Returns candidates newest-first (max 8 probed; unreadable files dropped), each with
`duration_s / width / height / bytes / vcodec`. Then:

- Chat line: `Found N videos in this folder.`
- Card — question **"Which video should we cut?"**, header **"Footage"**:
  - up to 3 candidates: label = filename, description = `MM:SS · <height>p · <size> · newest`
    (`newest` tag on the first only; size human, e.g. `192 MB`, `6.4 GB`)
  - last option: label **"Somewhere else"**, description **"type a path"** → probe the
    typed path with `probe <file>`; if it fails, say why and re-ask.
- Zero candidates → no card; ask in chat for a path.

## 2 · Card — name the language

Transcription won't guess. Card — question **"What language is spoken in it?"**, header
**"Language"**:

| label | description |
|---|---|
| English | en |
| Hebrew | he |
| Spanish | es |
| Another language | name it |

- The description IS the tag passed to `--language` at dispatch (for "Another language",
  the user's free-text answer is the tag).
- Prefs are per machine (`~/.config/cutting-room/prefs.json`). A user asking for a
  "fresh" / "clean" run, or a second person on the same machine: export
  `CUTTING_ROOM_PREFS=<rundir>/prefs.json` for the whole session (every script reads it)
  and say so in chat — never delete the global file.
- `node scripts/prefs.mjs get` → if `language` is set, reorder so that language is first
  and disclose in one line: `Language pre-selected from your last run (Hebrew) — pick
  another to change it.`

## 3 · Card (conditional) — bring your key

Only when preflight found no profile. Nothing has uploaded yet — keep it that way until
this card resolves. The agent NEVER handles the key: never ask for it in chat, never run
`auth login` yourself, never read it from anywhere.

Chat message first:

> You need a NanoClip key before anything uploads. Free to start, no card required.
> Grab one at nanoclip.ai, then in another terminal:
> `nanoclip auth login --key <your-key>`

Card — question **"Ready to continue?"**, header **"API key"**:

| label | description | on pick |
|---|---|---|
| Done — check again | I ran auth login in another terminal | re-run `nanoclip auth status`; still no profile → say so, show this card again |
| Open nanoclip.ai | where the key lives · no card required | give the link https://nanoclip.ai (don't open it yourself), then re-show this card |
| Stop here | end the run — nothing has uploaded | end politely; note the run can restart anytime |

## 4 · Mezzanine rule (auto-decision, one line)

```
node scripts/mezzanine.mjs decide <file>
```

Arithmetic, not vibes: compares `t_upload(original)` against `t_transcode +
t_upload(mezzanine)` using measured speeds from prefs (declared priors on a first run —
the output says which via `basis`). Sources already at mezzanine grade (≤1080p, modest
bitrate) short-circuit to direct upload. State the decision in ONE chat line built from
the returned `reason`, and make it reversible, e.g.:

- `Uploading the original — already mezzanine-grade (1080p at 2.7 Mbps); a transcode can't shrink it enough to matter.`
- `Transcoding to a 1080p mezzanine first (≈420s + ≈250s upload beats ≈1370s direct — first-run estimates). Reply "skip transcode" to upload the original instead.`

If the decision is `transcode_1080p`:

```
node scripts/mezzanine.mjs transcode <file> cutting-room/mezzanine.mp4
```

(records the measured transcode speed into prefs). Upload the mezzanine; the final render
always reads the local original — the uploaded copy is analysis-only, so aggressive
compression is safe. 720p (`--eco`) only when the user explicitly asks for economy. A user
override in chat always wins over the arithmetic.

## 5 · Upload (timed)

```
node scripts/mezzanine.mjs upload <file>
```

Wraps `nanoclip upload`, times it, records the measured upload speed into prefs, and
returns `{project_id, bytes, seconds, upload_Bps}`. Chat line:

`uploaded 192 MB in 27s · project 2026-01-12_093000Z_api_h264-aac-1080p-10min-mp4_99c9`

Upload is free — nothing is billed at this point. If it fails on auth, fall back to
card 3; on anything else, report the CLI's message verbatim and offer to retry.

## 6 · Server quote

```
nanoclip quote -p <project_id> --transcript --diarize --vision
```

The v1 line-item set is fixed: transcript + diarization + vision. Retake-removal stays out
of v1 (locked decision) — never add it to the quote or the card. stdout is a JSON line
(recorded shape below), stderr the human line.

**Balance guard:** `nanoclip me` → `billing.credit_balance_cents`. If `total_cents`
exceeds it, do NOT show the spend gate; state the quote, the balance, and that topping up
happens at nanoclip.ai, then stop this stage.

## 7 · Card — approve the spend (THE gate)

```
nanoclip quote -p <id> --transcript --diarize --vision | node scripts/mezzanine.mjs split
```

`split` verifies the line items sum to the total and returns the exact per-command
approvals: `{diarize, transcript_approve_usd, vision_approve_usd, total_usd}`.

Chat first — the moment money moves is narrated, not sprung:

> The server priced your 10 minutes. Nothing runs until you approve it.
>
> | | |
> |---|---|
> | transcript | $0.02 |
> | diarization | $0.01 |
> | vision | $0.55 |
> | **total** | **$0.58** |
>
> for 10:00 of footage

Card — question **"Approve $<total> for transcript, diarization and vision?"**, header
**"Spend gate"**:

| label | description |
|---|---|
| Approve — $<total> | dispatched with --approve at exactly these numbers · overruns refused |
| Not now | nothing is billed · the upload keeps |

Money moves ONLY through this card. Never infer approval from earlier chat, never
pre-approve, never dispatch with numbers the card didn't show. "Not now" → seed plan.json
with the project id (resume path re-quotes later), end the stage gracefully.

## 8 · Dispatch

Two commands, `--approve` set to `split`'s exact strings — never rounded, never bumped:

```
nanoclip transcript start -p <project_id> --approve <transcript_approve_usd> --language <tag> --diarize
nanoclip vision start -p <project_id> --approve <vision_approve_usd>
```

The CLI hard-refuses if the live cost exceeds the approval (verified). If it refuses:
report its message verbatim, re-run `quote -p`, and present a NEW spend-gate card with the
new numbers. Raising `--approve` without a fresh card is forbidden.

After both dispatch:
- `node scripts/prefs.mjs set language <tag>` — remembered for the next run's card order.
- Seed `cutting-room/plan.json` (shape below).
- One chat line, e.g.: `Both analyses are cooking — transcript+diarization and vision ran
  ~3.3 minutes total on this 10-minute video last time.`

## plan.json seed (schema cutting-room/plan@2)

Written to `cutting-room/plan.json` in the working folder — the resume anchor. Pointers,
never payloads.

```jsonc
{
  "schema": "cutting-room/plan@2",
  "source": {
    "path": "h264_aac_1080p_10min.mp4",        // as the user picked it, relative to the working folder
    "duration_s": 600.066, "width": 1920, "height": 1080,
    "mezzanine_path": null,                     // "cutting-room/mezzanine.mp4" only if created
    "project_id": "2026-01-12_093000Z_api_h264-aac-1080p-10min-mp4_99c9"
  },
  "analyses": {
    "transcript": { "status": "running", "path": null, "cost_usd": "0.03" },  // transcript+diarization, = transcript_approve_usd
    "vision":     { "status": "running", "path": null, "cost_usd": "0.55" }
  }
}
```

## Handoff

The Screen and the watcher own the wait — continue in [references/screen.md](screen.md):
seed `cutting-room/state.json` (the seed template there wants the measured upload seconds
and the dispatch timestamps you have in hand), build the catalog, start the server and the
watcher, open the page.

(If you ever collect payloads by hand: `get --wait -o <file> > /dev/null` — **always
silence stdout**; even with `-o`, `get` echoes the full payload to stdout (measured:
~330KB transcript, ~1.1MB vision), and reading it defeats the token firewall. The human
status line arrives on stderr. `nanoclip status` returns ~648KB; avoid it.)

## Recorded formats (real API; sample ids illustrative)

- `quote -p` stdout: `{"line_items":{"vision":55,"transcript":2,"diarization":1},"total_cents":58,"total_usd":"0.58","duration_s":600.066133,"basis":"server","estimate":false}`
- `mezzanine.mjs upload` output: `{"project_id":"2026-01-12_093000Z_api_h264-aac-1080p-10min-mp4_99c9","bytes":192384833,"seconds":26.62,"upload_Bps":7227003}`
- `split` output: `{"diarize":true,"transcript_approve_usd":"0.03","vision_approve_usd":"0.55","total_usd":"0.58"}`
- Measured speeds vary run to run (20s and 27s for the same 192MB upload) — which is why
  the mezzanine rule reads cached measurements, not folklore.

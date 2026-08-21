---
name: Cutting Room — The Screen
description: A live wait-screen that narrates a NanoClip run on the visitor's own footage, in NanoClip's light-locked frosting world.
colors:
  surface-0: "oklch(98.5% 0.008 340)"
  surface-1: "oklch(96.5% 0.018 335)"
  surface-2: "oklch(94% 0.028 330)"
  surface-3: "oklch(88% 0.045 320)"
  ink: "oklch(22% 0.02 330)"
  ink-muted: "oklch(45% 0.025 330)"
  ink-subtle: "oklch(52% 0.025 330)"
  frosting: "oklch(70% 0.18 10)"
  frosting-ink: "oklch(52% 0.19 355)"
  frosting-soft: "oklch(95% 0.04 10)"
  peach: "oklch(70% 0.15 55)"
  peach-ink: "oklch(48% 0.15 55)"
  peach-bg: "oklch(93.5% 0.045 55)"
  mint: "oklch(64% 0.13 165)"
  mint-bg: "oklch(94.5% 0.05 165)"
  blueberry: "oklch(60% 0.16 280)"
  blueberry-bg: "oklch(94% 0.035 280)"
  lemon: "oklch(82% 0.14 90)"
  border: "oklch(90% 0.02 325)"
  border-strong: "oklch(83% 0.03 322)"
typography:
  display:
    fontFamily: "Inter Tight, Inter, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "clamp(2.3rem, 4.4vw, 3.4rem)"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Inter Tight, Inter, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 750
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter Tight, Inter, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "1.22rem"
    fontWeight: 700
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter Tight, Inter, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.7rem"
    fontWeight: 500
    letterSpacing: "0.2em"
rounded:
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  pill: "999px"
spacing:
  card-gap: "14px"
  block-gap: "18px"
  card-pad: "22px"
  page-pad: "28px"
  rail-gutter: "34px"
  beat-gap: "92px"
components:
  pill-action:
    backgroundColor: "{colors.surface-0}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "9px 18px"
  ghost-action:
    textColor: "{colors.frosting-ink}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  ghost-action-hover:
    backgroundColor: "{colors.frosting-soft}"
    textColor: "{colors.frosting-ink}"
  palette-chip:
    backgroundColor: "{colors.surface-0}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "9px 16px"
  palette-chip-selected:
    backgroundColor: "{colors.frosting-soft}"
    textColor: "{colors.ink}"
  caption-card:
    backgroundColor: "{colors.surface-0}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "14px"
  strip:
    backgroundColor: "{colors.surface-0}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "18px 22px"
  search-input:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    rounded: "10px"
    padding: "10px 14px"
  footband-ready:
    backgroundColor: "{colors.frosting}"
    textColor: "{colors.ink}"
    padding: "13px 28px"
---

# Design System: Cutting Room — The Screen

## Overview

**Creative North Star: "The Frosted Cutting Room"**

A film cutting room finished in frosting. The Screen is NanoClip's wait-that-demos: while analyses run on the visitor's own footage, the page narrates the work in a warm, light-locked confectionery world — cream ground, cards that float *lighter* than the page, one pink hue band for everything the brand says, and four candy colors that speak only when they carry status or data. The machine's own voice (stage names, timers, statuses, IDs) is small tracked-out mono; everything said to a human is tight, negative-tracked Inter Tight. The brand is borrowed from nanoclip.ai, not invented here — the upstream `nanoclip-brand` repo (`BRAND.md`, outside this repo) is law; the oklch values baked into `style.css` and this file are its canonical copy.

Nothing on the page pretends. Real artifacts (transcript words, face crops, film-strip frames) replace dashed placeholders as they land, revealed left-to-right by a pink chase-light; surfaces are earned by data. Sections never butt against each other — the ground itself drifts through the hue band in long oklch ramps, so beats read as one continuous surface. Confirmed rejections, all deliberate: no dark mode, no untinted white or gray, no second display face, no candy as decoration, no hard seams, no dead spinners.

**Key Characteristics:**
- Light-locked warm cream ground; cards lighter than the page (depth = lightness)
- One hue band (320–10) for brand and neutrals; candy colors carry status/data meaning only
- Frosting pink means commitment — selection rings, the reveal boundary, the ready band — never status
- Two voices: Inter Tight (human, negative-tracked) and IBM Plex Mono (machine, uppercase, tracked out)
- Tinted everything: shadows, borders, and grays all sit inside the brand hue
- Long oklch seam ramps between beats; zero-alpha endpoints, never the `transparent` keyword
- Dashed borders mark promised content; real artifacts arrive with a short "develop" rise
- Short, hard-eased motion (150/200ms, `cubic-bezier(0.16, 1, 0.3, 1)`)

## Colors

An all-oklch, light-locked palette: one warm pink band carries every surface, ink, border, and shadow, while four candy colors are reserved for what the system knows.

### Primary
- **Frosting Pink** (`frosting`): the brand pink, bit-identical to the logo. Commitment only — the selected-state ring, the chase-light reveal boundary, the kit-count badge, the ready foot band, the `clip` half of the wordmark. Text set on it is always dark ink (5.98:1), never white.
- **Frosting Ink** (`frosting-ink`): the pink gone deep (hue 355 — never scarlet, or it reads as error text). Emphasis words in running text, the hero's `em`, kickers, ghost-button text, the caret color.
- **Frosting Soft** (`frosting-soft`): pink-tinted hover and selected fills, text selection.

### Status & Data (candy)
Candy appears **only** when it means something; it is never decoration and never brand.
- **Blueberry** (`blueberry` / `blueberry-bg`): info and in-progress — the running strip's ring, the popped rail tab, live timers, the pulsing dot.
- **Mint** (`mint` / `mint-bg`): success — completed stages, the locked-kit confirmation, the spine's done gradient.
- **Peach** (`peach` / `peach-ink` / `peach-bg`): warning and failure — failed stages, the connection-lost banner. `peach` itself is icon-and-ring only; peach text uses `peach-ink`.
- **Lemon** (`lemon`): highlight — caption-style highlight specimens, one voice in the speaker-identity cycle.
- As **data**: speaker identity in the diarization strip and cluster-ring identity cycle through frosting → blueberry → mint → lemon → peach → ink-muted, in that order.

### Neutral
Every neutral is tinted into the 320–340 band; there is no untinted white or gray anywhere.
- **Frosted Card** (`surface-0`): cards, popovers, the drawer — the lightest thing on screen.
- **Warm Cream** (`surface-1`): the page ground, and the recessed fill of inputs sitting on a card.
- **Hover Blush** (`surface-2`): muted blocks, icon wells, data chips, hover fills.
- **Deep Blush** (`surface-3`): the deepest surface — gradient ends, media placeholders.
- **Warm Ink / Muted / Subtle** (`ink`, `ink-muted`, `ink-subtle`): primary text / secondary text / meta and captions. Contrast is tuned deliberately (`ink-subtle` clears 4.5:1) — do not lighten.
- **Tinted Borders** (`border`, `border-strong`): hairlines and dashed placeholder strokes.

### Named Rules
**The Candy-Is-Data Rule.** Peach, mint, blueberry, and lemon appear only to carry a status or a data identity. If a candy color would survive with its meaning removed, it is decoration — take it out.
**The Dark-Ink-On-Pink Rule.** Text and icons on frosting are always `ink`, never white. Hover lightens the pink, which only raises contrast.
**The Seam Rule.** Beats never butt. The ground drifts through the hue band in long oklch ramps (~230px; plateaus hold each beat), and every gradient's transparent end is written as *the color at zero alpha* (`oklch(98.5% 0.008 340 / 0)`), never the keyword `transparent`.

## Typography

**Display Font:** Inter Tight (with Inter, Helvetica Neue, Helvetica, Arial)
**Body Font:** Inter Tight — the same family; there is no second display face
**Label/Mono Font:** IBM Plex Mono (with ui-monospace, SF Mono, Menlo)

**Character:** One warm variable family doing all the human talking — tight, negative-tracked, confident at heavy weights — annotated throughout by a small machine voice in mono. The contrast between the two voices *is* the typographic system.

### Hierarchy
- **Display** (800, `clamp(2.3rem, 4.4vw, 3.4rem)`, 1.08, −0.025em): the hero statement only; max-width 13em, balanced wrapping; one `em` word in frosting-ink.
- **Headline** (750, 1.35rem, −0.02em): shelf and drawer titles.
- **Title** (700, 1.22rem, −0.02em): card titles; strip names step down to 1.02rem / −0.01em at the same weight.
- **Body** (400, 16px, 1.55): explanatory copy; secondary copy drops to 0.88–0.92rem in `ink-muted`.
- **Label** (mono, 500–600, 0.58–0.74rem, +0.1 to +0.22em, UPPERCASE): the machine voice — eyebrows, kickers, statuses, timers, schematic notes, IDs, zone notes.

Weights are variable and fractional where it matters (640, 650, 750); emphasis climbs the weight axis or takes frosting-ink — it never changes family.

### Named Rules
**The Machine Voice Rule.** Anything the system says about itself — stage names, timers, statuses, IDs, schematic notes — is small uppercase IBM Plex Mono, tracked out. Anything said to a human is Inter Tight, sentence case, said once, no exclamation marks.
**The One Face Rule.** Inter Tight is the only display face. Gradient-clipped, glowing, or glitched text never appears as page chrome — those treatments exist on this page only inside caption-specimen previews, where they render third-party product content.

## Layout

A single desktop-first page: a `minmax(0, 1fr) 236px` grid capped at 1320px, 34px gutter, 26–28px page padding. The left column stacks five numbered beats separated by a 92px rhythm; the right column is the always-visible progress rail, sticky at `top: 76px` beneath the sticky top bar. A fixed foot band holds the bottom edge (body reserves 72px for it).

Density is airy: cards pad 14–22px, grids gap 14–18px, related blocks gap 18px. Card interiors are the only dense zones (data chips, film strips), and overflow inside them fades out via zero-alpha masks rather than clipping hard or widening the page.

The ground does layout work too: `body` carries the beat-to-beat seam ramp (five plateaus drifting hue 335 → 352 → 322 → 344 → 355), and two ambient radial lobes of the band paint once on a fixed `body::before` layer — never `background-attachment: fixed`, which would repaint the world every frame.

Below **1020px** the page becomes one column: the rail moves above the content as a horizontally scrolling tab strip (no popped tab), explainers and strips stack to one column, the caption shelf drops to two, and the tagline hides.

## Elevation & Depth

Depth is a hybrid: **lightness first, tinted shadow second**. Surfaces come toward the viewer by getting lighter (`surface-0` cards on the `surface-1` ground), and shadows confirm the float. Every shadow is tinted into the brand hue at low alpha — never gray, never black. Status and selection are expressed as box-shadow *rings* stacked on the elevation shadow, so meaning and depth compose without borders.

### Shadow Vocabulary
- **Rest** (`box-shadow: 0 1px 2px 0 oklch(60% 0.05 330 / 0.08)`): chips, pills, strips at rest.
- **Float / hover** (`box-shadow: 0 8px 24px -8px oklch(60% 0.08 330 / 0.16)`): explainer cards, hovered actions (paired with a −1 to −2px lift), the running strip.
- **Overlay** (`box-shadow: 0 24px 60px -16px oklch(55% 0.1 330 / 0.2)`): the kit panel and the browse-all drawer.
- **Focus** (`box-shadow: 0 0 0 4px oklch(70% 0.18 10 / 0.22)`): the global `:focus-visible` glow — pink, on everything focusable.
- **Rings**: running = `0 0 0 2px` blueberry at 0.5 alpha; failed = `0 0 0 2px` peach at 0.55; selected = `0 0 0 2.5–3px` frosting, solid.

### Named Rules
**The Lighter-Forward Rule.** The closer a surface is to the viewer, the lighter it is. Cards are lighter than the page; recessed things (inputs on a card) step back down the ladder. Never darken to elevate.
**The Tinted Shadow Rule.** Shadows are oklch hue-330 at low alpha, always. A gray shadow is a seam in the world.

## Shapes

Everything is a rounded rectangle; nothing is sharp. The token ladder is 0.5rem / 0.75rem / 1rem, with full pills (999px) for every action, chip, and badge. Radii nest downward with element size — 20px on the drawer's open corner, 12px icon wells and rail tabs, 9–10px media thumbs and previews, 6–8px data chips, 4px micro-tags — so a child never out-rounds its container.

Borders are quiet 1px tinted hairlines when present at all; most edges are carried by lightness and shadow instead. The one loud border is the **1.5px dashed `border-strong`** stroke, which has a reserved meaning (below). The beta stamp on the wordmark is the single rotated element in the world (−7°, dashed, ticket-like) — a signature of the header, not a license to tilt things.

### Named Rules
**The Dashed-Promise Rule.** A dashed border means "reserved for something real that hasn't landed yet" — skeleton chips, waiting slots, the cut and clips zones. When the artifact arrives, the dash is replaced by a solid, lit surface; dashed strokes are never decoration on real content.

## Components

### Buttons
- **Shape:** full pill (999px)
- **Pill action** (`.pill`, `.kit-chip`, `.footband-cta`): `surface-0` fill, 1px `border`, `shadow-sm`, ink text at 600–700 / 0.9–0.95rem; padding ~9px 16–20px. The workhorse action.
- **Hover / Focus:** lift `translateY(-1px)` + `shadow-md` over 150ms hard ease-out; focus takes the global pink glow.
- **Ghost** (`.browse-all`, `.kit-remove`): borderless, `frosting-ink` text, `frosting-soft` fill on hover.
- **No filled-pink button exists on this surface.** Commitment arrives as the foot band morphing to frosting, not as a pink button.

### Chips
- **Palette chip:** pill on `surface-0` with a leading motif mini; selected = `frosting-soft` fill + 2.5px frosting ring. On the shelf the chips sit in **family groups** — a mono group header (`TRANSITIONS`) carries a human placement clause ("play at the cuts inside a clip") so the chip itself needs no family label; the drawer's flat items keep their per-item mono label.
- **Tag chip (drawer filters):** mono 0.74rem pill on `surface-1`; selected = `frosting-soft` + frosting border.
- **Data chip (S1/P1 tags, transcript words):** mono or body 0.6–0.8rem on `surface-2`, 6–8px radius — identity and content, not interactive.

### Cards / Containers
- **Corner Style:** `radius-lg` (1rem)
- **Background:** `surface-0`, always lighter than what it sits on
- **Shadow Strategy:** `shadow-sm` at rest for selectable cards, `shadow-md` for content cards; hover lifts −2px to `shadow-md`; selected caption cards add the 3px frosting ring + a frosting check badge
- **Border:** none — lightness and shadow carry the edge
- **Internal Padding:** 14px (caption cards) to 22px (explainers, strips)

### Inputs / Fields
- **Style:** recessed a step *down* the ladder — `surface-1` fill on a `surface-0` container, 1px `border`, 10px radius, 10px 14px padding; placeholder in `ink-subtle`.
- **Focus:** the global pink `:focus-visible` glow; no border-color swap.

### Navigation
- **Top bar:** sticky, dissolving into the page via a zero-alpha ramp (no hard edge, no blur). Wordmark: `nano` in ink, `clip` always frosting, never capitalized; mono tagline tracked +0.22em; kit chip on the right. **Adding to the kit flies**: a small frosting ghost arcs from the clicked card to the kit chip, which bumps on arrival — commitment in commitment pink. Removes never fly; reduced motion and drawer picks (the chip sits behind the overlay) fall back to the immediate bump.
- **Progress rail** (signature): a sticky stack of mono tabs, one per stage, threaded by a spine — solid mint-to-ink gradient above the current stage (the past), faint dashed hairline below (the future). Exactly one tab is popped at a time: shifted −16px, `surface-0`, blueberry ring, stage icon in a `blueberry-bg` well, oversized 1.6rem mono live timer. The tab column keeps 30px of air on its left so the popped tab clears the spine instead of bleeding across it. Exactly one waiting tab — the first in rail order — is **Up next**: 0.72 opacity, a 1.5px dashed ring (the dashed promise), hollow dot; the other waiting tabs sit at 0.35 opacity. Failed tabs ring peach. The rail is the run's source of truth, and its statuses stay candy — pink never means status.

### The Progress Strip & Chase-Light (signature)
Stage strips are `surface-0` rows (190px name column / fluid body / 74px timer) whose bodies fill with **real artifacts** left-to-right. The reveal boundary is the chase-light: a 2px vertical frosting line with a glowing 14px head, sweeping on a 900ms linear step, trailed by a veil of `surface-0` at graduated zero-alpha that hides unrevealed content. Status is worn as a ring + icon-well recolor (running blueberry, done mint, failed peach with a `peach-bg` error block), and new artifacts enter with the 150ms "develop" rise. The vision strip's face detections are **corner brackets, never a full box** (a locked product decision): four 2.5px L-marks (32% arms, gradient-drawn on `currentColor`), padded ~24% per side, lifted by a bracket-following drop-shadow halo, and colored by **person identity** (`cid-N`): the same candy cycle as the clustering card's rings, keyed by the cluster's row position there, so brackets and rings always agree on who is which color.

### Explainer Demos (beat 01)
Each beat-01 card carries a working diagram, schematic until the visitor's own artifacts land. The ASD demo is a **two-shot**: two person glyphs in one frame, the frosting corner brackets + a three-bar speaking meter (`.eq`, drawn geometry, staircase-static under reduced motion) jumping between them on a 4.2s steps loop — the bracketed person is the one talking, no caption needed. Live, the real frame's detection brackets spotlight the speaker (the element's 400px shadow dims the rest of the frame; detection padded ~12% so brackets sit off the face) and the ON AIR chip carries the meter. Cluster crops ring in their `cid-N` identity colors.

### The Foot Band (signature)
A fixed bottom strip on near-opaque `surface-0` with an upward tinted shadow. On run completion it **morphs into the commitment band**: fill goes `frosting`, copy goes bold `ink`, the pink glow deepens, and the pill CTA appears — the page's one full-pink moment.

### Caption Specimens & Motif Previews (product content, not chrome)
Caption cards composite each registry style's specimen text over the visitor's own frame behind a breath of dark scrim. The specimen treatments (`.sp-highlight`, `.sp-neon`, `.sp-glitch`, `.sp-gradient`, …) render **third-party caption styles being sold** — they are demonstrated data, exempt from the page's typography and hue rules, and must never leak into the page's own styling. Specimens are word-level spans and **loop their style's character** (karaoke walk, per-word rise, wipe sweep, camera pan, slam-in…); transition and accent items carry **motif previews** (`.motif` / `.m-*`) — A→B over two of the visitor's frames for transitions, a light overlay motif over one frame for accents — as chip minis (44×28) and full stages (58px) in the drawer. A name-keyword motif hit is **clamped to the family's legal set** (transitions ∈ wipe/fade/flip/zoom/glitch, accents ∈ pulse/lockup/trail/cloud) because the element structure is per-family; out-of-family hits fall back to crossfade/pulse. All loops are our rendition of the style, the same claim level as the static specimens. Playback is viewport-gated by IntersectionObserver (`.playing`) so a shelf of loops never taxes the SSE-driven page, and `prefers-reduced-motion` drops every loop to an authored static pose (each motif's 0% frame is legible at rest).

### Browse-all Drawer
A right-edge overlay drawer (search + tag chips + 2-col grid). Browsing unfiltered, the grid is **sectioned by family** — sticky mono headers (`CAPTIONS · 16`) on a `surface-0` zero-alpha fade; any query or tag **flattens** the grid to one result set, because sections fight filters. Caption items carry live specimens, transition/accent items carry motif previews.

## Do's and Don'ts

### Do:
- **Do** keep cards lighter than their ground: `surface-0` on `surface-1`, stepping down the ladder for recessed fields.
- **Do** write every gradient's transparent end as the color at zero alpha (`oklch(96.5% 0.018 335 / 0)`) and join beats with long (~230px) oklch ramps.
- **Do** reserve candy for meaning: blueberry = running/info, mint = done, peach = warning/failure, lemon = highlight; identity cycles reuse the same set as data.
- **Do** set dark `ink` on frosting, and reach for `frosting-ink` (hue 355) when the pink must be text.
- **Do** mark not-yet-real content with 1.5px dashed `border-strong` and replace it with solid surfaces when real artifacts land (150ms "develop" rise).
- **Do** speak machine in small uppercase tracked mono and human in Inter Tight; say the thing once, same words each time, no exclamation marks.
- **Do** move fast and settle hard: 150/200ms, `cubic-bezier(0.16, 1, 0.3, 1)`, −1 to −2px hover lifts; drop animation entirely under `prefers-reduced-motion`.

### Don't:
- **Don't** use `#FFFFFF`, untinted gray, or gray/black shadows — every neutral, border, and shadow is tinted into the band.
- **Don't** use candy as decoration, or pink as a status color — frosting means commitment and brand, nothing else.
- **Don't** ship a dark mode; the world is light-locked on purpose.
- **Don't** write the keyword `transparent` in any gradient, or let two sections meet at a hard edge.
- **Don't** set white text on frosting, add a second display face, or apply specimen treatments (gradient-clipped, neon, glitch text) to the page's own type.
- **Don't** inherit this page's numbered eyebrow sequence ("01 · WHAT NANOCLIP SEES" …): it is locked to this surface — the numbers carry the run's real order — so eyebrows and kickers stay off-limits on future surfaces unless a deliberate product decision locks them again.
- **Don't** lighten the ink ladder or shrink the mono voice below ~0.58rem — contrast floors here are deliberate.

// scaffold.mjs — plan.json clips → HyperFrames compositions.
// `extract` locks each clip window to a 30fps CFR proxy (reference pipeline,
// references/reframe.md) and finds scene cuts ON the proxy; `build` writes one
// standalone 9:16 project per clip riding that proxy (framework-owned media, muted
// <video> + separate <audio>, media-start rebased into extract time). Static center
// crop until per-shot reframe lands. Preview and render read local files
// only — the uploaded analysis copy never matters here (deliberate decoupling).
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cropPx } from './reframe.mjs';

export const COMPOSE_WIDTH = 1080;
export const COMPOSE_HEIGHT = 1920;
// Reference pipeline (references/reframe.md): every clip proxy locks to 30fps
// CFR, and cuts are detected on the produced file at the calibrated threshold.
export const CANONICAL_EDIT_FPS = 30;
export const REFRAME_SCENE_THRESHOLD = 0.12;
export const EXTRACT_PAD_S = 5;
const EOF_CLONE_PAD_MAX_S = 2;

const round = (v) => Math.round(v * 100) / 100;

const escapeHtml = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Boundary-safe grid timing (references/reframe.md §float law). The runtime shows a
// clip while start <= t <= start+duration — inclusive both ends, RAW float compare —
// and samples t = k/30. 1/30 has no finite decimal, so boundary-exact attribute
// values round past the sample point and open 1-2 frame black holes at shot switches
// (measured on the drafts; switches at frames divisible by 3 were clean, all others
// glitched). Quarter-frame margins put every window edge half-way between samples,
// and land media seeks mid-frame-interval instead of on a PTS boundary.
// Product decision: never round grid-valued (1/30) numbers — emit the exact
// double (String = shortest round-trip). round() below is reserved for 2dp-TRUE
// values (NanoClip word grid), where it recovers the exact decimal from float noise.
// Shot windows live on the quarter-frame grid: start (f0 - 0.25)/30 (shot 0 from the
// origin), end (f1 - 0.25)/30 — no boundary ever sits on a render sample t = k/30, so the
// render covers frames f0..f1-1 exactly once and the runtime's end-of-window media clamp
// lands on the shot's true last frame (reframe.md §The two-runtime law). Every non-final
// window then keeps a two-frame TAIL past its successor's start, UNDER it (pane z-index =
// shot order, tracks alternate because lint forbids same-track overlap): the live player
// samples at display rate, not on the render grid — a hole between windows is a black
// frame there (measured 11/13 switches), and a freshly revealed <video> can paint
// transparent for one compositor frame (measured on replays); under the tail the previous
// frame shows instead of the background. Render samples f1, f1+1 fall inside the tail and
// show the successor (on top), pixels identical to no tail.
// 2 frames = 66.7 ms: covers a reveal that lands late in a display interval plus the
// next one or two compositor frames, at 60 Hz and at the ~35 Hz a split page runs at
// (0.5 frames measured insufficient: one blank slipped 0.7 ms past the tail's end).
const TAIL_FRAMES = 2;
const gridStart = (f0) => (f0 === 0 ? 0 : (f0 - 0.25) / 30);
const gridEnd = (f1) => (f1 - 0.25) / 30;
const shotWindow = (f0, f1, final) => {
  const start = gridStart(f0);
  // non-final: end + tail, as end - start (exact doubles, never rounded); final: the clean
  // grid ratio — nothing follows it, and it must never outlive the root.
  const duration = final ? (f0 === 0 ? gridEnd(f1) : (f1 - f0) / 30) : (gridEnd(f1) + TAIL_FRAMES / 30) - start;
  return { start: String(start), duration: String(duration) };
};

// Per-shot reframe emission (references/reframe.md, split-spike pattern): every shot
// gets its own timed element(s) with STATIC px crops inside overflow-hidden panes; the
// framework's clip timing does all switching (verified frame-exact on both runtimes).
const shotMedia = (clip, source, mediaOffset, width, height) => {
  // composition-frame base of each segment, to rebase a shot into proxy media time
  const segBases = [];
  let acc = 0;
  for (const s of clip.segments) {
    segBases.push({ base: acc, srcIn: s.src_in });
    acc += Math.round((s.src_out - s.src_in) * 30);
  }
  return clip.reframe.shots.map((shot, k) => {
    const seg = [...segBases].reverse().find((b) => shot.f0 >= b.base);
    // 2dp-true part noise-stripped, grid part exact — never rounded (see decision above)
    const mediaStart = String(round(seg.srcIn - mediaOffset) + (shot.f0 - seg.base) / 30);
    const win = shotWindow(shot.f0, shot.f1, k === clip.reframe.shots.length - 1);
    const timing = `data-start="${win.start}" data-duration="${win.duration}" data-media-start="${mediaStart}"`;
    return shot.panes.map((pane, j) => {
      const split = shot.layout === 'split';
      const paneH = split ? height / 2 : height;
      const paneTop = split && j === 1 ? `${height / 2}px` : '0';
      const id = `${clip.id}-s${k}${split ? 'ab'[j] : ''}`;
      const px = cropPx(pane, { paneW: width, paneH });
      // tracks alternate per shot (0/1 then 2/3) so the tail overlap never shares a track
      const track = (k % 2) * 2 + j;
      return `      <div class="pane" style="position:absolute;left:0;top:${paneTop};width:${width}px;height:${paneH}px;overflow:hidden;z-index:${k + 1};">
        <video id="${id}" src="${source}" ${timing} data-track-index="${track}" muted playsinline style="position:absolute;width:${px.width}px;height:${px.height}px;left:${px.left}px;top:${px.top}px"></video>
      </div>`;
    }).join('\n');
  }).join('\n');
};

// Caption block emission: static cue markup + word-timed mounts on the ONE
// registered paused timeline. Cues come from captions.mjs (composition clock); the
// house baseline is the highlight archetype — the Composer restyles to the Kit pick
// named in data-caption-style. RTL cues carry dir="rtl" and lay out right-to-left.
// Baseline look fed back from the first Composer run: per-word scrim pill
// (contrast over bright footage — check 20/20 AA), border-box cue row (side padding
// must not shove the line off-center), Montserrat-first stack (the renderer bundles it).
const CAPTION_CSS = `      .captions { position: absolute; inset: 0; z-index: 20; pointer-events: none; }
      .cap-cue { position: absolute; bottom: 480px; left: 0; width: 100%; box-sizing: border-box; display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: center; gap: 10px; padding: 0 72px; opacity: 0; visibility: hidden; }
      .cap-word { font-family: "Montserrat", "Arial Black", "Helvetica Neue", Arial, sans-serif; font-weight: 900; font-size: 62px; line-height: 1.15; text-transform: uppercase; color: #fff; padding: 5px 16px 7px; border-radius: 14px; background-color: rgba(8, 8, 10, 0.72); text-shadow: 0 3px 10px rgba(0, 0, 0, 0.35); display: inline-block; will-change: transform, background-color; }
`;

const captionMarkup = (clip) => {
  const cues = clip.captions.cues.map((cue, k) => {
    const dir = cue.rtl ? ' dir="rtl"' : '';
    // one line per cue (the cue is a flex row, so inter-span whitespace is inert):
    // a word per line tripped lint's composition_file_too_large on every clip.
    const words = cue.words.map((w, j) =>
      `<span class="cap-word" id="${clip.id}-cue${k}w${j}">${escapeHtml(w.text)}</span>`).join(' ');
    return `      <div id="${clip.id}-cue${k}" class="cap-cue"${dir}>${words}</div>`;
  }).join('\n');
  return `      <div id="${clip.id}-captions" class="captions" data-caption-style="${escapeHtml(clip.captions.style ?? '')}" aria-hidden="true">\n${cues}\n      </div>`;
};

const captionMounts = (clip) => {
  // numbers only — the text already lives in the static markup
  const slim = clip.captions.cues.map((c) => ({
    start: c.start, end: c.end, words: c.words.map((w) => ({ start: w.start, end: w.end })),
  }));
  return `        var CUES = ${JSON.stringify(slim)};
        // Render advances the timeline monotonically frame by frame: two tweens
        // overlapping on one property let the longer tween's later ticks clobber
        // the other (a single seek hides this — verify overlays in RENDER).
        // So: rise never crosses the word end, revert starts exactly there.
        CUES.forEach(function (cue, k) {
          var grp = document.getElementById("${clip.id}-cue" + k);
          var half = (cue.end - cue.start) / 2;
          tl.set(grp, { visibility: "visible" }, cue.start);
          tl.fromTo(grp, { opacity: 0 }, { opacity: 1, duration: Math.min(0.12, half), ease: "power2.out" }, cue.start);
          cue.words.forEach(function (w, j) {
            var el = document.getElementById("${clip.id}-cue" + k + "w" + j);
            var rise = Math.min(0.12, Math.max(w.end - w.start, 0));
            tl.to(el, { backgroundColor: "rgba(255,23,69,0.96)", scale: 1.06, duration: rise, ease: "power2.out" }, w.start);
            tl.to(el, { backgroundColor: "rgba(8,8,10,0.72)", scale: 1, duration: 0.06, ease: "power2.in" }, w.end);
          });
          var fade = Math.min(0.1, half);
          tl.to(grp, { opacity: 0, duration: fade, ease: "power2.in" }, cue.end - fade);
          tl.set(grp, { visibility: "hidden" }, cue.end);
        });`;
};

// One standalone composition (hyperframes-core minimal-composition contract):
// sized root, data-start="0", one paused timeline registered under the clip id.
export function scaffoldComposition(clip, { source, mediaOffset = 0, width = COMPOSE_WIDTH, height = COMPOSE_HEIGHT } = {}) {
  const segs = clip.segments.map((s) => ({ ...s, dur: round(s.src_out - s.src_in) }));
  const total = round(segs.reduce((sum, s) => sum + s.dur, 0));
  let t = 0;
  const audio = segs.map((s, i) => {
    const startAttr = `data-start="${round(t)}" data-duration="${s.dur}" data-media-start="${round(s.src_in - mediaOffset)}"`;
    t += s.dur;
    return `      <audio id="${clip.id}-a${i}" src="${source}" ${startAttr} data-track-index="10" data-volume="1"></audio>`;
  }).join('\n');
  t = 0;
  const media = clip.reframe?.shots?.length
    ? `${shotMedia(clip, source, mediaOffset, width, height)}\n${audio}`
    : segs.map((s, i) => {
      const startAttr = `data-start="${round(t)}" data-duration="${s.dur}" data-media-start="${round(s.src_in - mediaOffset)}"`;
      t += s.dur;
      return `      <video id="${clip.id}-v${i}" src="${source}" ${startAttr} data-track-index="0" muted playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>`;
    }).join('\n') + `\n${audio}`;
  const captioned = Boolean(clip.captions?.cues?.length);
  const timeline = captioned
    ? `window.__timelines = window.__timelines || {};
      // Captions mount on the ONE registered timeline; the Composer's
      // other motion extends this same timeline.
      (function () {
        var tl = gsap.timeline({ paused: true });
${captionMounts(clip)}
        tl.seek(0);
        window.__timelines["${clip.id}"] = tl;
      })();`
    : `window.__timelines = window.__timelines || {};
      // Scaffold baseline: footage only. The Composer's motion lands on this timeline.
      window.__timelines["${clip.id}"] = gsap.timeline({ paused: true });`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${escapeHtml(clip.title)}</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      body { margin: 0; background: #000; }
      #root { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
${captioned ? CAPTION_CSS : ''}    </style>
  </head>
  <body>
    <!-- ${escapeHtml(clip.hook ?? '')} -->
    <div
      id="root"
      data-composition-id="${clip.id}"
      data-start="0"
      data-width="${width}"
      data-height="${height}"
      data-duration="${total}"
    >
${media}
${captioned ? captionMarkup(clip) + '\n' : ''}    </div>
    <script data-cutting-room="prime-media">
      // Timed videos hold their FIRST frame before their window opens. The live player
      // reveals a timed <video> and seeks it in the same instant; until the seek lands
      // (2-8 display frames, measured) the viewer sees whatever frame the element held —
      // file t=0 without this. Pre-seek each video to its data-media-start once metadata
      // is in, and re-arm it when the runtime pauses it outside its window, so replays
      // and scrub-backs reveal the shot's own first frame too. The renderer is unaffected:
      // it seeks in-window media per frame and waits for readiness. Keep this block.
      (function () {
        var vids = document.querySelectorAll('video[data-media-start]');
        for (var i = 0; i < vids.length; i++) (function (v) {
          var ms = parseFloat(v.dataset.mediaStart || '0');
          var start = parseFloat(v.dataset.start || '0');
          var end = start + parseFloat(v.dataset.duration || '0');
          if (!(ms >= 0)) return;
          var prime = function () { try { if (!v.seeking && Math.abs(v.currentTime - ms) > 0.001) v.currentTime = ms; } catch (e) {} };
          v.addEventListener('loadedmetadata', function () { if (v.currentTime < 0.001) prime(); });
          v.addEventListener('pause', function () {
            var tl = window.__timelines && window.__timelines[document.getElementById('root').dataset.compositionId];
            var t = tl && typeof tl.time === 'function' ? tl.time() : null;
            if (t == null || t < start || t > end) prime();
          });
          if (v.readyState >= 1 && v.currentTime < 0.001) prime();
        })(vids[i]);
      })();
    </script>
    <script>
      ${timeline}
    </script>
  </body>
</html>
`;
}

const writeAtomic = (path, text) => {
  writeFileSync(path + '.tmp', text);
  renameSync(path + '.tmp', path);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const [cmd] = argv;
  const dir = flag('dir');
  if (!['build', 'extract'].includes(cmd) || !dir) {
    console.error('usage: scaffold.mjs extract --dir <workdir>/cutting-room [--pad <s>] [--clip <id>] [--force] | build --dir <rundir> [--clip <id>]');
    process.exit(2);
  }
  const planPath = join(dir, 'plan.json');
  if (!existsSync(planPath)) {
    console.error(`no plan.json in ${dir} — run the editorial pass first`);
    process.exit(1);
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const srcPath = plan.source?.path;
  const original = srcPath && (isAbsolute(srcPath) ? srcPath : resolve(dir, '..', srcPath));

  const only = flag('clip');
  const workClips = (plan.clips ?? []).filter(
    (c) => (!only || c.id === only) && ['proposed', 'approved'].includes(c.status),
  );

  if (cmd === 'extract') {
    // reframe.md law #2: per-clip 30fps CFR proxies (extraction cost
    // is independent of source length), then scene detection ON THE FILE JUST MADE —
    // the second ffmpeg call's -i is the first one's output, no re-timestamping.
    if (!original || !existsSync(original)) {
      console.error(`local source video not found (${srcPath ?? 'none in plan'})`);
      process.exit(1);
    }
    const pad = flag('pad') !== undefined ? Number(flag('pad')) : EXTRACT_PAD_S;
    const duration = plan.source?.duration_s;
    const extracted = [];
    for (const clip of workClips) {
      const lo = Math.min(...clip.segments.map((s) => s.src_in));
      const hi = Math.max(...clip.segments.map((s) => s.src_out));
      const prior = clip.composition?.extract;
      const projectDir = join(dir, 'compose', clip.id);
      const priorFile = prior && join(projectDir, prior.file);
      const covered = prior && existsSync(priorFile)
        && prior.start <= lo && hi <= prior.start + prior.frames / CANONICAL_EDIT_FPS;
      if (covered && !argv.includes('--force')) continue;
      const start = round(Math.max(0, lo - pad));
      const end = duration ? Math.min(duration, hi + pad) : hi + pad;
      const len = round(end - start);
      const frames = Math.round(len * CANONICAL_EDIT_FPS);
      mkdirSync(join(projectDir, 'assets'), { recursive: true });
      const out = join(projectDir, 'assets', 'clip30.mp4');
      execFileSync('ffmpeg', [
        '-nostdin', '-y', '-ss', String(start), '-t', String(len + 1), '-i', original,
        '-filter_complex',
        `[0:v]setpts=PTS-STARTPTS,fps=${CANONICAL_EDIT_FPS},`
        + `tpad=stop_mode=clone:stop_duration=${EOF_CLONE_PAD_MAX_S.toFixed(6)},`
        + `trim=end_frame=${frames},setpts=PTS-STARTPTS[v];`
        + `[0:a]asetpts=PTS-STARTPTS,atrim=end=${len}[a]`,
        '-map', '[v]', '-map', '[a]',
        '-r', String(CANONICAL_EDIT_FPS), '-fps_mode', 'cfr',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-c:a', 'aac', '-b:a', '192k',
        out + '.tmp.mp4',
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      renameSync(out + '.tmp.mp4', out);
      // scene detection on the file just made — showinfo logs pts_time to stderr
      const det = spawnSync('ffmpeg', [
        '-nostdin', '-i', out, '-an',
        '-vf', `select='gt(scene,${REFRAME_SCENE_THRESHOLD})',showinfo`,
        '-f', 'null', '-',
      ], { encoding: 'utf8' });
      const cuts = [...new Set(
        [...(det.stderr ?? '').matchAll(/pts_time:([\d.]+)/g)]
          .map((m) => Math.round(Number(m[1]) * CANONICAL_EDIT_FPS)),
      )].sort((a, b) => a - b);
      clip.composition = {
        ...(clip.composition ?? { status: 'none', path: null }),
        extract: { file: 'assets/clip30.mp4', start, fps: CANONICAL_EDIT_FPS, frames, cuts },
      };
      extracted.push(clip.id);
    }
    writeAtomic(planPath, JSON.stringify(plan, null, 2) + '\n');
    console.log(JSON.stringify({ extracted }));
    console.error(`extracted ${extracted.length} clip prox${extracted.length === 1 ? 'y' : 'ies'} at ${CANONICAL_EDIT_FPS}fps CFR`);
    process.exit(0);
  }

  const source = original;
  if (!source || !existsSync(source)) {
    console.error(`local source video not found (${srcPath ?? 'none in plan'}) — previews and renders read the local copy`);
  }
  const scaffolded = [];
  for (const clip of workClips) {
    const projectDir = join(dir, 'compose', clip.id);
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    // A rebuild replaces whatever styling landed in index.html since the last
    // build (a Composer's, or a hand edit with the status still 'scaffolded'):
    // keep the previous file whenever one exists and say so (iterate.md §1).
    const prior = join(projectDir, 'index.html');
    if (existsSync(prior)) {
      copyFileSync(prior, prior + '.prev');
      const composed = clip.composition?.status && clip.composition.status !== 'scaffolded';
      console.error(`${clip.id}: rebuilding — previous index.html kept as index.html.prev${composed ? '; re-run the Composer pass' : ''}`);
    }
    const extract = clip.composition?.extract;
    const proxy = extract && join(projectDir, extract.file);
    const link = join(projectDir, 'assets', 'source.mp4');
    if (proxy && existsSync(proxy)) {
      // the per-clip 30fps proxy IS the media (reframe.md); media-start rebases into it
      rmSync(link, { force: true });
      writeAtomic(join(projectDir, 'index.html'),
        scaffoldComposition(clip, { source: extract.file, mediaOffset: extract.start }));
    } else {
      // no proxy yet — fall back to the original. Hardlink, never symlink: the
      // play/preview static server 403s symlinks that resolve outside the project
      // root; a hardlink keeps the path inside and costs no bytes (cross-volume
      // sources fall back to a copy).
      rmSync(link, { force: true });
      if (source && existsSync(source)) {
        try {
          linkSync(source, link);
        } catch {
          console.error(`hardlink failed (cross-volume?) — copying source for ${clip.id}`);
          copyFileSync(source, link);
        }
      }
      writeAtomic(join(projectDir, 'index.html'), scaffoldComposition(clip, { source: 'assets/source.mp4' }));
    }
    clip.composition = { ...(clip.composition ?? {}), status: 'scaffolded', path: `compose/${clip.id}` };
    scaffolded.push(clip.id);
  }
  writeAtomic(planPath, JSON.stringify(plan, null, 2) + '\n');
  console.log(JSON.stringify({ scaffolded, compose_dir: join(dir, 'compose') }));
  console.error(`scaffolded ${scaffolded.length} composition${scaffolded.length === 1 ? '' : 's'} → ${join(dir, 'compose')}/`);
  process.exit(0);
}

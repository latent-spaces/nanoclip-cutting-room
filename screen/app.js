// app.js — the Screen's wiring. One SSE stream in, one POST out. The rail is the
// source of truth, the chase-light is the reveal boundary, the cart IS style.json.
import {
  emptyKit, kitAdd, kitRemove, kitCount, kitToChoices, kitFromStyle,
  PALETTE_FAMILIES, project, fmtTimer, fmtSize,
} from './lib.mjs';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---------- shared client state ----------

let state = null;      // cutting-room/state@1
let catalog = null;    // cutting-room/catalog@1
let kit = emptyKit();
let locked = false;
const prevStatus = {}; // stage → last seen status, for develop-on-complete

const RAIL_ORDER = ['upload', 'transcript', 'vision', 'cast', 'cut', 'clips'];
const RAIL_LABELS = { upload: 'UPLOAD', transcript: 'TRANSCRIPT', vision: 'VISION', cast: 'CAST', cut: 'CUT', clips: 'CLIPS' };
const RAIL_ICONS = {
  upload: '<path d="M12 16V4"/><path d="m6 10 6-6 6 6"/><path d="M4 20h16"/>',
  transcript: '<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h14"/>',
  vision: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/>',
  cast: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M17.5 14.6c2.1.8 3.5 2.9 3.5 5.4"/>',
  cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.5 13.5"/><path d="M20 20 8.5 10.5"/>',
  clips: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9.5h18"/><path d="M8 5v4.5"/><path d="M13 5v4.5"/><path d="M18 5v4.5"/>',
};
const STATUS_LINES = {
  upload: { completed: 'done', running: 'uploading', waiting: 'waiting', failed: 'failed' },
  transcript: { completed: 'full transcript revealed', running: 'listening for words', waiting: 'waiting', failed: 'failed — see chat' },
  vision: { completed: 'detections mapped', running: 'faces detected and tracking', waiting: 'waiting', failed: 'failed — see chat' },
  cast: { completed: 'cast fused', running: 'building the cast list', waiting: 'building the cast list from detected faces', failed: 'failed — see chat' },
};

const elapsedS = (stage) => (stage?.started_at ? (Date.now() - Date.parse(stage.started_at)) / 1000 : 0);

// The one popped tab: the first running stage in rail order.
const currentStage = () => RAIL_ORDER.find((k) => state?.stages?.[k]?.status === 'running') ?? null;

// ---------- rail ----------

function renderRail() {
  const tabs = $('#rail-tabs');
  tabs.textContent = '';
  if (!state) return;
  const current = currentStage();
  // "Up next" is a promise, not a synonym for waiting: exactly one waiting tab
  // — the first in rail order — is next in line and wears the dashed-promise
  // treatment; the rest stay quiet.
  const upNext = RAIL_ORDER.find((k) => (state.stages?.[k] ?? { status: 'waiting' }).status === 'waiting') ?? null;
  for (const key of RAIL_ORDER) {
    const stage = state.stages[key] ?? { status: 'waiting' };
    const li = el('li', 'rail-tab');
    li.dataset.status = stage.status;
    if (key === upNext && stage.status === 'waiting') li.classList.add('upnext');
    // Product rule: only ONE tab is ever popped — the current stage, the first
    // running stage in rail order — even while analyses run in parallel.
    if (key === current) {
      li.classList.add('current');
      const icon = el('span', 'rt-icon');
      icon.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${RAIL_ICONS[key]}</svg>`;
      li.append(icon);
    }
    li.append(el('span', 'rt-name', RAIL_LABELS[key]));
    const timer = el('span', 'rt-timer');
    timer.dataset.stage = key;
    timer.textContent = stage.status === 'completed' && stage.seconds ? fmtTimer(stage.seconds)
      : stage.status === 'running' ? fmtTimer(elapsedS(stage))
      : '—';
    li.append(timer);
    const status = el('span', 'rt-status');
    status.append(el('i', 'dot'));
    status.append(document.createTextNode(
      stage.status === 'completed' ? 'Done'
      : stage.status === 'running' ? 'Running'
      : stage.status === 'failed' ? 'Failed — see chat'
      : key === upNext ? 'Up next' : 'Waiting',
    ));
    li.append(status);
    tabs.append(li);
  }
  // Spine: solid past above the current tab, faint future below it.
  const idx = current ? RAIL_ORDER.indexOf(current) : RAIL_ORDER.findIndex((k) => state.stages[k]?.status !== 'completed');
  const solidUnits = idx === -1 ? RAIL_ORDER.length : idx;
  tabs.style.setProperty('--spine-past', String(solidUnits / RAIL_ORDER.length));
}

// ---------- strips ----------

const makeChips = (words) => {
  const chips = el('div', 'chips');
  for (const w of words) chips.append(el('span', 'chip', w));
  return chips;
};

const makeSkeletonChips = (n) => {
  const chips = el('div', 'chips');
  for (let i = 0; i < n; i++) {
    const c = el('span', 'chip skeleton', '·');
    c.style.minWidth = `${44 + ((i * 37) % 52)}px`;
    chips.append(c);
  }
  return chips;
};

const makeTicks = (values) => {
  const ticks = el('div', 'ticks');
  for (const v of values) {
    const bar = el('i');
    bar.style.height = `${Math.max(3, Math.round(v * 20))}px`;
    ticks.append(bar);
  }
  return ticks;
};

const makeCounts = (pairs) => {
  const p = el('p', 'counts');
  pairs.forEach(([n, label], i) => {
    if (i) p.append(' · ');
    if (n !== null) { p.append(Object.assign(el('b'), { textContent: n })); p.append(' '); }
    p.append(label);
  });
  return p;
};

// Person identity rides the candy cycle (data, not decoration): a cluster's
// color is its row position in the clustering card, so the film's boxes and
// the card's rings always agree on who is which color.
const clusterClass = (clusterId) => {
  const rows = state?.artifacts?.vision?.faces_by_cluster;
  const pos = rows ? rows.findIndex((r) => r.cluster === clusterId) : -1;
  return `cid-${(pos >= 0 ? pos : Math.abs(clusterId)) % 6}`;
};

const makeFilm = (strip) => {
  const film = el('div', 'film');
  for (const frame of strip) {
    const t = el('span', 'thumb');
    const img = el('img');
    img.src = `/run/${frame.thumb}`;
    img.alt = `frame at ${fmtTimer(frame.t)}`;
    t.append(img);
    for (const [x0, y0, x1, y1, cluster] of frame.boxes ?? []) {
      const box = el('i', 'facebox');
      // pad the detection ~24% per side (+48% linear) so it reads at strip size
      const px = (x1 - x0) * 0.24;
      const py = (y1 - y0) * 0.24;
      const left = Math.max(0, x0 - px);
      const top = Math.max(0, y0 - py);
      Object.assign(box.style, {
        left: `${left * 100}%`, top: `${top * 100}%`,
        width: `${(Math.min(1, x1 + px) - left) * 100}%`, height: `${(Math.min(1, y1 + py) - top) * 100}%`,
      });
      if (cluster !== undefined) box.classList.add(clusterClass(cluster));
      t.append(box);
    }
    film.append(t);
  }
  return film;
};

const makeSkeletonFilm = (n) => {
  const film = el('div', 'film');
  for (let i = 0; i < n; i++) film.append(el('span', 'thumb skeleton'));
  return film;
};

const makeSlots = (n) => {
  const slots = el('div', 'slots');
  for (let i = 0; i < n; i++) slots.append(el('i', null, '+'));
  return slots;
};

function stripBody(key, stage) {
  const body = el('div');
  if (stage.status === 'failed') {
    const err = el('p', 'strip-error');
    err.append(Object.assign(el('b'), { textContent: 'analysis failed. ' }));
    err.append(`${stage.error ?? 'unknown error'} — ask in chat to retry.`);
    body.append(err);
    return body;
  }
  if (key === 'upload') {
    const meta = el('div', 'upload-meta');
    meta.append(el('span', 'upload-name', (state.video?.name ?? '').split('/').pop()));
    const bits = [
      state.video?.duration_s ? fmtTimer(state.video.duration_s) : null,
      state.video?.height ? `${state.video.height}p` : null,
      state.video?.bytes ? fmtSize(state.video.bytes) : null,
      state.facts?.total_usd ? `analysis $${state.facts.total_usd}` : null,
    ].filter(Boolean).join(' · ');
    meta.append(el('span', 'upload-sub', bits));
    body.append(meta);
    body.append(el('div', 'upload-fill'));
    return body;
  }
  if (key === 'transcript') {
    const a = state.artifacts?.transcript;
    if (stage.status === 'completed' && a) {
      body.append(makeChips(a.words_head ?? []));
      if (a.word_ticks) body.append(makeTicks(a.word_ticks));
      body.append(makeCounts([[a.utterances, 'utterances'], [a.speakers, 'speakers'], [a.words, 'words']]));
    } else if (stage.status === 'running') {
      body.append(makeSkeletonChips(9));
      body.append(makeTicks(new Array(48).fill(0.12)));
    } else {
      body.append(makeSlots(6));
    }
    return body;
  }
  if (key === 'vision') {
    const a = state.artifacts?.vision;
    if (stage.status === 'completed' && a) {
      body.append(a.strip?.length ? makeFilm(a.strip) : makeTicks(a.scene_ticks ?? []));
      body.append(makeCounts([
        [a.face_clusters, 'face clusters'], [a.face_tracks, 'tracks'],
        [a.scene_cuts, 'scene cuts'], [null, a.asd_ran ? 'ASD ✓' : 'ASD skipped'],
      ]));
    } else if (stage.status === 'running') {
      // The visitor's own frames, plain, behind the veil: the chase-light has
      // something real to reveal while vision cooks (boxes join on completion).
      body.append(state.frames?.length ? makeFilm(state.frames) : makeSkeletonFilm(6));
    } else {
      body.append(makeSlots(6));
    }
    return body;
  }
  if (key === 'cast') {
    // live fill: announce.mjs lands the fused cast (real crops + who talked how long)
    const cast = state.artifacts?.cast;
    if (stage.status === 'completed' && cast?.length) {
      const row = el('div', 'cast-row');
      for (const p of cast) {
        const m = el('div', 'cast-member');
        if (p.thumb) {
          const img = el('img', 'cast-face');
          img.src = `/run/${p.thumb}`;
          img.alt = p.label ?? p.person_id;
          m.append(img);
        }
        const txt = el('div', 'cast-text');
        txt.append(el('p', 'cast-name', p.label ?? p.person_id));
        txt.append(el('p', 'cast-meta', [p.role, p.speaking_s ? `${fmtTimer(Math.round(p.speaking_s))} on mic` : null]
          .filter(Boolean).join(' · ')));
        m.append(txt);
        row.append(m);
      }
      body.append(row);
      return body;
    }
    body.append(makeSlots(6));
    const visionDone = state.stages?.vision?.status === 'completed';
    body.append(el('p', 'waiting-note', visionDone
      ? 'FACES MAPPED — THE CAST FUSES AT THE DIGEST STAGE'
      : 'WAITING FOR VISION'));
    return body;
  }
  return body;
}

function renderStrips() {
  if (!state) return;
  const current = currentStage();
  for (const article of document.querySelectorAll('.strip')) {
    const key = article.dataset.stage;
    const stage = state.stages?.[key] ?? { status: 'waiting' };
    article.dataset.status = stage.status;
    article.querySelector('[data-slot="status"]').textContent = STATUS_LINES[key]?.[stage.status] ?? stage.status;
    const timer = article.querySelector('[data-slot="timer"]');
    timer.textContent = stage.status === 'completed' && stage.seconds ? fmtTimer(stage.seconds)
      : stage.status === 'running' ? fmtTimer(elapsedS(stage)) : '';
    const body = article.querySelector('[data-slot="body"]');
    body.textContent = '';
    const content = stripBody(key, stage);
    body.append(...content.childNodes);
    // develop-on-complete: artifacts stagger in the moment a stage lands
    if (prevStatus[key] === 'running' && stage.status === 'completed') {
      body.querySelectorAll('.chip, .ticks i, .thumb').forEach((n, i) => {
        n.classList.add('develop');
        n.style.animationDelay = `${Math.min(i * 40, 800)}ms`;
      });
    }
    // the chase-light lives only in the current strip
    if (key === current && (key === 'transcript' || key === 'vision')) {
      const veil = el('i', 'chase-veil');
      const chase = el('i', 'chase');
      const p = project(elapsedS(stage), stage.expected_s ?? 60);
      veil.style.setProperty('--reveal', `${p * 100}%`);
      chase.style.left = `${6 + p * 88}%`;
      body.append(veil, chase);
    }
    prevStatus[key] = stage.status;
  }
  // ETA line: the longest remaining projection among running stages
  const remaining = RAIL_ORDER
    .map((k) => state.stages?.[k])
    .filter((s) => s?.status === 'running' && s.expected_s)
    .map((s) => Math.max(0, s.expected_s - elapsedS(s)));
  const eta = $('#eta');
  if (remaining.length) {
    eta.hidden = false;
    eta.innerHTML = '';
    eta.append('ESTIMATED TIME REMAINING ');
    eta.append(Object.assign(el('b'), { textContent: fmtTimer(Math.max(...remaining)) }));
  } else {
    eta.hidden = true;
  }
}

// ---------- beat 01 · hero explainers go live on real artifacts ----------

const SPEAKER_COLORS = ['var(--frosting)', 'var(--blueberry)', 'var(--mint)', 'var(--lemon)', 'var(--peach)', 'var(--ink-muted)'];
const heroLive = { diar: false, cluster: false, asd: false };

const goLive = (kind, demo, note, text) => {
  note.textContent = text;
  note.classList.add('live');
  demo.removeAttribute('aria-hidden');
  if (!heroLive[kind]) {
    heroLive[kind] = true;
    demo.querySelectorAll(':scope > *').forEach((n, i) => {
      n.classList.add('develop');
      n.style.animationDelay = `${i * 60}ms`;
    });
  }
};

function renderHero() {
  if (!state) return;
  const tArt = state.artifacts?.transcript;
  const vArt = state.artifacts?.vision;
  if (tArt?.speaker_rows?.length) {
    const demo = $('#diar-demo');
    demo.textContent = '';
    tArt.speaker_rows.forEach((r, i) => {
      const row = el('div', 'diar-row');
      row.append(el('span', 'diar-chip', `S${r.speaker + 1}`));
      const wave = el('span', 'diar-wave real');
      wave.style.setProperty('--wave-c', SPEAKER_COLORS[i % SPEAKER_COLORS.length]);
      wave.style.width = `${Math.max(8, Math.round(r.share * 100))}%`;
      row.append(wave);
      row.append(el('span', 'diar-secs mono', fmtTimer(r.seconds)));
      demo.append(row);
    });
    goLive('diar', demo, $('#diar-note'), `FROM YOUR FOOTAGE · ${tArt.speakers} SPEAKERS`);
  }
  if (vArt?.faces_by_cluster?.length) {
    const demo = $('#cluster-demo');
    demo.textContent = '';
    for (const c of vArt.faces_by_cluster) {
      const row = el('div', 'cluster-row');
      row.append(el('span', 'cluster-tag mono', `P${c.cluster + 1}`));
      for (const crop of c.crops) {
        const img = el('img', `cluster-face ${clusterClass(c.cluster)}`);
        img.src = `/run/${crop}`;
        img.alt = `person ${c.cluster + 1}, seen across your video`;
        row.append(img);
      }
      demo.append(row);
    }
    goLive('cluster', demo, $('#cluster-note'), `FROM YOUR FOOTAGE · ${vArt.face_clusters} FACE CLUSTERS`);
  }
  if (vArt?.asd_moment?.thumb) {
    const m = vArt.asd_moment;
    const demo = $('#asd-demo');
    demo.textContent = '';
    const frame = el('span', 'asd-frame real');
    const img = el('img');
    img.src = `/run/${m.thumb}`;
    img.alt = `your footage at ${fmtTimer(m.t)} — active speaker boxed`;
    frame.append(img);
    // the facebox spotlights the speaker (its shadow dims everything else),
    // and the ON AIR chip carries a live speaking meter; a ~12%/side pad keeps
    // the corner brackets off the face itself
    const [x0, y0, x1, y1] = m.box;
    const px = (x1 - x0) * 0.12;
    const py = (y1 - y0) * 0.12;
    const bl = Math.max(0, x0 - px);
    const bt = Math.max(0, y0 - py);
    const box = el('i', 'facebox');
    Object.assign(box.style, {
      left: `${bl * 100}%`, top: `${bt * 100}%`,
      width: `${(Math.min(1, x1 + px) - bl) * 100}%`, height: `${(Math.min(1, y1 + py) - bt) * 100}%`,
    });
    frame.append(box);
    const onair = el('span', 'onair mono');
    onair.append('ON AIR');
    const eq = el('i', 'eq');
    eq.append(el('b'), el('b'), el('b'));
    onair.append(eq);
    frame.append(onair);
    demo.append(frame);
    goLive('asd', demo, $('#asd-note-live'), `FROM YOUR FOOTAGE · ON AIR AT ${fmtTimer(m.t)}`);
  }
}

// ---------- beats 04 / 05 + foot band ----------

function renderEnd() {
  if (!state) return;
  const clips = state.artifacts?.clips;
  const zone = $('#clips-zone');
  const ready = state.stages?.clips?.status === 'completed' && Array.isArray(clips) && clips.length;
  document.body.classList.toggle('ready', Boolean(ready));
  const band = $('#footband');
  band.classList.toggle('ready', Boolean(ready));
  $('#footband-cta').hidden = !ready;
  if (ready) {
    $('#footband-copy').lastChild.textContent = ` ${clips.length === 3 ? 'Three' : clips.length} clips, ready.`;
    // clips embed in the page (product decision): the band walks you to them; the
    // own-tab preview remains only for runs without embedded players
    const embedded = clips.some((c) => c.url);
    const cta = $('#footband-cta');
    if (embedded) {
      cta.href = '#clips-zone';
      cta.textContent = 'See your clips ↓';
    } else if (state.preview_url) {
      cta.href = state.preview_url;
    }
    zone.textContent = '';
    const cards = el('div', 'clip-cards');
    for (const c of clips) {
      const card = el('div', 'clip-card');
      // product decision: the clips play IN the page. The player component
      // works cross-origin against a play server (its /player.js injects the HF
      // runtime into the composition — measured in an embed spike); raw files don't.
      if (c.url) {
        if (!document.getElementById('hfp-lib')) {
          const lib = document.createElement('script');
          lib.id = 'hfp-lib';
          lib.src = `${c.url}/player.js`;
          document.head.append(lib);
        }
        const wrap = el('div', 'clip-player');
        const player = document.createElement('hyperframes-player');
        player.setAttribute('src', `${c.url}/composition/index.html`);
        player.setAttribute('controls', '');
        player.setAttribute('muted', '');
        wrap.append(player);
        card.append(wrap);
      }
      card.append(el('p', 'hook', c.hook ?? c.title ?? 'clip'));
      card.append(el('p', 'meta', c.duration_s ? `${fmtTimer(c.duration_s)} · vertical` : 'vertical'));
      cards.append(card);
    }
    zone.append(cards);
    // the drafts are steerable — say it where the clips are, in say-this chips
    const steer = el('div', 'steer');
    steer.append(el('p', 'steer-lead', 'These are drafts — direct the edit from chat:'));
    const chips = el('div', 'chips steer-chips');
    for (const say of [
      '“start c1 two seconds earlier”',
      '“swap c2 for something from the pool”',
      '“switch the caption style”',
      '“ship it in high quality”',
    ]) chips.append(el('span', 'chip', say));
    steer.append(chips);
    zone.append(steer);
    const nextLine = $('#next-line');
    if (nextLine) nextLine.hidden = true;
  }
}

// ---------- catalog + kit ----------

const FAMILY_LABEL = {
  captions: 'CAPTION', transitions: 'TRANSITION', blocks: 'ACCENT',
  treatments: 'TREATMENT', titles: 'TITLE',
};
const kitFamily = (family) => (family === 'captions' ? 'caption' : family);
// every item array the catalog file carries, in shelf order (old catalog files
// without the style@2 families read as empty)
const catalogItems = (cat) => ['captions', ...PALETTE_FAMILIES].flatMap((f) => cat?.[f] ?? []);

// Caption previews: each registry style's own character, composited over the
// visitor's real footage once frames exist — specimen words come from their
// own transcript. Before any frame lands, the neutral pill is the fallback.
const SPECIMEN_CLASS = [
  ['glitch', 'sp-glitch'], ['neon', 'sp-neon'], ['highlight', 'sp-highlight'],
  ['karaoke', 'sp-highlight'], ['emoji', 'sp-emoji'], ['gradient', 'sp-gradient'],
  ['matrix', 'sp-matrix'], ['typewriter', 'sp-matrix'], ['slam', 'sp-slam'],
  ['kinetic', 'sp-slam'], ['bounce', 'sp-slam'], ['editorial', 'sp-editorial'],
  ['wipe', 'sp-wipe'], ['parallax', 'sp-parallax'], ['follow', 'sp-follow'],
];
const specimenClass = (name) => SPECIMEN_CLASS.find(([k]) => name.includes(k))?.[1] ?? 'sp-plain';
const specimenWords = () => {
  const words = state?.artifacts?.transcript?.words_head;
  return words?.length >= 5 ? words.slice(1, 5).join(' ') : null;
};
const previewFrame = (i) => {
  const frames = state?.artifacts?.vision?.strip ?? state?.frames;
  return frames?.length ? `/run/${frames[i % frames.length].thumb}` : null;
};

// Live previews play only while in the viewport (and pause off it): a shelf of
// loops must never tax the SSE-driven page. prefers-reduced-motion drops every
// animation globally, so the same cards fall back to their static poses.
const previewIO = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
      for (const e of entries) e.target.classList.toggle('playing', e.isIntersecting);
    }, { rootMargin: '80px', threshold: 0.1 })
  : null;
const watchPlay = (node) => {
  if (previewIO) previewIO.observe(node);
  else node.classList.add('playing');
};

function makeCaptionPreview(item, idx) {
  const preview = el('div', 'caption-preview');
  const src = previewFrame(idx);
  if (src) {
    const img = el('img', 'preview-frame');
    img.src = src;
    img.alt = '';
    preview.append(img);
    preview.classList.add('framed');
  }
  const spec = el('span', `specimen ${specimenClass(item.name)}`);
  // word-level spans: the loop animates each style's character per word
  const text = specimenWords() ?? item.title;
  text.split(/\s+/).forEach((word, i) => {
    if (i) spec.append(' ');
    const w = el('i', 'w', word);
    w.style.setProperty('--i', i);
    spec.append(w);
  });
  if (item.name.includes('emoji')) {
    spec.append(' ');
    const w = el('i', 'w emoji', '🔥');
    w.style.setProperty('--i', 4);
    spec.append(w);
  }
  preview.append(spec);
  watchPlay(preview);
  return preview;
}

// Transition / accent motifs: the family's character demonstrated over the
// visitor's own frames (A→B for transitions, an overlay motif for accents) —
// our rendition of each style, the same claim level as the caption specimens.
const MOTIF_CLASS = [
  ['wipe', 'm-wipe'], ['slide', 'm-wipe'], ['cover', 'm-wipe'], ['swipe', 'm-wipe'],
  ['3d', 'm-flip'], ['flip', 'm-flip'], ['cube', 'm-flip'],
  ['zoom', 'm-zoom'], ['punch', 'm-zoom'], ['resize', 'm-zoom'],
  ['glitch', 'm-glitch'], ['chromatic', 'm-glitch'], ['aberration', 'm-glitch'],
  ['fade', 'm-fade'], ['dissolve', 'm-fade'], ['blur', 'm-fade'], ['freeze', 'm-fade'],
  ['cta', 'm-lockup'], ['lockup', 'm-lockup'], ['lower', 'm-lockup'], ['title', 'm-lockup'],
  ['ascii', 'm-trail'], ['trail', 'm-trail'], ['count', 'm-trail'],
  ['avatar', 'm-cloud'], ['cloud', 'm-cloud'],
  ['accent', 'm-pulse'], ['pulse', 'm-pulse'], ['beat', 'm-pulse'], ['gloss', 'm-pulse'],
  ['grain', 'm-wash'], ['texture', 'm-wash'], ['vignette', 'm-wash'], ['halftone', 'm-wash'],
  ['grade', 'm-wash'], ['camcorder', 'm-wash'], ['ink', 'm-wash'],
  ['type', 'm-lockup'], ['weight', 'm-lockup'], ['marker', 'm-trail'], ['decode', 'm-trail'],
];
// A keyword hit outside the family's legal set falls back to the family default:
// the element structure is per-family (transitions animate an A→B frame, the
// rest an overlay), so a cross-family motif would target a child that doesn't
// exist. Treatments read as a wash over the frame; titles as type lockups.
const MOTIF_FAMILY = {
  transitions: ['m-wipe', 'm-fade', 'm-flip', 'm-zoom', 'm-glitch'],
  blocks: ['m-pulse', 'm-lockup', 'm-trail', 'm-cloud'],
  treatments: ['m-wash'],
  titles: ['m-lockup', 'm-trail'],
};
const MOTIF_DEFAULT = { transitions: 'm-fade', blocks: 'm-pulse', treatments: 'm-wash', titles: 'm-lockup' };
const motifClass = (name, family) => {
  const legal = MOTIF_FAMILY[family] ?? MOTIF_FAMILY.blocks;
  const hit = MOTIF_CLASS.find(([k]) => name.includes(k))?.[1];
  return legal.includes(hit) ? hit : (MOTIF_DEFAULT[family] ?? 'm-pulse');
};

function makeMotifPreview(item, family, idx, size) {
  const wrap = el('div', `motif ${size} ${motifClass(item.name, family)}`);
  const a = previewFrame(idx);
  if (a) {
    const fa = el('img', 'mf-a');
    fa.src = a;
    fa.alt = '';
    wrap.append(fa);
  }
  if (family === 'transitions') {
    const b = previewFrame(idx + 3);
    if (b && b !== a) {
      const fb = el('img', 'mf-b');
      fb.src = b;
      fb.alt = '';
      wrap.append(fb);
    } else {
      wrap.append(el('i', 'mf-b'));
    }
  } else {
    wrap.append(el('i', 'mf-x'));
  }
  watchPlay(wrap);
  return wrap;
}

function postChoices() {
  return fetch('/choices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(kitToChoices(kit)),
  }).then((r) => {
    if (r.status === 409) { locked = true; renderCatalog(); renderKit(); }
    return r;
  }).catch(() => {});
}

// Adding to the kit is commitment — say it with motion (product decision): the
// picked chip itself lifts off, arcs to the Kit chip and shrinks into it, so
// you see exactly what you added; the Kit bumps on arrival. Reduced motion,
// missing WAAPI, or an open drawer (the chip is behind the overlay) fall back
// to the immediate bump. Never fires on remove.
function celebrateAdd(fromEl) {
  const chip = $('#kit-chip');
  const bump = () => {
    chip.classList.remove('bump');
    requestAnimationFrame(() => chip.classList.add('bump'));
  };
  const drawerOpen = !$('#overlay').hidden;
  if (!fromEl || drawerOpen || typeof fromEl.animate !== 'function'
    || matchMedia('(prefers-reduced-motion: reduce)').matches) { bump(); return; }
  const a = fromEl.getBoundingClientRect();
  const b = chip.getBoundingClientRect();
  const ghost = fromEl.cloneNode(true);
  ghost.classList.add('fly-clone');
  ghost.style.left = `${a.left}px`;
  ghost.style.top = `${a.top}px`;
  ghost.style.width = `${a.width}px`;
  ghost.style.height = `${a.height}px`;
  document.body.append(ghost);
  const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
  const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
  const anim = ghost.animate([
    { transform: 'translate(0, 0) scale(1)', opacity: 1 },
    { transform: `translate(${dx * 0.55}px, ${dy - 54}px) scale(0.65)`, opacity: 0.95, offset: 0.55 },
    { transform: `translate(${dx}px, ${dy}px) scale(0.3)`, opacity: 0 },
  ], { duration: 620, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
  const land = () => { ghost.remove(); bump(); };
  anim.onfinish = land;
  anim.oncancel = land;
}

function toggle(family, name, fromEl) {
  if (locked) return;
  const fam = kitFamily(family);
  const selected = fam === 'caption' ? kit.caption === name : kit[fam].includes(name);
  kit = selected ? kitRemove(kit, fam, name) : kitAdd(kit, fam, name);
  if (!selected) celebrateAdd(fromEl);
  postChoices();
  renderCatalog();
  renderKit();
}

const isSelected = (family, name) => (kitFamily(family) === 'caption' ? kit.caption === name : kit[kitFamily(family)].includes(name));

function renderCatalog() {
  const beat = $('#beat-3');
  beat.classList.toggle('locked', locked);
  const fallback = $('#catalog-fallback');
  const shelf = $('#caption-shelf');
  const palette = $('#palette-shelf');
  shelf.textContent = '';
  palette.textContent = '';
  if (!catalog || catalog.error) {
    fallback.hidden = !catalog;
    return;
  }
  fallback.hidden = true;
  const byName = new Map(catalogItems(catalog).map((i) => [i.name, i]));
  catalog.curated.captions.forEach((name, idx) => {
    const item = byName.get(name);
    if (!item) return;
    const card = el('button', 'caption-card');
    card.type = 'button';
    card.append(makeCaptionPreview(item, idx));
    card.append(el('p', 'caption-name', item.title));
    card.append(el('p', 'caption-desc', item.description.split(' - ')[0]));
    if (isSelected('captions', name)) {
      card.classList.add('selected');
      const check = el('span', 'caption-check');
      check.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>';
      card.append(check);
    }
    card.addEventListener('click', () => toggle('captions', name, card));
    shelf.append(card);
  });
  // Grouped by family (product decision: clear categories + where a pick lands):
  // a mono family header carries a human placement role; chips drop their
  // per-chip family label — the group says it once.
  const FAMILY_ROLE = {
    transitions: 'play at the cuts inside a clip',
    blocks: 'short emphasis moments over the footage',
    treatments: 'a look layer over the whole clip',
    titles: 'type moments for hooks and openers',
  };
  let motifIdx = 0;
  for (const family of PALETTE_FAMILIES) {
    const names = (catalog.curated[family] ?? []).filter((n) => byName.has(n));
    if (!names.length) continue;
    const group = el('div', 'palette-group');
    const head = el('p', 'palette-group-head mono', `${FAMILY_LABEL[family]}S`);
    head.append(el('span', 'pg-role', ` — ${FAMILY_ROLE[family]}`));
    group.append(head);
    const row = el('div', 'palette-row');
    for (const name of names) {
      const item = byName.get(name);
      const chip = el('button', 'palette-chip with-motif');
      chip.type = 'button';
      chip.append(makeMotifPreview(item, family, motifIdx++, 'mini'));
      chip.append(el('span', null, item.title));
      chip.classList.toggle('selected', isSelected(family, name));
      chip.addEventListener('click', () => toggle(family, name, chip));
      row.append(chip);
    }
    group.append(row);
    palette.append(group);
  }
}

function renderKit() {
  $('#kit-count').hidden = kitCount(kit) === 0;
  $('#kit-count').textContent = kitCount(kit);
  const items = $('#kit-items');
  items.textContent = '';
  const rows = [
    ...(kit.caption ? [['captions', kit.caption]] : []),
    ...PALETTE_FAMILIES.flatMap((f) => (kit[f] ?? []).map((n) => [f, n])),
  ];
  $('#kit-empty').hidden = rows.length > 0;
  $('#kit-locked').hidden = !locked;
  const byName = catalog ? new Map(catalogItems(catalog).map((i) => [i.name, i])) : new Map();
  for (const [family, name] of rows) {
    const row = el('div', 'kit-item');
    row.append(el('span', 'kit-item-family', FAMILY_LABEL[family]));
    row.append(el('span', 'kit-item-name', byName.get(name)?.title ?? name));
    if (!locked) {
      const rm = el('button', 'kit-remove');
      rm.type = 'button';
      rm.setAttribute('aria-label', `remove ${name}`);
      rm.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>';
      rm.addEventListener('click', () => toggle(family, name));
      row.append(rm);
    }
    items.append(row);
  }
}

// ---------- browse-all overlay ----------

let overlayTag = null;

function renderOverlay() {
  if (!catalog || catalog.error) return;
  const q = $('#overlay-search').value.trim().toLowerCase();
  const grid = $('#overlay-grid');
  grid.textContent = '';
  const families = ['captions', ...PALETTE_FAMILIES].map((f) => [f, catalog[f] ?? []]);
  // Sectioned browse, flat search: family headers group the full catalog, but
  // any query or tag flattens results into one set (sections fight filters).
  const sectioned = !q && !overlayTag;
  let shown = 0;
  for (const [family, items] of families) {
    if (sectioned && items.length) {
      grid.append(el('p', 'overlay-section mono', `${FAMILY_LABEL[family]}S · ${items.length}`));
    }
    for (const item of items) {
      const hay = `${item.name} ${item.title} ${item.description} ${item.tags.join(' ')}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      if (overlayTag && !item.tags.includes(overlayTag)) continue;
      const btn = el('button', 'overlay-item');
      btn.type = 'button';
      if (family === 'captions') btn.append(makeCaptionPreview(item, shown));
      else btn.append(makeMotifPreview(item, family, shown, 'full'));
      btn.append(el('span', 'oi-family', FAMILY_LABEL[family]));
      btn.append(el('span', 'oi-name', item.title));
      btn.append(el('span', 'oi-desc', item.description));
      btn.classList.toggle('selected', isSelected(family, item.name));
      btn.addEventListener('click', () => { toggle(family, item.name, btn); renderOverlay(); });
      grid.append(btn);
      shown += 1;
    }
  }
  if (!shown) grid.append(el('p', 'overlay-empty', 'Nothing matches — clear the search or the tag.'));
}

function renderOverlayTags() {
  const counts = {};
  for (const item of catalogItems(catalog)) {
    for (const t of item.tags) counts[t] = (counts[t] ?? 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([t]) => t);
  const wrap = $('#overlay-tags');
  wrap.textContent = '';
  for (const t of top) {
    const chip = el('button', 'tag-chip', t);
    chip.type = 'button';
    chip.classList.toggle('selected', overlayTag === t);
    chip.addEventListener('click', () => {
      overlayTag = overlayTag === t ? null : t;
      renderOverlayTags();
      renderOverlay();
    });
    wrap.append(chip);
  }
}

// ---------- events in ----------

let previewKey = '';

function applyState(next) {
  state = next;
  renderRail();
  renderStrips();
  renderHero();
  renderEnd();
  // Caption previews composite over real frames and real words — re-shelve
  // only when that material actually changes, never on every state event.
  const key = `${state?.frames?.length ?? 0}|${state?.artifacts?.transcript ? 1 : 0}|${state?.artifacts?.vision?.strip ? 1 : 0}`;
  if (key !== previewKey) {
    previewKey = key;
    renderCatalog();
    if (!$('#overlay').hidden) renderOverlay();
  }
}

function applyStyle(style) {
  kit = kitFromStyle(style);
  locked = Boolean(style?.locked);
  renderCatalog();
  renderKit();
}

function applyCatalog(next) {
  catalog = next;
  renderCatalog();
  renderKit();
  renderOverlayTags();
  renderOverlay();
}

async function boot() {
  // initial snapshots (tolerate absence — SSE will fill in)
  for (const [path, apply] of [
    ['/run/state.json', applyState], ['/run/style.json', applyStyle], ['/run/catalog.json', applyCatalog],
  ]) {
    try {
      const r = await fetch(path);
      if (r.ok) apply(await r.json());
    } catch { /* server will push it */ }
  }

  const es = new EventSource('/events');
  es.addEventListener('state', (e) => applyState(JSON.parse(e.data)));
  es.addEventListener('style', (e) => applyStyle(JSON.parse(e.data)));
  es.addEventListener('catalog', (e) => applyCatalog(JSON.parse(e.data)));
  es.onerror = () => { $('#rail-stale').hidden = false; };
  es.onopen = () => { $('#rail-stale').hidden = true; };

  // Live timers + the honest cursor: text and position updates only — the DOM is
  // rebuilt exclusively on state events, never on the clock.
  setInterval(tickClocks, 1000);
}

function tickClocks() {
  if (!state) return;
  const current = currentStage();
  for (const article of document.querySelectorAll('.strip')) {
    const stage = state.stages?.[article.dataset.stage];
    if (stage?.status !== 'running') continue;
    article.querySelector('[data-slot="timer"]').textContent = fmtTimer(elapsedS(stage));
    if (article.dataset.stage === current) {
      const p = project(elapsedS(stage), stage.expected_s ?? 60);
      const veil = article.querySelector('.chase-veil');
      const chase = article.querySelector('.chase');
      if (veil) veil.style.setProperty('--reveal', `${p * 100}%`);
      if (chase) chase.style.left = `${6 + p * 88}%`;
    }
  }
  for (const timer of document.querySelectorAll('.rt-timer')) {
    const stage = state.stages?.[timer.dataset.stage];
    if (stage?.status === 'running') timer.textContent = fmtTimer(elapsedS(stage));
  }
  const remaining = RAIL_ORDER
    .map((k) => state.stages?.[k])
    .filter((s) => s?.status === 'running' && s.expected_s)
    .map((s) => Math.max(0, s.expected_s - elapsedS(s)));
  const eta = $('#eta');
  if (remaining.length) {
    eta.hidden = false;
    eta.textContent = 'ESTIMATED TIME REMAINING ';
    eta.append(Object.assign(el('b'), { textContent: fmtTimer(Math.max(...remaining)) }));
  } else {
    eta.hidden = true;
  }
}

// kit panel open/close
$('#kit-chip').addEventListener('click', () => {
  const panel = $('#kit-panel');
  panel.hidden = !panel.hidden;
  $('#kit-chip').setAttribute('aria-expanded', String(!panel.hidden));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.kit-panel') && !e.target.closest('.kit-chip')) $('#kit-panel').hidden = true;
});

// overlay open/close
const overlay = $('#overlay');
$('#browse-all').addEventListener('click', () => {
  overlay.hidden = false;
  renderOverlayTags();
  renderOverlay();
  $('#overlay-search').focus();
});
const closeOverlay = () => { overlay.hidden = true; };
$('#overlay-close').addEventListener('click', closeOverlay);
$('#overlay-backdrop').addEventListener('click', closeOverlay);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay(); });
$('#overlay-search').addEventListener('input', renderOverlay);

boot();

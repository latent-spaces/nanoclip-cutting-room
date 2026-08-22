#!/usr/bin/env node
// player-probe — the LIVE-PLAYER gate for shot switches (references/compose.md §4).
//
// A composition runs on two runtimes. The renderer samples t = k/fps and waits for
// media readiness before every capture — it cannot see a visibility hole between two
// windows or a seek that is still in flight. The play server + <hyperframes-player>
// run in real time: visibility is evaluated at display rate (~60 Hz rAF) and a timed
// <video> is revealed and seeked in the same instant. Both defects show only there:
//   · a hole between shot windows  → one sampled frame with NO video visible = black frame
//   · seek-on-reveal               → 2-8 display frames of whatever frame the element held
// switch-scan / switch-lab verify rendered frames; this probe verifies the player.
//
// Method: real Chrome via playwright (channel 'chrome'), the composition iframe gets a
// rAF sampler (per <video>: visible?, readyState, seeking, currentTime, mean luma of
// the element's current frame via a 16×16 canvas) plus the registered GSAP timeline
// time; CDP Page.startScreencast records every compositor frame → ffmpeg YAVG on the
// 9:16 composition column = what the viewer sees. Each plan switch ((f0 − 0.25)/30)
// is then judged: none-visible samples, incoming element not ready at first reveal,
// screencast luma dips near the switch. Exit 1 on any flag.
//
// usage: node scripts/player-probe.mjs --port 3003 --clip c1 --plan <rundir>/plan.json
//        [--out <dir>] [--headed] [--replay] [--seconds N]
// needs: Chrome installed + playwright-core (or playwright) resolvable — global install
//        (`npm i -g playwright-core`) or the @playwright/cli bundle both work.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

const FPS = 30;
const flag = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i === -1 ? d : process.argv[i + 1]; };
const has = (k) => process.argv.includes(`--${k}`);

const loadPlaywright = () => {
  const roots = [process.cwd(), resolve(new URL('..', import.meta.url).pathname)];
  try { roots.push(execSync('npm root -g', { encoding: 'utf8' }).trim()); } catch {}
  try { roots.push(join(execSync('npm root -g', { encoding: 'utf8' }).trim(), '@playwright/cli/node_modules')); } catch {}
  for (const root of roots) {
    for (const name of ['playwright-core', 'playwright']) {
      const p = join(root, 'node_modules', name);
      const q = join(root, name);
      for (const cand of [p, q]) {
        if (existsSync(join(cand, 'package.json'))) {
          try { return createRequire(join(cand, 'package.json')).call(null, cand); } catch {}
          try { return createRequire(import.meta.url)(cand); } catch {}
        }
      }
    }
  }
  return null;
};

export const switchesOf = (plan, clipId) => {
  const clip = plan?.clips?.find((c) => c.id === clipId);
  const shots = clip?.reframe?.shots ?? [];
  return shots.map((s, k) => ({ k, f0: s.f0, t: (s.f0 - 0.25) / FPS, layout: s.layout, ids: (s.panes ?? [null]).map((_, j) => `${clipId}-s${k}${s.layout === 'split' ? 'ab'[j] : ''}`) })).filter((s) => s.f0 > 0);
};

// judge one switch from the in-frame samples + screencast frames of one playback pass
export const judgeSwitch = (sw, samples, frames) => {
  const win = samples.filter((s) => s.t != null && s.t >= sw.t - 0.25 && s.t <= sw.t + 0.35);
  const incoming = sw.ids[0];
  const firstVis = win.find((s) => s.v.find((v) => v.id === incoming)?.vis);
  const ent = firstVis?.v.find((v) => v.id === incoming);
  const noneVisible = win.filter((s) => s.v.filter((v) => v.vis).length === 0).map((s) => s.t);
  const dips = frames.filter((f) => f.dip && f.tl != null && Math.abs(f.tl - sw.t) < 0.3).map((f) => ({ idx: f.idx, y: f.y, tl: f.tl }));
  const notReady = ent ? (ent.rs < 2 || ent.sk) : false;
  return {
    f0: sw.f0, t: +sw.t.toFixed(4), layout: sw.layout, incoming,
    first_visible: ent ? { t: firstVis.t, readyState: ent.rs, seeking: ent.sk, currentTime: ent.ct, luma: ent.L } : null,
    none_visible_samples: noneVisible, not_ready_at_reveal: notReady, screencast_dips: dips,
    ok: noneVisible.length === 0 && !notReady && dips.length === 0 && ent != null,
  };
};

const main = async () => {
  const port = Number(flag('port', '3003'));
  const clipId = flag('clip', 'c1');
  const planPath = flag('plan');
  const out = flag('out', join(process.cwd(), 'player-probe', clipId));
  const headed = has('headed');
  const replay = has('replay');
  const seconds = Number(flag('seconds', '0')) || null;
  if (!planPath) { console.error('usage: player-probe.mjs --port N --clip <id> --plan <rundir>/plan.json [--out dir] [--headed] [--replay] [--seconds N]'); process.exit(2); }
  const pw = loadPlaywright();
  if (!pw) { console.error('player-probe needs playwright-core (npm i -g playwright-core) and Chrome'); process.exit(2); }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const switches = switchesOf(plan, clipId);
  mkdirSync(out, { recursive: true });
  const framesDir = join(out, 'frames');
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  const browser = await pw.chromium.launch({ channel: 'chrome', headless: !headed });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  let comp = null;
  for (let i = 0; i < 200 && !comp; i++) { comp = page.frames().find((f) => f.url().includes('/composition/')); if (!comp) await page.waitForTimeout(100); }
  if (!comp) throw new Error('composition frame never appeared — is this a play server root?');
  await comp.waitForFunction(() => window.__timelines && Object.keys(window.__timelines).length > 0 && document.querySelectorAll('video').length > 0, null, { timeout: 20000 });
  await page.waitForFunction(() => { const p = document.querySelector('hyperframes-player'); return p && Number(p.duration) > 0; }, null, { timeout: 20000 });
  const duration = await page.evaluate(() => Number(document.querySelector('hyperframes-player').duration));
  const runFor = seconds ?? Math.min(duration + 1.0, 180);
  const iframeRect = await page.evaluate(() => { const hp = document.querySelector('hyperframes-player'); const f = (hp.shadowRoot && hp.shadowRoot.querySelector('iframe')) || hp.querySelector('iframe') || hp; const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const colW = Math.round(iframeRect.h * 9 / 16);
  const crop = { w: colW, h: Math.round(iframeRect.h), x: Math.round(iframeRect.x + (iframeRect.w - colW) / 2), y: Math.round(iframeRect.y) };

  await comp.evaluate(() => {
    const vids = [...document.querySelectorAll('video')];
    const cv = document.createElement('canvas'); cv.width = 16; cv.height = 16;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const luma = (v) => { try { cx.drawImage(v, 0, 0, 16, 16); const d = cx.getImageData(0, 0, 16, 16).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; return +(s / 256).toFixed(1); } catch { return -1; } };
    window.__probe = { samples: [] };
    const tick = () => {
      const tl = window.__timelines && Object.values(window.__timelines)[0];
      const t = tl && typeof tl.time === 'function' ? +tl.time().toFixed(4) : null;
      const row = { d: Date.now(), t, v: [] };
      for (const v of vids) {
        const cs = getComputedStyle(v);
        const vis = cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
        const ent = { id: v.id, vis, rs: v.readyState, sk: v.seeking, ct: +v.currentTime.toFixed(3) };
        if (vis) ent.L = luma(v);
        row.v.push(ent);
      }
      window.__probe.samples.push(row);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const cdp = await ctx.newCDPSession(page);
  const meta = [];
  let n = 0;
  cdp.on('Page.screencastFrame', async (ev) => {
    const idx = n++;
    writeFileSync(join(framesDir, `f-${String(idx).padStart(5, '0')}.jpg`), Buffer.from(ev.data, 'base64'));
    meta.push({ idx, ts: ev.metadata.timestamp });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }); } catch {}
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });

  const passes = [];
  const runPass = async (label) => {
    const from = Date.now();
    await page.evaluate(() => document.querySelector('hyperframes-player').play());
    await page.waitForTimeout(runFor * 1000);
    await page.evaluate(() => document.querySelector('hyperframes-player').pause());
    passes.push({ label, from, to: Date.now() });
  };
  const log = (m) => console.error(`[player-probe] ${m}`);
  log(`composition ready — duration ${duration}s, running ${runFor}s per pass`);
  await runPass('play');
  log('pass 1 done');
  if (replay) {
    await page.evaluate(() => document.querySelector('hyperframes-player').seek(0));
    await page.waitForTimeout(600);
    await runPass('replay');
    log('replay pass done');
  }
  await cdp.send('Page.stopScreencast');
  await page.waitForTimeout(300);
  const samples = await comp.evaluate(() => window.__probe.samples);
  await browser.close();
  log(`browser closed — ${meta.length} screencast frames, ${samples.length} samples; analysing`);

  // screencast luma on the composition column
  const st = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-f', 'image2', '-pattern_type', 'glob', '-i', join(framesDir, 'f-*.jpg'), '-vf', `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${join(out, 'yavg.txt')}`, '-an', '-f', 'null', '-'], { encoding: 'utf8' });
  if (st.status !== 0) console.error(st.stderr.slice(-600));
  const y = [...readFileSync(join(out, 'yavg.txt'), 'utf8').matchAll(/YAVG=([\d.]+)/g)].map((m) => +m[1]);
  const tSamples = samples.filter((s) => s.t != null);
  const tlAt = (epochMs) => { let best = null; for (const s of tSamples) if (!best || Math.abs(s.d - epochMs) < Math.abs(best.d - epochMs)) best = s; return best ? best.t : null; };
  const frames = meta.map((m, i) => ({ idx: m.idx, epoch: m.ts * 1000, y: y[i], tl: tlAt(m.ts * 1000) }));
  for (let i = 1; i < frames.length - 1; i++) { const a = frames[i - 1].y, b = frames[i].y, c = frames[i + 1].y; const nb = (a + c) / 2; frames[i].dip = b != null && nb - b > 20 && b < 0.6 * nb; }
  writeFileSync(join(out, 'samples.json'), JSON.stringify({ crop, passes, samples, frames: frames.map(({ idx, y, tl, dip }) => ({ idx, y, tl, dip })) }));

  const report = { clipId, port, duration, headed, switches: switches.length, passes: [] };
  let failed = 0;
  for (const pass of passes) {
    const ps = samples.filter((s) => s.d >= pass.from && s.d <= pass.to);
    const pf = frames.filter((f) => f.epoch >= pass.from && f.epoch <= pass.to);
    const judged = switches.map((sw) => judgeSwitch(sw, ps, pf));
    const bad = judged.filter((j) => !j.ok);
    failed += bad.length;
    report.passes.push({ label: pass.label, samples: ps.length, rAF_hz: +(ps.length / runFor).toFixed(1), screencast_frames: pf.length, flagged: bad.length, switches: judged });
    console.log(`\n== ${clipId} pass "${pass.label}": ${judged.length} switches, ${bad.length} flagged (rAF ${(ps.length / runFor).toFixed(0)} Hz, ${pf.length} screencast frames)`);
    for (const j of judged) {
      const fv = j.first_visible;
      console.log(`${j.ok ? 'ok' : '!!'} f${j.f0} t=${j.t}s ${j.layout} ${j.incoming}: reveal ${fv ? `rs${fv.readyState}${fv.seeking ? ' SEEKING' : ''} ct=${fv.currentTime} L=${fv.luma}` : 'NEVER VISIBLE'} · none-visible=${j.none_visible_samples.length} · dips=${j.screencast_dips.length}`);
    }
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — report ${join(out, 'report.json')}`);
  process.exit(failed === 0 ? 0 : 1);
};

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });

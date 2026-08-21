// Embed spike: can the screen embed <hyperframes-player> instead of
// popping player tabs? Writes <rundir>/embed-spike.html with two variants, serve it
// via the screen server (/run/embed-spike.html) with a c1 player on 3003 running.
//
// MEASURED (hyperframes@0.8.4):
//   A  src=http://localhost:3003/composition/index.html  → FULLY WORKS cross-origin:
//      the play server injects the HF runtime into the composition page, and the
//      component bridges to it — media seeks (data-media-start honored), captions,
//      controls, duration all correct.
//   C  src=/run/compose/c1/index.html (raw file, same-origin) → timeline runs but
//      MEDIA STAYS AT FILE t=0 (no HF runtime = nobody manages media seek/sync).
//      Raw-file embedding is NOT viable.
// Conclusion: the embed surface is the play server (component src or full-page
// iframe). v1 decision stays "preview = own tab"; these facts are for the v2 screen.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (!process.argv[2]) {
  console.error('usage: node scripts/embed-spike.mjs <rundir>');
  process.exit(2);
}
const rundir = resolve(process.argv[2]);
writeFileSync(join(rundir, 'embed-spike.html'), `<!doctype html>
<html>
<head><meta charset="utf-8"><title>embed spike</title>
<style>
body { background:#111; color:#eee; font-family:monospace; display:flex; gap:20px; padding:20px; }
figure { margin:0; } figcaption { padding:6px 0; font-size:12px; }
hyperframes-player { width:270px; height:480px; display:block; }
</style>
<script src="http://localhost:3003/player.js"></script>
</head>
<body>
<figure>
  <figcaption>A: cross-origin src (3003)</figcaption>
  <hyperframes-player id="a" src="http://localhost:3003/composition/index.html" controls muted></hyperframes-player>
</figure>
<figure>
  <figcaption>C: same-origin src (/run/compose/c1)</figcaption>
  <hyperframes-player id="c" src="/run/compose/c1/index.html" controls muted></hyperframes-player>
</figure>
</body>
</html>
`);
console.log(`spike page → ${join(rundir, 'embed-spike.html')}
open http://127.0.0.1:4816/run/embed-spike.html (screen server + player 3003 must be up),
press play on both; A must advance real footage, C is expected to stay on file t=0.`);

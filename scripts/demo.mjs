// demo.mjs — the keyless demo in one command: serves the Screen, replays the
// synthetic "Prototype Hour" run into it from fixtures/, and opens the browser.
// No key, no account, no spend. Ctrl-C stops the server.
// Usage: node scripts/demo.mjs [--dir <folder>] [--port 4816] [--speed 8] [--no-open]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from './server.mjs';
import { replayRun } from './replay.mjs';

const SCREEN_DIR = fileURLToPath(new URL('../screen', import.meta.url));

const openBrowser = (url) => {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref(); } catch { /* best effort */ }
};

// Starts the server first (the replay writes into the folder the server watches),
// then kicks off the replay. Returns the url, the replay promise and a closer.
export async function runDemo({ dir, port = 4816, speed = 8, open = true } = {}) {
  const runDir = join(dir ?? mkdtempSync(join(tmpdir(), 'cutting-room-demo-')), 'cutting-room');
  let handle = null;
  for (let p = port; p < port + 10 && !handle; p++) {
    try { handle = await startServer({ dir: runDir, screenDir: SCREEN_DIR, port: p }); }
    catch (err) { if (err.code !== 'EADDRINUSE') throw err; }
  }
  if (!handle) throw new Error(`ports ${port}–${port + 9} are all busy`);
  if (open) openBrowser(handle.url);
  const replay = replayRun({ dir: runDir, speed, finale: true, source: null });
  return { url: handle.url, dir: runDir, replay, close: () => handle.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1]; };
  const demo = await runDemo({
    dir: flag('dir'),
    port: Number(flag('port') ?? 4816),
    speed: Number(flag('speed') ?? 8),
    open: !argv.includes('--no-open'),
  });
  process.on('SIGINT', async () => { await demo.close(); process.exit(0); });
  console.error(`the screen is at ${demo.url} — replaying "The Prototype Hour" into ${demo.dir}`);
  await demo.replay;
  console.error('replay finished — the Screen stays up, Ctrl-C to stop');
}

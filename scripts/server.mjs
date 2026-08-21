// server.mjs — the Screen's entire API: serve the static page,
// push state.json / style.json / catalog.json changes over SSE, accept catalog
// choices → style.json. No agent long-poll, no journal. Zero-dep node, loopback only.
import { createServer } from 'node:http';
import { existsSync, readFileSync, renameSync, statSync, watch, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PALETTE_FAMILIES } from '../screen/lib.mjs';

// style@2: palette gains treatments[] + titles[]. Reading a style@1
// file stays fine — missing family arrays read as empty; writes emit @2.
export const STYLE_SCHEMA = 'cutting-room/style@2';

export const defaultStyle = () => ({
  schema: STYLE_SCHEMA,
  aspect: '9:16',
  caption_block: null,
  palette: Object.fromEntries(PALETTE_FAMILIES.map((f) => [f, []])),
  locked: false,
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

// The run files the SSE stream mirrors, file name → event name.
const RUN_EVENTS = { 'state.json': 'state', 'style.json': 'style', 'catalog.json': 'catalog' };

const writeJsonAtomic = (path, obj) => {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path);
};

// Resolve a URL path inside a root; null when it escapes (traversal guard).
const safeJoin = (root, urlPath) => {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const rootResolved = resolve(root);
  const p = normalize(join(rootResolved, decoded));
  return p === rootResolved || p.startsWith(rootResolved + sep) ? p : null;
};

const readBody = (req, cap = 1024 * 1024) => new Promise((resolvePromise, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > cap) {
      reject(new Error('body too large'));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

export async function startServer({ dir, screenDir, port = 4816, host = '127.0.0.1' } = {}) {
  const clients = new Set();
  const lastPushed = {};

  const compactRunFile = (file) => {
    const path = join(dir, file);
    if (!existsSync(path)) return null;
    try {
      return JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))); // single line for SSE data:
    } catch {
      return null; // torn or invalid — the next change will push
    }
  };

  const sendEvent = (res, event, data) => res.write(`event: ${event}\ndata: ${data}\n\n`);

  const pushFile = (file) => {
    const event = RUN_EVENTS[file];
    if (!event) return;
    const data = compactRunFile(file);
    if (data === null || lastPushed[file] === data) return;
    lastPushed[file] = data;
    for (const c of clients) sendEvent(c, event, data);
  };

  let dirWatcher = null;
  try {
    dirWatcher = watch(dir, (_evt, fname) => {
      if (fname && RUN_EVENTS[fname]) setTimeout(() => pushFile(fname), 30);
    });
  } catch { /* fs.watch unavailable — the poll below covers it */ }
  const poll = setInterval(() => Object.keys(RUN_EVENTS).forEach(pushFile), 750);
  const heartbeat = setInterval(() => { for (const c of clients) c.write(':hb\n\n'); }, 15000);

  const serveFile = (res, root, rel) => {
    const path = safeJoin(root, rel);
    if (!path || !existsSync(path) || !statSync(path).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(readFileSync(path));
  };

  const server = createServer(async (req, res) => {
    const path = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`).pathname;

    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(':connected\n\n');
      clients.add(res);
      for (const file of Object.keys(RUN_EVENTS)) {
        const data = compactRunFile(file);
        if (data !== null) sendEvent(res, RUN_EVENTS[file], data);
      }
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'POST' && path === '/choices') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not an object');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid JSON body"}');
        return;
      }
      const stylePath = join(dir, 'style.json');
      let current = defaultStyle();
      try {
        current = { ...current, ...JSON.parse(readFileSync(stylePath, 'utf8')) };
      } catch { /* no style yet */ }
      if (current.locked) {
        res.writeHead(409, { 'content-type': 'application/json' })
          .end('{"error":"kit is locked into your clips — ask in chat to change"}');
        return;
      }
      const style = {
        schema: STYLE_SCHEMA,
        aspect: typeof body.aspect === 'string' ? body.aspect : current.aspect,
        caption_block: 'caption_block' in body ? body.caption_block : current.caption_block,
        // every style@2 palette family; a style@1 file on disk just lacks the
        // new arrays, so current.palette?.[f] falls through to []
        palette: Object.fromEntries(PALETTE_FAMILIES.map((f) => [
          f, Array.isArray(body.palette?.[f]) ? body.palette[f] : current.palette?.[f] ?? [],
        ])),
        locked: current.locked,
      };
      writeJsonAtomic(stylePath, style);
      pushFile('style.json');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }

    if (req.method === 'GET' && path.startsWith('/run/')) {
      serveFile(res, dir, path.slice('/run/'.length));
      return;
    }

    if (req.method === 'GET') {
      serveFile(res, screenDir, path === '/' ? 'index.html' : path.slice(1));
      return;
    }

    res.writeHead(405, { 'content-type': 'text/plain' }).end('method not allowed');
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  const actualPort = server.address().port;

  return {
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: async () => {
      clearInterval(poll);
      clearInterval(heartbeat);
      dirWatcher?.close();
      for (const c of clients) c.end();
      clients.clear();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const dir = flag('dir');
  if (!dir) {
    console.error('usage: server.mjs --dir <workdir>/cutting-room [--screen <repo>/screen] [--port 4816]');
    process.exit(2);
  }
  const screenDir = flag('screen') ?? new URL('../screen', import.meta.url).pathname;
  const requested = Number(flag('port') ?? 4816);
  let handle = null;
  for (let p = requested; p < requested + 10 && !handle; p++) {
    try {
      handle = await startServer({ dir, screenDir, port: p });
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  if (!handle) {
    console.error(`ports ${requested}–${requested + 9} are all busy`);
    process.exit(1);
  }
  console.log(JSON.stringify({ url: handle.url, dir, screen: screenDir }));
  console.error(`the screen is at ${handle.url} — serving ${screenDir}, run files from ${dir}`);
}

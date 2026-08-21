import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../server.mjs';

const setup = async (opts = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'cr-srv-'));
  const dir = join(root, 'run');
  const screenDir = join(root, 'screen');
  mkdirSync(dir, { recursive: true });
  mkdirSync(screenDir, { recursive: true });
  writeFileSync(join(screenDir, 'index.html'), '<title>the screen</title>');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ schema: 'cutting-room/state@1', n: 1 }));
  const server = await startServer({ dir, screenDir, port: 0, ...opts });
  return { dir, screenDir, server };
};

test('serves the screen statics at /', async () => {
  const { server } = await setup();
  try {
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /the screen/);
  } finally { await server.close(); }
});

test('serves run files at /run/ with no-store', async () => {
  const { server } = await setup();
  try {
    const res = await fetch(`${server.url}/run/state.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await res.json()).n, 1);
  } finally { await server.close(); }
});

test('refuses path traversal and unknown paths', async () => {
  const { server } = await setup();
  try {
    assert.equal((await fetch(`${server.url}/run/%2e%2e/screen/index.html`)).status, 404);
    assert.equal((await fetch(`${server.url}/nope.txt`)).status, 404);
  } finally { await server.close(); }
});

test('POST /choices writes style@2, last write wins', async () => {
  const { dir, server } = await setup();
  try {
    const post = (body) => fetch(`${server.url}/choices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const r1 = await post({ caption_block: 'caption-pill-karaoke', palette: { transitions: ['fade-through'], blocks: [] } });
    assert.equal(r1.status, 200);
    const r2 = await post({ caption_block: 'caption-weight-shift', palette: { transitions: ['fade-through'], blocks: ['beat-accent'] } });
    assert.equal(r2.status, 200);
    const style = JSON.parse(readFileSync(join(dir, 'style.json'), 'utf8'));
    assert.equal(style.schema, 'cutting-room/style@2');
    assert.deepEqual(style.palette.treatments, []);
    assert.deepEqual(style.palette.titles, []);
    assert.equal(style.caption_block, 'caption-weight-shift');
    assert.deepEqual(style.palette.blocks, ['beat-accent']);
    assert.equal(style.locked, false);
  } finally { await server.close(); }
});

test('POST /choices is refused once the kit is locked', async () => {
  const { dir, server } = await setup();
  try {
    writeFileSync(join(dir, 'style.json'), JSON.stringify({
      schema: 'cutting-room/style@1', aspect: '9:16', caption_block: 'caption-texture',
      palette: { transitions: [], blocks: [] }, locked: true,
    }));
    const res = await fetch(`${server.url}/choices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caption_block: 'caption-glitch-rgb' }),
    });
    assert.equal(res.status, 409);
    const style = JSON.parse(readFileSync(join(dir, 'style.json'), 'utf8'));
    assert.equal(style.caption_block, 'caption-texture');
  } finally { await server.close(); }
});

test('rejects malformed choices JSON', async () => {
  const { server } = await setup();
  try {
    const res = await fetch(`${server.url}/choices`, { method: 'POST', body: '{nope' });
    assert.equal(res.status, 400);
  } finally { await server.close(); }
});

test('SSE: initial state event, then pushes on state.json change and on POST /choices', async () => {
  const { dir, server } = await setup();
  try {
    const res = await fetch(`${server.url}/events`);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const seen = [];
    const readUntil = async (predicate, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate() && Date.now() < deadline) {
        const race = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => null)]);
        if (!race || race.done) break;
        buffer += decoder.decode(race.value, { stream: true });
        for (const frame of buffer.split('\n\n').slice(0, -1)) {
          const ev = frame.match(/^event: (.+)$/m)?.[1];
          if (ev) seen.push(ev);
        }
        buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
      }
    };

    await readUntil(() => seen.includes('state'));
    assert.ok(seen.includes('state'), `initial state event (saw: ${seen.join(',')})`);

    writeFileSync(join(dir, 'state.json'), JSON.stringify({ schema: 'cutting-room/state@1', n: 2 }));
    await readUntil(() => seen.filter((e) => e === 'state').length >= 2);
    assert.ok(seen.filter((e) => e === 'state').length >= 2, `state push after file change (saw: ${seen.join(',')})`);

    await fetch(`${server.url}/choices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caption_block: 'caption-highlight' }),
    });
    await readUntil(() => seen.includes('style'));
    assert.ok(seen.includes('style'), `style push after POST (saw: ${seen.join(',')})`);
    await reader.cancel();
  } finally { await server.close(); }
});

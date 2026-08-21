import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNode, preflight, MIN_NODE_MAJOR } from '../preflight.mjs';

// A scripted fake exec: answers from a table, records every call.
const fakeExec = (table) => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(' ');
    for (const [prefix, res] of table) if (key.startsWith(prefix)) return res;
    return { ok: false, out: '' };
  };
  exec.calls = calls;
  return exec;
};

test('checkNode: enforces the minimum major', () => {
  assert.equal(checkNode(`${MIN_NODE_MAJOR}.1.0`).ok, true);
  assert.equal(checkNode(`${MIN_NODE_MAJOR - 1}.9.9`).ok, false);
});

test('preflight: everything present and authed → ready', () => {
  const exec = fakeExec([
    ['ffmpeg -version', { ok: true, out: 'ffmpeg version 7' }],
    ['ffprobe -version', { ok: true, out: 'ffprobe version 7' }],
    ['nanoclip --version', { ok: true, out: '{"name":"nanoclip","version":"0.1.5"}' }],
    ['nanoclip auth status', { ok: true, out: '{"profile":"prod"}' }],
    ['npx --yes hyperframes@', { ok: true, out: '0.8.4' }],
  ]);
  const r = preflight({ exec });
  assert.equal(r.ready, true);
  assert.equal(r.nanoclip.installed_now, false);
  assert.equal(r.nanoclip.version, '0.1.5');
  assert.match(r.hyperframes.pinned, /^hyperframes@\d/);
});

test('preflight: missing nanoclip is installed from npm, missing auth blocks ready', () => {
  let installed = false;
  const exec = (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    if (key === 'nanoclip --version') return { ok: installed, out: installed ? 'nanoclip 0.1.5' : '' };
    if (key === 'npm install -g nanoclip') { installed = true; return { ok: true, out: 'added 1 package' }; }
    if (key === 'nanoclip auth status') return { ok: false, out: 'no profile' };
    if (key.startsWith('ffmpeg') || key.startsWith('ffprobe') || key.startsWith('npx')) return { ok: true, out: 'x' };
    return { ok: false, out: '' };
  };
  const r = preflight({ exec });
  assert.equal(r.nanoclip.ok, true);
  assert.equal(r.nanoclip.installed_now, true);
  assert.equal(r.nanoclip.authed, false);
  assert.equal(r.ready, false, 'unauthenticated CLI is not ready');
});

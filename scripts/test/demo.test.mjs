import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDemo } from '../demo.mjs';

test('runDemo: one call serves the Screen and replays the synthetic run into it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-demo-'));
  const demo = await runDemo({ dir, speed: 400, open: false, port: 4910 });
  try {
    assert.match(demo.url, /^http:\/\/127\.0\.0\.1:\d+\/?$/);
    const res = await fetch(demo.url);
    assert.equal(res.status, 200);
    await demo.replay;
    const state = JSON.parse(readFileSync(join(dir, 'cutting-room', 'state.json'), 'utf8'));
    assert.equal(state.stages.clips.status, 'completed');
    assert.equal(state.artifacts.clips.length, 3);
    assert.ok(existsSync(join(dir, 'cutting-room', 'data', 'transcript.json')));
  } finally {
    await demo.close();
  }
});

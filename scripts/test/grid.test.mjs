import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exact2 } from '../grid.mjs';

test('exact2: strips float noise off 2dp-true values', () => {
  assert.equal(exact2(89.46 - 52.56), 36.9);
  assert.equal(exact2(0.1 + 0.2), 0.3);
  assert.equal(exact2(36.9), 36.9);
});

test('exact2: a 1/30-grid value passes through as the exact double', () => {
  const v = 47.56 + 1256 / 30; // 89.42666…
  assert.equal(exact2(v), v);
  assert.equal(exact2(v - 52.56), v - 52.56);
  assert.equal(exact2(1.5), 1.5); // frame 45: a grid value that IS 2dp-true
});

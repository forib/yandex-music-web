// runPool / uniqueName / outputFileExistsAny. No network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './helpers.mjs';

const { runPool, uniqueName, outputFileExistsAny } = loadFrontend();

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('runPool', () => {
  it('processes all items', async () => {
    const seen = [];
    await runPool(3, [1, 2, 3, 4, 5], async (x) => { await tick(); seen.push(x); });
    assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5]);
  });
  it('caps concurrency', async () => {
    let active = 0, max = 0;
    await runPool(2, [1, 2, 3, 4], async () => { active++; max = Math.max(max, active); await tick(); active--; });
    assert.equal(max, 2);
  });
  it('stops early on shouldStop', async () => {
    const seen = [];
    let n = 0;
    await runPool(1, [1, 2, 3, 4], async (x) => { seen.push(x); n++; }, () => n >= 2);
    assert.deepEqual(seen, [1, 2]);
  });
  it('empty list resolves', async () => {
    await runPool(3, [], async () => { throw new Error('must not run'); });
  });
});

describe('uniqueName', () => {
  const dirWith = (...existing) => ({
    // biome-ignore lint: mock File System Access API
    async getFileHandle(name, opts) {
      if (existing.includes(name) && !opts?.create) return {};
      if (opts?.create) return {};
      throw new DOMException('not found', 'NotFoundError');
    },
  });
  it('keeps free names', async () => {
    assert.equal(await uniqueName(dirWith(), 'a.m4a'), 'a.m4a');
  });
  it('appends (2), (3)', async () => {
    const dir = dirWith('a.m4a', 'a (2).m4a');
    assert.equal(await uniqueName(dir, 'a.m4a'), 'a (3).m4a');
  });
});

describe('outputFileExistsAny', () => {
  it('false without picked folder', async () => {
    const fake = { id: '1', title: 'T', artists: [{ name: 'A' }], albums: [] };
    assert.equal(await outputFileExistsAny(fake, '{track} - {title}'), false);
  });
});

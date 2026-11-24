import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server.js';

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const limit = 10 * 1024 * 1024;

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-attachments-'));
  const { url, server } = await start({ dbPath: join(dir, 'test.db'), islandLauncher: null });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const origin = new URL(url).origin;
  function post(body, type = 'image/png', headers = {}) {
    return fetch(url + 'api/attachments', {
      method: 'POST', duplex: 'half', headers: { origin, 'content-type': type, ...headers }, body,
    });
  }
  return { url, dir, origin, post };
}

test('concurrent uploads deduplicate across requests and return the original bytes with safe headers', async t => {
  const { post, dir, origin } = await fixture(t);
  const id = createHash('sha256').update(png).digest('hex') + '.png';
  const expected = { id, url: '/api/attachments/' + id, bytes: png.length, type: 'image/png' };
  const responses = await Promise.all([post(png), post(png), post(png)]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
  }
  const folder = join(dir, 'attachments', id.slice(0, 2));
  assert.deepEqual(await readdir(folder), [id]);
  assert.deepEqual(await readFile(join(folder, id)), png);

  const response = await fetch(origin + expected.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), 'sandbox');
  assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});

test('only the four allowed signatures are accepted and the same-origin guard runs first', async t => {
  const { post } = await fixture(t);
  for (const [type, bytes, ext] of [
    ['image/jpeg', Buffer.from('ffd8ff', 'hex'), 'jpg'],
    ['image/webp', Buffer.from('RIFF\0\0\0\0WEBP'), 'webp'],
    ['image/gif', Buffer.from('GIF89a'), 'gif'],
  ]) {
    const response = await post(bytes, type);
    assert.equal(response.status, 200);
    assert.ok((await response.json()).id.endsWith('.' + ext));
  }
  assert.equal((await post(png, 'image/jpeg')).status, 415);
  assert.equal((await post('<svg/>', 'image/svg+xml')).status, 415);
  assert.equal((await post(png, 'image/png', { origin: 'https://example.com' })).status, 403);
});

test('10 MiB is allowed and oversized bodies are rejected with or without a content length', async t => {
  const { post } = await fixture(t);
  const bytes = Buffer.alloc(limit);
  png.copy(bytes);
  assert.equal((await post(bytes)).status, 200);
  assert.equal((await post(Buffer.alloc(limit + 1))).status, 413);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.enqueue(png);
      controller.close();
    },
  });
  assert.equal((await post(body)).status, 413);
});

test('invalid paths are rejected before URL normalization and missing valid ids return 404', async t => {
  const { url } = await fixture(t);
  const { hostname, port } = new URL(url);
  const get = suffix => new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: '/api/attachments/' + suffix }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  for (const suffix of ['', '../health', '%2e%2e/health', 'ABC.png', 'a'.repeat(64) + '.svg']) {
    assert.equal(await get(suffix), 400);
  }
  assert.equal(await get('a'.repeat(64) + '.png'), 404);
});

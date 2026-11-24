import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startLive } from '../public/js/live.js';
import { start } from '../server.js';

const entry = fileURLToPath(new URL('../server.js', import.meta.url));

async function startProcess(t, configRoot) {
  const env = { ...process.env, PORT: '0', WORKBENCH_CONFIG_ROOT: configRoot };
  delete env.WORKBENCH_DB;
  const child = spawn(process.execPath, [entry], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  let errors = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  t.after(async () => { child.kill(); await exited; });
  const lines = createInterface({ input: child.stdout });
  try {
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(5000) });
    const url = line.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
    assert.ok(url, line);
    return url;
  } catch (error) {
    throw new Error(`子进程未启动：${errors}`, { cause: error });
  } finally { lines.close(); }
}

async function stream(t, url) {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(url + 'api/events', { signal: abort.signal });
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  return {
    close: () => abort.abort(),
    async next() {
      const timer = setTimeout(() => abort.abort(), 2000);
      try {
        while (!buffered.includes('\n\n')) {
          const { done, value } = await reader.read();
          assert.equal(done, false, 'SSE ended before delivering the expected event');
          buffered += value;
        }
        const end = buffered.indexOf('\n\n');
        const message = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const [, name, json] = /^event: (\w+)\ndata: (.+)$/.exec(message) ?? [];
        assert.ok(name, message);
        return { name, ...JSON.parse(json) };
      } finally { clearTimeout(timer); }
    },
  };
}

test('two independent servers sync writes via SQLite and SSE within two seconds', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-live-'));
  const configRoot = join(dir, 'config');
  const dataDir = join(dir, 'shared');
  await mkdir(configRoot);
  await writeFile(join(configRoot, 'location.json'), JSON.stringify({ version: 1, dataDir }));

  // 子进程先关闭再回收目录，确保 Windows 上不会删除正在使用的 SQLite / WAL。
  try {
    await t.test('external and self events, then revision polling without a subscriber', async childTest => {
      const a = await startProcess(childTest, configRoot);
      const b = await startProcess(childTest, configRoot);
      assert.equal((await (await fetch(a + 'api/storage')).json()).dataDir, dataDir);
      assert.equal((await (await fetch(b + 'api/storage')).json()).shared, true);
      const local = await stream(childTest, a);
      const peer = await stream(childTest, b);
      const initialA = await local.next();
      const initialB = await peer.next();
      assert.equal(initialA.name, 'hello');
      assert.equal(initialB.name, 'hello');

      const write = (id) => fetch(a + 'api/command', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: { type: 'createTask', id, title: id } }),
      });
      const startTime = performance.now();
      const waiting = Promise.all([local.next(), peer.next()]);
      const response = await write('shared-task');
      const [self, external] = await waiting;
      assert.ok(performance.now() - startTime < 2000);
      assert.equal(response.status, 200);
      assert.deepEqual(self, { name: 'change', rev: initialA.rev + 1, origin: 'self' });
      assert.deepEqual(external, { name: 'change', rev: initialB.rev + 1, origin: 'external' });
      const { view } = await (await fetch(b + 'api/view')).json();
      assert.ok(view.pending.some(task => task.id === 'shared-task'));

      const health = async () => (await (await fetch(b + 'api/health')).json()).dataRev;
      assert.equal(await health(), external.rev);
      peer.close();
      assert.equal((await write('health-poll')).status, 200);
      assert.equal(await health(), external.rev + 1);
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('server.close finishes within two seconds with an active SSE subscriber', { timeout: 5000 }, async t => {
  const { server, url } = await start({ dbPath: ':memory:', islandLauncher: null });
  t.after(() => {
    if (server.listening) server.close();
    server.closeAllConnections();
  });
  const response = await fetch(url + 'api/events');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  assert.match((await reader.read()).value, /^event: hello\n/);

  const started = performance.now();
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('server.close did not finish within two seconds')), 2000);
    server.close(error => {
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    });
  });
  t.diagnostic(`server.close callback after ${Math.round(performance.now() - started)} ms`);
  assert.deepEqual(await reader.read(), { done: true, value: undefined });
});

test('browser reuses EventSource reconnect and falls back after three consecutive errors', async t => {
  class FakeEventSource extends EventTarget {
    constructor(url) { super(); this.url = url; FakeEventSource.instance = this; }
    close() { this.closed = true; }
    emit(type, body) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(body) })); }
  }
  const original = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource;
  t.after(() => {
    if (original === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = original;
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, '/api/health');
    return Response.json({ dataRev: 10 });
  });
  const events = [];
  t.after(startLive({ onChange: event => events.push(event) }));
  const source = FakeEventSource.instance;
  assert.equal(source.url, '/api/events');
  source.emit('hello', { rev: 0 });
  source.emit('change', { rev: 1, origin: 'self' });
  source.emit('error');
  source.emit('hello', { rev: 1 });
  source.emit('error');
  source.emit('error');
  assert.equal(Boolean(source.closed), false);
  source.emit('error');
  assert.equal(source.closed, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [
    { rev: 1, origin: 'self' }, { rev: 1, origin: 'external' }, { rev: 10, origin: 'external' },
  ]);
});

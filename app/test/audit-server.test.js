import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { start } from '../server.js';
import { openDatabase } from '../lib/db.js';
import { createObsidian } from '../lib/obsidian.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-service-audit-'));
  const servers = [];
  t.after(async () => {
    for (const server of servers) {
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, async run(name = 'app') {
    const app = await start({ root: join(dir, name), islandLauncher: null,
      storageOptions: { configRoot: join(dir, name + '-config') } });
    servers.push(app.server);
    return app;
  } };
}

function post(app, path, body) {
  return fetch(new URL(path, app.url), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
}

async function rejected(response, status, reason) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.reason, reason);
  return body.message;
}

const task = id => ({ type: 'createTask', id, title: id });

test('M1 copy drains an admitted save and fences the old service until restart', async t => {
  const original = process.env.WORKBENCH_DB;
  delete process.env.WORKBENCH_DB;
  t.after(() => { if (original !== undefined) process.env.WORKBENCH_DB = original; });
  const f = fixture(t);
  const app = await f.run();
  const failedMove = await post(app, 'api/storage/relocate', { mode: 'copy', dataDir: 'relative' });
  await rejected(failedMove, 400, 'invalid');
  app.workbench.now = () => 1000;
  app.workbench.startFocus({ id: 'timer', plannedSeconds: 60 });
  const received = new Promise(resolve => app.server.once('request', req => req.once('data', resolve)));
  const save = request(new URL('api/command', app.url), { method: 'POST' });
  const saved = new Promise((resolve, reject) => {
    save.on('response', res => { res.resume(); resolve(res.statusCode); });
    save.on('error', reject);
  });
  save.write(JSON.stringify(task('before')).slice(0, -1));
  await received;
  const moveRead = new Promise(resolve => app.server.once('request', req => req.once('end', resolve)));
  const moving = post(app, 'api/storage/relocate', { mode: 'copy', dataDir: join(f.dir, 'moved') });
  let late;
  try {
    await moveRead;
    await nextTurn();
    late = await post(app, 'api/command', task('late'));
  } finally {
    save.end('}');
  }
  assert.equal(await saved, 200);
  assert.equal((await moving).status, 200);
  const message = '数据已搬到新位置，请重启工作台后再保存';
  assert.equal(await rejected(late, 409, 'restart-required'), message);
  assert.equal(await rejected(await post(app, 'api/attachments', {}), 409, 'restart-required'), message);
  app.workbench.now = () => 1100;
  assert.equal((await fetch(new URL('api/view', app.url))).status, 200);
  assert.equal(app.workbench.db.prepare("SELECT state FROM focus_sessions WHERE id='timer'").get().state, 'running');
  assert.equal((await post(app, 'api/restart', {})).status, 200);
  const next = await f.run();
  assert.deepEqual(next.workbench.db.prepare('SELECT id FROM tasks').all().map(r => r.id), ['before']);
  assert.equal((await post(next, 'api/command', task('after'))).status, 200);
});

test('M2 exported backup over 512 KiB round-trips intact', async t => {
  const f = fixture(t);
  const app = await f.run();
  const dest = await f.run('restore');
  for (let i = 0; i < 20; i++) {
    const id = 'task' + i;
    app.workbench.createTask(task(id));
    app.workbench.saveTaskNote(id, '笔记'.repeat(5000), 0);
  }
  const raw = await (await fetch(new URL('api/export', app.url))).text();
  assert.ok(Buffer.byteLength(raw) > 512 * 1024);
  const restore = await post(dest, 'api/import', raw);
  assert.equal(restore.status, 200);
  const tables = JSON.parse(raw).tables;
  assert.equal((await restore.json()).inserted, Object.values(tables).flat().length);
  assert.deepEqual((await (await fetch(new URL('api/export', dest.url))).json()).tables, tables);
});

test('M2 oversized import returns readable 413', async t => {
  const app = await fixture(t).run();
  const response = await post(app, 'api/import', ' '.repeat(64 * 1024 * 1024 + 1));
  assert.ok(await rejected(response, 413, 'import-too-large'));
});

test('M3 createTask preserves project association and repository validation', async t => {
  const app = await fixture(t).run();
  app.workbench.createProject({ id: 'p', mainTaskId: 'main', title: 'project', startDay: '2026-11-25' });
  assert.equal((await post(app, 'api/command', { ...task('child'), projectId: 'p' })).status, 200);
  assert.equal(app.workbench.db.prepare("SELECT project_id FROM tasks WHERE id='child'").get().project_id, 'p');
  await rejected(await post(app, 'api/command', { ...task('unattached'), projectId: 'unknown' }), 404, 'missing');
});

test('M4 restarted exporter catches offline edits, retries failure and skips unchanged data', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-export-audit-'));
  const vault = join(dir, 'vault');
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  const wb = openDatabase(join(dir, 'test.db'));
  const open = () => createObsidian({ wb, dataDir: dir, revision: () => 0, pollMs: 10, debounceMs: 30 });
  let service = open();
  t.after(() => { service.close(); wb.close(); rmSync(dir, { recursive: true, force: true }); });
  service.configure({ vaultPath: vault, folder: 'Export', enabled: true, auto: true });
  wb.createTask(task('editor'));
  wb.saveTaskNote('editor', 'first draft', 0);
  service.run();
  service.close();
  wb.saveTaskNote('editor', 'updated draft', 1);
  renameSync(join(vault, '.obsidian'), join(vault, 'offline'));
  service = open();
  async function until(check) {
    const deadline = Date.now() + 2500;
    while (!check() && Date.now() < deadline) await delay(15);
    assert.ok(check());
  }
  await until(() => service.get().status.error);
  renameSync(join(vault, 'offline'), join(vault, '.obsidian'));
  const note = join(vault, 'Export', '任务正文', 'editor-editor.md');
  await until(() => readFileSync(note, 'utf8').includes('updated draft'));
  const exported = service.get().status.lastExportAt;
  service.close();
  service = open();
  await delay(120);
  assert.equal(service.get().status.lastExportAt, exported);
  service.close();
  wb.createTask(task('offline'));
  service = open();
  await until(() => service.get().status.lastExportAt !== exported);
});

test('M5 invalid tz is a client error on all date views', async t => {
  const app = await fixture(t).run();
  for (const path of ['api/view', 'api/month', 'api/insights']) {
    await rejected(await fetch(new URL(path + '?tz=NoSuchZone', app.url)), 400, 'invalid');
    const implicit = await (await fetch(new URL(path, app.url))).json();
    assert.deepEqual(implicit, await (await fetch(new URL(path + '?tz=Asia/Shanghai', app.url))).json());
  }
});

test('M6 autoCheck accepts only JSON booleans', async t => {
  const app = await fixture(t).run();
  const setting = autoCheck => post(app, 'api/update', { action: 'settings', autoCheck });
  assert.equal((await (await setting(false)).json()).update.autoCheck, false);
  for (const value of ['false', 0, null, undefined]) await rejected(await setting(value), 400, 'invalid');
  await assert.rejects(app.updater.setAutoCheck('false'), { code: 'invalid' });
  assert.equal(app.updater.status().autoCheck, false);
  assert.equal((await (await setting(true)).json()).update.autoCheck, true);
});

test('M7 rejects malformed backups atomically and accepts older table sets', async t => {
  const app = await fixture(t).run();
  const backup = { format: 'learning-space-workbench', version: 1 };
  const tasks = [{ id: 'legacy', title: 'legacy' }];
  for (const change of [{ version: 2, tables: {} }, {}, { tables: [] }, { tables: null },
    { tables: { tasks, harvests: {} } }, { tables: { tasks, projects: null } }]) {
    await rejected(await post(app, 'api/import', { ...backup, ...change }), 400, 'invalid');
    assert.equal(app.workbench.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  }
  const rollback = await post(app, 'api/import', { ...backup, tables: { tasks: [...tasks, ...tasks] } });
  assert.ok(rollback.status >= 400);
  const imported = await post(app, 'api/import', { ...backup, tables: { tasks } });
  assert.equal((await imported.json()).inserted, 1);
});

test('M8 a failed listen releases the exporter interval', async t => {
  const f = fixture(t);
  const held = createServer();
  await new Promise(resolve => held.listen(0, '127.0.0.1', resolve));
  const intervals = new Set();
  const set = globalThis.setInterval, clear = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', (...args) => {
    const handle = set(...args);
    intervals.add(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearInterval', handle => { intervals.delete(handle); clear(handle); });
  try {
    await assert.rejects(start({ port: held.address().port, dbPath: join(f.dir, 'failed.db'), islandLauncher: null }),
      { code: 'EADDRINUSE' });
    assert.equal(intervals.size, 0);
  } finally {
    for (const handle of intervals) clear(handle);
    await new Promise(resolve => held.close(resolve));
  }
});

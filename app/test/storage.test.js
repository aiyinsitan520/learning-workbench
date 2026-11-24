import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../lib/db.js';
import { start } from '../server.js';

const originalDb = process.env.WORKBENCH_DB;
before(() => { delete process.env.WORKBENCH_DB; });
after(() => { if (originalDb !== undefined) process.env.WORKBENCH_DB = originalDb; });

async function fixture(t, options = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'workbench-storage-')));
  const root = join(dir, 'app');
  const configRoot = join(dir, 'config');
  const configPath = join(configRoot, 'location.json');
  const apps = [];
  t.after(async () => {
    for (const { server } of apps) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  });
  const run = async (overrides = {}) => {
    const { storageOptions, ...other } = overrides;
    const app = await start({ root, islandLauncher: null, ...options, ...other,
      storageOptions: { configRoot, ...options.storageOptions, ...storageOptions } });
    apps.push(app);
    return app;
  };
  return { dir, root, configPath, run };
}

function post(app, path, body = {}, headers = {}) {
  return fetch(app.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body) });
}

async function info(app) {
  const response = await fetch(app.url + 'api/storage');
  assert.equal(response.status, 200);
  return response.json();
}

function verifySnapshot(dbPath, id, expectedVersion) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, expectedVersion);
    assert.equal(db.prepare('SELECT title FROM tasks WHERE id = ?').get(id).title, '原始任务');
  } finally { db.close(); }
}

const userVersion = wb => wb.db.prepare('PRAGMA user_version').get().user_version;

test('default web layout and legacy desktop userData, then shared copy with attachments', async t => {
  const f = await fixture(t);
  const app = await f.run();
  const data = await info(app);
  const desktopDir = join(f.dir, 'User Data');
  const desktop = await f.run({ storageOptions: { edition: 'desktop', desktopDir } });
  const local = await info(desktop);
  assert.equal(data.dataDir, join(f.root, 'data'));
  assert.equal(data.configPath, f.configPath);
  assert.equal(data.source, 'default');
  assert.equal(data.shared, false);
  assert.equal(data.defaults.desktop, null);
  assert.equal(local.dbPath, join(desktopDir, 'workbench.db'));
  assert.equal(local.edition, 'desktop');
  assert.equal(local.remote, false);
  assert.match(await readFile(join(data.dataDir, '关于这个文件夹.txt'), 'utf8'), /attachments.*backups/);

  app.workbench.createTask({ id: 'original', title: '原始任务' });
  const attachmentDir = join(data.dataDir, 'attachments', '嵌套');
  await mkdir(attachmentDir);
  await writeFile(join(attachmentDir, '图.txt'), 'test');
  assert.equal((await info(app)).attachmentCount, 1);
  assert.equal((await info(app)).attachmentsBytes, 4);

  const dataDir = join(f.dir, "新位置 ' copy");
  const response = await post(app, 'api/storage/relocate', { dataDir, mode: 'copy' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { restartRequired: true, dataDir });
  assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), { version: 1, dataDir });
  assert.equal((await info(app)).dataDir, data.dataDir);
  verifySnapshot(join(dataDir, 'workbench.db'), 'original', userVersion(app.workbench));
  verifySnapshot(data.dbPath, 'original', userVersion(app.workbench));
  assert.equal(await readFile(join(dataDir, 'attachments', '嵌套', '图.txt'), 'utf8'), 'test');
  assert.equal(await readFile(join(attachmentDir, '图.txt'), 'utf8'), 'test');
  for (const storageOptions of [{}, { edition: 'desktop', desktopDir }]) {
    const reopened = await info(await f.run({ storageOptions }));
    assert.equal(reopened.dataDir, dataDir);
    assert.equal(reopened.source, 'config');
    assert.equal(reopened.shared, true);
    assert.ok(reopened.dbBytes > 0);
  }
});

test('use checks existing database read-only and returns script restart instructions', async t => {
  const f = await fixture(t);
  const app = await f.run();
  const dataDir = join(f.dir, 'existing');
  const path = join(dataDir, 'workbench.db');
  const db = openDatabase(path);
  db.createTask({ id: 'existing-task', title: '原始任务' });
  db.close();
  const before = await readFile(path);
  const response = await post(app, 'api/storage/relocate', { dataDir, mode: 'use' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { restartRequired: true, dataDir });
  assert.deepEqual(await readFile(path), before);
  assert.equal((await stat(join(f.root, 'data', 'workbench.db'))).isFile(), true);
  assert.deepEqual(await (await post(app, 'api/restart')).json(), { restartRequired: true, how: 'script' });
  verifySnapshot(path, 'existing-task', userVersion(app.workbench));
});

test('relocate rejects unsafe targets and keeps the source, destination data, and config intact', async t => {
  const f = await fixture(t);
  const app = await f.run();
  const current = await info(app);
  const existing = join(f.dir, 'existing');
  const unwriteable = join(f.dir, 'regular-file');
  await mkdir(existing);
  await writeFile(join(existing, 'workbench.db'), 'untouched');
  await writeFile(unwriteable, 'untouched');
  const tooNew = join(f.dir, 'future');
  const future = openDatabase(join(tooNew, 'workbench.db'));
  future.db.exec(`PRAGMA user_version = ${userVersion(app.workbench) + 1}`);
  future.close();
  for (const [dataDir, mode, status] of [
    ['relative/path', 'copy', 400], [current.dataDir, 'copy', 400],
    [join(f.root, 'protected'), 'copy', 400], [resolve('app', 'protected'), 'copy', 400],
    [join(unwriteable, 'no-directory'), 'copy', 400], [existing, 'copy', 409],
    [existing, 'use', 400], [join(f.dir, 'missing'), 'use', 400], [tooNew, 'use', 409],
  ]) {
    const response = await post(app, 'api/storage/relocate', { dataDir, mode });
    assert.equal(response.status, status, `${dataDir} ${mode}`);
  }
  assert.equal(await readFile(join(existing, 'workbench.db'), 'utf8'), 'untouched');
  await assert.rejects(stat(f.configPath), { code: 'ENOENT' });
  const env = await f.run({ dbPath: join(f.dir, 'env.db') });
  assert.equal((await info(env)).source, 'env');
  assert.equal((await post(env, 'api/storage/relocate', { dataDir: existing, mode: 'use' })).status, 409);
});

test('an attachment collision rolls back the copy while preserving the destination files', async t => {
  const f = await fixture(t);
  const app = await f.run();
  const source = join(app.location.dataDir, 'attachments');
  const target = join(f.dir, 'target');
  const attachments = join(target, 'attachments');
  await mkdir(attachments, { recursive: true });
  await writeFile(join(source, '01.txt'), 'copied');
  await writeFile(join(source, '02.txt'), 'source');
  await writeFile(join(attachments, '02.txt'), 'target');
  assert.equal((await post(app, 'api/storage/relocate', { dataDir: target, mode: 'copy' })).status, 409);
  assert.deepEqual(await readdir(target), ['attachments']);
  assert.deepEqual(await readdir(attachments), ['02.txt']);
  assert.equal(await readFile(join(attachments, '02.txt'), 'utf8'), 'target');
  assert.equal(await readFile(join(source, '02.txt'), 'utf8'), 'source');
  await assert.rejects(stat(f.configPath), { code: 'ENOENT' });
});

test('native backup snapshots include WAL data and prune only recognized backups to 20', async t => {
  const f = await fixture(t);
  const app = await f.run();
  app.workbench.createTask({ id: 'backup-me', title: '原始任务' });
  const backups = join(app.location.dataDir, 'backups');
  for (let i = 0; i < 24; i++) await writeFile(join(backups, `workbench-20200101T0000${String(i).padStart(2, '0')}.db`), 'old');
  await writeFile(join(backups, 'my-backup.db'), 'keep');
  await mkdir(join(backups, 'workbench-20200101T000099.db'));
  const response = await post(app, 'api/storage/backup');
  assert.equal(response.status, 200);
  const { name } = await response.json();
  assert.match(name, /^workbench-\d{8}T\d{6}\.db$/);
  verifySnapshot(join(backups, name), 'backup-me', userVersion(app.workbench));
  const metadata = (await info(app)).backups;
  assert.equal(metadata.length, 20);
  assert.equal(metadata[0].name, name);
  assert.ok(metadata[0].bytes > 0 && metadata[0].createdAt > 0);
  assert.equal(await readFile(join(backups, 'my-backup.db'), 'utf8'), 'keep');
  assert.equal((await stat(join(backups, 'workbench-20200101T000099.db'))).isDirectory(), true);
});

test('reveal accepts only known folder names and folder selection is injected', async t => {
  const paths = [];
  const f = await fixture(t, { storageOptions: { openFolder: async path => paths.push(path) } });
  const app = await f.run();
  for (const target of ['data', 'backups', 'attachments']) {
    assert.equal((await post(app, 'api/storage/reveal', { target })).status, 200);
  }
  for (const target of ['../outside', f.dir, '__proto__', ['data']]) {
    assert.equal((await post(app, 'api/storage/reveal', { target })).status, 400);
  }
  const { dataDir } = app.location;
  assert.deepEqual(paths, [dataDir, join(dataDir, 'backups'), join(dataDir, 'attachments')]);
  const web = await post(app, 'api/storage/pick-folder');
  assert.equal(web.status, 501);
  assert.deepEqual(await web.json(), { code: 'not-supported' });
  const desktop = await f.run({ storageOptions: { edition: 'desktop', desktopDir: join(f.dir, 'desktop'),
    pickFolder: async () => ({ dataDir: f.dir }) } });
  assert.deepEqual(await (await post(desktop, 'api/storage/pick-folder')).json(), { dataDir: f.dir });
});

test('mutating routes reject other Origins and all routes reject other Hosts', async t => {
  const app = await (await fixture(t)).run();
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await fetch(app.url + 'api/command', { method, headers: { origin: 'https://example.invalid' } });
    assert.equal(response.status, 403);
  }
  assert.equal((await post(app, 'api/storage/backup', {}, { origin: 'null' })).status, 403);
  assert.equal((await post(app, 'api/storage/backup', {}, { 'content-type': 'text/plain' })).status, 415);
  for (const host of ['example.invalid', '127.0.0.1:1']) {
    const status = await new Promise((resolve, reject) => {
      request(app.url + 'api/storage', { headers: { host } }, res => { res.resume(); resolve(res.statusCode); })
        .on('error', reject).end();
    });
    assert.equal(status, 403);
  }
  assert.equal((await post(app, 'api/command', { type: 'createTask', id: 'safe', title: 'safe' },
    { origin: new URL(app.url).origin })).status, 200);
  assert.equal((await post(app, 'api/command', { type: 'createTask', id: 'script', title: 'script' })).status, 200);
});

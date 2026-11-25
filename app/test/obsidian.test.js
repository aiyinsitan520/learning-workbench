import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObsidian } from '../lib/obsidian.js';
import { start } from '../server.js';

const day = '2026-11-24';
const created = Date.parse(day + 'T01:00:00Z') / 1000;
const getText = path => readFile(path, 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wb-obsidian-')));
  const vault = join(root, 'vault');
  const dataDir = join(root, 'data');
  await mkdir(join(vault, '.obsidian'), { recursive: true });
  await mkdir(dataDir);
  const app = await start({ dbPath: join(dataDir, 'test.db'), islandLauncher: null });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const config = { vaultPath: vault, folder: '学习工作台', enabled: true, auto: false,
    include: { days: true, notes: true, harvests: true, projects: true } };
  const api = async (path = '', body, headers = {}) => {
    const response = await fetch(new URL('/api/obsidian' + path, app.url), body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.notEqual(response.status, 500, JSON.stringify(result));
    return { code: response.status, body: result };
  };
  return { ...app, root, dataDir, vault, output: join(vault, config.folder), config, api };
}

function seed(wb, image) {
  const db = wb.db;
  wb.createProject({ id: 'p1', title: '复习计划', startDay: day, mainTaskId: 'abcdef123' });
  db.prepare('UPDATE tasks SET title = ?, created_at = ? WHERE id = ?').run('CON', created, 'abcdef123');
  db.prepare('INSERT INTO task_notes VALUES (?, ?, 1)').run('abcdef123', '正文 ![图](/api/attachments/' + image + ')');
  db.prepare('INSERT INTO task_note_days VALUES (?, ?, ?, ?)').run('abcdef123', day, '正文', created);
  db.prepare('INSERT INTO schedule_blocks VALUES (?, ?, ?, ?)').run('b1', 'abcdef123', created, 1800);
  db.prepare('INSERT INTO focus_sessions (id, task_id, state, planned_seconds, elapsed_seconds, started_at, state_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('f1', 'abcdef123', 'finished', 1800, 1500, created, created + 1500);
  db.prepare('INSERT INTO day_notes (id, study_date, title) VALUES (?, ?, ?)').run('d1', day, '当天手记');
  db.prepare('INSERT INTO note_blocks (id, note_id, position, kind, body) VALUES (?, ?, 0, ?, ?)').run('n1', 'd1', 'text', '旧版正文');
  db.prepare('INSERT INTO project_logs VALUES (?, ?, ?, ?, ?)').run('p1', day, '完成第一章', 30, created);
  wb.saveDailyReview({ day, factsHash: 'hash', text: '当日小结' });
  wb.createHarvest({ id: 'h1', day, title: '复盘?', conclusion: '尝试回忆法', tags: ['学习'],
    projectId: 'p1' });
  wb.updateHarvest({ harvestId: 'h1', taskId: 'abcdef123', images: [image] });
}

test('exports four document groups, reversible links and content-addressed images, then only changes hashes', async t => {
  const f = await fixture(t);
  const image = Buffer.from('89504e470d0a1a0a', 'hex');
  const upload = await fetch(new URL('/api/attachments', f.url), { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: image });
  assert.equal(upload.status, 200);
  const { id } = await upload.json();
  seed(f.workbench, id);
  assert.equal((await f.api('/config', f.config)).code, 200);
  assert.deepEqual(JSON.parse(await getText(join(f.dataDir, 'obsidian.json'))), f.config);
  const first = await f.api('/export', {});
  assert.equal(first.code, 200, JSON.stringify(first.body));
  assert.equal(first.body.status.written, 5);
  const daily = await getText(join(f.output, '日计划', day + '.md'));
  for (const part of ['workbench_id:', 'type:', 'day:', 'updated:', 'tags:', '## 时间块', '09:00–09:30', '## 专注时间线',
    '## 手记', '旧版正文', '## 当天回顾', '当日小结', '[[学习工作台/任务正文/_CON-abcdef]]',
    '[[学习工作台/长期项目/复习计划]]', '[[学习工作台/收获/' + day + '-复盘_]]']) assert.ok(daily.includes(part), part);
  const note = await getText(join(f.output, '任务正文', '_CON-abcdef.md'));
  assert.ok(note.includes('](../附件/' + id + ')'));
  assert.ok(note.includes('[[学习工作台/日计划/' + day + ']]'));
  assert.deepEqual(await readFile(join(f.output, '附件', id)), image);
  const project = await getText(join(f.output, '长期项目', '复习计划.md'));
  assert.match(project, /完成第一章/);
  const harvest = await getText(join(f.output, '收获', day + '-复盘_.md'));
  assert.match(harvest, /tags: \["学习"\]/);
  assert.ok(harvest.includes('](../附件/' + id + ')'));
  const again = await f.api('/export', {});
  assert.equal(again.body.status.written, 0);
  assert.equal(again.body.status.unchanged, 5);
  const manifest = JSON.parse(await getText(join(f.output, '.workbench-export.json')));
  assert.ok(manifest.entries.some(entry => entry.id === 'notes:abcdef123' && entry.hash === sha(note)));
});

test('preserves modified and untracked files; removes only unchanged obsolete exports', async t => {
  const f = await fixture(t);
  const wb = f.workbench;
  for (const [id, title] of [['first1', '原名'], ['second', '要保留'], ['third3', '用户已有']]) {
    wb.createTask({ id, title });
    wb.saveTaskNote(id, '版本一', 0);
  }
  const notes = join(f.output, '任务正文');
  await mkdir(notes, { recursive: true });
  await writeFile(join(notes, '用户已有-third3.md'), '独立笔记');
  await writeFile(join(notes, '随手记.md'), '个人内容');
  await f.api('/config', f.config);
  const first = await f.api('/export', {});
  assert.deepEqual(first.body.status.conflicts, ['任务正文/用户已有-third3.md']);
  await writeFile(join(notes, '要保留-second.md'), 'Obsidian 修改');
  wb.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('新名字', 'first1');
  wb.saveTaskNote('second', '版本二', 1);
  const next = await f.api('/export', {});
  assert.deepEqual(next.body.status.conflicts.sort(), ['任务正文/用户已有-third3.md', '任务正文/要保留-second.md']);
  assert.equal(await getText(join(notes, '要保留-second.md')), 'Obsidian 修改');
  assert.equal(await getText(join(notes, '随手记.md')), '个人内容');
  assert.equal(await getText(join(notes, '用户已有-third3.md')), '独立笔记');
  await assert.rejects(getText(join(notes, '原名-first1.md')), { code: 'ENOENT' });
  assert.match(await getText(join(notes, '新名字-first1.md')), /版本一/);
  wb.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('改名但保留旧版', 'second');
  const renamed = await f.api('/export', {});
  assert.ok(renamed.body.status.conflicts.includes('任务正文/要保留-second.md'));
  assert.equal(await getText(join(notes, '要保留-second.md')), 'Obsidian 修改');
});

test('rejects path traversal, junctions and malformed manifests before touching external files', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/config', { ...f.config, folder: '../escape' })).code, 400);
  const traversal = f.vault + '/.obsidian/..';
  assert.equal((await f.api('/config', { ...f.config, vaultPath: traversal })).code, 400);
  const alias = join(f.root, 'alias');
  await symlink(f.vault, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.api('/config', { ...f.config, vaultPath: alias })).code, 400);
  assert.equal((await f.api('/config', { ...f.config, vaultPath: f.dataDir })).code, 400);
  assert.equal((await f.api('/config', f.config)).code, 200);
  f.workbench.createTask({ id: 'testid', title: '笔记' });
  f.workbench.saveTaskNote('testid', '测试内容', 0);
  const external = join(f.root, 'external');
  await mkdir(external);
  await mkdir(f.output);
  const notes = join(f.output, '任务正文');
  await symlink(external, notes, process.platform === 'win32' ? 'junction' : 'dir');
  const sentinel = join(external, '笔记-testid.md');
  await writeFile(sentinel, '外部原文');
  assert.equal((await f.api('/export', {})).code, 400);
  assert.equal(await getText(sentinel), '外部原文');
  await rm(notes);
  const manifest = join(f.output, '.workbench-export.json');
  await writeFile(manifest, JSON.stringify({ version: 1, entries: [
    { id: 'notes:testid', path: '任务正文/../../external/笔记-testid.md', hash: sha('外部原文') },
  ] }));
  assert.equal((await f.api('/export', {})).code, 400);
  assert.equal(await getText(sentinel), '外部原文');
});

test('a matching hash alone does not make a personal note an export', async t => {
  const f = await fixture(t);
  const notes = join(f.output, '任务正文');
  await mkdir(notes, { recursive: true });
  const path = join(notes, '个人笔记.md');
  const body = '# 用户笔记';
  await writeFile(path, body);
  await writeFile(join(f.output, '.workbench-export.json'), JSON.stringify({ version: 1, entries: [
    { id: 'notes:gone', path: '任务正文/个人笔记.md', hash: sha(body) },
  ] }));
  await f.api('/config', f.config);
  const result = await f.api('/export', {});
  assert.deepEqual(result.body.status.conflicts, ['任务正文/个人笔记.md']);
  assert.equal(await getText(path), body);
});

test('honors an active lock, reclaims a stale lock and guards API writes', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/config', f.config, { Origin: 'http://example.invalid' })).code, 403);
  assert.equal((await f.api('/config', f.config, { 'Content-Type': 'text/plain' })).code, 415);
  assert.equal((await f.api('/config', f.config)).code, 200);
  await mkdir(f.output);
  const lock = join(f.output, '.workbench-export.lock');
  await writeFile(lock, JSON.stringify({ pid: 999999, time: Date.now() }));
  assert.equal((await f.api('/export', {})).code, 409);
  await writeFile(lock, JSON.stringify({ pid: 999999, time: Date.now() - 121_000 }));
  assert.equal((await f.api('/export', {})).code, 200);
  await assert.rejects(getText(lock), { code: 'ENOENT' });
});

test('detect returns only configured paths without opening any vault', async t => {
  const f = await fixture(t);
  const name = process.platform === 'win32' ? 'APPDATA' : process.platform === 'darwin' ? 'HOME' : 'XDG_CONFIG_HOME';
  const previous = process.env[name];
  process.env[name] = f.root;
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  const dir = process.platform === 'darwin' ? join(f.root, 'Library', 'Application Support', 'obsidian') : join(f.root, 'obsidian');
  await mkdir(dir, { recursive: true });
  const missing = join(f.root, 'does-not-exist');
  await writeFile(join(dir, 'obsidian.json'), JSON.stringify({ vaults: {
    one: { path: f.vault, ts: 5, open: true }, two: { path: missing }, duplicate: { path: f.vault }, relative: { path: 'other' },
  } }));
  assert.deepEqual((await f.api('/detect')).body, { vaults: [f.vault, missing] });
});

test('automatically exports external database revisions without SSE subscribers', async t => {
  const f = await fixture(t);
  const second = await start({ dbPath: join(f.dataDir, 'test.db'), islandLauncher: null });
  t.after(async () => {
    second.server.closeAllConnections();
    if (second.server.listening) await new Promise(resolve => second.server.close(resolve));
  });
  let sequence = 0;
  let last = f.workbench.dataVersion();
  const service = createObsidian({ wb: f.workbench, dataDir: f.dataDir, debounceMs: 100, pollMs: 10, revision() {
    const next = f.workbench.dataVersion();
    if (next !== last) sequence += 1;
    last = next;
    return sequence;
  } });
  t.after(() => service.close());
  service.configure({ ...f.config, auto: true });
  const note = join(f.output, '任务正文', '自动-watch0.md');
  second.workbench.createTask({ id: 'watch01', title: '自动' });
  second.workbench.saveTaskNote('watch01', '旧稿', 0);
  await new Promise(resolve => setTimeout(resolve, 35));
  second.workbench.saveTaskNote('watch01', '经防抖的新稿', 1);
  const until = Date.now() + 2000;
  let content = '';
  while (!content && Date.now() < until) {
    content = await getText(note).catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
    if (!content) await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.match(content, /经防抖的新稿/);
  assert.equal(service.get().status.written, 2);
  service.close();
  await new Promise(resolve => second.server.close(resolve));
});

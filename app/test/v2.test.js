// v2 框架：库迁移（带备份）、长期项目、每日摘要、AI 数据快照。只用临时库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_PATH } from '../lib/db.js';
import { dayDigest, contextSnapshot, factsHash } from '../lib/digest.js';
import { dayRange } from '../lib/time.js';
import { start } from '../server.js';

const TZ = 'Asia/Shanghai';
const DAY = '2026-11-20';
const { start: MIDNIGHT } = dayRange(DAY, TZ);
const at = (h, m = 0) => MIDNIGHT + h * 3600 + m * 60;

function tempDir() { return mkdtempSync(join(tmpdir(), 'wb-v2-')); }

test('v1 旧库自动迁移到 v2：先备份，旧数据不丢，新表可用', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'old.db');
    const raw = new DatabaseSync(file);
    raw.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    raw.exec("INSERT INTO tasks (id, title) VALUES ('t1', '旧任务')");
    raw.close();
    const wb = openDatabase(file, { timeZone: TZ });
    assert.equal(wb.db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(wb.readDay(DAY).pending[0].title, '旧任务');
    assert.equal(wb.readDay(DAY).pending[0].projectId, null);
    wb.close();
    const backups = readdirSync(dir).filter((f) => f.startsWith('old.db.bak-v1-'));
    assert.equal(backups.length, 1, '迁移前应另存一份 v1 备份');
    const bak = new DatabaseSync(join(dir, backups[0]), { readOnly: true });
    assert.equal(bak.prepare('PRAGMA user_version').get().user_version, 1);
    bak.close();
    // 再次打开不重复迁移、不再备份
    openDatabase(file, { timeZone: TZ }).close();
    assert.equal(readdirSync(dir).filter((f) => f.includes('.bak-')).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('长期项目：建项目带主任务，跨天统计专注，写日志，完成与重开', () => {
  let now = at(20);
  const wb = openDatabase(':memory:', { timeZone: TZ, now: () => now });
  wb.createProject({ id: 'p1', title: '写毕业论文', goal: '完成初稿', startDay: '2026-11-18', dueDay: '2026-11-30',
    dailyMinutes: 90, mainTaskId: 'p1-main' });
  assert.deepEqual(wb.createProject({ id: 'p1', title: '写毕业论文', goal: '完成初稿', startDay: '2026-11-18',
    dueDay: '2026-11-30', dailyMinutes: 90, mainTaskId: 'p1-main' }), { ok: true, created: false }, '同内容重试幂等');
  wb.createTask({ id: 'p1-a', title: '文献综述', projectId: 'p1' });
  assert.throws(() => wb.createTask({ id: 'x', title: 'x', projectId: 'nope' }), /不存在/);

  // 主任务出现在待办里，带项目归属
  const main = wb.readDay(DAY).pending.find((t) => t.id === 'p1-main');
  assert.deepEqual([main.course, main.projectId], ['长期项目', 'p1']);

  // 当天在主任务上专注 25 分钟
  now = at(9);
  wb.startFocus({ id: 'f1', taskId: 'p1-main', plannedSeconds: 1500 });
  now = at(9, 25);
  wb.settleExpired();
  wb.saveProjectLog({ projectId: 'p1', day: DAY, note: '写完第一章', progress: 20 });

  const [p] = wb.readDay(DAY).projects;
  assert.equal(p.dayIndex, 3);
  assert.equal(p.totalDays, 13);
  assert.equal(p.daysLeft, 10);
  assert.equal(p.focusSecondsOnDay, 1500);
  assert.equal(p.taskCount, 1, '子任务数不含主任务');
  assert.equal(p.log.note, '写完第一章');
  assert.equal(wb.readDay('2026-11-21').projects[0].lastLog.progress, 20);
  assert.equal(wb.readDay('2026-11-17').projects.length, 0, '开始前不显示');

  wb.updateProject({ projectId: 'p1', title: '毕业论文初稿' });
  assert.equal(wb.readDay(DAY).pending.find((t) => t.id === 'p1-main').title, '毕业论文初稿', '改名同步主任务');

  now = at(21);
  wb.setProjectState({ projectId: 'p1', action: 'complete' });
  assert.ok(wb.readDay(DAY).completedOnDay.some((t) => t.id === 'p1-main'), '完成项目即完成主任务');
  assert.equal(wb.readDay(DAY).projects.length, 1, '完成当天仍可回看');
  assert.equal(wb.readDay('2026-11-22').projects.length, 0, '完成之后的日子不再显示');
  wb.setProjectState({ projectId: 'p1', action: 'reopen' });
  assert.equal(wb.readDay(DAY).pending.some((t) => t.id === 'p1-main'), true);
  wb.setProjectState({ projectId: 'p1', action: 'archive' });
  assert.equal(wb.readDay(DAY).projects.length, 0);
  assert.equal(wb.listProjects()[0].logs.length, 1);
  wb.close();
});

test('每日摘要：计划 vs 专注、未完成块、指纹随记录变化', () => {
  let now = at(8);
  const wb = openDatabase(':memory:', { timeZone: TZ, now: () => now });
  wb.createTask({ id: 'a', title: '高数' });
  wb.createTask({ id: 'b', title: '刷视频', course: '日计划' });
  wb.saveSchedule({ block: { id: 'ba', taskId: 'a', startsAt: at(9), plannedSeconds: 3600 } });
  wb.saveSchedule({ block: { id: 'bb', taskId: 'b', startsAt: at(10), plannedSeconds: 1800 } });
  wb.startFocus({ id: 'f', taskId: 'a', plannedSeconds: 1200 });
  now = at(8, 20);
  wb.settleExpired();
  const d1 = dayDigest(wb, DAY);
  assert.equal(d1.plan.plannedSeconds, 5400);
  assert.equal(d1.plan.focusedOnPlannedSeconds, 1200);
  assert.equal(d1.plan.followRate, 0.5);
  assert.deepEqual(d1.plan.blocks.map((b) => [b.start, b.planOnly]), [['09:00', false], ['10:00', true]]);
  assert.deepEqual(d1.unfinishedBlocks.map((b) => b.id), ['ba', 'bb']);
  assert.equal(d1.focus.byTask[0].title, '高数');
  const h1 = factsHash(d1);
  assert.equal(factsHash(dayDigest(wb, DAY)), h1, '记录没变指纹不变');
  wb.setTaskCompleted({ taskId: 'a', completed: true });
  assert.notEqual(factsHash(dayDigest(wb, DAY)), h1);
  assert.deepEqual(dayDigest(wb, DAY).unfinishedBlocks.map((b) => b.id), ['bb']);

  const snap = contextSnapshot(wb, { endDay: DAY, days: 3 });
  assert.equal(snap.format, 'learning-space-ai-context');
  assert.deepEqual(snap.days.map((d) => d.day), ['2026-11-18', '2026-11-19', DAY]);
  assert.equal(snap.taskNotes, undefined, '默认不带任务正文');
  wb.close();
});

test('接口：/api/review 默认昨天，/api/context 不含密钥，项目命令走 /api/command', async () => {
  const dir = tempDir();
  const app = await start({ port: 0, dbPath: join(dir, 'w.db'), timeZone: TZ });
  const base = app.url.replace(/\/$/, '');
  const post = (command) => fetch(`${base}/api/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command }),
  }).then((r) => r.json());
  try {
    const today = (await (await fetch(`${base}/api/view`)).json()).view.day;
    assert.equal((await post({ type: 'createProject', id: 'p', title: '雅思', startDay: today, mainTaskId: 'p-m' })).ok, true);
    assert.equal((await post({ type: 'saveProjectLog', projectId: 'p', day: today, note: '背了 50 个词' })).ok, true);
    const review = await (await fetch(`${base}/api/review`)).json();
    assert.equal(review.ok, true);
    assert.equal(review.today, today);
    assert.ok(review.digest.day < today, '默认是昨天');
    assert.equal(review.review, null);
    const ctx = await (await fetch(`${base}/api/context?days=2`)).json();
    assert.equal(ctx.projects[0].logs[0].note, '背了 50 个词');
    assert.doesNotMatch(JSON.stringify(ctx), /apiKey|api_key|Bearer/i);
    const md = await fetch(`${base}/api/context?format=md`);
    assert.match(md.headers.get('content-type'), /text\/markdown/);
    const bad = await fetch(`${base}/api/review?day=2026-13-40`);
    assert.equal(bad.status, 400);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

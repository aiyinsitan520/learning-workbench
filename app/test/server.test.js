// 服务层与 API 集成测试：真起 HTTP 服务，走完整用户路径。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server.js';
import { dayRange, localDateOf, nowSeconds } from '../lib/time.js';

let app;
let dir;
let base;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'workbench-srv-'));
  app = await start({ port: 0, dbPath: join(dir, 'workbench.db'), timeZone: 'Asia/Shanghai' });
  base = app.url.replace(/\/$/, '');
});

after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

async function api(path, init) {
  const res = await fetch(base + path, init);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const post = (command) => api('/api/command', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ command }),
});

// 专注与完成都按真实当前时间入库，测试日期必须跟着「今天」走，否则过了午夜就会对不上。
const DAY = localDateOf(nowSeconds(), 'Asia/Shanghai');
const NOON = dayRange(DAY, 'Asia/Shanghai').start + 12 * 3600;

test('健康检查返回时区', async () => {
  const { status, json } = await api('/api/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.timeZone, 'Asia/Shanghai');
  // 前端版本号：public/ 最新修改时间，长期开着的页面据此自动重载
  assert.match(json.build, /^\d+$/);
});

test('完整用户路径：新建 → 排期 → 专注 → 完成 → 撤销', async () => {
  assert.equal((await post({ type: 'createTask', id: 'p1', title: '画出采样前后的频谱', course: '通信原理', estimatedSeconds: 1500 })).status, 200);

  let view = (await api(`/api/view?day=${DAY}`)).json;
  assert.equal(view.view.pending.length, 1);
  assert.equal(view.recommended.id, 'p1');

  await post({ type: 'saveSchedule', block: { id: 'pb1', taskId: 'p1', startsAt: NOON, plannedSeconds: 1500 } });
  view = (await api(`/api/view?day=${DAY}`)).json;
  assert.equal(view.view.scheduled.length, 1);

  // 改期：同一任务，任务数不变
  await post({ type: 'saveSchedule', block: { id: 'pb1', taskId: 'p1', startsAt: NOON + 3600, plannedSeconds: 1500 } });
  view = (await api(`/api/view?day=${DAY}`)).json;
  assert.equal(view.view.scheduled.length, 1);
  assert.equal(view.view.pending.length, 1);
  assert.equal(view.view.scheduled[0].startsAt, NOON + 3600);

  // 专注
  await post({ type: 'startFocus', id: 'pf1', taskId: 'p1', plannedSeconds: 1500 });
  view = (await api(`/api/view?day=${DAY}`)).json;
  assert.equal(view.view.openFocus.state, 'running');
  assert.equal(view.view.openFocus.revision, 0);

  // 暂停
  await post({ type: 'changeFocus', id: 'pf1', expectedRevision: 0, action: 'pause' });
  view = (await api(`/api/view?day=${DAY}`)).json;
  assert.equal(view.view.openFocus.state, 'paused');

  // 恢复 + 结束
  await post({ type: 'changeFocus', id: 'pf1', expectedRevision: 1, action: 'resume' });
  await post({ type: 'changeFocus', id: 'pf1', expectedRevision: 2, action: 'finish' });
  view = (await api(`/api/view?day=${DAY}`)).json;
  assert.equal(view.view.openFocus, null);
  assert.equal(view.view.focusSummary.finishedSessions, 1);
  assert.equal(view.focusLog.length, 1);

  // 完成 → 撤销
  await post({ type: 'setTaskCompleted', taskId: 'p1', completed: true });
  view = (await api(`/api/view?day=${DAY}`)).json;
  assert.equal(view.view.completedOnDay.length, 1);
  assert.equal(view.stats.completedTasks, 1);

  await post({ type: 'setTaskCompleted', taskId: 'p1', completed: false });
  view = (await api(`/api/view?day=${DAY}`)).json;
  assert.equal(view.view.completedOnDay.length, 0);
  assert.equal(view.view.pending.length, 1);
});

test('重复创建同一任务幂等', async () => {
  const first = await post({ type: 'createTask', id: 'dup1', title: '幂等任务', course: '' });
  assert.equal(first.json.result.created, true);
  const again = await post({ type: 'createTask', id: 'dup1', title: '幂等任务', course: '' });
  assert.equal(again.json.result.created, false);
  const view = (await api(`/api/view?day=${DAY}`)).json;
  assert.equal(view.view.pending.filter((t) => t.id === 'dup1').length, 1);
});

test('冲突返回 409 并带原因', async () => {
  await post({ type: 'createTask', id: 'c1', title: '冲突测试' });
  const bad = await post({ type: 'createTask', id: 'c1', title: '不同标题' });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.reason, 'conflict');
});

test('非法输入返回 400', async () => {
  const r1 = await post({ type: 'createTask', id: 'x1', title: '   ' });
  assert.equal(r1.status, 400);
  assert.equal(r1.json.reason, 'invalid');
  const r2 = await post({ type: 'nonsense' });
  assert.equal(r2.status, 400);
  const r3 = await api('/api/view?day=2026-02-30');
  assert.equal(r3.status, 400);
});

test('缺失记录返回 404', async () => {
  const r = await post({ type: 'setTaskCompleted', taskId: 'ghost', completed: true });
  assert.equal(r.status, 404);
  assert.equal(r.json.reason, 'missing');
});

test('第二路专注被拒（全库最多一条开放）', async () => {
  await post({ type: 'createTask', id: 'o1', title: '开放位测试' });
  const a = await post({ type: 'startFocus', id: 'of1', taskId: 'o1', plannedSeconds: 600 });
  assert.equal(a.status, 200);
  const b = await post({ type: 'startFocus', id: 'of2', taskId: 'o1', plannedSeconds: 600 });
  assert.equal(b.status, 409);
  await post({ type: 'changeFocus', id: 'of1', expectedRevision: 0, action: 'finish' });
});

test('手记保存、版本冲突与读回', async () => {
  const note = {
    id: 'n-api',
    studyDate: DAY,
    title: '采样以后，频谱去了哪里？',
    blocks: [
      { id: 'nb1', kind: 'text', title: '', body: '采样会让原信号的频谱周期性重复。' },
      { id: 'nb2', kind: 'question', title: '为什么会出现频谱混叠？', body: '试着画出采样频率减半后的频谱。' },
    ],
  };
  const created = await post({ type: 'saveDayNote', note, expectedRevision: null });
  assert.equal(created.json.result.revision, 0);

  let view = (await api(`/api/view?day=${DAY}`)).json;
  assert.equal(view.view.note.blocks.length, 2);
  assert.equal(view.view.note.blocks[0].kind, 'text');

  // 旧版本 → 409
  const stale = await post({ type: 'saveDayNote', note: { ...note, title: '陈旧' }, expectedRevision: 99 });
  assert.equal(stale.status, 409);

  // 新版本 → 成功
  const next = await post({
    type: 'saveDayNote',
    note: { ...note, blocks: [note.blocks[1], note.blocks[0]] },
    expectedRevision: 0,
  });
  assert.equal(next.json.result.revision, 1);
  view = (await api(`/api/view?day=${DAY}`)).json;
  assert.deepEqual(view.view.note.blocks.map((b) => b.id), ['nb2', 'nb1']);
});

test('月份汇总接口：覆盖整月并计入当天完成', async () => {
  // 完成时间用真实当前时间，所以按"今天"所在的月份断言，不依赖别的用例。
  // 「今天」按服务的时区（Asia/Shanghai）算，不按本机时区，否则两边时区不同时会差一天。
  const today = localDateOf(nowSeconds(), 'Asia/Shanghai');
  const month = today.slice(0, 7);
  const [year, monthNo] = month.split('-').map(Number);
  await post({ type: 'createTask', id: 'm1', title: '月度汇总任务' });
  await post({ type: 'setTaskCompleted', taskId: 'm1', completed: true });

  const { status, json } = await api(`/api/month?month=${month}`);
  assert.equal(status, 200);
  const daysInMonth = new Date(Date.UTC(year, monthNo, 0)).getUTCDate();
  assert.equal(json.days.length, daysInMonth);
  assert.equal(json.days.at(0).day, `${month}-01`);
  assert.equal(json.days.at(-1).day, `${month}-${String(daysInMonth).padStart(2, '0')}`);
  const cell = json.days.find((d) => d.day === today);
  assert.equal(cell.completedTasks, 1, '今天的完成数应为 1');
  assert.ok(json.days.some((d) => d.completedTasks > 0));
});

test('静态资源：页面、脚本、素材都能取到', async () => {
  for (const [path, type] of [
    ['/', 'text/html'],
    ['/js/app.js', 'javascript'],
    ['/js/views.js', 'javascript'],
    ['/app.css', 'text/css'],
    ['/desk.png', 'image/png'],
    ['/kitten.png', 'image/png'],
  ]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, `${path} 应可访问`);
    assert.match(res.headers.get('content-type') ?? '', new RegExp(type), `${path} 的 content-type`);
    await res.arrayBuffer();
  }
});

test('静态资源：目录穿越被拒', async () => {
  const res = await fetch(`${base}/../architecture/schema.sql`);
  assert.ok([403, 404].includes(res.status), `目录穿越应被拒，实际 ${res.status}`);
  const res2 = await fetch(`${base}/%2e%2e/architecture/schema.sql`);
  assert.ok([403, 404].includes(res2.status));
});

test('任务正文按任务 ID 隔离，支持幂等重试和冲突保护', async () => {
  assert.deepEqual((await api('/api/task-note?task=p1')).json.note, { body: '', revision: 0 });
  const command = { type: 'saveTaskNote', taskId: 'p1', body: '任务一正文\n第二行', expectedRevision: 0 };
  assert.equal((await post(command)).json.result.revision, 1);
  assert.equal((await post(command)).json.result.revision, 1);
  assert.equal((await post({ ...command, body: '过期草稿' })).status, 409);
  assert.deepEqual((await api('/api/task-note?task=p1')).json.note, { body: command.body, revision: 1 });
  assert.deepEqual((await api('/api/task-note?task=dup1')).json.note, { body: '', revision: 0 });
});

test('导出：整库 JSON 带格式标识与全部表', async () => {
  const res = await fetch(`${base}/api/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="workbench-/);

  const dump = await res.json();
  assert.equal(dump.format, 'learning-space-workbench');
  assert.equal(dump.version, 1);
  assert.ok(dump.exportedAt > 0);
  assert.deepEqual(
    Object.keys(dump.tables).sort(),
    // v2 起多了长期项目、项目日志、AI 回顾三张表；AI 密钥不在库里，永远不会出现在导出里
    ['daily_reviews', 'day_notes', 'focus_sessions', 'note_blocks', 'project_logs', 'projects',
      'schedule_blocks', 'task_notes', 'tasks'],
  );
  assert.ok(dump.tables.tasks.length >= 1, '至少应有前面用例建的任务');
});

test('导入：导出文件可原样恢复到空库', async () => {
  const dump = await (await fetch(`${base}/api/export`)).json();

  const dir = mkdtempSync(join(tmpdir(), 'workbench-imp-'));
  const fresh = await start({ port: 0, dbPath: join(dir, 'fresh.db'), timeZone: 'Asia/Shanghai' });
  const freshBase = fresh.url.replace(/\/$/, '');
  try {
    const res = await fetch(`${freshBase}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dump),
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.ok(result.inserted > 0);

    const src = await (await fetch(`${base}/api/view?day=${DAY}`)).json();
    const dst = await (await fetch(`${freshBase}/api/view?day=${DAY}`)).json();
    assert.equal(dst.view.pending.length, src.view.pending.length, '任务数应一致');
    assert.equal(dst.view.scheduled.length, src.view.scheduled.length, '排期数应一致');
    assert.equal(dst.view.note?.title ?? null, src.view.note?.title ?? null, '手记标题应一致');
    const roundTrip = await (await fetch(`${freshBase}/api/task-note?task=p1`)).json();
    assert.deepEqual(roundTrip.note, { body: '任务一正文\n第二行', revision: 1 });
    assert.equal(
      dst.view.note?.blocks.length ?? 0,
      src.view.note?.blocks.length ?? 0,
      '手记块数应一致',
    );
  } finally {
    await new Promise((resolve) => fresh.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('导入：非空库与非法文件都被拒绝', async () => {
  const dump = await (await fetch(`${base}/api/export`)).json();
  const busy = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dump),
  });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).reason, 'conflict');

  const bad = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ format: 'something-else' }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).reason, 'invalid');
});

test('未知 API 返回 404', async () => {
  const res = await api('/api/nope');
  assert.equal(res.status, 404);
});

test('坏 JSON 返回 400', async () => {
  const res = await fetch(`${base}/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});

// 数据层行为测试。用 node --test 运行，零依赖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, WorkbenchError } from '../lib/db.js';

const TZ = 'Asia/Shanghai';
const DAY = '2026-11-20';
const NOON = 1795104000 + 12 * 3600; // 2026-11-20 12:00 CST

/** 可控时钟，用来验证暂停、跨截止点与重复结算。 */
function makeClock(start = NOON) {
  let t = start;
  return {
    now: () => t,
    advance: (s) => { t += s; },
    set: (v) => { t = v; },
  };
}

function fresh(clock = makeClock()) {
  const wb = openDatabase(':memory:', { timeZone: TZ, now: clock.now });
  return { wb, clock };
}

const reason = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof WorkbenchError, `应抛出 WorkbenchError，实际 ${err?.name}`);
    return err.reason;
  }
  return null;
};

// ---------------------------------------------------------------- 任务

test('任务：创建、按日读取、完成与撤销', () => {
  const { wb } = fresh();
  assert.deepEqual(wb.createTask({ id: 't1', title: '画出采样前后的频谱', course: '通信原理' }), { ok: true, created: true });
  const v1 = wb.readDay(DAY, TZ);
  assert.equal(v1.pending.length, 1);
  assert.equal(v1.pending[0].title, '画出采样前后的频谱');
  assert.equal(v1.completedOnDay.length, 0);

  wb.setTaskCompleted({ taskId: 't1', completed: true });
  const v2 = wb.readDay(DAY, TZ);
  assert.equal(v2.pending.length, 0);
  assert.equal(v2.completedOnDay.length, 1, '完成后应出现在今日完成区');
  assert.ok(v2.completedOnDay[0].completedAt > 0);

  wb.setTaskCompleted({ taskId: 't1', completed: false });
  const v3 = wb.readDay(DAY, TZ);
  assert.equal(v3.pending.length, 1, '撤销完成应回到待办');
  assert.equal(v3.completedOnDay.length, 0);
  wb.close();
});

test('任务：同 ID 同内容重试成功，同 ID 不同内容报冲突', () => {
  const { wb } = fresh();
  wb.createTask({ id: 't1', title: '整理泰勒公式例题', course: '高等数学', estimatedSeconds: 2400 });
  // 模拟"请求发出但响应丢失后重试"
  assert.deepEqual(
    wb.createTask({ id: 't1', title: '整理泰勒公式例题', course: '高等数学', estimatedSeconds: 2400 }),
    { ok: true, created: false },
  );
  assert.equal(wb.readDay(DAY, TZ).pending.length, 1, '重试不得产生第二条任务');
  assert.equal(
    reason(() => wb.createTask({ id: 't1', title: '换了标题', course: '高等数学', estimatedSeconds: 2400 })),
    'conflict',
  );
  wb.close();
});

test('任务：空标题与超长 id 被拒', () => {
  const { wb } = fresh();
  assert.equal(reason(() => wb.createTask({ id: 't1', title: '   ' })), 'invalid');
  assert.equal(reason(() => wb.createTask({ id: '', title: '有效标题' })), 'invalid');
  assert.equal(reason(() => wb.createTask({ id: 'x'.repeat(65), title: '有效标题' })), 'invalid');
  assert.equal(reason(() => wb.createTask({ id: 't2', title: '有效', estimatedSeconds: 0 })), 'invalid');
  assert.equal(wb.readDay(DAY, TZ).pending.length, 0, '校验失败不得写入');
  wb.close();
});

test('任务：改名保留 ID、完成状态与排期', () => {
  const { wb } = fresh();
  wb.createTask({ id: 't1', title: '旧标题', course: '通信原理', estimatedSeconds: 1500 });
  wb.saveSchedule({ block: { id: 'b1', taskId: 't1', startsAt: NOON, plannedSeconds: 1500 } });
  wb.setTaskCompleted({ taskId: 't1', completed: true });

  const r = wb.updateTask({ taskId: 't1', title: '新标题' });
  assert.equal(r.changed, true);
  const v = wb.readDay(DAY, TZ);
  assert.equal(v.completedOnDay.length, 1, '改名不影响完成状态');
  assert.equal(v.completedOnDay[0].id, 't1', 'ID 必须保持');
  assert.equal(v.completedOnDay[0].title, '新标题');
  assert.equal(v.scheduled.length, 1, '改名不影响排期');
  assert.equal(v.scheduled[0].task.title, '新标题', '排期读到的是新标题');

  assert.equal(wb.updateTask({ taskId: 't1', title: '新标题' }).changed, false, '无变化时幂等');
  assert.equal(reason(() => wb.updateTask({ taskId: 't1', title: '  ' })), 'invalid');
  assert.equal(reason(() => wb.updateTask({ taskId: 'ghost', title: 'x' })), 'missing');
  assert.equal(wb.readDay(DAY, TZ).completedOnDay[0].title, '新标题', '失败不得改动');
  wb.close();
});

test('任务：完成不存在的任务报 missing', () => {
  const { wb } = fresh();
  assert.equal(reason(() => wb.setTaskCompleted({ taskId: 'nope', completed: true })), 'missing');
  wb.close();
});

// ---------------------------------------------------------------- 排期

test('排期：同一任务改期不改变任务数', () => {
  const { wb } = fresh();
  wb.createTask({ id: 't1', title: '画出采样前后的频谱', course: '通信原理' });
  wb.saveSchedule({ block: { id: 'b1', taskId: 't1', startsAt: NOON, plannedSeconds: 1500 } });
  assert.equal(wb.readDay(DAY, TZ).scheduled.length, 1);

  // 改到两小时后，同一条块
  wb.saveSchedule({ block: { id: 'b1', taskId: 't1', startsAt: NOON + 7200, plannedSeconds: 1500 } });
  const v = wb.readDay(DAY, TZ);
  assert.equal(v.pending.length, 1, '改期不得新建任务');
  assert.equal(v.scheduled.length, 1, '改期不得新增时间块');
  assert.equal(v.scheduled[0].startsAt, NOON + 7200);
  assert.equal(v.scheduled[0].task.id, 't1');
  wb.close();
});

test('排期：同一任务可以安排多次', () => {
  const { wb } = fresh();
  wb.createTask({ id: 't1', title: '复习欧拉公式', course: '高等数学' });
  wb.saveSchedule({ block: { id: 'b1', taskId: 't1', startsAt: NOON, plannedSeconds: 900 } });
  wb.saveSchedule({ block: { id: 'b2', taskId: 't1', startsAt: NOON + 3600, plannedSeconds: 900 } });
  const v = wb.readDay(DAY, TZ);
  assert.equal(v.pending.length, 1);
  assert.equal(v.scheduled.length, 2);
  assert.deepEqual(v.scheduled.map((s) => s.startsAt), [NOON, NOON + 3600]);
  wb.close();
});

test('排期：错误 task_id 被外键拒绝', () => {
  const { wb } = fresh();
  assert.equal(
    reason(() => wb.saveSchedule({ block: { id: 'b1', taskId: 'ghost', startsAt: NOON, plannedSeconds: 600 } })),
    'missing',
  );
  assert.equal(wb.readDay(DAY, TZ).scheduled.length, 0, '外键失败不得留下时间块');
  wb.close();
});

test('排期：负数时间与非正时长被拒', () => {
  const { wb } = fresh();
  wb.createTask({ id: 't1', title: '预习线性空间' });
  assert.equal(reason(() => wb.saveSchedule({ block: { id: 'b1', taskId: 't1', startsAt: -1, plannedSeconds: 600 } })), 'invalid');
  assert.equal(reason(() => wb.saveSchedule({ block: { id: 'b2', taskId: 't1', startsAt: 0, plannedSeconds: 0 } })), 'invalid');
  assert.equal(reason(() => wb.saveSchedule({ block: { id: 'b3', taskId: 't1', startsAt: 1.5, plannedSeconds: 600 } })), 'invalid');
  wb.close();
});

test('排期：删除时间块不动任务', () => {
  const { wb } = fresh();
  wb.createTask({ id: 't1', title: '阅读英文摘要' });
  wb.saveSchedule({ block: { id: 'b1', taskId: 't1', startsAt: NOON, plannedSeconds: 900 } });
  wb.removeSchedule({ blockId: 'b1' });
  const v = wb.readDay(DAY, TZ);
  assert.equal(v.scheduled.length, 0);
  assert.equal(v.pending.length, 1);
  assert.equal(reason(() => wb.removeSchedule({ blockId: 'b1' })), 'missing');
  wb.close();
});

test('排期：不同日期的块只出现在对应那天', () => {
  const { wb } = fresh();
  wb.createTask({ id: 't1', title: '整理电路实验数据' });
  wb.saveSchedule({ block: { id: 'b1', taskId: 't1', startsAt: NOON, plannedSeconds: 900 } });
  wb.saveSchedule({ block: { id: 'b2', taskId: 't1', startsAt: NOON + 86400, plannedSeconds: 900 } });
  assert.equal(wb.readDay('2026-11-20', TZ).scheduled.length, 1);
  assert.equal(wb.readDay('2026-11-21', TZ).scheduled.length, 1);
  wb.close();
});

// ---------------------------------------------------------------- 专注

test('专注：开始、暂停冻结、恢复续计、结束记录', () => {
  const { wb, clock } = fresh();
  wb.createTask({ id: 't1', title: '画出采样前后的频谱' });
  wb.startFocus({ id: 'f1', taskId: 't1', plannedSeconds: 1500 });

  clock.advance(600); // 跑了 10 分钟
  const paused = wb.changeFocus({ id: 'f1', expectedRevision: 0, action: 'pause' });
  assert.equal(paused.state, 'paused');
  assert.equal(paused.elapsedSeconds, 600);

  clock.advance(300); // 暂停期间不计时
  const still = wb.readDay(DAY, TZ).openFocus;
  assert.equal(still.state, 'paused');
  assert.equal(still.elapsedSeconds, 600, '暂停期间累计秒数必须冻结');

  wb.changeFocus({ id: 'f1', expectedRevision: 1, action: 'resume' });
  clock.advance(120);
  const done = wb.changeFocus({ id: 'f1', expectedRevision: 2, action: 'finish' });
  assert.equal(done.state, 'finished');
  assert.equal(done.elapsedSeconds, 720, '恢复后应接着累计');
  assert.equal(wb.readDay(DAY, TZ).openFocus, null);
  wb.close();
});

test('专注：全库最多一条 running 或 paused（四种组合）', () => {
  const cases = [
    ['running', 'running'], ['running', 'paused'],
    ['paused', 'running'], ['paused', 'paused'],
  ];
  for (const [first, second] of cases) {
    const { wb } = fresh();
    wb.startFocus({ id: 'f1', plannedSeconds: 900 });
    if (first === 'paused') wb.changeFocus({ id: 'f1', expectedRevision: 0, action: 'pause' });
    assert.equal(
      reason(() => wb.startFocus({ id: 'f2', plannedSeconds: 900 })),
      'conflict',
      `已有 ${first} 时不应能开始第二轮`,
    );
    assert.equal(wb.readDay(DAY, TZ).openFocus.state, first, `${first} 不应被顶掉`);
    wb.close();
    void second;
  }
});

test('专注：结束一轮后才能开始下一轮', () => {
  const { wb } = fresh();
  wb.startFocus({ id: 'f1', plannedSeconds: 900 });
  wb.changeFocus({ id: 'f1', expectedRevision: 0, action: 'finish' });
  wb.startFocus({ id: 'f2', plannedSeconds: 900 });
  assert.equal(wb.readDay(DAY, TZ).openFocus.id, 'f2');
  wb.close();
});

test('专注：task_id 可空（自由专注），同样占唯一开放位', () => {
  const { wb } = fresh();
  wb.startFocus({ id: 'f1', taskId: null, plannedSeconds: 600 });
  const open = wb.readDay(DAY, TZ).openFocus;
  assert.equal(open.taskId, null);
  assert.equal(reason(() => wb.startFocus({ id: 'f2', plannedSeconds: 600 })), 'conflict');
  wb.close();
});

test('专注：错误 task_id 被外键拒绝', () => {
  const { wb } = fresh();
  assert.equal(reason(() => wb.startFocus({ id: 'f1', taskId: 'ghost', plannedSeconds: 600 })), 'missing');
  assert.equal(wb.readDay(DAY, TZ).openFocus, null);
  wb.close();
});

test('专注：未知状态被数据库拒绝（直接写库也拦住）', () => {
  const { wb } = fresh();
  assert.throws(
    () => wb.db.prepare(
      'INSERT INTO focus_sessions (id, task_id, state, planned_seconds) VALUES (?, ?, ?, ?)',
    ).run('f1', null, 'idle', 600),
    /CHECK constraint failed/i,
  );
  wb.close();
});

test('专注：版本不符报冲突，重复结束只结算一次', () => {
  const { wb, clock } = fresh();
  wb.startFocus({ id: 'f1', plannedSeconds: 900 });
  assert.equal(reason(() => wb.changeFocus({ id: 'f1', expectedRevision: 7, action: 'finish' })), 'conflict');
  clock.advance(300);
  wb.changeFocus({ id: 'f1', expectedRevision: 0, action: 'finish' });
  const before = wb.readDay(DAY, TZ).focusSummary;
  assert.equal(before.finishedSessions, 1);
  assert.equal(before.elapsedSeconds, 300);
  assert.equal(reason(() => wb.changeFocus({ id: 'f1', expectedRevision: 1, action: 'finish' })), 'conflict');
  const after = wb.readDay(DAY, TZ).focusSummary;
  assert.equal(after.finishedSessions, 1, '重复结束不得产生第二条记录');
  assert.equal(after.elapsedSeconds, 300, '重复结束不得改变累计时长');
  wb.close();
});

test('专注：跨过截止点按计划时长结算，不超时', () => {
  const { wb, clock } = fresh();
  wb.startFocus({ id: 'f1', plannedSeconds: 900 });
  clock.advance(5000); // 远超计划
  const settled = wb.settleExpired();
  assert.equal(settled.length, 1);
  assert.equal(settled[0].elapsedSeconds, 900, '结算不得超过计划时长');
  const v = wb.readDay(DAY, TZ);
  assert.equal(v.openFocus, null);
  assert.equal(v.focusSummary.elapsedSeconds, 900);
  // 幂等：再结算一次不再变化
  assert.deepEqual(wb.settleExpired(), []);
  assert.equal(wb.readDay(DAY, TZ).focusSummary.elapsedSeconds, 900);
  wb.close();
});

test('专注：跨过午夜开始，仍按开始时刻归集到当天', () => {
  // 11-20 23:50 CST 开始，计划 30 分钟，跨过午夜
  const dayStart = 1795104000;
  const clock = makeClock(dayStart + 23 * 3600 + 50 * 60);
  const wb = openDatabase(':memory:', { timeZone: TZ, now: clock.now });
  wb.startFocus({ id: 'f1', plannedSeconds: 1800 });
  clock.advance(3600);
  const settled = wb.settleExpired();
  assert.equal(settled.length, 1);
  const today = wb.readDay('2026-11-20', TZ).focusSummary;
  const tomorrow = wb.readDay('2026-11-21', TZ).focusSummary;
  assert.equal(today.finishedSessions + tomorrow.finishedSessions, 1, '整轮只归一天');
  assert.equal(today.finishedSessions, 1, '按开始时刻归集到 11-20');
  assert.equal(today.elapsedSeconds, 1800);
  assert.equal(tomorrow.finishedSessions, 0);
  wb.close();
});

test('专注：进行中的一轮不出现在已结束明细里', () => {
  const { wb, clock } = fresh();
  wb.createTask({ id: 't1', title: '画出采样前后的频谱' });
  wb.startFocus({ id: 'f1', taskId: 't1', plannedSeconds: 1500 });
  assert.equal(wb.readFocusLog(DAY, TZ).length, 0, 'running 不应算作已结束');
  clock.advance(300);
  wb.changeFocus({ id: 'f1', expectedRevision: 0, action: 'finish' });
  const log = wb.readFocusLog(DAY, TZ);
  assert.equal(log.length, 1);
  assert.equal(log[0].elapsedSeconds, 300);
  assert.equal(log[0].taskTitle, '画出采样前后的频谱');
  wb.close();
});

// ---------------------------------------------------------------- 手记

const block = (id, kind, extra = {}) => ({ id, kind, ...extra });

test('手记：新建、读取、块顺序保持', () => {
  const { wb } = fresh();
  const saved = wb.saveDayNote({
    note: {
      id: 'n1',
      studyDate: DAY,
      title: '采样以后，频谱去了哪里？',
      blocks: [
        block('blk1', 'text', { body: '采样会让原信号的频谱周期性重复。' }),
        block('blk2', 'question', { title: '为什么会出现频谱混叠？', body: '试着画出采样频率减半后的频谱。' }),
        block('blk3', 'workflow', { title: '频谱绘图步骤', body: '画原谱 → 标周期 → 检查重叠' }),
      ],
    },
    expectedRevision: null,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.revision, 0);

  const note = wb.readDay(DAY, TZ).note;
  assert.equal(note.title, '采样以后，频谱去了哪里？');
  assert.deepEqual(note.blocks.map((b) => b.id), ['blk1', 'blk2', 'blk3']);
  assert.deepEqual(note.blocks.map((b) => b.kind), ['text', 'question', 'workflow']);
  wb.close();
});

test('手记：调整块顺序后按新顺序读回', () => {
  const { wb } = fresh();
  wb.saveDayNote({
    note: { id: 'n1', studyDate: DAY, title: 'T', blocks: [block('a', 'text', { body: 'A' }), block('b', 'text', { body: 'B' }), block('c', 'text', { body: 'C' })] },
    expectedRevision: null,
  });
  const v = wb.saveDayNote({
    note: { id: 'n1', studyDate: DAY, title: 'T', blocks: [block('c', 'text', { body: 'C' }), block('a', 'text', { body: 'A' }), block('b', 'text', { body: 'B' })] },
    expectedRevision: 0,
  });
  assert.equal(v.revision, 1);
  assert.deepEqual(wb.readDay(DAY, TZ).note.blocks.map((b) => b.id), ['c', 'a', 'b']);
  wb.close();
});

test('手记：旧版本写入报冲突且不落库', () => {
  const { wb } = fresh();
  wb.saveDayNote({ note: { id: 'n1', studyDate: DAY, title: 'v0', blocks: [] }, expectedRevision: null });
  wb.saveDayNote({ note: { id: 'n1', studyDate: DAY, title: 'v1', blocks: [] }, expectedRevision: 0 });
  const stale = {
    note: { id: 'n1', studyDate: DAY, title: '陈旧草稿', blocks: [block('x', 'text', { body: '不该写进去' })] },
    expectedRevision: 0,
  };
  assert.equal(reason(() => wb.saveDayNote(stale)), 'conflict');
  const note = wb.readDay(DAY, TZ).note;
  assert.equal(note.title, 'v1', '冲突不得覆盖已有内容');
  assert.equal(note.revision, 1);
  assert.equal(note.blocks.length, 0, '冲突不得写入块');
  wb.close();
});

test('手记：新建时重复报冲突', () => {
  const { wb } = fresh();
  wb.saveDayNote({ note: { id: 'n1', studyDate: DAY, title: 'T', blocks: [] }, expectedRevision: null });
  assert.equal(
    reason(() => wb.saveDayNote({ note: { id: 'n1', studyDate: DAY, title: 'T2', blocks: [] }, expectedRevision: null })),
    'conflict',
  );
  wb.close();
});

test('手记：任务引用块要求真实任务，且外键兜底', () => {
  const { wb } = fresh();
  wb.createTask({ id: 't1', title: '画出采样前后的频谱' });
  wb.saveDayNote({
    note: { id: 'n1', studyDate: DAY, title: 'T', blocks: [block('r1', 'task_ref', { taskId: 't1' })] },
    expectedRevision: null,
  });
  assert.equal(wb.readDay(DAY, TZ).note.blocks[0].taskId, 't1');
  assert.equal(
    reason(() => wb.saveDayNote({
      note: { id: 'n1', studyDate: DAY, title: 'T', blocks: [block('r2', 'task_ref', { taskId: 'ghost' })] },
      expectedRevision: 0,
    })),
    'missing',
  );
  assert.equal(wb.readDay(DAY, TZ).note.blocks[0].id, 'r1', '失败不得破坏已有块');
  wb.close();
});

test('手记：一天一份文档，跨日互不影响', () => {
  const { wb } = fresh();
  wb.saveDayNote({ note: { id: 'n1', studyDate: DAY, title: '20 号', blocks: [] }, expectedRevision: null });
  wb.saveDayNote({ note: { id: 'n2', studyDate: '2026-11-21', title: '21 号', blocks: [] }, expectedRevision: null });
  assert.equal(wb.readDay('2026-11-20', TZ).note.title, '20 号');
  assert.equal(wb.readDay('2026-11-21', TZ).note.title, '21 号');
  assert.equal(wb.readDay('2026-11-22', TZ).note, null);
  wb.close();
});

// ---------------------------------------------------------------- 统计

test('统计：分钟只在展示层换算，短会话不丢时长', () => {
  const { wb, clock } = fresh();
  wb.startFocus({ id: 'f1', plannedSeconds: 900 });
  clock.advance(20); // 20 秒
  wb.changeFocus({ id: 'f1', expectedRevision: 0, action: 'finish' });
  wb.startFocus({ id: 'f2', plannedSeconds: 900 });
  clock.advance(40); // 40 秒
  wb.changeFocus({ id: 'f2', expectedRevision: 0, action: 'finish' });

  const stats = wb.readStats(DAY, TZ);
  assert.equal(stats.focusSessions, 2);
  assert.equal(stats.focusSeconds, 60, '秒级累计应为 60');
  assert.equal(Math.floor(stats.focusSeconds / 60), 1, '换算成分钟是 1，不是 0');
  wb.close();
});

test('统计：按任务分组，自由专注归入自由专注', () => {
  const { wb, clock } = fresh();
  wb.createTask({ id: 't1', title: '整理泰勒公式例题' });
  wb.startFocus({ id: 'f1', taskId: 't1', plannedSeconds: 900 });
  clock.advance(120);
  wb.changeFocus({ id: 'f1', expectedRevision: 0, action: 'finish' });
  wb.startFocus({ id: 'f2', taskId: null, plannedSeconds: 900 });
  clock.advance(60);
  wb.changeFocus({ id: 'f2', expectedRevision: 0, action: 'finish' });
  const stats = wb.readStats(DAY, TZ);
  assert.equal(stats.byTask.length, 2);
  assert.equal(stats.byTask[0].title, '整理泰勒公式例题');
  assert.equal(stats.byTask[0].seconds, 120);
  assert.equal(stats.byTask[1].title, '自由专注');
  wb.close();
});

test('统计：完成数按完成时间归日', () => {
  const { wb, clock } = fresh();
  wb.createTask({ id: 't1', title: '复习欧拉公式' });
  wb.setTaskCompleted({ taskId: 't1', completed: true });
  assert.equal(wb.readStats(DAY, TZ).completedTasks, 1);
  assert.equal(wb.readStats('2026-11-21', TZ).completedTasks, 0);
  clock.advance(86400);
  wb.setTaskCompleted({ taskId: 't1', completed: false });
  wb.setTaskCompleted({ taskId: 't1', completed: true });
  assert.equal(wb.readStats(DAY, TZ).completedTasks, 0, '重新完成应计入新的日期');
  assert.equal(wb.readStats('2026-11-21', TZ).completedTasks, 1);
  wb.close();
});

// ---------------------------------------------------------------- 落盘与重开

test('落盘：关闭后重开，任务、排期、完成状态、笔记与专注都在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-'));
  const file = join(dir, 'workbench.db');
  const clock = makeClock();
  try {
    const a = openDatabase(file, { timeZone: TZ, now: clock.now });
    a.createTask({ id: 't1', title: '画出采样前后的频谱', course: '通信原理', estimatedSeconds: 1500 });
    a.createTask({ id: 't2', title: '整理泰勒公式例题', course: '高等数学' });
    a.saveSchedule({ block: { id: 'b1', taskId: 't1', startsAt: NOON, plannedSeconds: 1500 } });
    a.setTaskCompleted({ taskId: 't2', completed: true });
    a.saveDayNote({
      note: { id: 'n1', studyDate: DAY, title: '采样以后，频谱去了哪里？', blocks: [block('blk1', 'text', { body: '频谱周期性重复' })] },
      expectedRevision: null,
    });
    a.startFocus({ id: 'f1', taskId: 't1', plannedSeconds: 1500 });
    clock.advance(300);
    a.changeFocus({ id: 'f1', expectedRevision: 0, action: 'finish' });
    a.close();

    const b = openDatabase(file, { timeZone: TZ, now: clock.now });
    const v = b.readDay(DAY, TZ);
    assert.equal(v.pending.length, 1);
    assert.equal(v.pending[0].id, 't1', '原 ID 必须保持');
    assert.equal(v.completedOnDay.length, 1);
    assert.equal(v.completedOnDay[0].id, 't2');
    assert.equal(v.scheduled.length, 1);
    assert.equal(v.scheduled[0].task.id, 't1');
    assert.equal(v.note.title, '采样以后，频谱去了哪里？');
    assert.equal(v.note.blocks[0].body, '频谱周期性重复');
    assert.equal(v.focusSummary.finishedSessions, 1);
    assert.equal(v.focusSummary.elapsedSeconds, 300);
    b.close();

    // 第三次打开：仍然幂等，不重复建表
    const c = openDatabase(file, { timeZone: TZ, now: clock.now });
    assert.equal(c.readDay(DAY, TZ).pending.length, 1);
    c.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('落盘：版本不符的库被拒绝打开', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-'));
  const file = join(dir, 'future.db');
  try {
    const a = openDatabase(file);
    a.db.exec('PRAGMA user_version = 99');
    a.close();
    assert.throws(() => openDatabase(file), /版本/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('落盘：外键在重开后的连接上依然生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-'));
  const file = join(dir, 'fk.db');
  try {
    const a = openDatabase(file);
    a.close();
    const b = openDatabase(file);
    assert.throws(
      () => b.db.prepare('INSERT INTO schedule_blocks (id, task_id, starts_at, planned_seconds) VALUES (?, ?, ?, ?)')
        .run('b1', 'ghost', NOON, 600),
      /FOREIGN KEY constraint failed/i,
    );
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 视图与日期

test('视图：跨时区的日期边界正确', () => {
  const { wb } = fresh();
  wb.createTask({ id: 't1', title: '跨时区任务' });
  // 2026-11-20 23:30 UTC = 2026-11-21 07:30 上海
  const lateUTC = Date.UTC(2026, 10, 20, 23, 30) / 1000;
  wb.saveSchedule({ block: { id: 'b1', taskId: 't1', startsAt: lateUTC, plannedSeconds: 600 } });
  assert.equal(wb.readDay('2026-11-20', 'Asia/Shanghai').scheduled.length, 0);
  assert.equal(wb.readDay('2026-11-21', 'Asia/Shanghai').scheduled.length, 1);
  assert.equal(wb.readDay('2026-11-20', 'UTC').scheduled.length, 1);
  wb.close();
});

test('视图：非法日期被拒', () => {
  const { wb } = fresh();
  for (const bad of ['2026-13-01', '2026-02-30', '20261120', '', null]) {
    assert.equal(reason(() => wb.readDay(bad, TZ)), 'invalid', `${bad} 应被拒`);
  }
  wb.close();
});

test('视图：月份汇总覆盖整月', () => {
  const { wb } = fresh();
  wb.createTask({ id: 't1', title: '任务' });
  wb.setTaskCompleted({ taskId: 't1', completed: true });
  const month = wb.readMonth('2026-11', TZ);
  assert.equal(month.length, 30);
  assert.equal(month.find((d) => d.day === DAY).completedTasks, 1);
  assert.equal(month.find((d) => d.day === '2026-11-01').completedTasks, 0);
  wb.close();
});

test('视图：推荐顺序为用户选中 → 今日最早安排 → 最早创建', () => {
  const { wb } = fresh();
  wb.createTask({ id: 't1', title: '先创建' });
  wb.createTask({ id: 't2', title: '后安排' });
  assert.equal(wb.recommend(DAY, null, TZ).id, 't1');
  wb.saveSchedule({ block: { id: 'b1', taskId: 't2', startsAt: NOON, plannedSeconds: 900 } });
  assert.equal(wb.recommend(DAY, null, TZ).id, 't2', '今日有安排时优先安排项');
  assert.equal(wb.recommend(DAY, 't1', TZ).id, 't1', '用户选中优先');
  wb.setTaskCompleted({ taskId: 't1', completed: true });
  assert.equal(wb.recommend(DAY, 't1', TZ).id, 't2', '已完成的不再推荐');
  wb.close();
});

test('视图：事务失败后数据库仍可用', () => {
  const { wb } = fresh();
  wb.createTask({ id: 't1', title: '任务' });
  assert.equal(reason(() => wb.saveSchedule({ block: { id: 'b1', taskId: 'ghost', startsAt: NOON, plannedSeconds: 600 } })), 'missing');
  // 回滚后继续写入应正常
  wb.saveSchedule({ block: { id: 'b2', taskId: 't1', startsAt: NOON, plannedSeconds: 600 } });
  assert.equal(wb.readDay(DAY, TZ).scheduled.length, 1);
  wb.close();
});

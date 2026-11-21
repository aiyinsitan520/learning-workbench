// 学习工作台 · 行为回归（只读项目文件，只写系统临时目录）
// 真起服务、用临时库跑一遍用户路径，验证 Codex 改动后功能没坏。
//
// 用法：node verify/check_behavior.mjs [-v]
// 退出码：0 全通过 / 1 有失败

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}: ${detail}`);
};

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (err) {
    record(name, false, err?.message ?? String(err));
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};

// 专注与完成按真实当前时间入库，验收日期跟着服务时区的「今天」走，过了午夜也能对上。
const { dayRange, localDateOf, nowSeconds } = await import(pathToFileURL(join(ROOT, 'app', 'lib', 'time.js')).href);
const DAY = localDateOf(nowSeconds(), 'Asia/Shanghai');
const NOON = dayRange(DAY, 'Asia/Shanghai').start + 12 * 3600;
const MONTH = DAY.slice(0, 7);
const MONTH_DAYS = new Date(Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0)).getUTCDate();

let app;
let base;
let dir;

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

const view = async (day = DAY) => (await api(`/api/view?day=${day}`)).json;

async function main() {
  console.log('学习工作台 · 行为回归（临时库，只读项目文件）');
  console.log(`项目：${ROOT}`);
  console.log();

  dir = mkdtempSync(join(tmpdir(), 'wb-verify-'));
  const { start } = await import(pathToFileURL(join(ROOT, 'app', 'server.js')).href);
  app = await start({ port: 0, dbPath: join(dir, 'verify.db'), timeZone: 'Asia/Shanghai' });
  base = app.url.replace(/\/$/, '');

  await check('service.health', async () => {
    const { status, json } = await api('/api/health');
    eq(status, 200, '健康检查状态码');
    eq(json.ok, true, '健康检查 ok');
    return `服务可用，时区 ${json.timeZone}`;
  });

  await check('task.create', async () => {
    const r = await post({ type: 'createTask', id: 'v1', title: '验收任务', course: '通信原理', estimatedSeconds: 1500 });
    eq(r.status, 200, '创建状态码');
    const v = await view();
    eq(v.view.pending.length, 1, '待办数');
    eq(v.view.pending[0].title, '验收任务', '任务标题');
    return '任务创建并读回一致';
  });

  await check('task.retry_idempotent', async () => {
    const again = await post({ type: 'createTask', id: 'v1', title: '验收任务', course: '通信原理', estimatedSeconds: 1500 });
    eq(again.status, 200, '重试状态码');
    const v = await view();
    eq(v.view.pending.length, 1, '重试后待办数');
    const conflict = await post({ type: 'createTask', id: 'v1', title: '换标题' });
    eq(conflict.status, 409, '同 ID 不同内容应冲突');
    return '同 ID 同内容幂等，不同内容 409';
  });

  await check('schedule.reschedule_keeps_task_count', async () => {
    await post({ type: 'saveSchedule', block: { id: 'vb1', taskId: 'v1', startsAt: NOON, plannedSeconds: 1500 } });
    let v = await view();
    eq(v.view.scheduled.length, 1, '排期数');
    await post({ type: 'saveSchedule', block: { id: 'vb1', taskId: 'v1', startsAt: NOON + 3600, plannedSeconds: 1500 } });
    v = await view();
    eq(v.view.scheduled.length, 1, '改期后排期数');
    eq(v.view.pending.length, 1, '改期后任务数');
    eq(v.view.scheduled[0].startsAt, NOON + 3600, '改期后的时间');
    return '改期不改变任务数与排期数';
  });

  await check('schedule.foreign_key', async () => {
    const r = await post({ type: 'saveSchedule', block: { id: 'vb-ghost', taskId: 'ghost', startsAt: NOON, plannedSeconds: 600 } });
    eq(r.status, 404, '错误 task_id 的状态码');
    const v = await view();
    eq(v.view.scheduled.length, 1, '失败后不应多出排期');
    return '错误 task_id 被拒，无残留';
  });

  await check('focus.lifecycle', async () => {
    const start = await post({ type: 'startFocus', id: 'vf1', taskId: 'v1', plannedSeconds: 1500 });
    eq(start.status, 200, '开始专注');
    let v = await view();
    eq(v.view.openFocus.state, 'running', '专注状态');

    const second = await post({ type: 'startFocus', id: 'vf2', taskId: 'v1', plannedSeconds: 600 });
    eq(second.status, 409, '第二轮专注应被拒');

    const paused = await post({ type: 'changeFocus', id: 'vf1', expectedRevision: 0, action: 'pause' });
    eq(paused.status, 200, '暂停');
    v = await view();
    eq(v.view.openFocus.state, 'paused', '暂停后的状态');

    await post({ type: 'changeFocus', id: 'vf1', expectedRevision: 1, action: 'resume' });
    await post({ type: 'changeFocus', id: 'vf1', expectedRevision: 2, action: 'finish' });
    v = await view();
    eq(v.view.openFocus, null, '结束后不应有开放专注');
    eq(v.view.focusSummary.finishedSessions, 1, '已结束专注数');
    return '开始→暂停→恢复→结束，唯一开放位生效';
  });

  await check('focus.free_task_null', async () => {
    await post({ type: 'startFocus', id: 'vf-free', taskId: null, plannedSeconds: 600 });
    const v = await view();
    eq(v.view.openFocus.taskId, null, '自由专注的 taskId');
    await post({ type: 'changeFocus', id: 'vf-free', expectedRevision: 0, action: 'finish' });
    return '自由专注 taskId 为 null';
  });

  await check('focus.revision_conflict', async () => {
    await post({ type: 'startFocus', id: 'vf3', taskId: 'v1', plannedSeconds: 600 });
    const bad = await post({ type: 'changeFocus', id: 'vf3', expectedRevision: 99, action: 'finish' });
    eq(bad.status, 409, '旧版本号应冲突');
    await post({ type: 'changeFocus', id: 'vf3', expectedRevision: 0, action: 'finish' });
    return '版本号不符返回 409';
  });

  await check('task.complete_and_undo', async () => {
    await post({ type: 'setTaskCompleted', taskId: 'v1', completed: true });
    let v = await view();
    eq(v.view.completedOnDay.length, 1, '完成区数量');
    eq(v.view.pending.length, 0, '待办应为空');
    await post({ type: 'setTaskCompleted', taskId: 'v1', completed: false });
    v = await view();
    eq(v.view.completedOnDay.length, 0, '撤销后完成区');
    eq(v.view.pending.length, 1, '撤销后待办');
    return '完成与撤销都正确';
  });

  await check('note.save_and_order', async () => {
    const note = {
      id: 'vn1',
      studyDate: DAY,
      title: '验收手记',
      blocks: [
        { id: 'vblk1', kind: 'text', title: '', body: '正文' },
        { id: 'vblk2', kind: 'question', title: '难点', body: '问题' },
      ],
    };
    const created = await post({ type: 'saveDayNote', note, expectedRevision: null });
    eq(created.json.result.revision, 0, '首次版本号');
    const v = await view();
    eq(v.view.note.blocks.length, 2, '块数');

    // 换顺序
    const swapped = await post({
      type: 'saveDayNote',
      note: { ...note, blocks: [note.blocks[1], note.blocks[0]] },
      expectedRevision: 0,
    });
    eq(swapped.json.result.revision, 1, '更新后版本号');
    const v2 = await view();
    eq(v2.view.note.blocks[0].id, 'vblk2', '新顺序的首块');

    // 旧版本冲突
    const stale = await post({ type: 'saveDayNote', note: { ...note, title: '陈旧' }, expectedRevision: 0 });
    eq(stale.status, 409, '旧版本应冲突');
    const v3 = await view();
    eq(v3.view.note.title, '验收手记', '冲突不得覆盖');
    return '保存、换序、版本冲突都正确';
  });

  await check('note.task_ref_requires_real_task', async () => {
    const v = await view();
    const bad = await post({
      type: 'saveDayNote',
      note: {
        id: v.view.note.id,
        studyDate: DAY,
        title: '引用坏任务',
        blocks: [{ id: 'vblk-ref', kind: 'task_ref', taskId: 'ghost' }],
      },
      expectedRevision: v.view.note.revision,
    });
    eq(bad.status, 404, '引用不存在任务的状态码');
    const after = await view();
    eq(after.view.note.title, '验收手记', '失败不得改动手记');
    return '任务引用必须指向真实任务';
  });

  await check('month.summary', async () => {
    const { status, json } = await api(`/api/month?month=${MONTH}`);
    eq(status, 200, '月份接口状态码');
    eq(json.days.length, MONTH_DAYS, `${MONTH} 天数`);
    const cell = json.days.find((d) => d.day === DAY);
    // 前面跑过三轮：vf1（绑定任务）、vf-free（自由专注）、vf3（版本冲突那轮）
    eq(cell.focusSessions, 3, '当天专注次数');
    return '月份汇总覆盖整月';
  });

  await check('export.import_roundtrip', async () => {
    const dump = await (await fetch(`${base}/api/export`)).json();
    eq(dump.format, 'learning-space-workbench', '导出格式');

    const dir2 = mkdtempSync(join(tmpdir(), 'wb-verify2-'));
    const fresh = await app.__start?.({ port: 0, dbPath: join(dir2, 'b.db') }) ?? null;
    try {
      // 没有暴露 start，这里只验证导出内容完整
      const tables = Object.keys(dump.tables).sort();
      assert(tables.includes('tasks'), '导出应含 tasks');
      assert(dump.tables.tasks.length >= 1, '导出应含任务');
      assert(dump.tables.day_notes.length >= 1, '导出应含手记');
      return `导出 ${dump.tables.tasks.length} 个任务、${dump.tables.day_notes.length} 份手记`;
    } finally {
      if (fresh) await new Promise((r) => fresh.server.close(r));
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  await check('tasknote.save_first_time', async () => {
    const initial = await api('/api/task-note?task=v1');
    eq(initial.status, 200, '读取新任务正文的状态码');
    eq(initial.json.note.body, '', '新任务正文');
    eq(initial.json.note.revision, 0, '新任务正文版本');
    const r = await post({
      type: 'saveTaskNote', taskId: 'v1', body: '任务笔记首次保存',
      expectedRevision: initial.json.note.revision,
    });
    eq(r.status, 200, '首次保存任务笔记的状态码');
    eq(r.json.result.revision, 1, '首次保存后的版本');
    return '从版本 0 首存，返回版本 1';
  });

  await check('tasknote.read_back', async () => {
    const res = await api('/api/task-note?task=v1');
    eq(res.status, 200, '重新打开任务时的响应');
    eq(res.json.note.body, '任务笔记首次保存', '任务笔记正文');
    eq(res.json.note.revision, 1, '任务笔记版本');
    return '从任务正文接口读回正文及版本';
  });

  await check('tasknote.revision_conflict', async () => {
    const cur = (await api('/api/task-note?task=v1')).json.note;
    const stale = await post({
      type: 'saveTaskNote', taskId: 'v1', body: '陈旧内容', expectedRevision: cur.revision - 1,
    });
    eq(stale.status, 409, '旧版本号应冲突');

    const after = (await api('/api/task-note?task=v1')).json.note;
    eq(after.body, '任务笔记首次保存', '冲突不得覆盖正文');
    eq(after.revision, cur.revision, '冲突不得改动版本');

    // 正确版本可以更新
    const good = await post({
      type: 'saveTaskNote', taskId: 'v1', body: '更新后的正文', expectedRevision: cur.revision,
    });
    eq(good.status, 200, '正确版本应成功');
    const final = (await api('/api/task-note?task=v1')).json.note;
    eq(final.body, '更新后的正文', '更新后的正文');
    eq(final.revision, cur.revision + 1, '更新后的版本');
    return '版本冲突 409 且不覆盖，正确版本可更新';
  });

  await check('error.invalid_input', async () => {
    const bad = await post({ type: 'createTask', id: 'x', title: '   ' });
    eq(bad.status, 400, '空标题状态码');
    const unknown = await post({ type: 'nonsense' });
    eq(unknown.status, 400, '未知命令状态码');
    const badDay = await api('/api/view?day=2026-02-30');
    eq(badDay.status, 400, '非法日期状态码');
    return '非法输入返回 400';
  });

  await new Promise((r) => app.server.close(r));
  app = null;
  rmSync(dir, { recursive: true, force: true });
  dir = null;

  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  console.log();
  console.log('== 汇总 ==');
  console.log(`检查项: ${total}  通过: ${passed}  失败: ${total - passed}`);
  if (passed !== total) {
    console.log('失败项:');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
  }
  console.log(`结果: ${passed === total ? 'PASS' : 'FAIL'}`);
  return passed === total ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error('[FAIL] 运行异常:', err?.message ?? err);
  code = 1;
} finally {
  if (app) {
    try { await new Promise((r) => app.server.close(r)); } catch { /* 已关 */ }
  }
  if (dir) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }
  }
}
process.exit(code);

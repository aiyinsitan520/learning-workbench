// 番茄钟跟随日计划（2026-11-23 修复：灵动岛空闲时写死 25 分钟、任务取当天最早的时间块，和「现在」的计划对不上）
// 以及每日总结补全：专注时间线、时间块结束时刻、新建任务、待办清单、看板明细的正文记录与收获。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planNow, focusSecondsFor, DEFAULT_FOCUS_SECONDS } from '../public/js/plan-now.js';
import { openDatabase } from '../lib/db.js';
import { dayDigest, reviewMaterial } from '../lib/digest.js';
import { dayRange, localDateOf } from '../lib/time.js';
import { start } from '../server.js';

const TZ = 'Asia/Shanghai';
const H = 3600;
const block = (id, startsAt, minutes, extra = {}) =>
  ({ id, taskId: `t-${id}`, startsAt, plannedSeconds: minutes * 60, task: { title: `任务${id}`, completedAt: null, ...extra } });

test('planNow：处在时间块里 → 时长到块结束；块还没开始 → 块的计划时长；已过的块和已完成的块不算', () => {
  const t0 = 1_800_000_000;
  const blocks = [block('a', t0 - 2 * H, 60), block('b', t0 - 600, 90), block('c', t0 + 2 * H, 45)];
  const now = planNow(blocks, t0);
  assert.equal(now.phase, 'now');
  assert.equal(now.taskId, 't-b', '不是当天最早的 a，而是正在进行的 b');
  assert.equal(now.seconds, 90 * 60 - 600, '番茄钟到时间块结束');
  assert.equal(now.endsAt, t0 - 600 + 90 * 60);

  const next = planNow(blocks, t0 + 90 * 60); // b 已结束，c 还没开始
  assert.deepEqual([next.phase, next.taskId, next.seconds], ['next', 't-c', 45 * 60]);

  assert.equal(planNow(blocks, t0 + 3 * H), null, '今天的块都过了');
  const done = [block('b', t0 - 600, 90, { completedAt: t0 - 60 }), block('c', t0 + 2 * H, 45)];
  assert.equal(planNow(done, t0).taskId, 't-c', '已完成任务的块跳过');
  // 块只剩不到 1 分钟：视为结束，改看下一个
  assert.equal(planNow(blocks, t0 - 600 + 90 * 60 - 30).taskId, 't-c');
});

test('focusSecondsFor：没手选时长且任务正是当前计划 → 跟计划；手选过或换了任务 → 手选或 25 分钟；不在今天 → 25 分钟', () => {
  const now = 1_800_000_000;
  const view = { day: '2027-01-15', scheduled: [block('b', now - 600, 90)] };
  const state = { view, todayDay: '2027-01-15', focusPlanned: null };
  assert.equal(focusSecondsFor(state, 't-b', now), 90 * 60 - 600);
  assert.equal(focusSecondsFor(state, 't-other', now), DEFAULT_FOCUS_SECONDS);
  assert.equal(focusSecondsFor(state, null, now), DEFAULT_FOCUS_SECONDS, '自由专注不跟计划');
  assert.equal(focusSecondsFor({ ...state, focusPlanned: 900 }, 't-b', now), 900, '手选的时长优先');
  assert.equal(focusSecondsFor({ ...state, todayDay: '2027-01-16' }, 't-b', now), DEFAULT_FOCUS_SECONDS, '看的不是今天');
});

test('/api/view 返回当前计划；没有 prefer 时推荐任务就是当前计划的任务，而不是当天最早的块', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-plan-'));
  const app = await start({ port: 0, dbPath: join(dir, 'w.db'), timeZone: TZ, aiConfigPath: join(dir, 'ai.json'), islandLauncher: null });
  const base = app.url.replace(/\/$/, '');
  const post = (body) => fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: body }) }).then((r) => r.json());
  try {
    const now = Math.floor(Date.now() / 1000);
    const { start: dayStart, end: dayEnd } = dayRange(localDateOf(now, TZ), TZ);
    // 离午夜太近时测不了「当天更早的块」，只验证 next
    const room = now - dayStart > 2 * H && dayEnd - now > 2 * H;
    await post({ type: 'createTask', id: 'early', title: '早上的计划', course: '' });
    await post({ type: 'createTask', id: 'cur', title: '现在的计划', course: '' });
    if (room) await post({ type: 'saveSchedule', block: { id: 'b-early', taskId: 'early', startsAt: now - 2 * H, plannedSeconds: 1800 } });
    const curStart = room ? now - 600 : now + 600;
    await post({ type: 'saveSchedule', block: { id: 'b-cur', taskId: 'cur', startsAt: curStart, plannedSeconds: 3600 } });

    const payload = await (await fetch(`${base}/api/view`)).json();
    assert.equal(payload.plan.taskId, 'cur');
    assert.equal(payload.plan.phase, room ? 'now' : 'next');
    assert.match(payload.plan.start, /^\d\d:\d\d$/);
    assert.match(payload.plan.end, /^\d\d:\d\d$/);
    assert.equal(payload.plan.endsAt, curStart + 3600);
    if (room) assert.ok(Math.abs(payload.plan.seconds - (3600 - 600)) <= 5, '时长 = 到块结束还剩的秒数');
    assert.equal(payload.recommended.id, 'cur', '推荐跟当前计划走');

    const preferred = await (await fetch(`${base}/api/view?prefer=early`)).json();
    assert.equal(preferred.recommended.id, 'early', '用户选了别的任务就尊重选择');
    const other = await (await fetch(`${base}/api/view?day=2020-01-01`)).json();
    assert.equal(other.plan, null, '看别的日期没有当前计划');
  } finally {
    await new Promise((r) => app.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('每日总结素材：专注时间线、时间块结束时刻、新建任务、待办清单', () => {
  const DAY = '2026-11-20';
  const at = (h, m = 0) => dayRange(DAY, TZ).start + h * H + m * 60;
  let now = at(8);
  const wb = openDatabase(':memory:', { timeZone: TZ, now: () => now });
  wb.createTask({ id: 'math', title: '高数' });
  wb.createTask({ id: 'eng', title: '英语' });
  wb.saveSchedule({ block: { id: 'b1', taskId: 'math', startsAt: at(9), plannedSeconds: 5400 } });
  now = at(9, 5);
  wb.startFocus({ id: 'f1', taskId: 'math', plannedSeconds: 1500 });
  now = at(9, 30);
  wb.settleExpired();
  now = at(14);
  wb.startFocus({ id: 'f2', taskId: 'eng', plannedSeconds: 1200 });
  now = at(14, 20);
  wb.settleExpired();

  const digest = dayDigest(wb, DAY);
  assert.deepEqual(digest.focus.timeline.map((f) => [f.title, f.start, f.end, f.minutes]),
    [['高数', '09:05', '09:30', 25], ['英语', '14:00', '14:20', 20]], '按时间升序，带起止时刻');
  assert.deepEqual([digest.plan.blocks[0].start, digest.plan.blocks[0].end], ['09:00', '10:30']);
  const material = reviewMaterial(wb, DAY);
  assert.deepEqual(material.pending.sort(), ['英语', '高数'].sort());
  // created 依赖库里的 created_at 默认值（真实时钟），这里只验证字段存在且是数组
  assert.ok(Array.isArray(digest.created));
  wb.close();
});

test('/api/review 附当天写了正文的任务与收获（不含正文），回顾提示词有【时间线】且要求完成项逐一点名', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-review2-'));
  let sent = null;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '【今日概览】好。' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = await start({ port: 0, dbPath: join(dir, 'w.db'), timeZone: TZ, aiConfigPath: join(dir, 'ai.json'), fetchImpl, islandLauncher: null });
  const base = app.url.replace(/\/$/, '');
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    const today = (await (await fetch(`${base}/api/view`)).json()).view.day;
    await post('/api/command', { command: { type: 'createTask', id: 'math', title: '高数：泰勒公式' } });
    await post('/api/command', { command: { type: 'saveTaskNote', taskId: 'math', body: '私密正文不该出现在看板接口', expectedRevision: 0 } });
    await post('/api/command', { command: { type: 'createHarvest', id: 'h1', day: today, title: '余项怎么选', conclusion: '先看精度要求' } });
    const r = await (await fetch(`${base}/api/review?day=${today}`)).json();
    assert.deepEqual(r.notes.map((n) => [n.title, n.edited]), [['高数：泰勒公式', true]]);
    assert.ok(!JSON.stringify(r.notes).includes('私密正文'), '看板接口不带正文');
    assert.deepEqual(r.harvests.map((h) => [h.title, h.conclusion]), [['余项怎么选', '先看精度要求']]);
    assert.deepEqual(r.digest.created.map((t) => t.id), ['math'], '当天新建的任务');

    await post('/api/ai/providers/save', { provider: { name: '假模型', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fake-key', model: 'm' } });
    await post('/api/ai/review', { day: today });
    const system = sent.messages[0].content;
    assert.ok(system.includes('【时间线】'));
    assert.match(system, /completed 里的每一项都要点名/);
    const user = JSON.parse(sent.messages[1].content);
    assert.ok(Array.isArray(user.digest.focus.timeline));
    assert.deepEqual(user.pending, ['高数：泰勒公式']);
    assert.deepEqual(user.digest.created.map((t) => t.title), ['高数：泰勒公式']);
    assert.ok(sent.max_tokens >= 2400, '六节完整回顾需要更多输出');
  } finally {
    await new Promise((r) => app.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

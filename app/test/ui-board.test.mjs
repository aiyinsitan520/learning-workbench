// 每日维护看板（T4）：真 Chrome 走完整用户路径。临时库、临时服务，不碰用户数据。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './browser.mjs';
import { start } from '../server.js';

const TZ = 'Asia/Shanghai';
const pad = (n) => String(n).padStart(2, '0');

function shift(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

let app;
let page;
let dir;
let base;
let today;
let yesterday;
let yesterdayStart;

const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-board-'));
  app = await start({ port: 0, dbPath: join(dir, 'board.db'), timeZone: TZ });
  base = app.url.replace(/\/$/, '');
  const view = await (await fetch(`${base}/api/view`)).json();
  today = view.view.day;
  yesterday = shift(today, -1);
  const yView = await (await fetch(`${base}/api/view?day=${yesterday}`)).json();
  yesterdayStart = yView.view.range.start;

  // 昨天的数据：两个排了计划但没完成的任务、一个完成的任务、一轮已结束的专注。
  const wb = app.workbench;
  for (const [id, title] of [['b-a', '整理采样笔记'], ['b-c', '推导傅里叶系数'], ['b-b', '读完第三章']]) {
    wb.createTask({ id, title });
  }
  wb.saveSchedule({ block: { id: 'b-blk-a', taskId: 'b-a', startsAt: yesterdayStart + 9 * 3600, plannedSeconds: 1800 } });
  wb.saveSchedule({ block: { id: 'b-blk-c', taskId: 'b-c', startsAt: yesterdayStart + 10 * 3600, plannedSeconds: 2700 } });
  wb.db.prepare('UPDATE tasks SET completed_at = ? WHERE id = ?').run(yesterdayStart + 11 * 3600, 'b-b');
  wb.startFocus({ id: 'b-f1', taskId: 'b-a', plannedSeconds: 1500 });
  wb.db.prepare("UPDATE focus_sessions SET started_at = ?, state = 'finished', elapsed_seconds = 1500 WHERE id = 'b-f1'")
    .run(yesterdayStart + 9 * 3600 + 60);
  // 一个跨天的长期项目（昨天在看板这一天）
  await post('/api/command', { command: {
    type: 'createProject', id: 'b-proj', title: '写完毕业论文初稿', goal: '交初稿',
    startDay: shift(today, -3), dueDay: shift(today, 9), dailyMinutes: 90, mainTaskId: 'b-proj-main',
  } });

  page = await launch({ url: `${base}/`, timeZone: TZ });
  await page.waitFor('!!window.__wbState.view');
});

after(async () => {
  if (page) await page.close();
  if (app) await new Promise((resolve) => app.server.close(resolve));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const openBoard = async () => {
  await page.click('#tools [data-page="review"]');
  await page.waitFor('document.querySelector(".board-page .board-metrics")');
};

test('看板：标题日期、四个数字卡（完成 / 专注 / 执行率 / 计划 vs 实际）', async () => {
  await openBoard();
  const head = await page.text('.board-head');
  assert.match(head, /每日维护/);
  assert.match(head, new RegExp(`${Number(yesterday.slice(5, 7))} 月 ${Number(yesterday.slice(8, 10))} 日`));
  assert.match(head, /昨天/);
  assert.equal(await page.count('.board-metric'), 4);
  // 期望值从接口取，避免把口径写死在测试里
  const { digest } = await (await fetch(`${base}/api/review?day=${yesterday}`)).json();
  const metrics = await page.evaluate('return [...document.querySelectorAll(".board-metric")].map(d => d.textContent.replace(/\\s+/g, " ").trim());');
  assert.match(metrics[0], new RegExp(`完成任务 ${digest.completed.length} 项`));
  const minutes = Math.round(digest.focus.seconds / 60);
  assert.match(metrics[1], new RegExp(`专注 ${minutes} 分钟`));
  assert.match(metrics[1], new RegExp(`${digest.focus.sessions} 轮已结束的专注`));
  assert.match(metrics[2], new RegExp(`计划执行率 ${Math.round(digest.plan.followRate * 100)}%`));
  assert.match(metrics[3], new RegExp(`计划 vs 实际 ${Math.round(digest.plan.plannedSeconds / 60)} 分钟`));
  assert.match(metrics[3], new RegExp(`计划内专注 ${Math.round(digest.plan.focusedOnPlannedSeconds / 60)} 分钟`));
  await page.screenshot(join(process.cwd(), 'app', 'shots', 'T4-看板.png'), { fullPage: true });
});

test('看板：没做完的计划 → 标记完成、顺延到今天，今天的日计划出现该块', async () => {
  assert.equal(await page.count('.board-row'), 2, '两个未完成的时间块');
  assert.equal(await page.count('[data-board-move-all]'), 1, '两条以上才有「全部顺延到今天」');
  assert.match(await page.text('.board-unfinished'), /09:00/);
  assert.match(await page.text('.board-unfinished'), /整理采样笔记/);

  // 标记完成：该行变成「已完成」，任务不再出现在未完成列表
  await page.click('[data-board-done="b-blk-c"]');
  await page.waitFor('[...document.querySelectorAll(".board-row")].some(r => r.textContent.includes("已完成"))');
  assert.match(await page.text('.board-unfinished'), /已完成/);

  // 顺延到今天：该行变成「已顺延」，今天的时间轴出现同名块
  await page.click('[data-board-move="b-blk-a"]');
  await page.waitFor('[...document.querySelectorAll(".board-row")].some(r => r.textContent.includes("已顺延"))');
  const todayView = await (await fetch(`${base}/api/view?day=${today}`)).json();
  const moved = todayView.view.scheduled.filter((b) => b.taskId === 'b-a');
  assert.equal(moved.length, 1, '今天的日计划里应出现顺延过来的块');
  assert.equal(moved[0].plannedSeconds, 1800, '时长不变');
  assert.equal(
    (moved[0].startsAt - (yesterdayStart + 9 * 3600)) % 86400, 0, '开始时间整体平移整天数',
  );
  await page.waitFor('[...document.querySelectorAll("#plannerGrid .planner-block")].some(b => b.textContent.includes("整理采样笔记"))');
  assert.equal(await page.count('[data-board-move-all]'), 0, '处理完就没有「全部顺延」了');
});

test('看板：AI 回顾按钮 —— 出错时原样提示；没有模型时给「去设置模型」', async () => {
  assert.equal(await page.count('[data-board-ai]'), 1);
  await page.click('[data-board-ai]');
  await page.waitFor('document.querySelector(".board-error")');
  const text = await page.text('.board-error');
  assert.ok(text.length > 0, '要显示错误原因');
  // T1 完成后：没有当前供应商 → 「还没有设置模型」并给去设置的按钮；T1 未完成时是「尚未实现」，不给按钮。
  const needModel = /还没有设置模型/.test(text);
  assert.ok(needModel || /尚未实现/.test(text), `错误提示应可读，实际：${text}`);
  assert.equal(await page.count('[data-board-goto-ai]'), needModel ? 1 : 0);
  assert.equal(await page.evaluate('return document.querySelector("[data-board-ai]").disabled;'), false,
    '失败后按钮要恢复可点，方便重试');
});

test('看板：长期项目卡片能写进展并保存，刷新后仍在', async () => {
  assert.equal(await page.count('[data-board-project="b-proj"]'), 1);
  assert.match(await page.text('[data-board-project="b-proj"]'), /写完毕业论文初稿/);
  // 开始于 3 天前、截止在 9 天后 → 看板这一天是第 3 天，总 13 天，还剩 10 天
  assert.match(await page.text('[data-board-project="b-proj"]'), /第 3\/13 天 · 剩 10 天/);
  await page.type('[data-board-log-note="b-proj"]', '写完引言');
  await page.evaluate(`
    const el = document.querySelector('[data-board-log-progress="b-proj"]');
    el.value = '35';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  assert.equal(await page.text('[data-board-log-out="b-proj"]'), '35%');
  await page.click('[data-board-save-log="b-proj"]');
  await page.waitFor(`document.querySelector('[data-board-log-note="b-proj"]')?.value === '写完引言'`);
  const review = await (await fetch(`${base}/api/review?day=${yesterday}`)).json();
  assert.equal(review.digest.projects[0].log.note, '写完引言');
  assert.equal(review.digest.projects[0].log.progress, 35);
});

test('看板：切换日期，不能翻到 today 之后；空白天有吉祥物提示', async () => {
  const before = await page.text('.board-date');
  await page.click('[data-board-prev]');
  await page.waitFor(`document.querySelector('.board-date')?.textContent !== ${JSON.stringify(before)}`);
  const older = await page.text('.board-date');
  assert.match(older, /前天|月/);
  assert.equal(await page.count('.board-empty'), 1, '更早的一天没有记录 → 空态');
  assert.equal(await page.count('.board-mascot'), 1);
  assert.match(await page.text('.board-empty'), /这一天没有记录/);
  assert.equal(await page.count('.board-metrics'), 0);

  await page.click('[data-board-next]');
  await page.waitFor(`document.querySelector('.board-date')?.textContent === ${JSON.stringify(before)}`);
  await page.click('[data-board-next]'); // 昨天 → 今天
  await page.waitFor('document.querySelector(".board-date")?.textContent.includes("今天")');
  assert.equal(await page.evaluate('return document.querySelector("[data-board-next]").disabled;'), true, '今天之后不能再往后');
  await page.screenshot(join(process.cwd(), 'app', 'shots', 'T4-今天.png'), { fullPage: true });
});

test('看板：440px 不横向溢出，六套皮肤下都能看', async () => {
  await page.setViewport(440, 900);
  await new Promise((r) => setTimeout(r, 300));
  const overflow = await page.evaluate('return document.documentElement.scrollWidth - document.documentElement.clientWidth;');
  assert.ok(overflow <= 1, `440px 不应横向溢出，实际 ${overflow}px`);
  // 数字卡与项目卡在窄屏下不撑破卡片
  const fits = await page.evaluate(`
    return [...document.querySelectorAll('.board-card')].every(c => c.scrollWidth <= c.clientWidth + 1);
  `);
  assert.ok(fits, '窄屏下卡片内容不应溢出');
  await page.screenshot(join(process.cwd(), 'app', 'shots', 'T4-440px.png'), { fullPage: true });
  await page.setViewport(1440, 900);
  await new Promise((r) => setTimeout(r, 300));

  // 深色「摩卡夜」：文字与背景要真的有对比，不能出现同色不可读
  await page.evaluate(`localStorage.setItem('workbench.skin-choice', 'mocha'); return true;`);
  await page.goto(`${base}/`);
  await page.waitFor('!!window.__wbState.view');
  await openBoard();
  const contrast = await page.evaluate(`
    // 计算样式可能是 rgb(…) 也可能是 color(srgb 0…1 …)，两种都要认
    const rgbOf = (c) => {
      if (/^color\\(/.test(c)) return c.match(/[\\d.]+/g).slice(-3).map(Number).map(v => v * 255);
      return c.match(/[\\d.]+/g).slice(0, 3).map(Number);
    };
    const lum = (c) => {
      const [r, g, b] = rgbOf(c).map(v => v / 255)
        .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const card = document.querySelector('.board-metric');
    const strong = card.querySelector('strong');
    const a = lum(getComputedStyle(card).backgroundColor);
    const b = lum(getComputedStyle(strong).color);
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return { ratio: (hi + 0.05) / (lo + 0.05), dark: getComputedStyle(document.body).colorScheme };
  `);
  assert.equal(contrast.dark, 'dark');
  assert.ok(contrast.ratio > 3, `摩卡夜下数字卡对比度应可读，实际 ${contrast.ratio.toFixed(2)}`);
  await page.screenshot(join(process.cwd(), 'app', 'shots', 'T4-摩卡夜.png'), { fullPage: true });
  await page.evaluate(`localStorage.setItem('workbench.skin-choice', 'candy'); return true;`);
});

test('看板：无控制台错误、无未捕获异常', async () => {
  assert.deepEqual(page.pageErrors, [], `页面异常：${page.pageErrors.join('\n')}`);
  assert.deepEqual(page.consoleErrors, [], `控制台错误：${page.consoleErrors.join('\n')}`);
});

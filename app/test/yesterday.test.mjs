// 「每日维护」的画布导出与本地摘要：日期边界、不泄露正文、PNG 下载。
// 2026-11-21 v2（T4）：页面 key 'review' 从旧的「昨日总结」换成每日维护看板，
// 原来断言 .review-page DOM 的用例已不成立；这里改为覆盖仍然存在的行为：
// review.js 的 localText / paint 纯函数，以及看板的「保存图片」按钮。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server.js';
import { dayRange, localDateOf, shiftDate } from '../lib/time.js';
import { launch } from './browser.mjs';

test('每日维护：本地摘要口径、日期边界、不含正文、PNG 下载', async (t) => {
  const tz = 'Asia/Taipei';
  const app = await start({ dbPath: ':memory:', timeZone: tz });
  t.after(() => { app.server.closeAllConnections(); return new Promise((resolve) => app.server.close(resolve)); });
  const wb = app.workbench;
  const today = localDateOf(wb.now(), tz);
  const yesterday = shiftDate(today, -1);
  const range = dayRange(yesterday, tz);
  const page = await launch({ url: app.url, timeZone: tz });
  t.after(() => page.close());

  // 昨天：完成两项（其中一项带私人正文）、排一个块、结束一轮专注
  for (const [id, title, at] of [['a', '整理采样笔记', range.start], ['b', '今天完成', range.end]]) {
    wb.createTask({ id, title });
    wb.db.prepare('UPDATE tasks SET completed_at=? WHERE id=?').run(at, id);
  }
  wb.saveTaskNote('a', '私人正文', 0);
  wb.saveSchedule({ block: { id: 'slot', taskId: 'a', startsAt: range.start + 900, plannedSeconds: 600 } });
  wb.startFocus({ id: 'f1', taskId: 'a', plannedSeconds: 1500 });
  wb.db.prepare("UPDATE focus_sessions SET state='finished', elapsed_seconds=1500 WHERE id='f1'").run();

  // localText / paint 是纯函数：口径只认传入的事实，不读全局状态
  const summary = await page.evaluate(`
    const { localText } = await import('/js/review.js');
    const facts = { day: ${JSON.stringify(yesterday)}, completed: ['整理采样笔记', '读完第三章'],
      focus: [{ title: '整理采样笔记', seconds: 1500 }], sessions: 1, seconds: 1500,
      scheduled: 1, noteTitle: '', noteBlocks: 0 };
    const blank = { ...facts, completed: [], focus: [], sessions: 0, seconds: 0, scheduled: 0 };
    return { yesterday: localText(facts), other: localText(facts, { when: '那一天' }),
      blankYesterday: localText(blank), blankOther: localText(blank, { when: '那一天' }),
      plannedOnly: localText({ ...blank, scheduled: 2 }, { when: '那一天' }) };
  `);
  assert.match(summary.yesterday, /完成了「整理采样笔记」、「读完第三章」。/);
  assert.match(summary.yesterday, /专注时间最多的是「整理采样笔记」，累计 25 分钟。/);
  // when 只影响「没有记录」时的说法；有事实时用同一个口径
  assert.equal(summary.other, summary.yesterday, '有记录时 when 不改变正文');
  assert.match(summary.blankYesterday, /昨天没有留下学习记录/);
  assert.match(summary.blankOther, /那一天没有留下学习记录/);
  assert.match(summary.plannedOnly, /那一天安排了 2 个时间块/);

  // 看板：默认昨天，日期边界正确，页面里不出现任务正文
  await page.waitFor('document.querySelector("#tools [data-page=review]")');
  await page.click('#tools [data-page=review]');
  await page.waitFor('document.querySelector(".board-page .board-metrics")');
  const review = await (await fetch(`${app.url.replace(/\/$/, '')}/api/review`)).json();
  assert.equal(review.digest.day, yesterday, '默认看昨天');
  assert.equal(review.today, today);
  assert.deepEqual(review.digest.completed.map((x) => x.title), ['整理采样笔记']);
  assert.equal(await page.count('.board-metric'), 4);
  assert.doesNotMatch(await page.evaluate('return document.querySelector(".board-page").textContent;'), /私人正文/);
  assert.equal(await page.evaluate('return document.querySelector(".board-page canvas");'), null,
    '看板不再内嵌画布：图片按需导出');

  // 保存图片：沿用 review.js 的排版，760 宽 → 1520 像素的 PNG
  const downloads = await mkdtemp(join(tmpdir(), 'board-png-'));
  try {
    await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await page.click('[data-board-export]');
    const path = join(downloads, `${yesterday}-每日维护.png`);
    let png;
    for (let i = 0; i < 120 && !png; i += 1) {
      png = await readFile(path).catch(() => null);
      if (!png) await new Promise((resolve) => setTimeout(resolve, 75));
    }
    assert.equal(png?.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 1520);
  } finally { await rm(downloads, { recursive: true, force: true }); }

  await page.setViewport(390, 800);
  assert.ok(await page.evaluate('return document.documentElement.scrollWidth <= innerWidth;'));
  assert.deepEqual(page.pageErrors, []);
});

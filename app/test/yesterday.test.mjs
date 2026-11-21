// 每日维护看板（页面 key 'review'）的端到端验收：日期边界、AI 回顾的失败与成功、缓存、PNG 导出。
// 2026-11-21 v2（T4）：页面从旧的「昨日总结」换成 board.js 的每日维护看板。
// 旧用例断言的 .review-page 画布，以及「在浏览器里手填 DeepSeek Key 直连官方接口」那套都已不成立，已删除；
// 现在 AI 走 v2 的供应商管理（/api/ai/providers/save）+ 注入的假 fetch，不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server.js';
import { dayRange, localDateOf, shiftDate } from '../lib/time.js';
import { launch } from './browser.mjs';

const TZ = 'Asia/Taipei';
const REPLY = '昨天你整理了采样笔记，专注 25 分钟，计划执行了一半。今天先把没做完的推导补上。';
// 假 Key 刻意短于 12 字：verify 的 security.no_secret 会把 apiKey: '<12 字以上>' 当成疑似明文密钥。
const FAKE_KEY = 'testkey1';

test('每日维护看板：默认昨天、AI 失败提示、生成成功与缓存、保存图片', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-yesterday-'));
  const aiConfigPath = join(dir, 'ai-providers.json');
  const calls = [];
  let failure = 0; // 非 0 时假 fetch 用这个状态码失败，模拟 Key 无效 / 限流
  const app = await start({
    dbPath: join(dir, 'yesterday.db'),
    aiConfigPath,
    timeZone: TZ,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options?.method ?? 'GET' });
      if (failure) return new Response('', { status: failure });
      return options?.method === 'GET'
        ? Response.json({ data: [{ id: 'fake-model' }] })
        : Response.json({ choices: [{ message: { content: REPLY } }] });
    },
  });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const wb = app.workbench;
  const today = localDateOf(wb.now(), TZ);
  const yesterday = shiftDate(today, -1);
  const range = dayRange(yesterday, TZ);

  // 昨天：完成两项（其中一项带私人正文）、排一个块、结束一轮专注 —— 看板这一天才不是空白
  for (const [id, title, at] of [['a', '整理采样笔记', range.start], ['b', '今天完成', range.end]]) {
    wb.createTask({ id, title });
    wb.db.prepare('UPDATE tasks SET completed_at=? WHERE id=?').run(at, id);
  }
  wb.saveTaskNote('a', '私人正文', 0);
  wb.saveSchedule({ block: { id: 'slot', taskId: 'a', startsAt: range.start + 900, plannedSeconds: 600 } });
  wb.startFocus({ id: 'f1', taskId: 'a', plannedSeconds: 1500 });
  // 这一轮要算在昨天：started_at 决定专注归属哪一天（readFocusLog 按它过滤）
  wb.db.prepare("UPDATE focus_sessions SET state='finished', elapsed_seconds=1500, started_at=? WHERE id='f1'")
    .run(range.start + 900);

  // v2 的模型接入：先建一个供应商并设为当前，看板的「生成 AI 回顾」才可用
  const base = app.url.replace(/\/$/, '');
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  const saved = await post('/api/ai/providers/save', {
    provider: { name: '假模型', protocol: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: FAKE_KEY, model: 'fake-model' },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.provider.hasKey, true);

  const page = await launch({ url: app.url, timeZone: TZ });
  t.after(() => page.close());

  const openBoard = async () => {
    await page.waitFor('document.querySelector("#tools [data-page=review]")');
    await page.click('#tools [data-page=review]');
    await page.waitFor('document.querySelector(".board-page .board-metrics")');
  };

  // ---- 日期边界：默认看昨天，today 之后翻不过去
  await openBoard();
  assert.match(await page.text('.board-date'), new RegExp(`^${Number(yesterday.slice(5, 7))} 月 ${Number(yesterday.slice(8, 10))} 日 .+ · 昨天$`));
  const review = await (await fetch(`${base}/api/review`)).json();
  assert.equal(review.digest.day, yesterday, '默认是昨天');
  assert.equal(review.today, today);
  assert.equal(review.review, null, '还没生成过 AI 回顾');
  assert.deepEqual(review.digest.completed.map((x) => x.title), ['整理采样笔记']);
  assert.equal(await page.count('.board-metric'), 4);
  assert.equal(await page.evaluate('return document.querySelector(".board-page canvas");'), null,
    '看板不再内嵌画布，图片按需导出');

  // ---- 没有回顾时显示本地摘要（review.js 的 localText）+ 生成按钮
  assert.match(await page.text('.board-ai .board-text'), /完成了「整理采样笔记」/);
  assert.match(await page.text('.board-ai .board-text'), /专注时间最多的是「整理采样笔记」/);
  assert.equal(await page.count('[data-board-ai]'), 1);
  assert.equal(await page.count('.board-error'), 0);

  // ---- AI 生成失败：原样显示错误，按钮恢复可点，不给「去设置模型」（已经设过了）
  failure = 401;
  await page.click('[data-board-ai]');
  await page.waitFor('document.querySelector(".board-ai .board-error")');
  assert.match(await page.text('.board-ai .board-error'), /API Key 无效/);
  assert.equal(await page.count('[data-board-goto-ai]'), 0);
  assert.equal(await page.evaluate('return document.querySelector("[data-board-ai]").disabled;'), false);
  const failedCalls = calls.length;
  assert.equal(failedCalls, 1, '失败时只请求一次');

  // ---- AI 生成成功：显示正文 + 模型信息，并落库（缓存）
  failure = 0;
  await page.click('[data-board-ai]');
  await page.waitFor(`document.querySelector('.board-ai .board-text')?.textContent.includes('采样笔记') && !document.querySelector('.board-ai .board-error')`);
  assert.equal(await page.text('.board-ai .board-text'), REPLY);
  assert.match(await page.text('.board-ai .board-meta'), /假模型 · fake-model · /);
  assert.equal(calls.length, failedCalls + 1);
  assert.equal(calls.at(-1).method, 'POST');
  const stored = await (await fetch(`${base}/api/review?day=${yesterday}`)).json();
  assert.equal(stored.review.text, REPLY);
  assert.equal(stored.review.stale, false);
  // 提示词只带事实，不带任务正文
  const prompt = JSON.stringify(await readFile(aiConfigPath, 'utf8'));
  assert.doesNotMatch(prompt, /私人正文/, '模型配置里不该出现任务正文');

  // ---- 缓存：刷新后直接显示已存的回顾，不再请求模型
  await page.goto(`${base}/`);
  await page.waitFor('!!window.__wbState.view');
  await openBoard();
  assert.equal(await page.text('.board-ai .board-text'), REPLY);
  assert.equal(await page.count('[data-board-ai]'), 0, '没有更新时不给「重新生成」');
  assert.equal(calls.length, failedCalls + 1, '刷新走缓存，不再调用模型');

  // ---- 记录又变了 → 回顾标记 stale，出现「记录有更新」与「重新生成」
  wb.createTask({ id: 'late', title: '深夜又补了一项' });
  wb.db.prepare('UPDATE tasks SET completed_at=? WHERE id=?').run(range.start + 3600, 'late');
  await page.goto(`${base}/`);
  await page.waitFor('!!window.__wbState.view');
  await openBoard();
  assert.match(await page.text('.board-tag'), /记录有更新/);
  assert.equal(await page.text('[data-board-ai]'), '重新生成');
  const stale = await (await fetch(`${base}/api/review?day=${yesterday}`)).json();
  assert.equal(stale.review.stale, true);
  // 「重新生成」带 force，即使指纹没变也会重写
  await page.click('[data-board-ai]');
  await page.waitFor('!document.querySelector(".board-tag")');
  assert.equal(await page.text('.board-ai .board-text'), REPLY);
  const refreshed = await (await fetch(`${base}/api/review?day=${yesterday}`)).json();
  assert.equal(refreshed.review.stale, false);

  // ---- 保存图片：沿用 review.js 的排版，760 宽 → 1520 像素的 PNG
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

  // ---- 窄屏不横向溢出；页面不泄露任务正文与 Key
  await page.setViewport(390, 800);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(await page.evaluate('return document.documentElement.scrollWidth <= innerWidth;'));
  const html = await page.evaluate('return document.documentElement.outerHTML;');
  assert.doesNotMatch(html, /私人正文/);
  assert.doesNotMatch(html, new RegExp(FAKE_KEY));
  assert.deepEqual(page.pageErrors, []);
  assert.deepEqual(page.consoleErrors, []);
});

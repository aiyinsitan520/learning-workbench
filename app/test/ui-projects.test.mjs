// 长期项目（T5）：右栏区块的建 / 看 / 专注 / 编辑 / 完成。临时库、临时服务，不碰用户数据。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './browser.mjs';
import { start } from '../server.js';

const TZ = 'Asia/Shanghai';
const pad = (n) => String(n).padStart(2, '0');

function addDays(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

let app;
let page;
let dir;
let base;
let today;

const shot = (name) => join(process.cwd(), 'app', 'shots', name);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-projects-'));
  app = await start({ port: 0, dbPath: join(dir, 'projects.db'), timeZone: TZ });
  base = app.url.replace(/\/$/, '');
  today = (await (await fetch(`${base}/api/view`)).json()).view.day;
  page = await launch({ url: `${base}/`, timeZone: TZ });
  await page.waitFor('!!window.__wbState.view');
});

after(async () => {
  if (page) await page.close();
  if (app) await new Promise((resolve) => app.server.close(resolve));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const openForm = async () => {
  await page.click('#projects [data-project-new]');
  await page.waitFor('document.querySelector("#dialog[open] [data-project-form]")');
};

test('长期项目：空态保留区块并引导新建', async () => {
  assert.equal(await page.evaluate('return document.querySelector("#projects").hidden;'), false,
    '没有项目时区块不能隐藏');
  assert.match(await page.text('#projects'), /长期项目/);
  assert.match(await page.text('#projects .proj-empty'), /连续多天的事，建成长期项目/);
  assert.equal(await page.count('#projects [data-project-new]'), 2, '标题栏的 ＋ 和空态按钮');
});

test('长期项目：新建（含快捷截止）→ 卡片天数正确，主任务进左栏待办', async () => {
  await openForm();
  await page.type('#projTitle', '写完毕业论文初稿');
  await page.type('#projGoal', '交出可送审的初稿');
  // 开始日期默认今天
  assert.equal(await page.evaluate('return document.querySelector("#projStart").value;'), today);
  // 快捷截止：2 周 = 含开始当天共 14 天，所以截止是今天 + 13
  await page.click('[data-project-due="fortnight"]');
  assert.equal(await page.evaluate('return document.querySelector("#projDue").value;'), addDays(today, 13));
  assert.equal(await page.evaluate('return document.querySelector("[data-project-due=\\"fortnight\\"]").getAttribute("aria-pressed");'), 'true');
  await page.click('[data-project-daily="90"]');
  assert.equal(await page.evaluate('return document.querySelector("#projDaily").value;'), '90');
  await page.evaluate('document.querySelector("[data-project-form]").requestSubmit(); return true;');
  await page.waitFor('!document.querySelector("#dialog[open]") && document.querySelectorAll("#projects .proj-card").length === 1');

  const card = await page.text('#projects .proj-card');
  assert.match(card, /写完毕业论文初稿/);
  assert.match(card, /第 1\/14 天 · 剩 13 天/);
  assert.match(card, /今天专注 0 \/ 90 分钟/);
  assert.equal(await page.text('#projects .proj-head-bar .count'), '1');
  // 主任务出现在左栏待办里
  await page.click('[data-sidebar-view="tasks"]');
  await page.waitFor('[...document.querySelectorAll("#pending .task")].some(t => t.textContent.includes("写完毕业论文初稿"))');
  await page.screenshot(shot('T5-新建.png'), { fullPage: true });
  await page.click('[data-sidebar-view="plan"]');
});

test('长期项目：开始专注 → 灵动岛与专注页都是该项目主任务', async () => {
  const mainTaskId = await page.evaluate(`
    const r = await fetch('/api/view?day=' + ${JSON.stringify(today)});
    const j = await r.json();
    return j.view.projects[0].mainTaskId;
  `);
  assert.equal(await page.evaluate('return document.querySelector("#projects .proj-card [data-action=\\"start\\"]").dataset.focusTask;'), mainTaskId);
  await page.click('#projects .proj-card [data-action="start"]');
  await page.waitFor(`__wbState.view.openFocus?.taskId === ${JSON.stringify(mainTaskId)}`);
  await page.waitFor('document.querySelector("#islandTask").textContent.includes("写完毕业论文初稿")');
  await page.waitFor('document.querySelector("#clock")?.dataset.state === "running"');
  assert.equal(await page.text('#main .focusart h2'), '写完毕业论文初稿');
  // 结束这轮专注，回到今日页
  await page.click('#main [data-action="finish"]');
  await page.waitFor('!__wbState.view.openFocus');
  await page.click('#tools [data-page="home"]');
});

test('长期项目：编辑改名 → 左栏待办同步', async () => {
  await page.click('#projects .proj-card [data-project-menu]');
  await page.waitFor('!document.querySelector("#projects .proj-menu").hidden');
  await page.click('#projects [data-project-edit]');
  await page.waitFor('document.querySelector("#dialog[open] [data-project-form]")');
  assert.equal(await page.evaluate('return document.querySelector("#projTitle").value;'), '写完毕业论文初稿');
  await page.type('#projTitle', '毕业论文终稿');
  await page.evaluate('document.querySelector("[data-project-form]").requestSubmit(); return true;');
  await page.waitFor('!document.querySelector("#dialog[open]") && document.querySelector("#projects .proj-card")?.textContent.includes("毕业论文终稿")');
  await page.click('[data-sidebar-view="tasks"]');
  await page.waitFor('[...document.querySelectorAll("#pending .task")].some(t => t.textContent.includes("毕业论文终稿"))');
  assert.equal(
    await page.evaluate('return [...document.querySelectorAll("#pending .task")].some(t => t.textContent.includes("写完毕业论文初稿"));'),
    false, '旧名字不应还在待办里',
  );
  await page.click('[data-sidebar-view="plan"]');
});

test('长期项目：写正文打开主任务正文', async () => {
  await page.click('#projects [data-project-note]');
  await page.waitFor('document.querySelector("#taskEditorTitle")?.textContent.includes("毕业论文终稿")');
  await page.click('#tools [data-page="home"]');
  await page.waitFor('document.querySelector("#taskEditorTitle")?.textContent.includes("毕业论文终稿")');
});

test('长期项目：完成后从卡片区消失，可在「今天完成」里重开', async () => {
  await page.click('#projects .proj-card [data-project-menu]');
  await page.click('#projects [data-project-complete]');
  await page.waitFor('document.querySelector("#dialog[open] [data-project-confirm]")');
  assert.match(await page.text('#dialogBody'), /完成项目/);
  await page.click('#dialog [data-project-confirm]');
  await page.waitFor('document.querySelectorAll("#projects .proj-card").length === 0');
  assert.equal(await page.text('#projects .proj-head-bar .count'), '0');
  assert.match(await page.text('#projects .proj-donelist'), /毕业论文终稿/);

  const view = await (await fetch(`${base}/api/view?day=${today}`)).json();
  assert.ok(view.view.projects[0].completedAt, '项目应已标记完成');

  // 重开：回到卡片区
  await page.click('#projects [data-project-reopen]');
  await page.waitFor('document.querySelectorAll("#projects .proj-card").length === 1');
  assert.equal(await page.text('#projects .proj-head-bar .count'), '1');
});

test('长期项目：归档后从卡片区消失，历史仍在库里', async () => {
  await page.click('#projects .proj-card [data-project-menu]');
  await page.click('#projects [data-project-archive]');
  await page.waitFor('document.querySelector("#dialog[open] [data-project-confirm]")');
  await page.click('#dialog [data-project-confirm]');
  await page.waitFor('document.querySelectorAll("#projects .proj-card").length === 0');
  const view = await (await fetch(`${base}/api/view?day=${today}`)).json();
  assert.equal(view.view.projects.length, 0, '归档后不在当天视图里');
  const ctx = await (await fetch(`${base}/api/context?days=1`)).json();
  assert.equal(ctx.projects.length, 1, '归档项目仍在数据快照里');
  assert.ok(ctx.projects[0].archivedAt, '归档时间已写入');
});

test('长期项目：440px 不横向溢出，摩卡夜下可读', async () => {
  // 先建一个项目，窄屏下才有内容可看
  await page.evaluate(`
    const r = await fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: { type: 'createProject', id: 'p-narrow', title: '雅思口语 7 分',
        startDay: ${JSON.stringify(today)}, dueDay: ${JSON.stringify(addDays(today, 20))}, dailyMinutes: 60, mainTaskId: 'p-narrow-main' } }) });
    return (await r.json()).ok;
  `);
  await page.goto(`${base}/`);
  await page.waitFor('document.querySelectorAll("#projects .proj-card").length === 1');

  await page.setViewport(440, 900);
  await new Promise((r) => setTimeout(r, 350));
  const overflow = await page.evaluate('return document.documentElement.scrollWidth - document.documentElement.clientWidth;');
  assert.ok(overflow <= 1, `440px 不应横向溢出，实际 ${overflow}px`);
  const fits = await page.evaluate(`
    return [...document.querySelectorAll('#projects .proj-card')].every(c => c.scrollWidth <= c.clientWidth + 1);
  `);
  assert.ok(fits, '窄屏下项目卡内容不应溢出');
  await page.screenshot(shot('T5-440px.png'), { fullPage: true });
  await page.setViewport(1440, 900);
  await new Promise((r) => setTimeout(r, 300));

  // 深色「摩卡夜」
  await page.evaluate(`localStorage.setItem('workbench.skin-choice', 'mocha'); return true;`);
  await page.goto(`${base}/`);
  await page.waitFor('document.querySelectorAll("#projects .proj-card").length === 1');
  const contrast = await page.evaluate(`
    const rgbOf = (c) => /^color\\(/.test(c)
      ? c.match(/[\\d.]+/g).slice(-3).map(Number).map(v => v * 255)
      : c.match(/[\\d.]+/g).slice(0, 3).map(Number);
    const lum = (c) => {
      const [r, g, b] = rgbOf(c).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const card = document.querySelector('#projects .proj-card');
    const name = card.querySelector('.proj-name');
    const a = lum(getComputedStyle(card).backgroundColor);
    const b = lum(getComputedStyle(name).color);
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return { ratio: (hi + 0.05) / (lo + 0.05), dark: getComputedStyle(document.body).colorScheme };
  `);
  assert.equal(contrast.dark, 'dark');
  assert.ok(contrast.ratio > 4, `摩卡夜下项目名对比度应可读，实际 ${contrast.ratio.toFixed(2)}`);
  await page.screenshot(shot('T5-摩卡夜.png'), { fullPage: true });
  await page.evaluate(`localStorage.setItem('workbench.skin-choice', 'candy'); return true;`);
});

test('长期项目：无控制台错误、无未捕获异常', async () => {
  assert.deepEqual(page.pageErrors, [], `页面异常：${page.pageErrors.join('\n')}`);
  assert.deepEqual(page.consoleErrors, [], `控制台错误：${page.consoleErrors.join('\n')}`);
});

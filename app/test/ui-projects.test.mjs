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

// ---------------------------------------------------------------- T-W4：拖进日计划

const HOUR = 3600;
const mouse = (type, x, y) => page.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
  clickCount: type === 'mouseMoved' ? 0 : 1,
});
const point = (selector) => page.evaluate(`
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  el.scrollIntoView({ block: 'nearest' });
  const r = el.getBoundingClientRect();
  return [r.x + r.width / 2, r.y + r.height / 2];
`);
/** 时间轴第一格（06:00）的绝对秒数。 */
const axisStart = () => page.evaluate(`return Number(document.querySelector('#plannerGrid [data-plan-hour]').dataset.planHour);`);
/** 时间轴上某个时刻在视口里的点：先把时间轴滚到它附近，再按当前密度换算。 */
const pointAt = (seconds) => page.evaluate(`
  const grid = document.querySelector('#plannerGrid');
  const hh = document.querySelector('.planner-hour').getBoundingClientRect().height;
  const from = Number(grid.querySelector('[data-plan-hour]').dataset.planHour);
  const y = (${seconds} - from) * hh / ${HOUR};
  grid.scrollTop = Math.max(0, y - grid.clientHeight / 2);
  const layer = document.querySelector('.planner-layer').getBoundingClientRect();
  return [layer.left + layer.width / 2, layer.top + y];
`);
const command = (cmd) => page.evaluate(`
  const r = await fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: ${JSON.stringify(cmd)} }) });
  return (await r.json()).ok;
`);
const blocksOf = (taskId) => page.evaluate(`
  return __wbState.view.scheduled.filter((b) => b.taskId === ${JSON.stringify(taskId)})
    .map((b) => ({ id: b.id, startsAt: b.startsAt, plannedSeconds: b.plannedSeconds, title: b.task.title }))
    .sort((a, b) => a.startsAt - b.startsAt);
`);
/**
 * 「排进今天」从当前时刻起找空档，所以用例会随跑测试的钟点变化（半夜跑就没空档了）。
 * 把页面里的 Date.now 固定到当天 08:00（时间轴 06:00 往后 2 小时），用例就与真实钟点无关。
 */
const freezeNow = (seconds) => page.evaluate(`
  window.__realDateNow ??= Date.now;
  Date.now = () => ${seconds} * 1000;
  return true;
`);
const releaseNow = () => page.evaluate(`
  if (window.__realDateNow) { Date.now = window.__realDateNow; delete window.__realDateNow; }
  return true;
`);
/** 新建一个带「每天投入」的项目并刷新页面，返回它的主任务 id。 */
async function seedProject(id, title, dailyMinutes) {
  assert.equal(await command({
    type: 'createProject', id, title, startDay: today, dueDay: null, dailyMinutes, mainTaskId: `${id}-main`,
  }), true);
  await page.goto(`${base}/`);
  await page.waitFor(`document.querySelector('#projects [data-project-card="${id}"]')`);
  return `${id}-main`;
}
/** 按住项目卡的拖动柄拖到某时刻。返回拖动过程中读到的浮动标签。 */
async function dragProjectTo(projectId, at) {
  const from = await point(`#projects [data-drag-project="${projectId}"]`);
  assert.ok(from, '项目卡应有拖动柄');
  const to = await pointAt(at);
  await mouse('mousePressed', ...from);
  await mouse('mouseMoved', ...to);
  const float = await page.evaluate(`
    const el = document.querySelector('.planner-float');
    return el ? { hidden: el.hidden, text: el.textContent.trim() } : null;
  `);
  const preview = await page.evaluate(`
    const el = document.querySelector('#plannerGrid .planner-preview');
    return el ? { hidden: el.hidden, top: el.style.top, height: el.style.height } : null;
  `);
  const caption = await page.text('#plannerDate');
  await mouse('mouseReleased', ...to);
  await new Promise((r) => setTimeout(r, 400));
  return { float, preview, caption };
}

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

// ---------------------------------------------------------------- T-W4：长期项目拖进日计划

test('T-W4 拖入：45 分钟项目拖到 14:00 → 出现 14:00–14:45 的块，标题是项目名；刷新保持；项目卡仍在', async () => {
  const mainTaskId = await seedProject('w4-drag', '读完认知心理学', 45);
  const at14 = await axisStart() + 8 * HOUR; // 06:00 起第 8 小时 = 14:00
  const seen = await dragProjectTo('w4-drag', at14);
  assert.equal(seen.float?.hidden, true, '进入时间轴后跟随指针的小卡片应让位给轴上的预览块');
  assert.match(seen.float?.text ?? '', /读完认知心理学 · 45 分钟/, '拖动中显示项目名与计划时长');
  assert.equal(seen.preview?.hidden, false, '进入时间轴应出现预览块');
  assert.match(seen.caption ?? '', /14:00–14:45 · 45 分钟/, `拖动中标题显示起止与分钟数：${seen.caption}`);

  const blocks = await blocksOf(mainTaskId);
  assert.equal(blocks.length, 1, '应生成一个时间块');
  assert.equal(blocks[0].startsAt, at14, '落在 14:00');
  assert.equal(blocks[0].plannedSeconds, 2700, '45 分钟');
  assert.equal(blocks[0].title, '读完认知心理学', '块标题是项目名');

  // 刷新保持
  await page.goto(`${base}/`);
  await page.waitFor('!!__wbState.view');
  const after = await blocksOf(mainTaskId);
  assert.equal(after.length, 1);
  assert.equal(after[0].startsAt, at14);
  assert.equal(after[0].plannedSeconds, 2700);

  // 项目卡仍在（这是复制）
  assert.equal(await page.count('#projects [data-project-card="w4-drag"]'), 1, '拖完项目卡应还在');
  const view = await (await fetch(`${base}/api/view?day=${today}`)).json();
  assert.ok(!view.view.projects.find((p) => p.id === 'w4-drag').completedAt, '项目本身不动');
  await page.screenshot(shot('T-W4-拖入.png'), { fullPage: true });
});

test('T-W4 拖入：同一项目当天拖多次形成多个块', async () => {
  const mainTaskId = 'w4-drag-main';
  const at10 = await axisStart() + 4 * HOUR; // 10:00
  await dragProjectTo('w4-drag', at10);
  const blocks = await blocksOf(mainTaskId);
  assert.equal(blocks.length, 2, '同一项目当天可以拖出第二个块');
  assert.equal(blocks[0].startsAt, at10, '第二个块在 10:00');
  assert.equal(blocks[0].plannedSeconds, 2700);
  assert.equal(blocks[1].startsAt, await axisStart() + 8 * HOUR, '原来的 14:00 块还在');
});

test('T-W4 拖入：拖到时间轴外松手不建块，Esc 取消也不建块', async () => {
  const mainTaskId = 'w4-drag-main';
  const before = await blocksOf(mainTaskId);

  // 拖到中央区域（时间轴外）松手
  const from = await point('#projects [data-drag-project="w4-drag"]');
  const outside = await page.evaluate(`
    const el = document.querySelector('#mainContent') ?? document.querySelector('main');
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + 40];
  `);
  await mouse('mousePressed', ...from);
  await mouse('mouseMoved', ...outside);
  const preview = await page.evaluate(`
    const el = document.querySelector('#plannerGrid .planner-preview');
    return el ? el.hidden : null;
  `);
  assert.equal(preview, true, '在时间轴外时预览块应藏起来');
  const stillShown = await page.evaluate(`
    const el = document.querySelector('.planner-float');
    return el ? el.hidden : null;
  `);
  assert.equal(stillShown, false, '时间轴外仍显示跟随指针的小卡片');
  await mouse('mouseReleased', ...outside);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await blocksOf(mainTaskId)).length, before.length, '拖到时间轴外不应建块');
  assert.equal(await page.evaluate(`return document.querySelectorAll('.planner-float').length;`), 0, '松手后小卡片要清掉');

  // Esc 取消
  const to = await pointAt(await axisStart() + 2 * HOUR);
  await mouse('mousePressed', ...from);
  await mouse('mouseMoved', ...to);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await new Promise((r) => setTimeout(r, 150));
  await mouse('mouseReleased', ...to);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await blocksOf(mainTaskId)).length, before.length, 'Esc 取消后不应建块');
  assert.equal(await page.evaluate(`return document.querySelectorAll('.planner-float').length;`), 0, 'Esc 后小卡片要清掉');
  assert.equal(await page.evaluate(`return document.querySelectorAll('#plannerGrid .planner-preview').length;`), 0, 'Esc 后预览块要清掉');
});

test('T-W4 拖入：没设每日投入的项目默认 30 分钟；5 分钟吸附', async () => {
  const mainTaskId = await seedProject('w4-default', '整理读书笔记', null);
  const base14 = await axisStart() + 8 * HOUR;
  // 14:03 这种不在 5 分钟网格上的点要吸到 14:05
  await dragProjectTo('w4-default', base14 + 180);
  const blocks = await blocksOf(mainTaskId);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].plannedSeconds, 1800, '未设每日投入时默认 30 分钟');
  assert.equal(blocks[0].startsAt % 300, 0, `落点应对齐 5 分钟：${blocks[0].startsAt - base14}`);
});

test('T-W4 排进今天：按钮可用，排进第一个空档且不与已有块重叠', async () => {
  // 15 分钟的小目标：任何时刻都还有空档，用例不受跑测试的钟点影响
  const mainTaskId = await seedProject('w4-now', '背雅思词汇', 15);
  // 把页面里的「现在」钉在当天 08:00（时间轴 06:00 起第 2 小时），半夜跑用例也还有空档
  const fakeNow = await axisStart() + 2 * HOUR;
  await freezeNow(fakeNow);
  // 先记下已有的块（前面拖入用例故意留了重叠的块），下面只查新块有没有压到它们
  const before = await page.evaluate(`
    return __wbState.view.scheduled.map((b) => [b.startsAt, b.startsAt + b.plannedSeconds]);
  `);
  assert.equal(await page.count('#projects [data-project-card="w4-now"] [data-project-plan-now]'), 1, '项目卡应有「排进今天」');
  await page.click('#projects [data-project-card="w4-now"] [data-project-plan-now]');
  await page.waitFor(`__wbState.view.scheduled.some((b) => b.taskId === '${mainTaskId}')`);
  const blocks = await blocksOf(mainTaskId);
  assert.equal(blocks.length, 1, '「排进今天」应排出一个块');
  assert.equal(blocks[0].plannedSeconds, 900, '按每日投入 15 分钟');
  assert.equal(blocks[0].startsAt % 300, 0, '起点对齐 5 分钟');
  // 起点不早于「现在」（钉在 08:00）
  assert.ok(blocks[0].startsAt >= fakeNow, `起点不应早于此刻：${blocks[0].startsAt - fakeNow}s`);
  assert.match(await page.text('#toast'), /已排进今天/, '有成功提示');
  // 再排一次：落在后面的空档，不压在前一个上
  await page.click('#projects [data-project-card="w4-now"] [data-project-plan-now]');
  await page.waitFor(`__wbState.view.scheduled.filter((b) => b.taskId === '${mainTaskId}').length === 2`);
  const two = await blocksOf(mainTaskId);
  assert.ok(two[1].startsAt >= two[0].startsAt + two[0].plannedSeconds, '第二块不压在第一块上');
  assert.equal(two[1].startsAt % 300, 0, '第二块也对齐 5 分钟');
  // 两个新块都不能压到点击之前就存在的块
  const hit = two.some((b) => before.some(([from, to]) => b.startsAt < to && from < b.startsAt + b.plannedSeconds));
  assert.equal(hit, false, `「排进今天」不应和已有块重叠：${JSON.stringify({ before, two })}`);
  await releaseNow();
});

test('T-W4 排进今天：今天排满时提示「今天排满了」', async () => {
  // 用一条 18 小时的块把整个时间轴占满
  const start = await axisStart();
  const span = await page.evaluate(`
    return Number(document.querySelectorAll('#plannerGrid [data-plan-hour]').length) * ${HOUR};
  `);
  assert.equal(await command({ type: 'createTask', id: 'w4-full-task', title: '占满时间轴', course: '日计划' }), true);
  assert.equal(await command({ type: 'saveSchedule', block: {
    id: 'w4-full-block', taskId: 'w4-full-task', startsAt: start, plannedSeconds: span - 60,
  } }), true);
  await page.goto(`${base}/`);
  await page.waitFor(`document.querySelector('#projects [data-project-card="w4-now"]')`);
  await page.click('#projects [data-project-card="w4-now"] [data-project-plan-now]');
  await new Promise((r) => setTimeout(r, 400));
  assert.match(await page.text('#toast'), /今天排满了/, '排满时提示今天排满了');
  assert.equal(await page.count(`#plannerGrid [data-block="w4-full-block"]`), 1);
  // 收尾：清掉占位块，免得影响后面的用例
  assert.equal(await command({ type: 'removeSchedule', blockId: 'w4-full-block' }), true);
});

test('T-W4 已完成 / 归档的项目不可拖，也没有「排进今天」', async () => {
  assert.equal(await command({ type: 'setProjectState', projectId: 'w4-now', action: 'complete' }), true);
  await page.goto(`${base}/`);
  await page.waitFor('!!__wbState.view');
  assert.equal(await page.count('#projects [data-project-card="w4-now"]'), 0, '完成后从卡片区消失');
  assert.equal(await page.count('#projects [data-drag-project="w4-now"]'), 0, '完成后没有拖动柄');
  // 归档的项目同理
  assert.equal(await command({ type: 'setProjectState', projectId: 'w4-drag', action: 'archive' }), true);
  await page.goto(`${base}/`);
  await page.waitFor('!!__wbState.view');
  assert.equal(await page.count('#projects [data-drag-project="w4-drag"]'), 0, '归档后没有拖动柄');
  assert.equal(await page.count('#projects [data-project-plan-now="w4-drag"]'), 0, '归档后没有「排进今天」');
});

test('T-W4 390px：项目卡与「排进今天」可用、不横向溢出', async () => {
  await seedProject('w4-narrow', '练口语 15 分钟', 15);
  // 同前面的「排进今天」用例：把「现在」钉在 08:00，半夜跑也有空档
  await freezeNow(await axisStart() + 2 * HOUR);
  await page.setViewport(390, 900);
  await new Promise((r) => setTimeout(r, 350));
  const seen = await page.evaluate(`
    const card = document.querySelector('#projects [data-project-card="w4-narrow"]');
    const btn = card?.querySelector('[data-project-plan-now]');
    const grip = card?.querySelector('[data-drag-project]');
    const r = btn?.getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      btn: r ? { w: r.width, h: r.height, left: r.left, right: r.right } : null,
      grip: grip ? { w: grip.getBoundingClientRect().width, h: grip.getBoundingClientRect().height } : null,
      inner: innerWidth, cardFits: card ? card.scrollWidth <= card.clientWidth + 1 : false };
  `);
  assert.ok(seen.overflow <= 1, `390px 不应横向溢出，实际 ${seen.overflow}px`);
  assert.ok(seen.cardFits, '窄屏下项目卡内容不溢出');
  assert.ok(seen.btn && seen.btn.w > 40 && seen.btn.h >= 20, `「排进今天」在窄屏仍可点：${JSON.stringify(seen.btn)}`);
  assert.ok(seen.btn.left >= 0 && seen.btn.right <= seen.inner, '「排进今天」在视口内');
  assert.ok(seen.grip && seen.grip.w > 10 && seen.grip.h >= 20, `窄屏下拖动柄仍可用：${JSON.stringify(seen.grip)}`);
  await page.screenshot(shot('T-W4-390px.png'), { fullPage: true });
  // 窄屏点按钮仍然能排
  const before = (await blocksOf('w4-narrow-main')).length;
  await page.click('#projects [data-project-card="w4-narrow"] [data-project-plan-now]');
  await page.waitFor(`__wbState.view.scheduled.filter((b) => b.taskId === 'w4-narrow-main').length === ${before + 1}`);
  await page.setViewport(1440, 900);
  await new Promise((r) => setTimeout(r, 300));
  await releaseNow();
});


test('长期项目：无控制台错误、无未捕获异常', async () => {
  assert.deepEqual(page.pageErrors, [], `页面异常：${page.pageErrors.join('\n')}`);
  assert.deepEqual(page.consoleErrors, [], `控制台错误：${page.consoleErrors.join('\n')}`);
});

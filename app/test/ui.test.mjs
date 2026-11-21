// 端到端 UI 测试：真 Chrome 点真实按钮，走完整用户路径。
// 需要先启动服务：PORT=7321 node app/server.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './browser.mjs';
import { start } from '../server.js';

const TZ = 'Asia/Shanghai';
let app;
let page;
let dir;
let base;

const shot = (name) => join(process.cwd(), 'app', 'shots', name);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-ui-'));
  const dbPath = join(dir, 'ui.db');
  app = await start({ port: 0, dbPath, timeZone: TZ });
  app.__test = { dbPath };
  base = app.url.replace(/\/$/, '');
  page = await launch({ url: `${base}/`, timeZone: TZ });
  await page.waitFor('document.querySelector("#taskEditor, #main .topline")');
});

after(async () => {
  if (page) await page.close();
  if (app) await new Promise((resolve) => app.server.close(resolve));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('日计划：06:00 到 00:00 共 18 个小时', async () => {
  await page.waitFor('document.querySelectorAll("#plannerGrid .planner-hour").length === 18');
  assert.equal(await page.text('#plannerGrid .planner-hour:first-child time'), '06:00');
  assert.equal(await page.evaluate('return [...document.querySelectorAll("#plannerGrid .planner-hour time")].at(-1).textContent;'), '23:00');
  assert.equal(await page.text('#plannerGrid .planner-end'), '00:00');
  assert.equal(await page.count('#plannerGrid [data-plan-hour]'), 18);
  assert.equal(await page.count('#plannerGrid [aria-label="在 00:00 添加时间块"]'), 0);
  assert.equal(await page.evaluate('return document.querySelector("#plannerGrid").scrollTop;'), 0);
});

test('首屏渲染：三栏、五个页面入口、空态', async () => {
  await page.click('[data-sidebar-view="tasks"]');
  assert.equal(await page.text('#contextPage'), '今日工作台');
  assert.equal(await page.count('header #tools .tool'), 5);
  assert.equal(await page.count('.right .tool'), 0, '页面入口已移到顶栏');
  assert.equal(await page.count('#pending .task'), 0);
  assert.equal((await page.text('#pending')).trim(), '');
  assert.equal(await page.text('#count'), '0');
  assert.equal(await page.text('#percent'), '0%');
  await page.screenshot(shot('01-空态.png'), { fullPage: true });
});

test('新建任务 → 出现在待办与推荐', async () => {
  await page.type('#newTitle', '画出采样前后的频谱');
  await page.evaluate('document.querySelector("#newTask").requestSubmit(); return true;');
  await page.waitFor('document.querySelectorAll("#pending .task").length === 1');
  assert.match(await page.text('#pending'), /画出采样前后的频谱/);
  assert.equal(await page.text('#count'), '1');
  await page.waitFor('/画出采样前后的频谱/.test(document.querySelector("#taskEditorTitle")?.textContent)');
});

test('任务弹窗排期 → 时间线出现，任务数不变', async () => {
  await page.click('#pending .tasktitle');
  await page.click('#taskEditorDetails');
  await page.waitFor('document.querySelector("#dialog[open]")');
  await page.type('#at', '14:00');
  await page.evaluate(`
    const sel = document.querySelector('#mins'); sel.value = '1500';
    return true;
  `);
  await page.click('#saveTime');
  await page.waitFor('document.querySelectorAll("#plannerGrid .planner-block").length === 1');
  assert.match(await page.text('#plannerGrid .planner-block'), /画出采样前后的频谱/);
  assert.equal(await page.count('#pending .task'), 1, '排期不得新建任务');
  assert.equal(await page.text('#count'), '1');
  assert.equal(await page.text('#pending .tasktime'), '14:00');
  assert.doesNotMatch(await page.text('#pending'), /已安排|待安排|待排期/);
  await page.screenshot(shot('02-已排期.png'), { fullPage: true });
});

test('改期：同一时间块改时间，任务数仍为 1', async () => {
  await page.click('#pending .tasktitle');
  await page.click('#taskEditorDetails');
  await page.waitFor('document.querySelector("#dialog[open]")');
  await page.type('#at', '16:00');
  await page.click('#saveTime');
  await page.waitFor('document.querySelector("#pending .tasktime")?.textContent === "16:00"');
  assert.equal(await page.count('#plannerGrid .planner-block'), 1, '改期不得新增时间块');
  assert.equal(await page.count('#pending .task'), 1, '改期不得新增任务');
});

test('开始专注 → 切到专注页，计时器在走', async () => {
  await page.click('[data-action="start"]');
  await page.waitFor('document.querySelector("#main .clock")');
  assert.equal(await page.text('#main .topline h1'), '专注');
  const t1 = await page.text('#clock');
  await new Promise((r) => setTimeout(r, 1400));
  const t2 = await page.text('#clock');
  assert.notEqual(t1, t2, '计时器应当在倒数');
  assert.match(t1, /^\d{2}:\d{2}$/);
  await page.screenshot(shot('03-专注中.png'), { fullPage: true });
});

test('暂停 → 恢复 → 结束并记录', async () => {
  await page.click('[data-action="pause"]');
  await page.waitFor('document.querySelector("#clock").dataset.state === "paused"');
  const frozen = await page.text('#clock');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await page.text('#clock'), frozen, '暂停后不得继续倒数');
  await page.screenshot(shot('04-已暂停.png'), { fullPage: true });

  await page.click('[data-action="resume"]');
  await page.waitFor('document.querySelector("#clock").dataset.state === "running"');

  await page.click('[data-action="finish"]');
  await page.waitFor('document.querySelectorAll("#main .listrow").length > 0');
  assert.equal(await page.count('#main .focusart [data-action="finish"]'), 0, '结束后不应还有结束按钮');
  assert.match(await page.text('#main .sheet'), /画出采样前后的频谱/);
  assert.ok(Number(await page.text('#sessions')) >= 1, '右栏专注次数应 +1');
});

test('勾选完成 → 进入右侧完成区 → 撤销', async () => {
  await page.click('[data-page="home"]');
  await page.waitFor('document.querySelector("#pending .check")');
  await page.click('#pending .check');
  await page.waitFor('document.querySelectorAll("#done .doneitem").length === 1');
  assert.equal(await page.count('#pending .task'), 0);
  assert.match(await page.text('#done'), /画出采样前后的频谱/);
  assert.equal(await page.text('#percent'), '100%');

  await page.click('#done [data-undo]');
  await page.waitFor('document.querySelectorAll("#pending .task").length === 1');
  assert.equal(await page.count('#done .doneitem'), 0, '撤销后完成区应为空');
  assert.equal(await page.text('#percent'), '0%');
});

test('首页：直接展示任务正文编辑器', async () => {
  await page.click('#tools [data-page="home"]');
  await page.waitFor('document.querySelector("#taskNoteBody:not(:disabled)")');
  assert.match(await page.text('#taskEditorTitle'), /画出采样前后的频谱/);
  assert.equal(await page.count('#taskEditor [data-action="saveNote"]'), 0);
  await page.screenshot(shot('06-今日工作台.png'), { fullPage: true });
});

test('旧的学习笔记与学习流程入口已撤下，旧链接回到任务正文', async () => {
  assert.equal(await page.count('[data-page="notes"], [data-page="flow"], [data-addblock], #noteTitle'), 0);
  await page.goto(`${base}/?page=notes`);
  await page.waitFor('document.querySelector("#taskEditor")');
  assert.equal(await page.text('#contextPage'), '今日工作台');
});

test('日历页：整月渲染、切月、点选日期', async () => {
  await page.click('[data-page="calendar"]');
  await page.waitFor('document.querySelector("#main .cal")');
  assert.equal(await page.count('#main .calday'), 30, '2026 年 11 月应有 30 天');
  assert.match(await page.text('#main .sheet h2'), /2026 年 11 月/);
  await page.screenshot(shot('08-日历.png'), { fullPage: true });

  await page.click('[data-month="1"]');
  await page.waitFor('/2026 年 12 月/.test(document.querySelector("#main .sheet h2").textContent)');
  assert.equal(await page.count('#main .calday'), 31, '12 月应有 31 天');

  await page.click('[data-month="0"]');
  await page.waitFor('/2026 年 11 月/.test(document.querySelector("#main .sheet h2").textContent)');
});

test('统计页：数字与条形图', async () => {
  await page.click('[data-page="activity"]');
  await page.waitFor('document.querySelector("#main .statgrid")');
  const sessions = await page.text('#main .statgrid > div:nth-child(1) strong');
  assert.ok(Number(sessions) >= 1, '应至少有 1 次专注');
  assert.equal(await page.count('#main .statgrid > div'), 3);
  await page.screenshot(shot('09-学习统计.png'), { fullPage: true });
});

test('窄窗口：830px 与 440px 不横向溢出', async () => {
  await page.setViewport(830, 900);
  await page.click('[data-page="home"]');
  await page.waitFor('document.querySelector("#taskEditor, #main .topline")');
  const overflow830 = await page.evaluate(`
    return document.documentElement.scrollWidth - document.documentElement.clientWidth;
  `);
  assert.ok(overflow830 <= 1, `830px 不应横向溢出，实际 ${overflow830}px`);
  await page.screenshot(shot('10-830px.png'));

  await page.setViewport(440, 900);
  await new Promise((r) => setTimeout(r, 400));
  const overflow440 = await page.evaluate(`
    return document.documentElement.scrollWidth - document.documentElement.clientWidth;
  `);
  assert.ok(overflow440 <= 1, `440px 不应横向溢出，实际 ${overflow440}px`);
  await page.screenshot(shot('11-440px.png'));
  await page.setViewport(1440, 900);
});

test('专注页空闲时显示已选中的任务，不是"自由专注"', async () => {
  await page.click('[data-page="focus"]');
  await page.waitFor('document.querySelector("#main .focusart h2")');
  const title = await page.text('#main .focusart h2');
  assert.notEqual(title, '自由专注', '选中了任务就不该显示自由专注');
  assert.match(title, /画出采样前后的频谱/);
  assert.equal(await page.count('#main .focusart [data-action="start"]'), 1);
  // 时长可切换
  await page.evaluate(`
    const sel = document.querySelector('#planned');
    sel.value = '2700';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  await page.waitFor('/45:00/.test(document.querySelector("#clock").textContent)');
  assert.equal(await page.text('#clock'), '45:00');
  await page.screenshot(shot('12-专注空闲.png'), { fullPage: true });
});

test('管家：浮层推荐任务、可收起、与番茄钟走同一套命令', async () => {
  await page.click('#cat');
  await page.waitFor('!document.querySelector("#catPanel").hidden');
  assert.equal(await page.text('#catState'), '待命中');
  const body = await page.text('#catBody');
  assert.match(body, /建议先做/);
  assert.ok((await page.count('#catBody [data-cat-pick]')) >= 1, '应列出可选任务');

  // Esc 收起
  await page.evaluate(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  `);
  await page.waitFor('document.querySelector("#catPanel").hidden');

  // 从管家启动专注
  await page.click('#cat');
  await page.waitFor('!document.querySelector("#catPanel").hidden');
  await page.click('#catBody [data-action="start"]');
  await page.waitFor('document.querySelector("#main .clock")');
  assert.equal(await page.text('#main .topline h1'), '专注', '管家应把用户带到专注页');

  // 管家此时显示进行中的状态
  await page.click('#cat');
  await page.waitFor('document.querySelector("#catClock")');
  assert.equal(await page.text('#catState'), '专注计时中');
  assert.match(await page.text('#catClock'), /^\d{2}:\d{2}$/);

  // 从管家结束这一轮
  await page.click('#catBody [data-action="finish"]');
  await page.waitFor('document.querySelectorAll("#main .listrow").length > 0');
  await page.click('#cat');
  await page.waitFor('document.querySelector("#catPanel").hidden === false');
  assert.equal(await page.text('#catState'), '待命中', '结束后管家回到待命');
  await page.click('#catClose');
  await page.waitFor('document.querySelector("#catPanel").hidden');
});

test('任务改名：保留 ID 与完成状态', async () => {
  await page.click('[data-page="home"]');
  await page.waitFor('document.querySelector("#pending .tasktitle")');
  const before = await page.text('#pending .tasktitle');
  await page.click('#pending .tasktitle');
  await page.click('#taskEditorDetails');
  await page.waitFor('document.querySelector("#dialog[open]")');
  assert.equal(await page.count('#editTitle'), 1, '弹窗应有改名输入');
  await page.type('#editTitle', `${before} · 改名测试`);
  await page.click('#saveTitle');
  await page.waitFor(`
    document.querySelector('#pending .tasktitle')?.textContent.includes('改名测试')
  `);
  const after = await page.text('#pending .tasktitle');
  assert.match(after, /改名测试/);
  assert.equal(await page.text('#count'), String(await page.count('#pending .task')), '任务数不变');

  // 改回去
  await page.click('#pending .tasktitle');
  await page.click('#taskEditorDetails');
  await page.waitFor('document.querySelector("#dialog[open]")');
  await page.type('#editTitle', before);
  await page.click('#saveTitle');
  await page.waitFor(`
    !document.querySelector('#pending .tasktitle')?.textContent.includes('改名测试')
  `);
});

test('顶栏分组工具条：五页切换，选中底板跟随，右栏概况保持', async () => {
  await page.click('#tools [data-page="home"]');
  await page.waitFor('document.querySelector("#taskEditor")');
  assert.deepEqual(await page.evaluate('return [...document.querySelectorAll("header #tools .tool")].map(b => b.textContent.trim());'),
    ['今日', '日历', '专注', '统计', '昨日']);
  const pillOn = (key) => `(() => {
    const pill = document.querySelector('#tools .toolbar-pill').getBoundingClientRect();
    const btn = document.querySelector('#tools [data-page="${key}"]').getBoundingClientRect();
    return Math.abs(pill.left - btn.left) < 2 && Math.abs(pill.width - btn.width) < 2;
  })()`;
  await page.waitFor(pillOn('home'));
  const summary = await page.text('.right');

  await page.click('#tools [data-page="calendar"]');
  await page.waitFor('/2026 年 11 月/.test(document.querySelector("#main").textContent)');
  assert.equal(await page.text('#contextPage'), '日历');
  assert.equal(await page.text('#tools [aria-pressed="true"]'), '日历');
  await page.waitFor(pillOn('calendar'));
  assert.equal(await page.text('.right'), summary, '切页不影响右栏概况');
  await page.click('#tools [data-page="home"]');
  await page.waitFor('document.querySelector("#taskEditor")');
});

test('Mac 灵动岛：显示推荐任务、可展开、可启动专注', async () => {
  assert.equal(await page.evaluate('return document.querySelector("#islandBox").hidden;'), true);
  assert.equal(await page.text('#islandTime'), '待专注');
  const task = await page.text('#islandTask');
  assert.ok(task && task !== '—', '灵动岛应显示当前任务');

  await page.click('#islandMain');
  await page.waitFor('!document.querySelector("#islandBox").hidden');
  assert.equal(await page.getAttribute?.('#islandMain', 'aria-expanded') ?? 'true', 'true');
  assert.equal(await page.evaluate('return document.querySelector("#islandMain").getAttribute("aria-expanded");'), 'true');
  await page.screenshot(shot('13-Mac灵动岛.png'), { fullPage: true });

  // 从灵动岛开始专注
  await page.click('#islandAct');
  await page.waitFor('document.querySelector("#main .clock")');
  assert.equal(await page.text('#main .topline h1'), '专注');
  await page.waitFor('/专注中/.test(document.querySelector("#islandTime").textContent)');
  assert.equal(await page.text('#islandTime'), '专注中');

  // 结束，恢复干净状态
  await page.click('[data-action="finish"]');
  await page.waitFor('document.querySelectorAll("#main .listrow").length > 0');
});

test('Mac 侧栏：折叠成图标轨道，可展开，状态记忆', async () => {
  await page.click('[data-page="home"]');
  await page.waitFor('document.querySelector("#taskEditor")');
  const widthOpen = await page.evaluate(`
    return Math.round(document.querySelector('.left').getBoundingClientRect().width);
  `);
  await page.click('#collapse');
  await page.waitFor('document.body.classList.contains("compact")');
  const widthClosed = await page.evaluate(`
    return Math.round(document.querySelector('.left').getBoundingClientRect().width);
  `);
  assert.ok(widthClosed < widthOpen, `折叠后应更窄：${widthClosed} < ${widthOpen}`);
  assert.equal(await page.evaluate('return getComputedStyle(document.querySelector("#newTask")).display;'), 'none');
  assert.notEqual(await page.evaluate('return getComputedStyle(document.querySelector("#railList")).display;'), 'none');
  assert.ok((await page.count('#railList button')) >= 1, '轨道上应有任务缩写');
  await page.screenshot(shot('14-Mac折叠侧栏.png'));

  // 重载后仍是折叠
  await page.goto(`${base}/`);
  await page.waitFor('document.querySelector("#taskEditor")');
  assert.equal(await page.evaluate('return document.body.classList.contains("compact");'), true, '折叠状态应被记住');

  await page.click('#collapse');
  await page.waitFor('!document.body.classList.contains("compact")');
  await page.evaluate('localStorage.removeItem("workbench.compact"); return true;');
});

test('切换日期：日计划跟随所选日期，再回到今天', async () => {
  await page.click('#tools [data-page="calendar"]');
  await page.waitFor('document.querySelector("#main .cal")');
  const today = await page.evaluate('return window.__wbState.day;');
  const other = await page.evaluate(`return [...document.querySelectorAll("#main .calday")].map(b => b.dataset.day).find(d => d !== '${today}');`);
  await page.evaluate(`document.querySelector('#main .calday[data-day="${other}"]').click(); return true;`);
  await page.waitFor(`window.__wbState.view?.day === '${other}'`);
  const [, m, d] = other.split('-').map(Number);
  await page.waitFor(`document.querySelector('#plannerDate').textContent.replace(/\\s/g, '').includes('${m}月${d}日')`);
  await page.click('[data-month="0"]');
  await page.waitFor(`window.__wbState.view?.day === '${today}'`);
});

test('自由专注：有待办时也能不绑定任务开始', async () => {
  await page.click('#tools [data-page="home"]');
  await page.waitFor('document.querySelector("#taskEditor")');
  assert.ok((await page.count('#pending .task')) >= 1, '前提：存在待办任务');

  await page.click('#tools [data-page="focus"]');
  await page.waitFor('document.querySelector("#main .focusart")');
  assert.equal(await page.count('[data-action="freeFocus"]'), 1, '有待办时也应能选自由专注');

  await page.click('[data-action="freeFocus"]');
  await page.waitFor(`/自由专注/.test(document.querySelector('#main .focusart h2').textContent)`);
  assert.equal(await page.text('#main .focusart h2'), '自由专注');

  await page.click('[data-action="start"]');
  await page.waitFor('document.querySelector("#main .clock")');
  const open = await page.evaluate(`
    const r = await fetch('/api/view?day=' + new Date().toISOString().slice(0,10));
    const j = await r.json();
    return j.view.openFocus;
  `);
  assert.ok(open, '应有一轮进行中的专注');
  assert.equal(open.taskId, null, '自由专注的 task_id 必须为空');

  // 结束，恢复干净状态
  await page.click('[data-action="finish"]');
  await page.waitFor('document.querySelectorAll("#main .listrow").length > 0');
});

test('切页保留各页滚动位置', async () => {
  await page.setViewport(1440, 480);
  await page.click('#tools [data-page="calendar"]');
  await page.waitFor('document.querySelector("#main .cal")');
  await new Promise((r) => setTimeout(r, 600));
  const scrollable = await page.evaluate('return document.documentElement.scrollHeight - window.innerHeight;');
  assert.ok(scrollable > 60, `日历页应可滚动，实际可滚动 ${scrollable}px`);
  await page.evaluate('window.scrollTo(0, 120); return true;');
  await new Promise((r) => setTimeout(r, 300));
  const before = await page.evaluate('return Math.round(window.scrollY);');
  assert.ok(before > 50, `应已滚动，实际 ${before}`);

  await page.evaluate(`document.querySelector('#tools [data-page="activity"]').click(); return true;`);
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(`document.querySelector('#tools [data-page="calendar"]').click(); return true;`);
  await new Promise((r) => setTimeout(r, 1200));
  const after = await page.evaluate('return Math.round(window.scrollY);');
  await page.setViewport(1440, 900);
  assert.equal(after, before, `切回日历应回到原位置：${before} → ${after}`);
});

test('任务正文存储失败时保留草稿，可重试', async () => {
  await page.click('#tools [data-page="home"]');
  await page.click('[data-sidebar-view="tasks"]');
  await page.click('#pending .tasktitle');
  await page.waitFor('document.querySelector("#taskNoteBody:not(:disabled)")');
  await page.evaluate(`
    window.__origFetch = window.fetch;
    window.fetch = async (url, init) => {
      if (String(url).includes('/api/command')) throw new TypeError('模拟网络中断');
      return window.__origFetch(url, init);
    };
    return true;
  `);
  await page.type('#taskNoteBody', '失败时要保留的草稿');
  await page.waitFor('/保存失败/.test(document.querySelector("#taskNoteStatus").textContent)');
  assert.match(await page.evaluate('return document.querySelector("#taskNoteBody").value;'), /失败时要保留的草稿/);
  assert.equal(await page.evaluate('return document.querySelector("#retryTaskNote").hidden;'), false, '失败后应出现重试');

  await page.evaluate('window.fetch = window.__origFetch; return true;');
  await page.click('#retryTaskNote');
  await page.waitFor('document.querySelector("#taskNoteStatus").textContent === "已自动保存"');
});

test('切页时专注继续计时，灵动岛同步', async () => {
  await page.click('#tools [data-page="focus"]');
  await page.waitFor('document.querySelector("#main .focusart")');
  const hasOpen = await page.evaluate('return !!window.__wbState.view.openFocus;');
  if (hasOpen) {
    await page.click('[data-action="finish"]');
    await page.waitFor('document.querySelector("#main .clock")');
  }

  await page.click('[data-action="start"]');
  await page.waitFor('document.querySelector("#main .clock")');
  const t1 = await page.text('#clock');
  assert.match(t1, /^\d{2}:\d{2}$/);
  assert.equal(await page.text('#islandTime'), '专注中', '灵动岛应同步显示专注中');

  // 切到别的页再回来，计时不该断
  await page.click('#tools [data-page="activity"]');
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(await page.text('#islandTime'), '专注中', '在别的页面灵动岛仍在计时');
  await page.click('#tools [data-page="focus"]');
  await page.waitFor('document.querySelector("#main .clock")');
  const t2 = await page.text('#clock');
  assert.notEqual(t2, t1, `切页后计时应在继续：${t1} → ${t2}`);

  // 服务端记录仍是 running，且只有一条
  const open = await page.evaluate(`
    const r = await fetch('/api/view?day=' + new Date().toISOString().slice(0,10));
    const j = await r.json();
    return j.view.openFocus && { state: j.view.openFocus.state };
  `);
  assert.equal(open.state, 'running');

  await page.click('[data-action="finish"]');
  await page.waitFor('document.querySelectorAll("#main .listrow").length > 0');
});

test('键盘快捷键：1-5 切页、N 新建、空格开关专注', async () => {
  const press = (key) => page.evaluate(
    'document.dispatchEvent(new KeyboardEvent("keydown", { key: ' + JSON.stringify(key) + ', bubbles: true }));'
    + ' return true;',
  );

  const pairs = [['2', '日历'], ['4', '学习统计'], ['5', '昨日总结'], ['3', '专注'], ['1', '今日工作台']];
  for (const [key, title] of pairs) {
    await press(key);
    await page.waitFor(`document.querySelector('#contextPage')?.textContent === ${JSON.stringify(title)}`);
  }

  await press('n');
  await page.waitFor('document.activeElement.id === "newTitle"');
  assert.equal(await page.evaluate('return document.activeElement.id;'), 'newTitle');

  // 空格：在专注页开始与暂停
  await press('3');
  await page.waitFor('document.querySelector("#main .focusart")');
  const already = await page.evaluate('return !!window.__wbState.view.openFocus;');
  if (already) {
    await page.click('[data-action="finish"]');
    await page.waitFor('document.querySelector("#main .clock")');
  }
  await page.evaluate('document.body.focus(); return true;');
  await press(' ');
  await page.waitFor('document.querySelector("#main .clock")');
  await page.waitFor('window.__wbState.view.openFocus?.state === "running"');
  await press(' ');
  await page.waitFor('window.__wbState.view.openFocus?.state === "paused"');

  await page.click('[data-action="finish"]');
  await page.waitFor('document.querySelectorAll("#main .listrow").length > 0');
});

test('任务正文：两项隔离，快速切换及刷新仍会自动保存', async () => {
  const firstTask = 'ui-task-note-first';
  const secondTask = 'ui-task-note-second';
  assert.equal(await page.evaluate(`
    for (const [id, title] of [['${firstTask}', '第一项测试任务'], ['${secondTask}', '第二项测试任务']]) {
      const result = await fetch('/api/command', {method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({command:{type:'createTask', id, title}})});
      if (!result.ok) return false;
    }
    return true;
  `), true);
  await page.goto(`${base}/`);
  await page.waitFor('document.querySelector("#taskEditor")');
  await page.click('[data-sidebar-view="tasks"]');
  await page.click(`#pending [data-task-note="${firstTask}"]`);
  await page.waitFor('document.querySelector("#taskNoteBody:not(:disabled)")');
  await page.type('#taskNoteBody', '第一项的独立正文');
  await page.click(`#pending [data-task-note="${secondTask}"]`);
  await page.waitFor('document.querySelector("#taskNoteBody:not(:disabled)")');
  assert.equal(await page.evaluate('return document.querySelector("#taskNoteBody").value;'), '');
  await page.type('#taskNoteBody', '第二项的独立正文');
  await page.waitFor('document.querySelector("#taskNoteStatus").textContent === "已自动保存"');
  await page.goto(`${base}/`);
  await page.waitFor('document.querySelector("#taskEditor")');
  for (const [id, body] of [[firstTask,'第一项的独立正文'],[secondTask,'第二项的独立正文']]) {
    await page.click(`#pending [data-task-note="${id}"]`);
    await page.waitFor('document.querySelector("#taskNoteBody:not(:disabled)")');
    assert.equal(await page.evaluate('return document.querySelector("#taskNoteBody").value;'), body);
  }
});

test('日计划：末尾新建、拖动改期、底边改时长、拖入待办并落盘', async () => {
  await page.click('#tools [data-page="home"]');
  await page.click('[data-sidebar-view="plan"]');
  const dayStart = await page.evaluate('return __wbState.view.range.end - 18 * 3600;');
  const tail = await page.evaluate(`
    return Math.max(__wbState.view.range.end - 18 * 3600,
      ...__wbState.view.scheduled.map((b) => b.startsAt + b.plannedSeconds));
  `);
  const readBlock = (title) => page.evaluate(`
    return __wbState.view.scheduled.find((b) => b.task.title === ${JSON.stringify(title)});
  `);
  const create = async (title) => {
    await page.type('#newTitle', title);
    await page.evaluate('document.querySelector("#newTask").requestSubmit();');
    await page.waitFor(`!__wbState.busy && __wbState.view.pending.some((t) => t.title === ${JSON.stringify(title)})`);
  };
  const mouse = (type, x, y) => page.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  });
  const point = (selector) => page.evaluate(`
    const el = document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({block:'nearest'});
    const rect = el.getBoundingClientRect();
    return [rect.x + rect.width / 2, rect.y + rect.height / 2];
  `);
  const dragTo = async ([x, y], [toX, toY]) => {
    await mouse('mousePressed', x, y);
    await mouse('mouseMoved', toX, toY);
    await mouse('mouseReleased', toX, toY);
  };

  const title = '日计划拖动测试';
  await create(title);
  const original = await readBlock(title);
  assert.equal(original.startsAt, tail);
  assert.equal(original.plannedSeconds, 1800);
  await page.click('[data-plan-add]');
  const nextTime = await page.evaluate(`
    return new Intl.DateTimeFormat('en-GB', {timeZone: __wbState.view.timeZone, hour:'2-digit', minute:'2-digit'})
      .format(new Date(${(tail + 1800) * 1000}));
  `);
  assert.match(await page.text('#dialogBody h2'), new RegExp(nextTime));
  await page.click('#dialog .close');

  const card = `#plannerGrid .planner-task[data-block="${original.id}"]`;
  const hourHeight = await page.evaluate('return document.querySelector(".planner-hour").getBoundingClientRect().height;');
  const [x, y] = await point(card);
  await dragTo([x, y], [x, y + hourHeight]);
  await page.waitFor(`__wbState.view.scheduled.some((b) => b.id === '${original.id}' && b.startsAt === ${tail + 3600})`);
  assert.equal((await readBlock(title)).plannedSeconds, 1800);
  const [handleX, handleY] = await point(`[data-resize-plan="${original.id}"]`);
  await dragTo([handleX, handleY], [handleX, handleY + hourHeight / 4]);
  await page.waitFor(`__wbState.view.scheduled.some((b) => b.id === '${original.id}' && b.plannedSeconds === 2700)`);
  assert.equal((await readBlock(title)).startsAt, tail + 3600);
  const afterResize = await point(card);
  await dragTo(afterResize, [afterResize[0] + 300, afterResize[1]]);
  assert.equal((await readBlock(title)).startsAt, tail + 3600);
  const [clickX, clickY] = await point(card);
  await mouse('mousePressed', clickX, clickY);
  await mouse('mouseReleased', clickX, clickY);
  await page.waitFor(`document.querySelector('#taskEditorTitle')?.textContent === '${title}'`);

  const todoTitle = '拖入计划的待办';
  await page.click('[data-sidebar-view="tasks"]');
  await create(todoTitle);
  assert.equal(await readBlock(todoTitle), undefined);
  const todoId = await page.evaluate(`return __wbState.view.pending.find((t) => t.title === '${todoTitle}').id;`);
  const from = await point(`#pending [data-drag-task="${todoId}"]`);
  const to = await page.evaluate(`
    document.querySelector('#plannerGrid').scrollTop = 0;
    const rect = document.querySelector('.planner-layer').getBoundingClientRect();
    return [rect.x + rect.width / 2, rect.y + ${hourHeight * 1.25}];
  `);
  await dragTo(from, to);
  await page.waitFor(`__wbState.view.scheduled.some((b) => b.taskId === '${todoId}')`);
  assert.equal((await readBlock(todoTitle)).startsAt, dayStart + 75 * 60);
  assert.equal(await page.count(`#pending [data-drag-task="${todoId}"]`), 1);
  await page.goto(`${base}/`);
  await page.waitFor('!!__wbState.view');
  assert.equal((await readBlock(title)).id, original.id);
  assert.equal((await readBlock(title)).plannedSeconds, 2700);
  assert.equal((await readBlock(todoTitle)).taskId, todoId);
});

test('日计划：松手后卡片停在落点不弹回，保存失败才复原', async () => {
  const id = 'ui-plan-no-snapback';
  assert.equal(await page.evaluate(`
    const post = (command) => fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }) }).then((r) => r.ok);
    const start = __wbState.view.range.end - 18 * 3600;
    return await post({ type: 'createTask', id: '${id}', title: '拖动不抖' })
      && await post({ type: 'saveSchedule', block: { id: '${id}-b', taskId: '${id}', startsAt: start + 3600, plannedSeconds: 1800 } });
  `), true);
  await page.goto(`${base}/`);
  await page.waitFor(`document.querySelector('[data-block="${id}-b"]')`);
  await page.click('[data-sidebar-view="plan"]');
  const card = `document.querySelector('[data-block="${id}-b"]').parentElement`;
  const mouse = (type, x, y) => page.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1,
  });
  const drag = async (dy) => {
    const [x, y] = await page.evaluate(`
      const el = document.querySelector('[data-block="${id}-b"]');
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    `);
    await mouse('mousePressed', x, y);
    await mouse('mouseMoved', x, y + dy);
    await mouse('mouseReleased', x, y + dy);
  };
  const top = () => page.evaluate(`return ${card}.style.top;`);
  const original = await top();

  // 让保存请求挂起：松手后、保存完成前，卡片必须留在落点
  await page.evaluate(`
    window.__origFetch = window.fetch;
    window.__release = null;
    window.fetch = (url, init) => String(url).includes('/api/command')
      ? new Promise((resolve) => { window.__release = () => resolve(window.__origFetch(url, init)); })
      : window.__origFetch(url, init);
    return true;
  `);
  await drag(32);
  await page.waitFor('typeof window.__release === "function"');
  const dropped = await top();
  assert.notEqual(dropped, original, '松手后不应先弹回原位');
  assert.equal(await page.evaluate(`return ${card}.classList.contains('planner-dragging');`), false);
  await page.evaluate('window.__release(); return true;');
  await page.waitFor(`__wbState.view.scheduled.find((b) => b.id === '${id}-b')?.startsAt === __wbState.view.range.end - 18 * 3600 + 7200`);
  assert.equal(await top(), dropped, '保存后的重绘位置与落点一致');

  // 保存失败：卡片回到保存前的位置
  await page.evaluate(`window.fetch = (url, init) => String(url).includes('/api/command')
    ? Promise.reject(new TypeError('模拟网络中断')) : window.__origFetch(url, init); return true;`);
  await drag(32);
  await page.waitFor(`${card}.style.top === ${JSON.stringify(dropped)}`);
  await page.evaluate('window.fetch = window.__origFetch; return true;');
});

test('添加时间块：列出待办可点选，新名字只进日计划不进待办', async () => {
  await page.goto(`${base}/`);
  await page.waitFor('!!__wbState.view && document.querySelector("#plannerGrid [data-plan-hour]")');
  await page.click('[data-sidebar-view="plan"]');
  const openAt = async (hourIndex) => {
    await page.evaluate(`document.querySelectorAll('#plannerGrid [data-plan-hour]')[${hourIndex}].click(); return true;`);
    await page.waitFor('document.querySelector("#dialog[open] #planTitle")');
  };
  const todoCount = await page.evaluate("return __wbState.view.pending.filter((t) => t.course !== '日计划').length;");
  const pendingCount = await page.evaluate('return __wbState.view.pending.length;');

  // 1) 点选已有待办 + 时长标签
  await openAt(1);
  assert.equal(await page.count('#planPicks [data-plan-pick]'), todoCount, '应列出待办清单里的全部任务');
  const pick = await page.evaluate('return document.querySelector("#planPicks [data-plan-pick]").dataset.planPick;');
  await page.click(`#planPicks [data-plan-pick="${pick}"]`);
  assert.equal(await page.evaluate(`return document.querySelector('[data-plan-pick="${pick}"]').getAttribute('aria-pressed');`), 'true');
  await page.click('[data-plan-minutes="45"]');
  assert.equal(await page.evaluate('return document.querySelector("#planMinutes").value;'), '45');
  assert.match(await page.text('#planSummary'), /排入这个待办/);
  await page.screenshot(shot('15-添加时间块.png'));
  const before = await page.evaluate('return __wbState.view.scheduled.length;');
  await page.evaluate('document.querySelector("#planForm").requestSubmit(); return true;');
  await page.waitFor(`__wbState.view.scheduled.length === ${before + 1}`);
  assert.equal(await page.evaluate(`
    const at = Number(document.querySelectorAll('#plannerGrid [data-plan-hour]')[1].dataset.planHour);
    return __wbState.view.scheduled.find((b) => b.taskId === '${pick}' && b.startsAt === at)?.plannedSeconds;
  `), 2700);
  assert.equal(await page.evaluate('return __wbState.view.pending.length;'), pendingCount, '点选已有待办不新建任务');

  // 2) 写一个新名字：筛选无匹配，提交后新建任务并排期
  await openAt(3);
  await page.evaluate(`const t = document.querySelector('#planTitle'); t.value = '临时加的复盘'; t.dispatchEvent(new Event('input')); return true;`);
  assert.match(await page.text('#planSummary'), /只加进日计划/);
  assert.equal(await page.evaluate('return document.querySelector("#planPicks .chip-empty")?.hidden ?? true;'), false);
  await page.evaluate('document.querySelector("#planForm").requestSubmit(); return true;');
  await page.waitFor('__wbState.view.pending.some((t) => t.title === "临时加的复盘")');
  const created = await page.evaluate('return __wbState.view.scheduled.find((b) => b.task.title === "临时加的复盘");');
  assert.ok(created, '新事项应已排进日计划');
  assert.equal(created.task.course, '日计划');
  await page.click('[data-sidebar-view="tasks"]');
  assert.doesNotMatch(await page.text('#pending'), /临时加的复盘/, '只进日计划的事项不出现在待办清单');
  assert.equal(await page.text('#count'), String(todoCount), '未完成任务数只算待办');
  assert.match(await page.text('#plannerGrid'), /临时加的复盘/);
  assert.equal(created.startsAt, await page.evaluate('return Number(document.querySelectorAll("#plannerGrid [data-plan-hour]")[3].dataset.planHour);'));
});

test('任务名称：点击标题编辑，待办和时间块同步，刷新后正文仍在', async () => {
  const id = 'ui-inline-rename';
  const blockId = 'ui-inline-rename-block';
  const title = '修改采样计划';
  const body = '任务名称与正文共用原任务编号';
  assert.equal(await page.evaluate(`
    const startsAt = __wbState.view.range.start + 8 * 3600;
    for (const command of [
      {type:'createTask', id:'${id}', title:'采样计划'},
      {type:'saveSchedule', block:{id:'${blockId}', taskId:'${id}', startsAt, plannedSeconds:1800}},
    ]) {
      const res = await fetch('/api/command', {method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({command})});
      if (!res.ok) return false;
    }
    return true;
  `), true);
  const pending = `#pending [data-task-note="${id}"]`;
  const block = `#plannerGrid [data-block="${blockId}"]`;
  await page.goto(`${base}/`);
  await page.waitFor(`document.querySelector('${pending}')`);
  await page.click('[data-sidebar-view="tasks"]');
  await page.click(pending);
  await page.waitFor('document.querySelector("#taskNoteBody:not(:disabled)")');
  await page.type('#taskNoteBody', body);
  await page.click('#editTaskName');
  await page.type('#taskNameInput', '这次取消');
  await page.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', windowsVirtualKeyCode:27 });
  await page.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', windowsVirtualKeyCode:27 });
  assert.equal(await page.text('#taskEditorTitle'), '采样计划');
  assert.equal(await page.text(pending), '采样计划');

  await page.click('#editTaskName');
  await page.type('#taskNameInput', '先用回车改名');
  await page.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Enter', windowsVirtualKeyCode:13 });
  await page.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Enter', windowsVirtualKeyCode:13 });
  await page.waitFor('!document.querySelector("#editTaskName").closest("h1").hidden && document.querySelector("#taskNameText").textContent === "先用回车改名"');

  await page.click('#editTaskName');
  await page.type('#taskNameInput', title);
  await page.evaluate('document.querySelector("#taskNoteBody").focus();');
  await page.waitFor(`document.querySelector('${pending}').textContent === '${title}'`);
  assert.equal(await page.text(block), title);
  assert.equal(await page.text('#taskEditorTitle'), title);
  await page.waitFor('document.querySelector("#taskNoteStatus").textContent === "已自动保存"');

  await page.goto(`${base}/`);
  await page.waitFor(`document.querySelector('${pending}')`);
  await page.click('[data-sidebar-view="tasks"]');
  await page.click(pending);
  await page.waitFor('document.querySelector("#taskNoteBody:not(:disabled)")');
  assert.equal(await page.text('#taskEditorTitle'), title);
  assert.equal(await page.text(block), title);
  assert.equal(await page.evaluate('return document.querySelector("#taskNoteBody").value;'), body);
});

test('贾维斯喵管家卡片：专注时与任务编辑器同屏，可返回原计时', async () => {
  const id = 'ui-home-focus-card';
  assert.equal(await page.evaluate(`
    const res = await fetch('/api/command', {method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({command:{type:'createTask', id:'${id}', title:'复习傅里叶级数'}})});
    return res.ok;
  `), true);
  const task = `#pending [data-task-note="${id}"]`;
  await page.goto(`${base}/`);
  await page.waitFor(`document.querySelector('${task}')`);
  await page.click('[data-sidebar-view="tasks"]');
  await page.click(task);
  assert.equal(await page.evaluate('return document.querySelector("#homeFocus").hidden;'), true);
  await page.click('#taskEditorFocus');
  await page.waitFor('__wbState.view.openFocus?.state === "running"');
  const focusId = await page.evaluate('return __wbState.view.openFocus.id;');

  await page.click('#tools [data-page="home"]');
  await page.waitFor('!document.querySelector("#homeFocus").hidden && document.querySelector("#homeFocus img").naturalWidth > 0');
  assert.equal(await page.text('#homeFocusTitle'), '本轮专注中：复习傅里叶级数。');
  assert.equal(await page.text('#taskEditorTitle'), '复习傅里叶级数');
  const viewport = await page.evaluate('return [innerWidth, innerHeight];');
  await page.setViewport(390, 800);
  assert.ok(await page.evaluate(`
    const card = document.querySelector('#homeFocus');
    const button = card.querySelector('button').getBoundingClientRect();
    const bounds = card.getBoundingClientRect();
    return card.scrollWidth <= card.clientWidth && button.width > 0 && button.right <= bounds.right;
  `), '窄窗口可见完整的返回按钮');
  await page.setViewport(...viewport);
  await page.waitFor('document.querySelector("#taskNoteBody:not(:disabled)")');
  await page.type('#taskNoteBody', '专注时在工作台记录');
  await page.click('#homeFocus [data-page="focus"]');
  await page.waitFor('document.querySelector("#clock")?.dataset.state === "running"');
  assert.equal(await page.evaluate('return __wbState.view.openFocus.id;'), focusId);

  await page.click('#main [data-action="pause"]');
  await page.waitFor('__wbState.view.openFocus?.state === "paused"');
  await page.click('#tools [data-page="home"]');
  assert.equal(await page.text('#homeFocusTitle'), '本轮专注已暂停：复习傅里叶级数。');
  assert.equal(await page.evaluate('return document.querySelector("#taskNoteBody").value;'), '专注时在工作台记录');
  await page.click('#homeFocus [data-page="focus"]');
  await page.click('#main [data-action="finish"]');
  await page.waitFor('__wbState.view.openFocus === null');
  await page.click('#tools [data-page="home"]');
  assert.equal(await page.evaluate('return document.querySelector("#homeFocus").hidden;'), true);

  assert.equal(await page.evaluate(`
    const res = await fetch('/api/command', {method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({command:{type:'startFocus', id:'ui-home-expiring', taskId:'${id}', plannedSeconds:3}})});
    return res.ok;
  `), true);
  await page.goto(`${base}/`);
  await page.waitFor('__wbState.view.openFocus?.id === "ui-home-expiring" && !document.querySelector("#homeFocus").hidden');
  await page.waitFor('__wbState.view.openFocus === null && document.querySelector("#homeFocus").hidden');
});

test('日计划：末尾排到午夜时，新任务放进最早的空档', async () => {
  const tail = 'ui-plan-tail';
  assert.equal(await page.evaluate(`
    const post = (command) => fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }) }).then((r) => r.ok);
    const { view } = await (await fetch('/api/view?day=' + window.__wbState.day)).json();
    // 清掉当天已有时间块，再放一个 22:00–24:00 的块
    for (const block of view.scheduled) await post({ type: 'removeSchedule', blockId: block.id });
    return await post({ type: 'createTask', id: '${tail}', title: '收尾复盘' })
      && await post({ type: 'saveSchedule', block: { id: '${tail}-b', taskId: '${tail}',
        startsAt: view.range.end - 7200, plannedSeconds: 7200 } });
  `), true);
  await page.goto(`${base}/`);
  await page.waitFor('document.querySelector("#taskEditor") && window.__wbState.view?.scheduled.length === 1');
  await page.click('[data-sidebar-view="plan"]');
  await page.type('#newTitle', '空档里的新任务');
  await page.evaluate('document.querySelector("#newTask").requestSubmit(); return true;');
  await page.waitFor('window.__wbState.view.scheduled.length === 2');
  const placed = await page.evaluate(`
    const v = window.__wbState.view;
    const b = v.scheduled.find((x) => x.task.title === '空档里的新任务');
    return { offset: b.startsAt - (v.range.end - 18 * 3600), seconds: b.plannedSeconds };
  `);
  assert.deepEqual(placed, { offset: 0, seconds: 1800 }, '应放在 06:00、默认 30 分钟');
  assert.doesNotMatch(await page.text('#toast'), /空档/);
});

test('日期按服务时区（北京时间）分日，不随浏览器所在时区变化', async () => {
  // 把浏览器换到洛杉矶时区：页面的「今天」仍应等于服务端的「今天」
  for (const zone of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
    await page.send('Emulation.setTimezoneOverride', { timezoneId: zone });
    await page.goto(`${base}/`);
    await page.waitFor('!!window.__wbState.view');
    const [client, server] = await page.evaluate(`
      const { view } = await (await fetch('/api/view?day=')).json();
      return [window.__wbState.day, view.day];
    `);
    assert.equal(client, server, `浏览器时区 ${zone} 下页面日期应跟服务一致`);
  }
  await page.send('Emulation.setTimezoneOverride', { timezoneId: TZ });
  await page.goto(`${base}/`);
  await page.waitFor('!!window.__wbState.view');
});

test('「改时区」扩展篡改 Intl 时，日计划仍按北京时间显示时间块', async () => {
  // 模拟用户装的 Change Timezone 扩展：Intl.DateTimeFormat 无视传入的 timeZone，一律按 UTC。
  const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const Real = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function (locale, options = {}) { return new Real(locale, { ...options, timeZone: 'UTC' }); };
    Intl.DateTimeFormat.prototype = Real.prototype;
  ` });
  try {
    const id = 'ui-spoofed-tz';
    assert.equal(await page.evaluate(`
      const post = (command) => fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }) }).then((r) => r.ok);
      const { view } = await (await fetch('/api/view')).json();
      return await post({ type: 'createTask', id: '${id}', title: '九点的块', course: '日计划' })
        && await post({ type: 'saveSchedule', block: { id: '${id}-b', taskId: '${id}',
          startsAt: view.range.start + 9 * 3600, plannedSeconds: 3600 } });
    `), true);
    await page.goto(`${base}/`);
    await page.waitFor('!!window.__wbState.view && document.querySelector("[data-plan-hour]")');
    const seen = await page.evaluate(`
      const v = window.__wbState.view;
      const first = Number(document.querySelector('[data-plan-hour]').dataset.planHour);
      const card = [...document.querySelectorAll('.planner-block')].find((e) => e.textContent.includes('九点的块'));
      return { spoofed: new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit' }).resolvedOptions().timeZone,
        firstHourOffset: first - v.range.start, top: card?.style.top ?? null,
        label: document.querySelector('.planner-hour')?.textContent.trim().slice(0, 5), day: window.__wbState.day, serverDay: v.day };
    `);
    assert.equal(seen.spoofed, 'UTC', '模拟扩展应生效');
    assert.equal(seen.firstHourOffset, 6 * 3600, '时间轴第一格应是北京时间 06:00');
    assert.equal(seen.label, '06:00');
    assert.equal(seen.top, '96px', '九点的块应画在 06:00 往下 3 小时处');
    assert.equal(seen.day, seen.serverDay);
  } finally {
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    await page.goto(`${base}/`);
    await page.waitFor('!!window.__wbState.view');
  }
});

test('无控制台错误、无未捕获异常', async () => {
  assert.deepEqual(page.pageErrors, [], `页面异常：${page.pageErrors.join('\n')}`);
  assert.deepEqual(page.consoleErrors, [], `控制台错误：${page.consoleErrors.join('\n')}`);
});

test('数据真的落盘：关掉服务再打开，任务与任务正文都还在', async () => {
  const { dbPath } = app.__test;
  const snapshot = await page.evaluate(`
    const res = await fetch('/api/view?day=' + new Date().toISOString().slice(0,10));
    const j = await res.json();
    const note = await (await fetch('/api/task-note?task=ui-task-note-first')).json();
    return { tasks: j.view.pending.length + j.view.completedOnDay.length, body: note.note.body };
  `);
  assert.ok(snapshot.tasks >= 1, '至少有一个任务');
  assert.equal(snapshot.body, '第一项的独立正文');

  // 关掉服务、用同一个库文件重新打开
  await new Promise((resolve) => app.server.close(resolve));
  const again = await start({ port: 0, dbPath, timeZone: TZ });
  try {
    const root = again.url.replace(/\/$/, '');
    const j = await (await fetch(`${root}/api/view?day=${new Date().toISOString().slice(0, 10)}`)).json();
    assert.equal(j.view.pending.length + j.view.completedOnDay.length, snapshot.tasks, '任务数应一致');
    const note = await (await fetch(`${root}/api/task-note?task=ui-task-note-first`)).json();
    assert.equal(note.note.body, snapshot.body, '任务正文应一致');
  } finally {
    await new Promise((resolve) => again.server.close(resolve));
    app = again; // 让 after() 还能关掉
  }
});

// 右键菜单（T-W7）：时间块、时间轴空白、左栏待办、长期项目卡、收获卡。临时库、临时服务，不碰用户数据。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './browser.mjs';
import { start } from '../server.js';

const TZ = 'Asia/Shanghai';
const HOUR = 3600;
let app;
let page;
let dir;
let base;
let view;
const at = (h, m = 0) => view.range.start + h * HOUR + m * 60;

async function command(cmd) {
  const res = await fetch(`${base}/api/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: cmd }),
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  return json;
}

const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
const menuOpen = () => page.evaluate('return !!document.querySelector(".ctx-menu");');
const labels = (depth = 0) => page.evaluate(`
  return [...document.querySelectorAll('.ctx-menu[data-depth="${depth}"] .ctx-label')].map((el) => el.textContent.trim());
`);
const activeLabel = () => page.evaluate(`
  return document.activeElement?.closest('.ctx-item')?.querySelector('.ctx-label')?.textContent.trim() ?? null;
`);
/** 在元素上（可指定元素内的相对位置 0–1）按鼠标右键。 */
async function rightClick(selector, { fx = 0.5, fy = 0.5 } = {}) {
  const pt = await page.evaluate(`
    const el = ${q(selector)};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return [r.left + r.width * ${fx}, r.top + r.height * ${fy}];
  `);
  assert.ok(pt, `右键目标不存在：${selector}`);
  const [x, y] = pt;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 120));
}
async function chooseItem(label, depth = 0) {
  const ok = await page.evaluate(`
    const row = [...document.querySelectorAll('.ctx-menu[data-depth="${depth}"] .ctx-item')]
      .find((el) => el.querySelector('.ctx-label').textContent.trim() === ${JSON.stringify(label)});
    if (!row) return false;
    row.click();
    return true;
  `);
  assert.ok(ok, `菜单里没有「${label}」：${(await labels(depth)).join('、')}`);
  await new Promise((r) => setTimeout(r, 250));
}
const KEYS = {
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13 },
  F10: { code: 'F10', windowsVirtualKeyCode: 121 },
  ContextMenu: { code: 'ContextMenu', windowsVirtualKeyCode: 93 },
  c: { code: 'KeyC', windowsVirtualKeyCode: 67 },
  v: { code: 'KeyV', windowsVirtualKeyCode: 86 },
};
/** modifiers：Alt=1 Ctrl=2 Meta=4 Shift=8（CDP 约定）。 */
async function key(name, modifiers = 0) {
  const spec = { key: name, modifiers, ...KEYS[name] };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...spec });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec });
  await new Promise((r) => setTimeout(r, 120));
}
const focus = (selector) => page.evaluate(`${q(selector)}.focus(); return document.activeElement === ${q(selector)};`);
const blocksOf = (taskId) => page.evaluate(`
  return __wbState.view.scheduled.filter((b) => b.taskId === ${JSON.stringify(taskId)})
    .map((b) => ({ id: b.id, startsAt: b.startsAt, plannedSeconds: b.plannedSeconds })).sort((a, b) => a.startsAt - b.startsAt);
`);
const waitBlocks = (taskId, predicate) => page.waitFor(`__wbState.view.scheduled.filter((b) => b.taskId === ${JSON.stringify(taskId)})${predicate}`);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-ctxmenu-'));
  app = await start({ port: 0, dbPath: join(dir, 'menu.db'), timeZone: TZ });
  base = app.url.replace(/\/$/, '');
  ({ view } = await (await fetch(`${base}/api/view`)).json());
  await command({ type: 'createTask', id: 'read', title: '读论文', course: '日计划', estimatedSeconds: null });
  await command({ type: 'saveSchedule', block: { id: 'b-read', taskId: 'read', startsAt: at(9), plannedSeconds: 1800 } });
  await command({ type: 'createTask', id: 'todo-1', title: '背单词', course: '', estimatedSeconds: null });
  await command({
    type: 'createProject', id: 'p1', title: '毕业论文', startDay: view.day, dueDay: null, dailyMinutes: 45, mainTaskId: 'p1-main',
  });
  app.workbench.createHarvest({
    id: 'h1', title: '梯度下降', conclusion: '先看损失曲线', points: ['学习率过大会震荡'], todos: ['画损失曲线'],
    tags: ['优化'], sourceUrl: 'https://www.example.com/c/1',
  });
  page = await launch({ url: `${base}/`, timeZone: TZ });
  await page.waitFor('!!window.__wbState.view');
  // 「下一个空档」从此刻起找：把页面时钟固定在当天 08:00，用例与真实钟点无关
  await page.evaluate(`
    Date.now = () => ${at(8)} * 1000;
    window.menuClipboard = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: async () => window.menuClipboard, writeText: async (v) => { window.menuClipboard = v; },
    } });
    document.addEventListener('contextmenu', (e) => { window.ctxPrevented = e.defaultPrevented; });
    return true;
  `);
});

after(async () => {
  if (page) await page.close();
  if (app) await new Promise((resolve) => app.server.close(resolve));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('时间块：右键出菜单，Esc 关闭；「改时长」子菜单改成 60 分钟', async () => {
  await rightClick('[data-block="b-read"]');
  assert.deepEqual(await labels(), ['打开正文', '开始专注', '标记完成', '改时长', '复制', '复制到明天同一时间',
    '移到下一个空档', '删除时间块']);
  assert.equal(await page.evaluate('return window.ctxPrevented;'), true, '注册过的元素应拦下浏览器菜单');
  assert.equal(await activeLabel(), '打开正文', '打开后焦点在第一项');
  await key('Escape');
  assert.equal(await menuOpen(), false);

  await rightClick('[data-block="b-read"]');
  await chooseItem('改时长');
  assert.deepEqual(await labels(1), ['15 分钟', '30 分钟', '45 分钟', '60 分钟', '90 分钟']);
  await chooseItem('60 分钟', 1);
  assert.equal(await menuOpen(), false);
  await waitBlocks('read', '.some((b) => b.plannedSeconds === 3600)');
});

test('键盘：Shift+F10 / ContextMenu 键打开，↑↓ 移动，→ 打开子菜单，Esc 关闭并把焦点还回去', async () => {
  assert.equal(await focus('[data-block="b-read"]'), true);
  await key('F10', 8);
  assert.equal(await menuOpen(), true, 'Shift+F10 应打开菜单');
  assert.equal(await activeLabel(), '打开正文');
  await key('ArrowDown');
  assert.equal(await activeLabel(), '开始专注');
  await key('ArrowUp');
  await key('ArrowUp');
  assert.equal(await activeLabel(), '删除时间块', '↑ 在首项时绕到末项');
  // 把焦点移到「改时长」再按 →
  await page.evaluate(`[...document.querySelectorAll('.ctx-item')].find((el) => el.textContent.includes('改时长')).focus(); return true;`);
  await key('ArrowRight');
  assert.equal(await activeLabel(), '15 分钟', '→ 打开子菜单并聚焦第一项');
  await key('ArrowLeft');
  assert.equal(await activeLabel(), '改时长', '← 收回子菜单');
  await key('Escape');
  assert.equal(await menuOpen(), false);
  assert.equal(await page.evaluate(`return document.activeElement === ${q('[data-block="b-read"]')};`), true,
    'Esc 关闭后焦点回到时间块');

  assert.equal(await focus('[data-project-card="p1"] .proj-start'), true);
  await key('ContextMenu');
  assert.ok((await labels()).includes('写今天进展'), 'ContextMenu 键在项目卡上打开项目菜单');
  await key('Escape');
  assert.equal(await menuOpen(), false);
});

test('复制与粘贴：菜单「复制」+ 空白处「粘贴」，以及 Ctrl+C / Ctrl+V', async () => {
  await rightClick('[data-block="b-read"]');
  await chooseItem('复制');
  await rightClick(`[data-plan-hour="${at(14)}"]`, { fy: 0.1 });
  assert.deepEqual(await labels(), ['在 14:00 添加时间块', '粘贴「读论文」']);
  await chooseItem('粘贴「读论文」');
  await waitBlocks('read', `.some((b) => b.startsAt === ${at(14)} && b.plannedSeconds === 3600)`);

  assert.equal(await focus('[data-block="b-read"]'), true);
  await key('c', 2);
  assert.equal(await focus(`[data-plan-hour="${at(16)}"]`), true);
  await key('v', 2);
  await waitBlocks('read', `.some((b) => b.startsAt === ${at(16)})`);
});

test('时间块：复制到明天同一时间、移到下一个空档、删除', async () => {
  await rightClick('[data-block="b-read"]');
  await chooseItem('复制到明天同一时间');
  const [y, m, d] = view.day.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  let copied = false;
  for (let i = 0; i < 30 && !copied; i += 1) {
    const next = await (await fetch(`${base}/api/view?day=${tomorrow}`)).json();
    copied = next.view.scheduled.some((b) => b.taskId === 'read' && b.startsAt === at(9) + 86400);
    if (!copied) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(copied, '明天 09:00 应有一块');

  // 09:00–10:00 往后挪：10:00 开始就是空的
  await rightClick('[data-block="b-read"]');
  await chooseItem('移到下一个空档');
  await page.waitFor(`__wbState.view.scheduled.find((b) => b.id === 'b-read')?.startsAt === ${at(10)}`);

  const sixteen = (await blocksOf('read')).find((b) => b.startsAt === at(16));
  await rightClick(`[data-block="${sixteen.id}"]`);
  await chooseItem('删除时间块');
  await page.waitFor(`!__wbState.view.scheduled.some((b) => b.id === ${JSON.stringify(sixteen.id)})`);
});

test('时间轴空白：按右键位置落到 15 分钟格，打开添加时间块', async () => {
  await rightClick(`[data-plan-hour="${at(11)}"]`, { fy: 0.8 });
  assert.equal((await labels())[0], '在 11:45 添加时间块');
  assert.equal((await labels()).length, 2, '有复制内容时才出现「粘贴」');
  await chooseItem('在 11:45 添加时间块');
  await page.waitFor('document.querySelector("#dialog").open');
  assert.match(await page.text('#dialogBody h2'), /11:45 添加时间块/);
  await page.evaluate('document.querySelector("#dialog").close(); return true;');
});

test('左栏待办：排进下一个空档、编辑', async () => {
  await page.click('[data-sidebar-view="tasks"]');
  await page.waitFor('!document.querySelector("#pending").hidden');
  await rightClick('#pending [data-task-note="todo-1"]');
  assert.deepEqual(await labels(), ['排进下一个空档', '打开正文', '标记完成', '编辑…']);
  await chooseItem('排进下一个空档');
  await waitBlocks('todo-1', `.some((b) => b.startsAt === ${at(8)} && b.plannedSeconds === 1800)`);
  await rightClick('#pending [data-task-note="todo-1"]');
  await chooseItem('编辑…');
  await page.waitFor('document.querySelector("#dialog").open && document.querySelector("#editTitle")');
  await page.evaluate('document.querySelector("#dialog").close(); return true;');
  await page.click('[data-sidebar-view="plan"]');
});

test('长期项目卡：写今天进展、排进今天；触屏长按 500ms 打开', async () => {
  await rightClick('[data-project-card="p1"] .proj-name');
  assert.deepEqual(await labels(), ['排进今天', '开始专注', '写今天进展', '打开正文', '编辑项目', '完成项目', '归档']);
  await chooseItem('写今天进展');
  await page.waitFor('document.querySelector("#projLogNote")');
  await page.type('#projLogNote', '写完第二章');
  await page.evaluate('document.querySelector("[data-project-log-form]").requestSubmit(); return true;');
  await page.waitFor('__wbState.view.projects.find((p) => p.id === "p1")?.log?.note === "写完第二章"');
  await page.waitFor('!document.querySelector("#dialog").open');

  await rightClick('[data-project-card="p1"] .proj-name');
  await chooseItem('排进今天');
  // 08:00–08:30 已有「背单词」，45 分钟放在 08:30
  await waitBlocks('p1-main', `.some((b) => b.startsAt === ${at(8, 30)} && b.plannedSeconds === 2700)`);

  await page.evaluate(`
    const el = ${q('[data-project-card="p1"] .proj-name')};
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 7,
      clientX: r.left + 5, clientY: r.top + 5, isPrimary: true }));
    return true;
  `);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await menuOpen(), false, '不到 500ms 不打开');
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(await menuOpen(), true, '长按 500ms 打开');
  await page.evaluate('document.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", pointerId: 7 })); return true;');
  await key('Escape');
  assert.equal(await menuOpen(), false);
});

test('收获卡：复制为 Markdown、星标、删除走确认', async () => {
  await page.click('#tools [data-page="harvest"]');
  await page.waitFor(q('[data-harvest-card="h1"]'));
  await rightClick('[data-harvest-card="h1"] h2');
  assert.deepEqual(await labels(), ['复制为 Markdown', '星标', '加入复习', '关联项目…', '编辑', '删除']);
  await chooseItem('复制为 Markdown');
  await page.waitFor('window.menuClipboard.length > 0');
  const md = await page.evaluate('return window.menuClipboard;');
  assert.match(md, /^## 梯度下降/);
  assert.match(md, /> 先看损失曲线/);
  assert.match(md, /- \[ \] 画损失曲线/);
  assert.match(md, /来源：\[example\.com\]\(https:\/\/www\.example\.com\/c\/1\)/);

  await rightClick('[data-harvest-card="h1"] h2');
  await chooseItem('星标');
  await page.waitFor(`${q('[data-harvest-card="h1"] [data-harvest-star]')}?.getAttribute('aria-pressed') === 'true'`);

  await rightClick('[data-harvest-card="h1"] h2');
  assert.equal((await labels())[1], '取消星标');
  await chooseItem('删除');
  await page.waitFor(q('#dialog[open] [data-harvest-confirm]'));
  await page.click('[data-harvest-confirm] [data-harvest-cancel]');
  assert.equal(app.workbench.readHarvests().harvests.length, 1, '取消后不删');
});

test('输入框、正文编辑区和未注册区域保留浏览器原生菜单', async () => {
  await rightClick('[data-harvest-search]');
  assert.equal(await page.evaluate('return window.ctxPrevented;'), false);
  assert.equal(await menuOpen(), false);
  await rightClick('.right-summary h2');
  assert.equal(await page.evaluate('return window.ctxPrevented;'), false, '未注册区域不拦');

  await page.click('#tools [data-page="home"]');
  await page.click('[data-block="b-read"]');
  await page.waitFor(q('#taskNoteBody'));
  await rightClick('#taskNoteBody');
  assert.equal(await page.evaluate('return window.ctxPrevented;'), false, '任务正文 textarea 保留原生菜单');
  assert.equal(await menuOpen(), false);
  await rightClick('#newTitle');
  assert.equal(await page.evaluate('return window.ctxPrevented;'), false);
});

test('390px 菜单不出界；六套皮肤下菜单用皮肤的底色与危险色；样式表不写死颜色', async () => {
  const css = readFileSync(new URL('../public/menu.css', import.meta.url), 'utf8');
  assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [], [], 'menu.css 里有写死的颜色');

  await page.setViewport(390, 844);
  await page.click('#tools [data-page="harvest"]');
  await page.waitFor(q('[data-harvest-card="h1"]'));
  await rightClick('[data-harvest-card="h1"]', { fx: 0.97, fy: 0.9 });
  assert.equal(await menuOpen(), true);
  const box = await page.evaluate(`
    const r = document.querySelector('.ctx-menu').getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: document.documentElement.clientWidth, vh: innerHeight };
  `);
  assert.ok(box.left >= 0 && box.right <= box.vw && box.top >= 0 && box.bottom <= box.vh, JSON.stringify(box));
  await page.screenshot(join(process.cwd(), 'app', 'shots', 'context-menu-390.png'));
  await key('Escape');

  for (const skin of ['candy', 'mint', 'latte', 'mocha', 'nord', 'rose']) {
    await page.evaluate(`
      if (${JSON.stringify(skin)} === 'mint') delete document.documentElement.dataset.skin;
      else document.documentElement.dataset.skin = ${JSON.stringify(skin)};
      return true;
    `);
    await rightClick('[data-harvest-card="h1"] h2');
    const look = await page.evaluate(`
      const probe = document.createElement('i');
      probe.style.cssText = 'background:var(--surface);color:var(--danger)';
      document.body.append(probe);
      const want = getComputedStyle(probe);
      const menu = getComputedStyle(document.querySelector('.ctx-menu'));
      const danger = getComputedStyle(document.querySelector('.ctx-item.danger'));
      const out = { bg: menu.backgroundColor, wantBg: want.backgroundColor, danger: danger.color, wantDanger: want.color };
      probe.remove();
      return out;
    `);
    assert.equal(look.bg, look.wantBg, `${skin} 菜单底色`);
    assert.equal(look.danger, look.wantDanger, `${skin} 危险项颜色`);
    if (skin === 'mocha') await page.screenshot(join(process.cwd(), 'app', 'shots', 'context-menu-mocha.png'));
    await key('Escape');
  }
  await page.evaluate('delete document.documentElement.dataset.skin; return true;');
  await page.setViewport(1440, 900);
});

test('无控制台错误、无未捕获异常', () => {
  assert.deepEqual(page.pageErrors, []);
  assert.deepEqual(page.consoleErrors, []);
});

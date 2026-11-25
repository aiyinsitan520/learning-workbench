// T-W2：日计划时间块上沿拖动、键盘调节、时间轴密度切换。真 Chrome，走完整用户路径。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-planner-'));
  app = await start({ port: 0, dbPath: join(dir, 'planner.db'), timeZone: TZ });
  base = app.url.replace(/\/$/, '');
  page = await launch({ url: `${base}/`, timeZone: TZ });
  await page.waitFor('document.querySelector("#plannerGrid [data-plan-hour]")');
});

after(async () => {
  if (page) await page.close();
  if (app) await new Promise((resolve) => app.server.close(resolve));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const mouse = (type, x, y) => page.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
  clickCount: type === 'mouseMoved' ? 0 : 1,
});
const point = (selector) => page.evaluate(`
  const el = document.querySelector(${JSON.stringify(selector)});
  el.scrollIntoView({block:'nearest'});
  const r = el.getBoundingClientRect();
  return [r.x + r.width / 2, r.y + r.height / 2];
`);
const dragTo = async (from, to) => {
  await mouse('mousePressed', ...from);
  await mouse('mouseMoved', ...to);
  await mouse('mouseReleased', ...to);
};
const key = async (k, { shift = false } = {}) => {
  const codes = { ArrowUp: 38, ArrowDown: 40 };
  const modifiers = shift ? 8 : 0;
  // 每次都显式写 modifiers，免得 Chrome 把上一次的 Shift 记成一直按着
  if (shift) await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: codes[k], modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: codes[k], modifiers });
  if (shift) await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 0 });
  await new Promise((r) => setTimeout(r, 260));
};
const block = (id) => page.evaluate(`return __wbState.view.scheduled.find((b) => b.id === '${id}');`);
/** 时间轴起点（北京时间 06:00）的秒数：直接读第一格 data-plan-hour，别用 range.end 去猜（那是 UTC 的 06:00）。 */
const axisStart = () => page.evaluate(`return Number(document.querySelector('#plannerGrid [data-plan-hour]').dataset.planHour);`);
/** 在时间轴第 offsetHours 小时放一个块（course=日计划，不进待办），并刷新到页面上。返回它的 startsAt。 */
const seed = async (id, offsetHours, seconds) => {
  const at = await axisStart();
  assert.equal(await page.evaluate(`
    const post = (command) => fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }) }).then((r) => r.ok);
    return await post({ type: 'createTask', id: '${id}', title: '${id}', course: '日计划' })
      && await post({ type: 'saveSchedule', block: { id: '${id}-b', taskId: '${id}', startsAt: ${at + offsetHours * HOUR}, plannedSeconds: ${seconds} } });
  `), true);
  await page.goto(`${base}/`);
  await page.waitFor(`document.querySelector('[data-resize-plan-start="${id}-b"]')`);
  await page.click('[data-sidebar-view="plan"]');
  return at + offsetHours * HOUR;
};
/** 等到某个块变成指定的 startsAt（和 plannedSeconds）。 */
const settled = (id, startsAt, seconds) => page.waitFor(`(() => { const b = __wbState.view.scheduled.find((x) => x.id === '${id}');
  return b.startsAt === ${startsAt}${seconds === undefined ? '' : ` && b.plannedSeconds === ${seconds}`}; })()`);
const scale = () => page.evaluate(`return document.querySelector('.planner-hour').getBoundingClientRect().height;`);
const clickScale = async (px) => {
  await page.click(`[data-plan-scale="${px}"]`);
  assert.equal(await scale(), px, `点「${px}」后每小时 ${px}px`);
};

test('默认密度 48px/小时；上沿手柄存在、两端各约 10px、光标 ns-resize', async () => {
  const seen = await page.evaluate(`
    const btn = document.querySelector('[data-plan-scale="48"]');
    return { pressed: btn?.getAttribute('aria-pressed'), scales: document.querySelectorAll('[data-plan-scale]').length,
      stored: localStorage.getItem('workbench.plannerScale') };
  `);
  assert.equal(await scale(), 48, '默认每小时 48px');
  assert.equal(seen.scales, 3, '紧凑 / 舒适 / 宽松 三档');
  assert.equal(seen.pressed, 'true', '默认选中「舒适」');
  assert.equal(seen.stored, null, '没手动切过时不写 localStorage');

  await seed('w2-size', 3, HOUR); // 09:00–10:00
  const handles = await page.evaluate(`
    const start = document.querySelector('[data-resize-plan-start="w2-size-b"]');
    const end = document.querySelector('[data-resize-plan="w2-size-b"]');
    const css = (el) => getComputedStyle(el);
    return { startH: start.getBoundingClientRect().height, endH: end.getBoundingClientRect().height,
      cursor: css(start).cursor + '|' + css(end).cursor, startRole: start.getAttribute('role'),
      startText: start.getAttribute('aria-valuetext'), endText: end.getAttribute('aria-valuetext'),
      startLabel: start.getAttribute('aria-label') };
  `);
  assert.equal(handles.startH, 10);
  assert.equal(handles.endH, 10);
  assert.equal(handles.cursor, 'ns-resize|ns-resize');
  assert.equal(handles.startRole, 'slider');
  assert.equal(handles.startText, '09:00', '上沿 aria-valuetext 写开始时刻');
  assert.equal(handles.endText, '60 分钟');
  assert.match(handles.startLabel, /开始时间/);
});

test('拖上沿：9:00–10:00 → 9:20–10:00（结束不变、吸附 5 分钟），标签实时显示；刷新后保持', async () => {
  const nine = await seed('w2-size', 3, HOUR); // 09:00–10:00
  const from = await point('[data-resize-plan-start="w2-size-b"]');
  await mouse('mousePressed', ...from);
  await mouse('mouseMoved', from[0], from[1] + 48 / 3); // 20 分钟
  const label = await page.text('#plannerDate');
  await mouse('mouseReleased', from[0], from[1] + 48 / 3);
  assert.equal(label, '09:20–10:00 · 40 分钟', '拖动过程中浮动标签显示起止与分钟数');
  await settled('w2-size-b', nine + 1200, 2400);
  await page.goto(`${base}/`);
  await page.waitFor(`!!__wbState.view`);
  assert.equal((await block('w2-size-b')).startsAt, nine + 1200, '刷新后开始时间保持');
  assert.equal((await block('w2-size-b')).plannedSeconds, 2400);
});

test('拖下沿：9:20–10:00 → 9:20–10:30，标签显示「09:20–10:30 · 70 分钟」', async () => {
  const nine = await axisStart() + 3 * HOUR; // 09:00
  const from = await point('[data-resize-plan="w2-size-b"]');
  await mouse('mousePressed', ...from);
  await mouse('mouseMoved', from[0], from[1] + 48 / 2);
  const label = await page.text('#plannerDate');
  await mouse('mouseReleased', from[0], from[1] + 48 / 2);
  assert.equal(label, '09:20–10:30 · 70 分钟');
  await settled('w2-size-b', nine + 1200, 4200);
});

test('上沿下限：不能早于 06:00；时长不得少于 15 分钟', async () => {
  const six = await seed('w2-limit-a', 0, 1800);   // 06:00–06:30，上沿已在时间轴起点
  // 往上猛拖 06:00 的块：开始时间不变
  let from = await point('[data-resize-plan-start="w2-limit-a-b"]');
  await dragTo(from, [from[0], from[1] - 400]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await block('w2-limit-a-b')).startsAt, six);
  assert.equal((await block('w2-limit-a-b')).plannedSeconds, 1800);

  const noon = await seed('w2-limit-b', 6, HOUR);  // 12:00–13:00，上沿最多推后到 12:45
  from = await point('[data-resize-plan-start="w2-limit-b-b"]');
  await dragTo(from, [from[0], from[1] + 400]);
  await settled('w2-limit-b-b', noon + 2700, 900);
  // 下沿往回缩到不足 15 分钟：停在 15
  from = await point('[data-resize-plan="w2-limit-b-b"]');
  await dragTo(from, [from[0], from[1] - 400]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await block('w2-limit-b-b')).plannedSeconds, 900, '下沿不得缩到 15 分钟以下');
});

test('原本短于 15 分钟的块：以原时长为下限；矮块手柄仍分上下', async () => {
  const at = await seed('w2-short', 5, 600); // 11:00，10 分钟 = 8px 高的块
  const size = await page.evaluate(`
    const card = document.querySelector('[data-resize-plan-start="w2-short-b"]').parentElement;
    const c = card.getBoundingClientRect();
    const s = card.querySelector('.planner-resize-start').getBoundingClientRect();
    const e = card.querySelector('.planner-resize-end').getBoundingClientRect();
    return { cls: card.className, cardH: c.height, sTop: s.top - c.top, sH: s.height, eTop: e.top - c.top, eH: e.height };
  `);
  assert.match(size.cls, /\btiny\b/, '块不足 12px 高时加 tiny');
  assert.ok(size.sTop <= 1.5 && size.sTop + size.sH <= size.eTop + 0.5, `上沿在块的上半、下沿在下半，不互相盖住：${JSON.stringify(size)}`);
  const from = await point('[data-resize-plan-start="w2-short-b"]');
  await dragTo(from, [from[0], from[1] + 200]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await block('w2-short-b')).startsAt, at);
  assert.equal((await block('w2-short-b')).plannedSeconds, 600, '原时长是下限');

  // 20 分钟 = 16px：short，两个手柄各 6px，中间仍留得出标题
  await seed('w2-short2', 7, 1200); // 13:00–13:20
  const mid = await page.evaluate(`
    const card = document.querySelector('[data-resize-plan-start="w2-short2-b"]').parentElement;
    const handle = card.querySelector('.planner-resize-start');
    return { cls: card.className, h: handle.getBoundingClientRect().height, taskH: card.querySelector('.planner-task').getBoundingClientRect().height };
  `);
  assert.match(mid.cls, /\bshort\b/);
  assert.doesNotMatch(mid.cls, /\btiny\b/);
  assert.equal(mid.h, 6, '矮块手柄缩到 6px');
  assert.ok(mid.taskH > 0, '中间仍留得出标题');
});

test('键盘：上沿 ↑ 提前 5 分钟、↓ 推后 5 分钟；Shift 为 15 分钟；下沿同理', async () => {
  const ten = await seed('w2-key', 4, HOUR); // 10:00–11:00
  await page.evaluate('document.querySelector(\'[data-resize-plan-start="w2-key-b"]\').focus(); return true;');
  await key('ArrowDown');
  await settled('w2-key-b', ten + 300, 3300);
  await key('ArrowUp', { shift: true });
  await settled('w2-key-b', ten - 600, 4200);
  assert.equal(await page.evaluate('return document.activeElement?.dataset.resizePlanStart;'), 'w2-key-b', '重绘后焦点回到上沿手柄');
  await page.evaluate('document.querySelector(\'[data-resize-plan="w2-key-b"]\').focus(); return true;');
  await key('ArrowUp');
  await settled('w2-key-b', ten - 600, 3900);
  await key('ArrowDown', { shift: true });
  await settled('w2-key-b', ten - 600, 4800);
  assert.equal(await page.evaluate('return document.activeElement?.dataset.resizePlan;'), 'w2-key-b', '焦点回到下沿手柄');
});

test('密度切换：三档可点、记进 localStorage、刷新后记住；Ctrl+滚轮也能切', async () => {
  await clickScale(32);
  assert.equal(await page.evaluate(`return localStorage.getItem('workbench.plannerScale');`), '32');
  assert.equal(await page.evaluate(`return document.querySelector('[data-plan-scale="32"]').getAttribute('aria-pressed');`), 'true');
  await clickScale(64);
  await page.goto(`${base}/`);
  await page.waitFor('document.querySelector("#plannerGrid [data-plan-hour]")');
  assert.equal(await scale(), 64, '刷新后仍是宽松');
  // Ctrl+滚轮：向下滚变紧、向上滚变松
  const [x, y] = await point('#plannerGrid .planner-hour:nth-child(3) time');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 120, modifiers: 2 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await page.evaluate(`return localStorage.getItem('workbench.plannerScale');`), '48');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -120, modifiers: 2 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await page.evaluate(`return localStorage.getItem('workbench.plannerScale');`), '64');
  // 不按 Ctrl 的滚轮只滚动，不改密度
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 120 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await page.evaluate(`return localStorage.getItem('workbench.plannerScale');`), '64');
  await clickScale(48);
});

test('换密度后拖上沿仍对齐 5 分钟：宽松 64px 下拖 16px = 15 分钟，紧凑 32px 下拖 8px = 15 分钟', async () => {
  await clickScale(64);
  const four = await seed('w2-scale', 10, HOUR); // 16:00–17:00
  let from = await point('[data-resize-plan-start="w2-scale-b"]');
  await dragTo(from, [from[0], from[1] + 16]);
  await settled('w2-scale-b', four + 900, 2700);
  await clickScale(32);
  from = await point('[data-resize-plan-start="w2-scale-b"]');
  await dragTo(from, [from[0], from[1] - 8]);
  await settled('w2-scale-b', four, HOUR);
  await clickScale(48);
});

test('390px 宽：密度切换与手柄可见可用，不横向溢出', async () => {
  const viewport = await page.evaluate('return [innerWidth, innerHeight];');
  const nine20 = (await block('w2-size-b')).startsAt;
  await page.setViewport(390, 900);
  const seen = await page.evaluate(`
    const bar = document.querySelector('.planner-scale');
    const handle = document.querySelector('[data-resize-plan-start="w2-size-b"]');
    handle.scrollIntoView({ block: 'nearest' });
    const r = bar.getBoundingClientRect();
    const h = handle.getBoundingClientRect();
    const grid = document.querySelector('#plannerGrid');
    return { w: r.width, right: r.right, left: r.left, hw: h.width, hh: h.height,
      overflow: grid.scrollWidth > grid.clientWidth + 1, inner: innerWidth };
  `);
  assert.ok(seen.w > 0 && seen.right <= seen.inner && seen.left >= 0, `密度切换应在视口内：${JSON.stringify(seen)}`);
  assert.equal(seen.overflow, false, '时间轴不得横向溢出');
  assert.ok(seen.hw > 40 && seen.hh === 10, `窄窗口手柄仍 10px 高、可点：${JSON.stringify(seen)}`);
  const from = await point('[data-resize-plan-start="w2-size-b"]');
  await dragTo(from, [from[0], from[1] + 4]); // 48px 下 4px = 5 分钟
  await settled('w2-size-b', nine20 + 300);
  await page.setViewport(...viewport);
});

// ---------------------------------------------------------------- 审查修复回归（T-W2/T-W4）

/** 按绝对秒数造一个块（可以早于 06:00，用来验上沿下限）。 */
const seedAt = async (id, startsAt, seconds) => {
  assert.equal(await page.evaluate(`
    const post = (command) => fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }) }).then((r) => r.ok);
    return await post({ type: 'createTask', id: '${id}', title: '${id}', course: '日计划' })
      && await post({ type: 'saveSchedule', block: { id: '${id}-b', taskId: '${id}', startsAt: ${startsAt}, plannedSeconds: ${seconds} } });
  `), true);
  await page.goto(`${base}/`);
  await page.waitFor(`document.querySelector('[data-resize-plan-start="${id}-b"]')`);
  await page.click('[data-sidebar-view="plan"]');
};

test('审查修复：05:30–07:00 的块按 ↑ 只会更早或不变，不会被限幅推到 06:00 之后', async () => {
  const at = await axisStart();
  const five30 = at - 1800; // 06:00 往前半小时
  await seedAt('w2-early', five30, 5400); // 05:30–07:00
  assert.equal((await block('w2-early-b')).startsAt, five30, '前提：块开始于 05:30');

  // 键盘 ↑：块本来就在时间轴起点之前，下限就是它自己 → 开始时间不变（旧实现会变成 06:00）
  const focusStart = 'document.querySelector(\'[data-resize-plan-start="w2-early-b"]\').focus(); return true;';
  await page.evaluate(focusStart);
  await key('ArrowUp');
  await new Promise((r) => setTimeout(r, 300));
  const afterUp = await block('w2-early-b');
  assert.equal(afterUp.startsAt, five30, `↑ 不得把开始时间往后推，实际 ${(afterUp.startsAt - five30) / 60} 分`);
  assert.equal(afterUp.plannedSeconds, 5400, '没推动就什么都不改');

  // ↓ 可以推后（上限是「结束前留 15 分钟」）
  await page.evaluate(focusStart);
  await key('ArrowDown');
  await new Promise((r) => setTimeout(r, 400));
  const afterDown = await block('w2-early-b');
  assert.equal(afterDown.startsAt, five30 + 300,
    `↓ 应推后 5 分钟：实际 ${(afterDown.startsAt - five30) / 60} 分，时长 ${afterDown.plannedSeconds}`);
  assert.equal(afterDown.plannedSeconds, 5100);

  // 拖动上沿向上：同样不得把开始时间往后推
  await seedAt('w2-early2', five30, 5400);
  const from = await point('[data-resize-plan-start="w2-early2-b"]');
  await dragTo(from, [from[0], from[1] - 48 / 3]); // 20 分钟
  await new Promise((r) => setTimeout(r, 300));
  const dragged = await block('w2-early2-b');
  assert.ok(dragged.startsAt <= five30, `向上拖不得把开始时间往后推：${dragged.startsAt - five30}s`);
});

test('审查修复：47 分钟项目拖到 23:40 保存 23:40–24:00，落点不被改写且吸附 5 分钟', async () => {
  const at = await axisStart();
  const axisHours = await page.evaluate('return document.querySelectorAll("#plannerGrid [data-plan-hour]").length;');
  const late = at + (axisHours - 1) * HOUR + 40 * 60; // 23:40（时间轴最后一小时 +40 分）
  assert.equal(await page.evaluate(`
    const r = await fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: { type: 'createProject', id: 'w4-trim', title: '深夜读书',
        startDay: __wbState.view.day, dueDay: null, dailyMinutes: 47, mainTaskId: 'w4-trim-main' } }) });
    return (await r.json()).ok;
  `), true);
  await page.goto(`${base}/`);
  await page.waitFor('document.querySelector(\'#projects [data-drag-project="w4-trim"]\')');

  const from = await point('#projects [data-drag-project="w4-trim"]');
  const to = await page.evaluate(`
    const grid = document.querySelector('#plannerGrid');
    const hh = document.querySelector('.planner-hour').getBoundingClientRect().height;
    const from = Number(grid.querySelector('[data-plan-hour]').dataset.planHour);
    const y = (${late} - from) * hh / ${HOUR};
    grid.scrollTop = Math.max(0, y - grid.clientHeight / 2);
    const layer = document.querySelector('.planner-layer').getBoundingClientRect();
    return [layer.left + layer.width / 2, layer.top + y];
  `);
  await mouse('mousePressed', ...from);
  await mouse('mouseMoved', ...to);
  await mouse('mouseReleased', ...to);
  await page.waitFor(`__wbState.view.scheduled.some((b) => b.taskId === 'w4-trim-main')`);
  const saved = (await page.evaluate(`return __wbState.view.scheduled.filter((b) => b.taskId === 'w4-trim-main');`))[0];
  assert.equal(saved.startsAt, late, `落点应是 23:40，实际 ${(saved.startsAt - at) / 60} 分`);
  assert.equal(saved.startsAt % 300, 0, '落点吸附到 5 分钟');
  assert.equal(saved.startsAt + saved.plannedSeconds, at + axisHours * HOUR, '结束于时间轴末尾（24:00）');
  assert.equal(saved.plannedSeconds, 20 * 60, '时长裁剪为当天剩余 20 分钟');
});

/** 卡片上没有「排进今天」按钮了：右键菜单里那条走同一条 planNow，用它验证「放不下就不建块」。 */
async function chooseProjectMenu(projectId, label) {
  const sel = '#projects [data-project-card="' + projectId + '"]';
  const pt = await page.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  `);
  assert.ok(pt, '右键目标不存在：' + projectId);
  const [x, y] = pt;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
  await page.waitFor('document.querySelector(".ctx-menu .ctx-item")');
  const ok = await page.evaluate(`
    const row = [...document.querySelectorAll('.ctx-menu .ctx-item')]
      .find((el) => el.querySelector('.ctx-label').textContent.trim() === ${JSON.stringify(label)});
    if (!row) return false;
    row.click();
    return true;
  `);
  assert.ok(ok, '右键菜单里没有「' + label + '」');
  await new Promise((r) => setTimeout(r, 400));
}

test('审查修复：每日 1200 分钟的项目从右键菜单「排进今天」，放不下就提示，不会溢到次日', async () => {
  // 1200 分钟 = 20 小时 > 时间轴 18 小时，今天不可能放下
  assert.equal(await page.evaluate(`
    const r = await fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: { type: 'createProject', id: 'w4-huge', title: '超长项目',
        startDay: __wbState.view.day, dueDay: null, dailyMinutes: 1200, mainTaskId: 'w4-huge-main' } }) });
    return (await r.json()).ok;
  `), true);
  await page.goto(`${base}/`);
  await page.waitFor('document.querySelector(\'#projects [data-project-card="w4-huge"]\')');
  const before = await page.evaluate(`return __wbState.view.scheduled.filter((b) => b.taskId === 'w4-huge-main').length;`);
  await chooseProjectMenu('w4-huge', '排进今天');
  const after = await page.evaluate(`return __wbState.view.scheduled.filter((b) => b.taskId === 'w4-huge-main');`);
  assert.equal(after.length, before, '放不下就不建块');
  assert.match(await page.text('#toast'), /今天排满了/);
});

test('审查修复：紧凑档 32px 下拖 3px 就能吸附一步（阈值不超过一个吸附步长）', async () => {
  await clickScale(32);
  const at = await seed('w2-tight', 10, HOUR); // 16:00–17:00
  // 32px/小时时 5 分钟 ≈ 2.67px，3px 已经够触发拖动
  const from = await point('[data-resize-plan-start="w2-tight-b"]');
  await dragTo(from, [from[0], from[1] + 3]);
  await settled('w2-tight-b', at + 300, 3300);
  await clickScale(48);
});

test('六套皮肤下手柄抓手线有颜色、光标正确、密度按钮文字随令牌变', async () => {
  await page.evaluate(`localStorage.setItem('workbench.skin', 'candy'); localStorage.setItem('workbench.skin-choice', 'candy'); return true;`);
  await page.goto(`${base}/`);
  await page.waitFor('document.querySelector("#skinToggle") && document.querySelector("[data-resize-plan-start]")');
  await page.click('#skinToggle');
  const colors = new Set();
  for (const id of ['mint', 'latte', 'mocha', 'nord', 'rose', 'candy']) {
    await page.click(`[data-skin-pick="${id}"]`);
    const seen = await page.evaluate(`
      const el = document.querySelector('[data-resize-plan-start="w2-size-b"]');
      el.scrollIntoView({ block: 'nearest' });
      const line = getComputedStyle(el, '::after');
      const pressed = getComputedStyle(document.querySelector('.planner-scale [aria-pressed="true"]'));
      return { bg: line.backgroundColor, ink: pressed.color, cursor: getComputedStyle(el).cursor, skin: document.documentElement.dataset.skin };
    `);
    assert.equal(seen.skin ?? 'mint', id);
    assert.notEqual(seen.bg, 'rgba(0, 0, 0, 0)', `${id} 下抓手线有颜色`);
    assert.equal(seen.cursor, 'ns-resize');
    assert.notEqual(seen.ink, 'rgba(0, 0, 0, 0)', `${id} 下密度按钮文字有颜色`);
    colors.add(seen.bg);
    if (id === 'mocha') await page.screenshot(join(process.cwd(), 'app', 'shots', 'planner-mocha.png'));
    await page.click('#skinToggle');
  }
  assert.ok(colors.size >= 2, `抓手线颜色应随皮肤变化：${[...colors].join(' / ')}`);
});

test('无控制台错误、无未捕获异常', async () => {
  assert.deepEqual(page.pageErrors, [], `页面异常：${page.pageErrors.join('\n')}`);
  assert.deepEqual(page.consoleErrors, [], `控制台错误：${page.consoleErrors.join('\n')}`);
});

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server.js';
import { launch } from './browser.mjs';

let dir, app, page;
const nav = name => page.click('#tools [data-page="' + name + '"]');
const run = source => page.evaluate(source);
const remember = '[data-harvest-review-remember]';
const point = '[data-harvest-card="points"] [data-harvest-point="1"]';
const points = () => app.workbench.readHarvest('points').points;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-pages-'));
  app = await start({ port: 0, dbPath: join(dir, 'test.db'), timeZone: 'Asia/Shanghai' });
  const { view } = await (await fetch(new URL('/api/view', app.url))).json();
  const wb = app.workbench;
  wb.createTask({ id: 'task', title: '昨天的任务' });
  wb.saveSchedule({ block: { id: 'old', taskId: 'task', startsAt: view.range.start - 86400 + 3600, plannedSeconds: 900 } });
  wb.createProject({ id: 'proj', title: '项目', startDay: view.day, mainTaskId: 'main-task' });
  wb.createHarvest({ id: 'points', title: '要点', points: ['甲','乙','丙'] });
  wb.createHarvest({ id: 'second', title: '第二张' });
  page = await launch({ url: app.url, timeZone: 'Asia/Shanghai' });
});
beforeEach(async () => {
  await page.goto(app.url);
  await page.waitFor('!!window.__wbState.view');
});
after(async () => {
  try { await page?.close(); } finally {
    if (app) await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); });
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// 用 Promise 控制请求先后次序，正常写操作仍走临时数据库。
async function intercept(body) {
  await run(`const real = window.fetch.bind(window);
    const gate = new Promise(resolve => { window.release = resolve; });
    window.calls = 0;
    window.fetch = async (url, init) => {
      const cmd = init?.body && JSON.parse(init.body).command;
      ${body}
      return real(url, init);
    };`);
}
async function review(ids = ['points']) {
  await nav('harvest');
  await run(`const previous = window.fetch;
    window.fetch = (url, init) => String(url).includes('due=1&limit=50')
      ? Promise.resolve(Response.json({ ok: true, harvests: ${JSON.stringify(ids.map(id => ({ id, title: id, points: [] })))} }))
      : previous(url, init);
    document.querySelector('[data-harvest-review-start]').click();`);
  await page.click('[data-harvest-review-show]');
}
const delayAnswer = 'if (cmd?.type === "reviewHarvest") { window.calls++; await gate; }';

test('01 顺延连点只写一次，重进看板识别已顺延', async () => {
  await nav('review');
  await page.waitFor('document.querySelector("[data-board-move]")');
  await intercept('if (cmd?.type === "saveSchedule") { window.calls++; await gate; }');
  await run('const b = document.querySelector("[data-board-move]"); b.click(); b.click();');
  await page.waitFor('calls > 0');
  assert.ok(await run('return document.querySelector("[data-board-move]").disabled'));
  await run('release()');
  const marked = 'document.querySelector(".board-mark")?.textContent === "已顺延"';
  await page.waitFor(marked);
  assert.equal(await run('return calls'), 1);
  await nav('harvest');
  await nav('review');
  await page.waitFor(marked);
  const { view } = await (await fetch(new URL('/api/view', app.url))).json();
  assert.equal(view.scheduled.filter(b => b.taskId === 'task').length, 1);
});

test('02 两个回答按钮同步锁定，一次只前进一张', async () => {
  await intercept(delayAnswer);
  await review(['points','second']);
  const locked = await run(`const b = document.querySelector('${remember}'); b.click(); b.click();
    return b.disabled && document.querySelector('[data-harvest-review-forgot]').disabled;`);
  assert.equal(locked, true);
  await run('release()');
  await page.waitFor('document.querySelector(".review-card h2")?.textContent === "second"');
  assert.equal(await run('return calls'), 1);
  assert.equal(app.workbench.readHarvest('points').review.count, 1);
});

test('03 写失败保留当前卡，允许重试', async () => {
  await intercept('if (cmd?.type === "reviewHarvest" && !window.calls++) return Response.json({ok:false,message:"写入失败"},{status:503});');
  await review();
  await page.click(remember);
  assert.match(await page.text('#toast'), /重试/);
  assert.equal(await page.text('.review-card h2'), 'points');
  await page.click(remember);
  await page.waitFor('document.querySelector("#toast").textContent.includes("复习完成")');
});

test('04 离开收获页后延迟读取不会打开旧弹框', async () => {
  await nav('harvest');
  await intercept('if (url === "/api/harvests/random") { window.calls++; await gate; return Response.json({id:"late",title:"late",points:[]}); }');
  await page.click('[data-harvest-random]');
  await page.waitFor('calls === 1');
  await nav('calendar');
  await run('release(); await new Promise(resolve => setTimeout(resolve, 0))');
  assert.equal(await page.count('#dialog[open] [data-harvest-reviewbox]'), 0);
});

test('05 已关闭的复习框收到回包时保留新弹窗', async () => {
  await intercept(delayAnswer);
  await review();
  await page.click(remember);
  await page.click('[data-harvest-review-close]');
  await page.click('[data-harvest-open]');
  const capture = '#dialog[open] [data-harvest-capture]';
  assert.equal(await page.count(capture), 1);
  await run('window.beforeAnswer = window.__wbState.view; release()');
  await page.waitFor('window.beforeAnswer !== window.__wbState.view');
  await run('await new Promise(requestAnimationFrame)');
  assert.equal(await page.count(capture), 1);
});

test('07 删除中间要点后撤销恢复原位置', async () => {
  await nav('harvest');
  await page.click(point + ' [data-harvest-removerow]');
  assert.deepEqual(points(), ['甲','丙']);
  assert.match(await page.text('#toast'), /已删除要点.*撤销/);
  await page.click('#toast button');
  assert.deepEqual(points(), ['甲','乙','丙']);
});

test('08 Enter 聚焦空草稿，有内容才保存', async () => {
  app.workbench.updateHarvest({ harvestId: 'points', points: ['甲','乙','丙'] });
  await nav('harvest');
  await run(`const span = document.querySelector('${point} [data-harvest-editrow]');
    span.focus(); span.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
  const finish = (value, key) => run(`document.activeElement.textContent = ${JSON.stringify(value)};
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}));`);
  await finish('改', 'Enter');
  await page.waitFor('document.activeElement.isContentEditable && !document.activeElement.textContent');
  assert.deepEqual(points(), ['甲','改','丙']);
  await finish('新增', 'Tab');
  await page.waitFor('document.querySelector(".harvest-list").textContent.includes("新增")');
  assert.deepEqual(points(), ['甲','改','新增','丙']);
});

test('09 Esc 和点外部都关闭项目菜单并归还焦点', async () => {
  for (const dismiss of ['escape','outside']) {
    await page.click('[data-project-menu="proj"]');
    assert.equal(await page.count('[data-project-menu-for="proj"]:not([hidden])'), 1);
    if (dismiss === 'escape') await page.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
    else await run('document.body.click()');
    const dismissed = await run(`return document.activeElement.dataset.projectMenu === 'proj'
      && document.querySelector('[data-project-menu-for="proj"]').hidden;`);
    assert.equal(dismissed, true);
  }
});

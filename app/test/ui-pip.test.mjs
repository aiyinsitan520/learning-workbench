// 任务正文上的「完成任务」按钮，与番茄钟悬浮小窗（js/pip.js）。临时库、临时服务，不碰用户数据。
// 无头 Chrome 里拿不到真正的 Document PiP 窗口，这里注入一个用 window.open 模拟的 documentPictureInPicture，
// 验证小窗的内容、按钮和跟随皮肤；真实小窗的置顶效果靠人工在 Chrome 里看。
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

/** 真实鼠标点击（有用户激活）：打开 PiP / 弹出窗口必须由用户手势触发，el.click() 不算。 */
async function realClick(selector) {
  const box = await page.evaluate(`const el = document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  await new Promise((r) => setTimeout(r, 200));
}

const post = (command) => page.evaluate(`
  const r = await fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: ${JSON.stringify(command)} }) });
  return r.ok;`);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-pip-'));
  app = await start({ port: 0, dbPath: join(dir, 'pip.db'), timeZone: TZ });
  base = app.url.replace(/\/$/, '');
  page = await launch({ timeZone: TZ });
  // 模拟 Document PiP：requestWindow 返回一个普通弹出窗口，记在 window.__pip 方便断言
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    // 浏览器自带的 documentPictureInPicture 是只读访问器，直接赋值无效，必须 defineProperty 覆盖
    Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: {
      async requestWindow({ width, height } = {}) {
        const w = window.open('', 'pip-' + Date.now(), 'popup,width=' + width + ',height=' + height);
        w.document.write('<!doctype html><html><head></head><body></body></html>');
        w.document.close();
        window.__pip = { w, width, height };
        return w;
      },
    } });` });
  await page.goto(`${base}/`);
  await page.waitFor('!!window.__wbState.view');
});

after(async () => {
  if (page) await page.close();
  if (app) await new Promise((resolve) => app.server.close(resolve));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('任务正文：「完成任务」按钮勾掉任务，再点可撤销', async () => {
  assert.equal(await post({ type: 'createTask', id: 'pip-done', title: '整理电路实验数据', course: '' }), true);
  await page.goto(`${base}/`);
  await page.waitFor('!!window.__wbState.view');
  await page.evaluate(`window.__wbState.selectedTaskId = 'pip-done'; return true;`);
  await page.click('#tools [data-page="calendar"]');
  await page.click('#tools [data-page="home"]');
  await page.waitFor('document.querySelector("#taskEditorDone")?.dataset.complete === "pip-done"');
  assert.equal(await page.text('#taskEditorDone'), '完成任务');

  await page.click('#taskEditorDone');
  await page.waitFor('window.__wbState.view.completedOnDay.some((t) => t.id === "pip-done")');
  await page.waitFor('document.querySelector("#taskEditorDone")?.dataset.undo === "pip-done"');
  assert.equal(await page.text('#taskEditorDone'), '已完成 · 撤销');
  assert.equal(await page.evaluate('return document.querySelector("#taskEditorFocus").hidden;'), true, '完成后不再显示开始专注');

  await page.click('#taskEditorDone');
  await page.waitFor('window.__wbState.view.pending.some((t) => t.id === "pip-done")');
  await page.waitFor('document.querySelector("#taskEditorDone")?.dataset.complete === "pip-done"');
});

test('悬浮小窗：从专注页打开，显示任务与倒计时，按钮能暂停 / 继续 / 完成任务', async () => {
  assert.equal(await post({ type: 'createTask', id: 'pip-focus', title: '画出采样前后的频谱', course: '' }), true);
  await page.goto(`${base}/`);
  await page.waitFor('!!window.__wbState.view');
  await page.evaluate(`window.__wbState.selectedTaskId = 'pip-focus'; window.__wbState.freeFocus = false; return true;`);
  await page.click('#tools [data-page="focus"]');
  await page.waitFor('document.querySelector("#main [data-action=pip]")');

  // 打开（空闲状态）：标题是选中的任务，主按钮是「开始」
  await realClick('#main [data-action="pip"]');
  await page.waitFor('window.__pip?.w?.document.querySelector(".pip-clock")?.textContent');
  const idle = await page.evaluate(`const d = window.__pip.w.document; return {
    size: [window.__pip.width, window.__pip.height],
    task: d.querySelector('.pip-task').textContent, clock: d.querySelector('.pip-clock').textContent,
    main: d.querySelector('[data-pip=toggle]').textContent, state: d.querySelector('.pip').dataset.state,
    styled: d.styleSheets.length > 0, skin: d.documentElement.dataset.skin ?? null };`);
  assert.deepEqual(idle.size, [280, 176]);
  assert.equal(idle.task, '画出采样前后的频谱');
  assert.match(idle.clock, /^\d\d:\d\d$/);
  assert.match(idle.main, /^开始 \d+ 分钟$/);
  assert.equal(idle.state, 'idle');
  assert.equal(idle.styled, true, '样式表应复制进小窗');
  assert.equal(idle.skin, await page.evaluate('return document.documentElement.dataset.skin ?? null;'), '小窗跟随当前皮肤');

  // 在小窗里点「开始」→ 开始专注；再点「暂停」→ 暂停
  await page.evaluate(`window.__pip.w.document.querySelector('[data-pip=toggle]').click(); return true;`);
  await page.waitFor('window.__wbState.view.openFocus?.state === "running"');
  await page.waitFor('window.__pip.w.document.querySelector(".pip").dataset.state === "running"');
  assert.equal(await page.evaluate(`return window.__pip.w.document.querySelector('[data-pip=toggle]').textContent;`), '暂停');
  await page.evaluate(`window.__pip.w.document.querySelector('[data-pip=toggle]').click(); return true;`);
  await page.waitFor('window.__wbState.view.openFocus?.state === "paused"');
  await page.waitFor('window.__pip.w.document.querySelector(".pip").dataset.state === "paused"');

  // 「完成任务」：先记下这一轮专注，再勾掉任务
  await page.evaluate(`window.__pip.w.document.querySelector('[data-pip=done]').click(); return true;`);
  await page.waitFor('window.__wbState.view.openFocus === null && window.__wbState.view.completedOnDay.some((t) => t.id === "pip-focus")');

  // 再点一次入口 = 关闭小窗
  await realClick('#main [data-action="pip"]');
  await page.waitFor('window.__pip.w.closed');
  assert.deepEqual(page.pageErrors, []);
});

test('悬浮小窗：浏览器不支持时给出提示，不报错', async () => {
  // pip.js 在启动时判断支持情况，重新加载一个没有该 API 的页面来验证提示
  const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: undefined });
      Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: false });` });
  try {
    await page.goto(`${base}/`);
    await page.waitFor('!!window.__wbState.view');
    await page.click('#tools [data-page="focus"]');
    await page.click('#main [data-action="pip"]');
    await page.waitFor('document.querySelector("#toast.on")?.textContent.includes("不支持悬浮小窗")');
  } finally {
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
  assert.deepEqual(page.pageErrors, []);
});

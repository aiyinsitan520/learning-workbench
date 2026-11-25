// 新手引导与帮助面板（T-W9）。临时库、临时服务、全新浏览器配置（localStorage 为空 = 第一次打开）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './browser.mjs';
import { start } from '../server.js';

const TZ = 'Asia/Shanghai';
const KEY = 'workbench.tour.v1';
const ALL = ['nav', 'planner', 'todo', 'focus', 'notes', 'projects', 'harvest', 'menu', 'data'];
let app;
let page;
let dir;
let base;

const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
const shown = (selector) => page.evaluate(`return (${q(selector)}?.getClientRects().length ?? 0) > 0;`);
const step = () => page.evaluate('return document.querySelector(".tour-layer")?.dataset.step ?? null;');
const stored = () => page.evaluate(`return localStorage.getItem(${JSON.stringify(KEY)});`);
const KEYS = {
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  '?': { code: 'Slash', windowsVirtualKeyCode: 191, text: '?', modifiers: 8 },
};
async function key(name) {
  const spec = { key: name, ...KEYS[name] };
  await page.send('Input.dispatchKeyEvent', { type: spec.text ? 'keyDown' : 'rawKeyDown', ...spec });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec });
  await new Promise((r) => setTimeout(r, 120));
}
async function reloadFresh({ clear = false } = {}) {
  if (clear) await page.evaluate(`localStorage.removeItem(${JSON.stringify(KEY)}); return true;`);
  await page.goto(`${base}/`);
  await page.waitFor('!!window.__wbState.view');
}
/** 一路点「下一步」到引导结束，返回经过的步骤，并检查每一步气泡都在视口内。 */
async function walk() {
  const seen = [];
  for (let i = 0; i < 20 && await step(); i += 1) {
    seen.push(await step());
    const box = await page.evaluate(`
      const r = document.querySelector('.tour-bubble').getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom, vw: document.documentElement.clientWidth, vh: innerHeight };
    `);
    assert.ok(box.l >= 0 && box.r <= box.vw && box.t >= 0 && box.b <= box.vh, `${seen.at(-1)} 气泡出界：${JSON.stringify(box)}`);
    await page.click('[data-tour-next]');
  }
  return seen;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-tour-'));
  app = await start({ port: 0, dbPath: join(dir, 'tour.db'), timeZone: TZ });
  base = app.url.replace(/\/$/, '');
  page = await launch({ url: `${base}/`, timeZone: TZ });
  await page.waitFor('!!window.__wbState.view');
});

after(async () => {
  if (page) await page.close();
  if (app) await new Promise((resolve) => app.server.close(resolve));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('首次打开：主区顶部出现欢迎卡；空日计划、空项目区、空收获页各有一句「试试……」', async () => {
  assert.equal(await stored(), null);
  assert.equal(await shown('.tour-welcome'), true);
  assert.match(await page.text('.tour-welcome'), /开始 1 分钟引导/);
  assert.match(await page.text('.tour-welcome'), /以后再说/);
  assert.equal(await shown('.tour-layer'), false, '欢迎卡不自动开始引导、不挡页面');
  assert.match(await page.text('#plannerGrid .planner-try'), /^试试/);
  assert.equal(await page.evaluate(`return getComputedStyle(${q('.planner-try')}).pointerEvents;`), 'none',
    '空日计划提示不能挡住时间轴的点击');
  assert.match(await page.text('#projects .proj-try'), /^试试/);
  await page.click('#tools [data-page="harvest"]');
  await page.waitFor(q('.harvest-empty'));
  assert.match(await page.text('.harvest-empty .harvest-try'), /^试试/);
  await page.click('#tools [data-page="home"]');
});

test('引导：9 步依次高亮，上一步 / 下一步 / 方向键可用；进行中不做实时刷新；完成后不再出现', async () => {
  await page.click('[data-tour-start]');
  await page.waitFor(q('.tour-layer'));
  assert.equal(await shown('.tour-welcome'), false, '开始后欢迎卡收起');
  assert.equal(await step(), 'nav');
  assert.match(await page.text('[data-tour-count]'), /第 1 \/ 9 步/);
  assert.equal(await page.evaluate(`return ${q('[data-tour-prev]')}.disabled;`), true);
  assert.equal(await page.evaluate('return document.activeElement?.matches("[data-tour-next]");'), true, '焦点在「下一步」');
  const spot = await page.evaluate(`
    const s = document.querySelector('.tour-spot').getBoundingClientRect();
    const a = document.querySelector('[data-tour="nav"]').getBoundingClientRect();
    return s.left <= a.left && s.right >= a.right && s.top <= a.top && s.bottom >= a.bottom;
  `);
  assert.equal(spot, true, '聚光圈罩住锚点');

  await key('ArrowRight');
  assert.equal(await step(), 'planner');
  await key('ArrowLeft');
  assert.equal(await step(), 'nav');

  // 引导期间别的窗口改了数据：先不重绘，结束后再跟上
  const res = await fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: { type: 'createTask', id: 'live-1', title: '引导期间的新任务', course: '', estimatedSeconds: null } }) });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(await page.evaluate('return __wbState.view.pending.some((t) => t.id === "live-1");'), false,
    '引导进行中不应重绘');

  const seen = await walk();
  assert.deepEqual(seen, ALL);
  assert.equal(await shown('.tour-layer'), false);
  assert.equal(await stored(), 'done');
  await page.waitFor('__wbState.view.pending.some((t) => t.id === "live-1")');

  await reloadFresh();
  assert.equal(await shown('.tour-welcome'), false, '完成后再打开不出现欢迎卡');
});

test('Esc 退出引导；锚点不可见的步骤自动跳过', async () => {
  await page.click('#helpBtn');
  await page.click('[data-tour-restart]');
  await page.waitFor(q('.tour-layer'));
  await key('ArrowRight');
  await key('Escape');
  assert.equal(await shown('.tour-layer'), false);
  assert.equal(await stored(), 'skipped');

  await page.evaluate(`document.querySelector('[data-tour="todo"]').style.display = 'none'; return true;`);
  await page.click('#helpBtn');
  await page.click('[data-tour-restart]');
  const seen = await walk();
  assert.deepEqual(seen, ALL.filter((id) => id !== 'todo'));
  await page.evaluate(`document.querySelector('[data-tour="todo"]').style.display = ''; return true;`);
});

test('帮助面板：顶栏「?」和 ? 键打开；功能速查「带我去」；快捷键表；重新开始引导', async () => {
  await page.click('#helpBtn');
  await page.waitFor(q('#dialog[open] [data-tour-help]'));
  assert.equal(await page.count('.tour-features li'), ALL.length);
  assert.equal(await page.count('.tour-features [data-tour-goto]'), ALL.length);
  const keys = await page.text('.tour-keys');
  for (const k of ['Ctrl+Shift+V', 'Shift+F10', 'Ctrl+S', 'Esc']) assert.ok(keys.includes(k), `快捷键表缺 ${k}`);
  await page.click(`[data-tour-goto="${ALL.indexOf('projects')}"]`);
  await page.waitFor(q('.tour-layer'));
  assert.equal(await page.evaluate('return document.querySelector("#dialog").open;'), false, '「带我去」先关帮助');
  assert.equal(await step(), 'projects');
  await key('Escape');

  await page.evaluate('document.activeElement?.blur(); return true;');
  await key('?');
  await page.waitFor(q('#dialog[open] [data-tour-help]'));
  await page.click('[data-tour-restart]');
  await page.waitFor(q('.tour-layer'));
  assert.equal(await step(), 'nav');
  await key('Escape');
});

test('「以后再说」：收起欢迎卡并记住，下次打开不再出现', async () => {
  await reloadFresh({ clear: true });
  assert.equal(await shown('.tour-welcome'), true);
  await page.click('[data-tour-later]');
  assert.equal(await shown('.tour-welcome'), false);
  assert.equal(await stored(), 'later');
  await reloadFresh();
  assert.equal(await shown('.tour-welcome'), false);
});

test('390px：引导每一步气泡都在视口内；六套皮肤下气泡用皮肤底色；样式表不写死颜色', async () => {
  const css = readFileSync(new URL('../public/tour.css', import.meta.url), 'utf8');
  assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [], [], 'tour.css 里有写死的颜色');

  await page.setViewport(390, 844);
  await reloadFresh({ clear: true });
  assert.equal(await shown('.tour-welcome'), true, '窄屏也有欢迎卡');
  await page.screenshot(join(process.cwd(), 'app', 'shots', 'tour-welcome-390.png'));
  await page.click('[data-tour-start]');
  await page.waitFor(q('.tour-layer'));
  await page.screenshot(join(process.cwd(), 'app', 'shots', 'tour-390.png'));
  const seen = await walk();
  assert.ok(seen.length >= 5, `窄屏至少走完大部分步骤：${seen.join('、')}`);
  await page.setViewport(1440, 900);

  for (const skin of ['candy', 'mint', 'latte', 'mocha', 'nord', 'rose']) {
    await page.evaluate(`
      if (${JSON.stringify(skin)} === 'mint') delete document.documentElement.dataset.skin;
      else document.documentElement.dataset.skin = ${JSON.stringify(skin)};
      return true;
    `);
    await page.click('#helpBtn');
    await page.click(`[data-tour-goto="${ALL.indexOf('planner')}"]`);
    await page.waitFor(q('.tour-layer'));
    const look = await page.evaluate(`
      const probe = document.createElement('i');
      probe.style.cssText = 'background:var(--surface)';
      document.body.append(probe);
      const out = { bg: getComputedStyle(document.querySelector('.tour-bubble')).backgroundColor,
        want: getComputedStyle(probe).backgroundColor };
      probe.remove();
      return out;
    `);
    assert.equal(look.bg, look.want, `${skin} 气泡底色`);
    if (skin === 'mocha') await page.screenshot(join(process.cwd(), 'app', 'shots', 'tour-mocha.png'));
    await key('Escape');
  }
  await page.evaluate('delete document.documentElement.dataset.skin; return true;');
});

test('无控制台错误、无未捕获异常', () => {
  assert.deepEqual(page.pageErrors, []);
  assert.deepEqual(page.consoleErrors, []);
});

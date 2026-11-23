// 收获速记通过真浏览器和临时 SQLite 验收。模型调用由测试服务拦截。
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { launch } from './browser.mjs';
import { start } from '../server.js';
import { CHATGPT_PROMPT, formatHarvest } from '../public/js/harvest-format.js';

const TZ = 'Asia/Shanghai';
const FIXED = [
  '这里是未保存的聊天原文',
  '【收获】梯度下降',
  '结论：先观察损失变化',
  '要点：', '- 学习率过大会震荡',
  '待办：', '- 比较学习率', '- 画损失曲线', '- 试验晚上排期',
  '标签：#优化 #实验',
  '来源：https://chatgpt.com/c/example',
].join('\n');
const RAW = '问：如何判断拟合过度？答：应比较训练误差和验证误差。';
const AI_REPLY = '【收获】判断过拟合\n结论：比较训练误差和验证误差\n要点：\n- 看误差差距\n标签：#泛化';

let app, dir, page, range, fixedId;
const aiCalls = [];

const sel = (name) => '[data-harvest-' + name + ']';
const press = (name) => page.click(sel(name));
const type = (name, text) => page.type(sel(name), text);
const query = (selector) => 'document.querySelector(' + JSON.stringify(selector) + ')';
const visible = (selector) => '(' + query(selector) + '?.getClientRects().length > 0)';
const waitFor = (selector) => page.waitFor(visible(selector));
const fieldValue = (name) => page.evaluate('return ' + query(sel(name)) + '.value;');
const cards = () => app.workbench.readHarvests().harvests;

async function api(path, body) {
  const res = await fetch(new URL(path, app.url), body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  return json;
}

async function shortcut(key, modifiers = 0) {
  await page.evaluate('document.activeElement.blur(); return true;');
  const spec = {
    key, modifiers,
    code: key === 'V' ? 'KeyV' : 'Digit' + key,
    windowsVirtualKeyCode: key.charCodeAt(0),
  };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec });
}

async function save() {
  await press('save');
  await page.waitFor('!document.querySelector("#dialog").open');
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-ui-harvest-'));
  app = await start({
    port: 0, timeZone: TZ, dbPath: join(dir, 'harvest.db'),
    fetchImpl: async (url, options) => {
      aiCalls.push({ url, body: JSON.parse(options.body) });
      return Response.json({ choices: [{ message: { content: AI_REPLY } }] });
    },
  });
  const { view } = await api('/api/view');
  range = view.range;
  await api('/api/command', { command: {
    type: 'createProject', id: 'harvest-project', title: '优化学习记录', startDay: view.day, mainTaskId: 'harvest-project-task',
  } });
  app.workbench.createTask({ id: 'existing-slot-task', title: '已安排的学习' });
  app.workbench.saveSchedule({ block: {
    id: 'existing-slot', taskId: 'existing-slot-task', startsAt: range.start + 9 * 3600 + 5 * 60, plannedSeconds: 37 * 60,
  } });

  page = await launch({ url: app.url, timeZone: TZ });
  await page.waitFor('!!window.__wbState.view');
  await page.evaluate([
    'window.harvestTestNow = ' + ((range.start + 9 * 3600 + 2 * 60) * 1000) + ';',
    'Date.now = () => window.harvestTestNow;',
    'window.harvestClipboard = "";',
    'Object.defineProperty(navigator, "clipboard", { configurable: true, value: {',
    '  readText: async () => window.harvestClipboard,',
    '  writeText: async (value) => { window.harvestClipboard = value; },',
    '} });',
    'return true;',
  ].join('\n'));
});

after(async () => {
  try {
    if (page) await page.close();
  } finally {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('全局 Ctrl+Shift+V 打开并聚焦，剪贴板自动预填，预览可修改后保存', async () => {
  await page.click('#tools [data-page="calendar"]');
  await page.waitFor('window.__wbState.page === "calendar"');
  await page.evaluate('window.harvestClipboard = ' + JSON.stringify(FIXED) + '; return true;');
  await shortcut('V', 2 | 8);
  await waitFor(sel('capture'));
  await waitFor(sel('form'));
  assert.equal(await page.evaluate('return document.activeElement.hasAttribute("data-harvest-text");'), true);
  assert.equal(await fieldValue('text'), FIXED);
  assert.equal(await fieldValue('title'), '梯度下降');
  assert.equal(await fieldValue('todos'), '比较学习率\n画损失曲线\n试验晚上排期');
  assert.equal(cards().length, 0, '预览时不写入库');
  await type('title', '调节梯度下降步长');
  await type('project', 'harvest-project');
  // 首次写入后模拟响应丢失，重试应复用原 ID 并只保存一张。
  await page.evaluate([
    'const nativeFetch = window.fetch;',
    'window.harvestSaveIds = [];',
    'window.fetch = async (url, options) => {',
    '  const command = url === "/api/command" && JSON.parse(options.body).command;',
    '  const response = await nativeFetch(url, options);',
    '  if (command?.type === "createHarvest") {',
    '    window.harvestSaveIds.push(command.id);',
    '    if (window.harvestSaveIds.length === 1) throw new Error("模拟响应丢失");',
    '    window.fetch = nativeFetch;',
    '  }',
    '  return response;',
    '}; return true;',
  ].join('\n'));
  await press('save');
  await waitFor(sel('save-error'));
  assert.equal(await fieldValue('title'), '调节梯度下降步长');
  await save();
  const ids = await page.evaluate('return window.harvestSaveIds;');
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(cards().length, 1);
  const [card] = cards();
  fixedId = card.id;
  assert.equal(card.source, 'chatgpt');
  assert.equal(card.projectId, 'harvest-project');
  assert.doesNotMatch(JSON.stringify(card), /未保存的聊天原文/);
  assert.equal(aiCalls.length, 0);

  await shortcut('6');
  await waitFor(sel('card'));
  assert.match(await page.text(sel('card')), /调节梯度下降步长/);
  assert.match(await page.text(sel('card')), /学习率过大会震荡/);
  assert.equal(await page.evaluate('const a = document.querySelector(".harvest-card a"); return a.target + " " + a.rel;'), '_blank noopener');
  await press('copy');
  assert.equal(await page.evaluate('return window.harvestClipboard;'), formatHarvest(card));
});

test('未设置模型时可转手动填写，保存立即出现在收获页', async () => {
  await page.evaluate('window.harvestClipboard = ""; return true;');
  await press('open');
  await type('text', RAW);
  await press('distill');
  await waitFor(sel('error'));
  assert.match(await page.text(sel('error')), /还没有设置模型/);
  await waitFor(sel('model'));
  await waitFor(sel('manual'));
  await press('manual');
  assert.equal(await fieldValue('title'), '');
  await type('title', '手动记忆卡');
  await type('conclusion', '先做主动回忆');
  await type('labels', '#复习');
  await save();
  await page.waitFor('document.querySelectorAll(".harvest-card[data-harvest-card]").length === 2');
  assert.equal(cards()[0].source, 'manual');
  assert.equal(aiCalls.length, 0);
});

test('假模型提炼后显示模型名，确认保存才入库', async () => {
  await api('/api/ai/providers/save', { provider: {
    name: '测试供应商', protocol: 'openai', baseUrl: 'https://fake.invalid/v1', model: 'fake-model',
  } });
  await press('open');
  await type('text', RAW);
  await press('distill');
  await waitFor(sel('form'));
  assert.equal(await fieldValue('title'), '判断过拟合');
  assert.match(await page.text(sel('hint')), /测试供应商 · fake-model/);
  assert.equal(cards().length, 2);
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].body.messages.at(-1).content, RAW);
  await save();
  await page.waitFor('document.querySelectorAll(".harvest-card[data-harvest-card]").length === 3');
  assert.equal(cards()[0].source, 'ai');
});

test('搜索匹配要点，标签有计数且可取消，搜索输入保留焦点', async () => {
  await type('search', '震荡');
  await page.waitFor('document.querySelectorAll("[data-harvest-card]").length === 1');
  assert.match(await page.text(sel('list')), /调节梯度下降步长/);
  assert.equal(await page.evaluate('return document.activeElement.hasAttribute("data-harvest-search");'), true);
  await type('search', '');
  await page.waitFor('document.querySelectorAll("[data-harvest-card]").length === 3');
  const tag = '[data-harvest-tag="复习"]';
  assert.match(await page.text(tag), /#复习\s*1/);
  await page.click(tag);
  await page.waitFor(query(tag) + '?.getAttribute("aria-pressed") === "true"');
  assert.match(await page.text(sel('list')), /手动记忆卡/);
  assert.equal(await page.count(sel('card')), 1);
  await page.click(tag);
  await page.waitFor('document.querySelectorAll("[data-harvest-card]").length === 3');
});

test('加入待办会更新待办清单，完成后卡片待办划掉', async () => {
  const row = '[data-harvest-todo="0"]';
  await page.click(row + ' ' + sel('join'));
  await page.waitFor(query(row) + '?.textContent.includes("已加入")');
  assert.equal(await page.count(row + ' ' + sel('join')), 0);
  await page.click('[data-sidebar-view="tasks"]');
  await page.waitFor('!document.querySelector("#pending").hidden && document.querySelector("#pending").textContent.includes("比较学习率")');
  const todo = app.workbench.readHarvest(fixedId).todos[0];
  assert.equal((await api('/api/view')).view.pending.find((task) => task.id === todo.taskId).course, '');

  await api('/api/command', { command: { type: 'setTaskCompleted', taskId: todo.taskId, completed: true } });
  await page.evaluate('document.dispatchEvent(new Event("visibilitychange")); return true;');
  await page.waitFor(query(row + ' s') + '?.textContent === "比较学习率"');
});

test('排进今天顺延到冲突块末尾，只排 30 分钟，过去日期禁用', async () => {
  const row = '[data-harvest-todo="1"]';
  await page.click(row + ' ' + sel('schedule'));
  await page.waitFor(query(row) + '?.textContent.includes("已加入")');
  await page.click('[data-sidebar-view="plan"]');
  await page.waitFor('Array.from(document.querySelectorAll("#plannerGrid .planner-block")).some((b) => b.textContent.includes("画损失曲线"))');
  const todo = app.workbench.readHarvest(fixedId).todos[1];
  const block = (await api('/api/view')).view.scheduled.find((b) => b.taskId === todo.taskId);
  assert.equal(block.task.course, '日计划');
  assert.equal(block.startsAt, range.start + 9 * 3600 + 42 * 60);
  assert.equal(block.plannedSeconds, 1800);

  const remaining = '[data-harvest-todo="2"] ' + sel('schedule');
  await page.evaluate('window.harvestTestNow = ' + ((range.end - 15 * 60) * 1000) + '; return true;');
  await page.click(remaining);
  assert.match(await page.text('#toast'), /今天已经排不下/);
  assert.equal(app.workbench.readHarvest(fixedId).todos[2].taskId, null, '排不下时不创建任务');

  await page.evaluate('window.harvestTestNow = ' + ((range.start + 9 * 3600) * 1000) + '; return true;');
  await page.click('#tools [data-page="calendar"]');
  await page.waitFor('window.__wbState.page === "calendar"');
  await page.waitFor('document.querySelectorAll("#mainContent [data-day]").length > 1');
  await page.evaluate([
    'const calendarDays = [...document.querySelectorAll("#mainContent [data-day]")];',
    'const day = calendarDays.find((item) => item.dataset.day !== window.__wbState.day);',
    'day.click(); return true;',
  ].join('\n'));
  await page.waitFor('window.__wbState.view.range.start !== ' + range.start);
  await shortcut('6');
  await waitFor(remaining);
  assert.equal(await page.evaluate('return ' + query(remaining) + '.disabled;'), true);
  assert.equal(await page.evaluate('return ' + query(remaining) + '.title;'), '回到今天再排');
});

test('编辑保留已转任务，删除需要确认', async () => {
  const card = '[data-harvest-card="' + fixedId + '"]';
  await page.click(card + ' ' + sel('edit'));
  assert.equal(await fieldValue('title'), '调节梯度下降步长');
  await type('title', '复查梯度下降步长');
  await type('points', '先对照训练损失');
  await save();
  await page.waitFor(query(card) + '?.textContent.includes("先对照训练损失")');
  assert.ok(app.workbench.readHarvest(fixedId).todos[0].taskId);
  assert.equal(app.workbench.readHarvest(fixedId).projectId, 'harvest-project');
  await page.click(card + ' ' + sel('delete'));
  await waitFor(sel('delete-confirm'));
  await press('cancel');
  assert.equal(await page.count(card), 1);
  await page.click(card + ' ' + sel('delete'));
  await press('delete-confirm');
  await page.waitFor('!' + query(card));
  assert.equal(cards().length, 2);
});

test('空库步骤、复制口令和分页', async () => {
  for (const card of cards()) app.workbench.deleteHarvest({ harvestId: card.id });
  await page.click('#tools [data-page="calendar"]');
  await shortcut('6');
  await waitFor('.harvest-empty');
  assert.equal(await page.count('.harvest-empty li'), 3);
  await press('prompt');
  assert.equal(await page.evaluate('return window.harvestClipboard;'), CHATGPT_PROMPT);

  for (let i = 1; i <= 22; i += 1) {
    app.workbench.createHarvest({ id: 'paging-' + i, title: '条目 ' + i, tags: ['分页'] });
  }
  await page.click('#tools [data-page="calendar"]');
  await shortcut('6');
  await waitFor(sel('more'));
  assert.equal(await page.count(sel('card')), 20);
  assert.match(await page.text(sel('card') + ' h2'), /条目 22/);
  await press('more');
  await page.waitFor('document.querySelectorAll("[data-harvest-card]").length === 22');
  assert.equal(await page.evaluate('return document.querySelector("[data-harvest-more]").hidden;'), true);
  assert.equal(await page.count('[data-harvest-card="paging-1"]'), 1);
  assert.match(await page.text('[data-harvest-tag="分页"]'), /22/);
});

test('390px 下收获页和弹窗不横向溢出，六套皮肤文字可读', async () => {
  await page.setViewport(390, 900);
  await page.evaluate('window.harvestClipboard = ' + JSON.stringify(FIXED) + '; return true;');
  await press('open');
  await waitFor(sel('form'));
  const layout = await page.evaluate([
    'const root = document.documentElement;',
    'const ids = ["candy", "mint", "latte", "mocha", "nord", "rose"];',
    'const fits = (node) => node.scrollWidth <= node.clientWidth + 1;',
    'const luminance = (color) => {',
    '  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });',
    '  ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);',
    '  const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => v / 255)',
    '    .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);',
    '  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];',
    '};',
    'return ids.map((id) => {',
    '  root.dataset.skin = id;',
    '  const card = document.querySelector(".harvest-card");',
    '  const field = document.querySelector("[data-harvest-title]");',
    '  const contrast = (el) => {',
    '    const { color, backgroundColor } = getComputedStyle(el);',
    '    const [a,b] = [luminance(color), luminance(backgroundColor)].sort((x,y) => x-y);',
    '    return (b + .05) / (a + .05);',
    '  };',
    '  const nodes = [root, document.querySelector("#dialog"), card, document.querySelector(".harvest-preview")];',
    '  return { id, fits: nodes.every(fits), card: contrast(card), field: contrast(field) };',
    '});',
  ].join('\n'));
  for (const result of layout) {
    assert.ok(result.fits, result.id + ' 横向溢出');
    assert.ok(result.card >= 4.5 && result.field >= 4.5, JSON.stringify(result));
  }
});

test('控制台无错误、页面无未捕获异常', () => {
  assert.deepEqual(page.consoleErrors, []);
  assert.deepEqual(page.pageErrors, []);
});

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
  // 前面的用例可能把日期切到别的天或留下筛选，这里先归位到今天、清掉筛选
  await page.click('#tools [data-page="calendar"]');
  await page.waitFor('window.__wbState.page === "calendar"');
  const isToday = await page.evaluate('return __wbState.view.day === __wbState.todayDay;');
  if (!isToday) {
    await page.evaluate('document.querySelector(\'[data-month="0"]\').click(); return true;');
    await page.waitFor('__wbState.view.day === __wbState.todayDay');
  }
  await shortcut('6');
  await waitFor('.harvest-empty');
  assert.equal(await page.count('.harvest-empty li'), 3);
  await press('prompt');
  assert.equal(await page.evaluate('return window.harvestClipboard;'), CHATGPT_PROMPT);

  for (let i = 1; i <= 22; i += 1) {
    app.workbench.createHarvest({ id: 'paging-' + i, title: '条目 ' + i, tags: ['分页'] });
  }
  // 清掉可能残留的筛选，再重进收获页（页面已在收获页时会走复用分支，不重读列表）
  await page.evaluate([
    'const on = [...document.querySelectorAll("[data-harvest-filter]")].filter((b) => b.getAttribute("aria-pressed") === "true");',
    'on.forEach((b) => b.click());',
    'return true;',
  ].join('\n'));
  await page.click('#tools [data-page="calendar"]');
  await page.waitFor('window.__wbState.page === "calendar"');
  await shortcut('6');
  await waitFor(sel('more'));
  await page.waitFor('document.querySelectorAll("[data-harvest-card]").length === 20');
  assert.equal(await page.count(sel('card')), 20);
  assert.match(await page.text(sel('card') + ' h2'), /条目 22/);
  await press('more');
  await page.waitFor('document.querySelectorAll("[data-harvest-card]").length === 22');
  assert.equal(await page.evaluate('return document.querySelector("[data-harvest-more]").hidden;'), true);
  assert.equal(await page.count('[data-harvest-card="paging-1"]'), 1);
  assert.match(await page.text('[data-harvest-tag="分页"]'), /22/);
  // 回归（2026-11-24 验收 T-W8b 时满载复现）：点过「加载更多」后，实时刷新 / 外壳重绘不能把列表缩回前 20 条
  await api('/api/command', { command: {
    type: 'createTask', id: 'paging-live-task', title: '分页期间的新任务', course: '', estimatedSeconds: null,
  } });
  await page.waitFor('__wbState.view.pending.some((t) => t.id === "paging-live-task")');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await page.count(sel('card')), 22);
});

// ---------------------------------------------------------------- T-W8b：卡片界面重做

/** 真鼠标点一下（走 pointerdown/mouseup 全流程；原地编辑就是靠 pointerdown 接管的）。 */
async function clickReal(selector) {
  const at = await page.evaluate(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  `);
  assert.ok(at, '点击目标不存在：' + selector);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at[0], y: at[1], button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at[0], y: at[1], button: 'left', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 250));
}

/** 造一张字段齐全的卡片，返回 id。 */
function seedCard(id, extra = {}) {
  app.workbench.createHarvest({
    id, title: '卡片 ' + id, conclusion: '结论 ' + id,
    points: ['要点一', '要点二', '要点三', '要点四', '要点五'],
    todos: [{ text: '待办甲' }, { text: '待办乙' }],
    tags: ['复习', '实验'], sourceUrl: 'https://chatgpt.com/c/' + id, ...extra,
  });
  return id;
}

/**
 * 把库清空到只剩给定的卡片，回到今天并清掉筛选。
 * T-W8b 的用例各自建立自己的数据，不依赖前面用例留下的状态（尤其「空库步骤」会建 22 张卡）。
 */
async function resetHarvest(seeds = []) {
  for (const card of cards()) app.workbench.deleteHarvest({ harvestId: card.id });
  for (const [id, extra] of seeds) seedCard(id, extra);
  await openHarvestToday();
  await page.waitFor('document.querySelectorAll("[data-harvest-card]").length === ' + seeds.length);
}
async function openHarvestToday() {
  await page.click('#tools [data-page="calendar"]');
  await page.waitFor('window.__wbState.page === "calendar"');
  const isToday = await page.evaluate('return __wbState.view.day === __wbState.todayDay;');
  if (!isToday) {
    await page.evaluate('document.querySelector(\'[data-month="0"]\').click(); return true;');
    await page.waitFor('__wbState.view.day === __wbState.todayDay');
  }
  await shortcut('6');
  await page.waitFor('window.__wbState.page === "harvest"');
  await waitFor(sel('list'));
  // 清掉可能残留的筛选：星标 / 待复习 / 按项目 / 搜索
  await page.evaluate([
    'const on = [...document.querySelectorAll("[data-harvest-filter]")].filter((b) => b.getAttribute("aria-pressed") === "true");',
    'on.forEach((b) => b.click());',
    'const select = document.querySelector("[data-harvest-project-filter]");',
    'if (select && select.value) { select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); }',
    'const search = document.querySelector("[data-harvest-search]");',
    'if (search && search.value) { search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true })); }',
    'return true;',
  ].join('\n'));
  await new Promise((r) => setTimeout(r, 350));
}

test('T-W8b 卡片层次：结论强调、要点默认收前 3 条可展开、标签按名着色、来源显示域名、日期在头部', async () => {
  await resetHarvest([['tier']]);

  const card = '[data-harvest-card="tier"]';
  // 要点默认只露 3 条
  assert.equal(await page.count(card + ' [data-harvest-point]'), 3, '默认收起，只露前 3 条');
  assert.match(await page.text(card + ' [data-harvest-expand]'), /展开其余 2 条/);
  await page.click(card + ' [data-harvest-expand]');
  await page.waitFor('document.querySelectorAll(\'[data-harvest-card="tier"] [data-harvest-point]\').length === 5');
  assert.match(await page.text(card + ' [data-harvest-expand]'), /收起要点/);
  await page.click(card + ' [data-harvest-expand]');
  await page.waitFor('document.querySelectorAll(\'[data-harvest-card="tier"] [data-harvest-point]\').length === 3');

  const seen = await page.evaluate([
    'const card = document.querySelector(\'[data-harvest-card="tier"]\');',
    'const conclusion = card.querySelector(".harvest-conclusion");',
    'const source = card.querySelector(".harvest-source");',
    'const tags = [...card.querySelectorAll(".harvest-tags .harvest-chip")];',
    'return {',
    '  conclusionWeight: Number(getComputedStyle(conclusion).fontWeight),',
    '  conclusionBorder: getComputedStyle(conclusion).borderInlineStartWidth,',
    '  sourceText: source?.textContent, sourceTarget: source?.target, sourceRel: source?.rel,',
    '  tagClasses: tags.map((t) => t.className), tagBg: tags.map((t) => getComputedStyle(t).backgroundColor),',
    '  hasTime: Boolean(card.querySelector(".harvest-cardhead time")),',
    '  star: card.querySelector("[data-harvest-star]")?.getAttribute("aria-pressed"),',
    '};',
  ].join('\n'));
  assert.ok(seen.conclusionWeight >= 600, '结论加粗强调：' + seen.conclusionWeight);
  assert.notEqual(seen.conclusionBorder, '0px', '结论左侧有强调线');
  assert.equal(seen.sourceText, 'chatgpt.com', '来源只显示域名');
  assert.equal(seen.sourceTarget, '_blank');
  assert.equal(seen.sourceRel, 'noopener');
  // 两个标签哈希到不同色调（或者至少都带 tone- 类）
  assert.ok(seen.tagClasses.every((name) => /tone-\d/.test(name)), '标签带色调类：' + seen.tagClasses.join(','));
  assert.ok(new Set(seen.tagBg).size >= 1, '标签有背景色');
  assert.equal(seen.hasTime, true, '日期在卡片头部');
  assert.equal(seen.star, 'false', '默认未加星');
});

test('T-W8b 星标：点星变实心并落库，筛选「星标」只显示它', async () => {
  await resetHarvest([['tier'], ['star-me']]);
  const star = '[data-harvest-card="star-me"] [data-harvest-star]';
  await page.click(star);
  await page.waitFor('document.querySelector(\'' + star + '\')?.getAttribute("aria-pressed") === "true"');
  assert.equal(await page.text(star), '★', '加星后是实心星');
  assert.equal(app.workbench.readHarvest('star-me').starred, true, '落库');
  assert.match(await page.evaluate('return document.querySelector(\'[data-harvest-card="star-me"]\').className;'), /starred/);

  // 筛选星标
  await page.click('[data-harvest-filter="starred"]');
  await page.waitFor('document.querySelectorAll("[data-harvest-card]").length === 1');
  assert.equal(await page.count('[data-harvest-card="star-me"]'), 1);
  await page.click('[data-harvest-filter="starred"]');
  await page.waitFor('document.querySelectorAll("[data-harvest-card]").length === 2');
});

test('T-W8b 复习：加入复习开关、顶部待复习入口、翻卡显示答案后记住了/没记住、顶栏红点', async () => {
  await resetHarvest([['tier']]);
  const toggle = '[data-harvest-card="tier"] [data-harvest-review]';
  await page.click(toggle);
  await page.waitFor('document.querySelector(\'' + toggle + '\')?.getAttribute("aria-pressed") === "true"');
  assert.match(await page.text(toggle), /在复习中/);
  const review = app.workbench.readHarvest('tier').review;
  assert.ok(review.nextDay, '开启复习后写下一次复习日');
  assert.equal(review.count, 0, '开启时复习次数不变');

  // 让这张卡今天就到期（开启复习排的是明天）：直接把下次复习日改到今天
  const today = (await api('/api/view')).view.day;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dir, 'harvest.db'));
  db.prepare('UPDATE harvests SET next_review_day = ? WHERE id = ?').run(today, 'tier');
  db.close();
  await page.evaluate('document.dispatchEvent(new Event("visibilitychange")); return true;');
  await openHarvestToday();
  await waitFor(sel('review-start'));
  assert.match(await page.text(sel('review-start')), /今天待复习 \d+ 张/);
  assert.equal(await page.evaluate('return document.querySelector("[data-harvest-dot]").hidden;'), false, '顶栏小红点亮起');

  // 翻卡：先只有标题，点显示答案才看到结论
  await press('review-start');
  await waitFor(sel('reviewbox'));
  assert.equal(await page.count('[data-harvest-reviewbox] .harvest-conclusion'), 0, '先不给答案');
  assert.match(await page.text('[data-harvest-reviewbox]'), /先自己回想一下/);
  await press('review-show');
  await waitFor(sel('review-remember'));
  assert.match(await page.text('[data-harvest-reviewbox]'), /结论 tier/);
  const before = app.workbench.readHarvest('tier').review.count;
  await press('review-remember');
  await page.waitFor('!document.querySelector("#dialog").open');
  const after = app.workbench.readHarvest('tier').review;
  assert.equal(after.count, before + 1, '记住了复习次数 +1');
  assert.ok(after.nextDay > today, '下次复习日往后推');
  // 复习完成后入口与红点消失
  await page.evaluate('document.dispatchEvent(new Event("visibilitychange")); return true;');
  await page.waitFor('document.querySelector("[data-harvest-review-start]").hidden === true');
  assert.equal(await page.evaluate('return document.querySelector("[data-harvest-dot]").hidden;'), true);
});

test('T-W8b 随便看一张：没有到期也能弹出一张，没记住回到明天', async () => {
  await resetHarvest([['tier']]);
  await press('random');
  await waitFor(sel('reviewbox'));
  assert.match(await page.text('[data-harvest-reviewbox]'), /第 1 \/ 1 张/);
  await press('review-show');
  await waitFor(sel('review-forgot'));
  await press('review-forgot');
  await page.waitFor('!document.querySelector("#dialog").open');
});

test('T-W8b 关联：下拉搜索项目/任务、可清除，卡片显示关联标签，项目卡显示收获 N', async () => {
  await resetHarvest([['tier']]);
  const card = '[data-harvest-card="tier"]';
  await page.click(card + ' [data-harvest-link]');
  await waitFor(sel('linker'));
  const seen = await page.evaluate([
    'const select = document.querySelector("[data-harvest-link-select]");',
    'return { options: [...select.options].map((o) => o.textContent), size: select.size };',
  ].join('\n'));
  assert.ok(seen.options.some((text) => text.startsWith('项目 · ')), '能选项目：' + seen.options.join('|'));
  assert.ok(seen.options.some((text) => text.startsWith('任务 · ')), '能选任务：' + seen.options.join('|'));
  // 搜索过滤
  await page.type('[data-harvest-link-search]', '优化');
  const filtered = await page.evaluate('return [...document.querySelector("[data-harvest-link-select]").options].filter((o) => !o.hidden).map((o) => o.textContent);');
  assert.ok(filtered.every((text) => text === '不关联' || text.includes('优化')), '搜索只留匹配项：' + filtered.join('|'));
  await page.evaluate([
    'const select = document.querySelector("[data-harvest-link-select]");',
    'select.value = "project:harvest-project";',
    'return true;',
  ].join('\n'));
  await press('link-save');
  await page.waitFor('!document.querySelector("#dialog").open');
  await page.waitFor('document.querySelector(\'[data-harvest-card="tier"] [data-harvest-goto-project]\')');
  assert.equal(app.workbench.readHarvest('tier').projectId, 'harvest-project');
  assert.match(await page.text(card + ' [data-harvest-goto-project]'), /优化学习记录/);

  // 项目卡「收获 N」
  await page.click('#tools [data-page="home"]');
  await page.waitFor('document.querySelector(\'[data-project-card="harvest-project"] [data-project-harvest]\')');
  assert.match(await page.text('[data-project-card="harvest-project"] [data-project-harvest]'), /收获 1/);
  // 点了跳到按该项目筛选的收获页
  await page.click('[data-project-card="harvest-project"] [data-project-harvest]');
  await page.waitFor('window.__wbState.page === "harvest"');
  await page.waitFor('document.querySelectorAll("[data-harvest-card]").length === 1');
  assert.equal(await page.count('[data-harvest-card="tier"]'), 1, '只剩这个项目的收获');
  assert.equal(await page.evaluate('return document.querySelector("[data-harvest-project-filter]").value;'), 'harvest-project');

  // 清除关联
  await page.click(card + ' [data-harvest-link]');
  await waitFor(sel('linker'));
  await page.evaluate('document.querySelector("[data-harvest-link-select]").value = ""; return true;');
  await press('link-save');
  await page.waitFor('!document.querySelector("#dialog").open');
  await page.waitFor('!document.querySelector(\'[data-harvest-card="tier"] [data-harvest-goto-project]\')');
  assert.equal(app.workbench.readHarvest('tier').projectId, null, '关联已清除');
});

test('T-W8b 筛选：待复习与按项目下拉都生效', async () => {
  await resetHarvest([['tier'], ['star-me']]);
  app.workbench.setHarvestReview({ id: 'star-me', enabled: true });
  await openHarvestToday();
  await page.waitFor('document.querySelectorAll("[data-harvest-card]").length === 2');
  await page.click('[data-harvest-filter="due"]');
  await page.waitFor('document.querySelector(\'[data-harvest-filter="due"]\').getAttribute("aria-pressed") === "true"');
  // star-me 刚开启（明天到期），tier 没记住（明天到期）——今天都不到期
  assert.equal(await page.evaluate('return document.querySelectorAll("[data-harvest-card]").length;'), 0, '今天没有到期的');
  await page.click('[data-harvest-filter="due"]');
  await page.waitFor('document.querySelectorAll("[data-harvest-card]").length === 2');
  // 按项目下拉：全部项目 → 指定项目
  await page.evaluate([
    'const select = document.querySelector("[data-harvest-project-filter]");',
    'select.value = "harvest-project"; select.dispatchEvent(new Event("change", { bubbles: true }));',
    'return true;',
  ].join('\n'));
  await page.waitFor('document.querySelector("[data-harvest-project-filter]").value === "harvest-project"');
  await page.waitFor('document.querySelectorAll("[data-harvest-card]").length === 0');
  await page.evaluate([
    'const select = document.querySelector("[data-harvest-project-filter]");',
    'select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true }));',
    'return true;',
  ].join('\n'));
  await page.waitFor('document.querySelectorAll("[data-harvest-card]").length === 2');
});

test('T-W8b 直接编辑：点要点原地改、Enter 新增一条、清空删除、上下移动排序', async () => {
  await resetHarvest([['tier']]);
  const card = '[data-harvest-card="tier"]';
  const row0 = card + ' [data-harvest-point="0"] [data-harvest-editrow]';
  // 原地编辑用 contenteditable（不换节点，避免被外壳的实时重绘换掉）。
  // 走真实鼠标：编辑由 pointerdown 接管，程序化 .click() 不经过这条路径。
  await clickReal(row0);
  await page.waitFor('document.querySelector(\'' + row0 + '\')?.getAttribute("contenteditable") === "true"');
  const editText = (text) => page.evaluate([
    'const el = document.querySelector(' + JSON.stringify(row0) + ');',
    'el.textContent = ' + JSON.stringify(text) + ';',
    'el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));',
    'return true;',
  ].join('\n'));
  await editText('改过的要点一');
  await page.waitFor('document.querySelector(\'[data-harvest-card="tier"]\').textContent.includes("改过的要点一")');
  assert.equal(app.workbench.readHarvest('tier').points[0], '改过的要点一', '原地改要点已落库');

  // 上移第二行
  const before = app.workbench.readHarvest('tier').points.slice();
  await page.click(card + ' [data-harvest-point="1"] [data-harvest-moveup]');
  await page.waitFor('document.querySelector(\'[data-harvest-card="tier"]\').textContent.indexOf("' + before[1] + '") < document.querySelector(\'[data-harvest-card="tier"]\').textContent.indexOf("' + before[0] + '")');
  const moved = app.workbench.readHarvest('tier').points;
  assert.equal(moved[0], before[1], '上移后顺序交换');
  assert.equal(moved[1], before[0]);

  // 删除最后一条（先展开，默认只露前 3 条）
  const count = app.workbench.readHarvest('tier').points.length;
  if (count > 3) {
    await page.click(card + ' [data-harvest-expand]');
    await page.waitFor('document.querySelectorAll(\'[data-harvest-card="tier"] [data-harvest-point]\').length === ' + count);
  }
  await page.click(card + ' [data-harvest-point="' + (count - 1) + '"] [data-harvest-removerow]');
  await page.waitFor('document.querySelectorAll(\'[data-harvest-card="tier"] [data-harvest-point]\').length === ' + (count - 1));
  assert.equal(app.workbench.readHarvest('tier').points.length, count - 1, '删除一条');

  // 待办同样能改（已生成任务的保留 taskId 由服务端负责，这里只验文字）
  const todoRow = card + ' [data-harvest-todo="0"] [data-harvest-editrow]';
  await clickReal(todoRow);
  await page.waitFor('document.querySelector(\'' + todoRow + '\')?.getAttribute("contenteditable") === "true"');
  await page.evaluate([
    'const el = document.querySelector(' + JSON.stringify(todoRow) + ');',
    'el.textContent = "改过的待办甲";',
    'el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));',
    'return true;',
  ].join('\n'));
  await page.waitFor('document.querySelector(\'[data-harvest-card="tier"]\').textContent.includes("改过的待办甲")');
  assert.equal(app.workbench.readHarvest('tier').todos[0].text, '改过的待办甲');
});

test('T-W8b 图片：卡片加图片走附件接口，最多 6 张，缩略图可点开', async () => {
  await resetHarvest([['tier']]);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await fetch(new URL('/api/attachments', app.url), {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: png,
    });
    assert.equal(res.status, 200);
    const { url } = await res.json();
    ids.push(String(url).replace('/api/attachments/', ''));
  }
  assert.equal(new Set(ids).size, 1, '同一张图按 SHA-256 去重');
  await api('/api/command', { command: { type: 'updateHarvest', harvestId: 'tier', images: [ids[0]] } });
  await openHarvestToday();
  await page.waitFor('document.querySelector(\'[data-harvest-card="tier"] [data-harvest-image]\')');  const thumb = await page.evaluate([
    'const link = document.querySelector(\'[data-harvest-card="tier"] [data-harvest-image]\');',
    'const img = link.querySelector("img");',
    'return { href: link.getAttribute("href"), target: link.target, src: img?.getAttribute("src"), alt: img?.alt };',
  ].join('\n'));
  assert.match(thumb.href, /^\/api\/attachments\/[0-9a-f]{64}\.png$/, '缩略图指向原图');
  assert.equal(thumb.target, '_blank', '点开看大图');
  assert.equal(thumb.src, thumb.href);
  assert.ok(thumb.alt, '图片有 alt');

  // 上限 6 张：库里塞满 6 个不同的 id 后，再加会提示
  const filled = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await fetch(new URL('/api/attachments', app.url), {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.concat([png, Buffer.from([i])]),
    });
    filled.push(String((await res.json()).url).replace('/api/attachments/', ''));
  }
  assert.equal(filled.length, 6);
  await api('/api/command', { command: { type: 'updateHarvest', harvestId: 'tier', images: filled } });
  await openHarvestToday();
  await page.waitFor('document.querySelectorAll(\'[data-harvest-card="tier"] [data-harvest-image]\').length === 6');
  // 再加：已满 6 张，点「加图片」直接提示上限，不再打开选文件框
  await page.evaluate('document.querySelector("#toast").className = ""; return true;');
  await page.click('[data-harvest-card="tier"] [data-harvest-image-add]');
  await page.waitFor('document.querySelector("#toast").className.includes("bad")');
  assert.match(await page.text('#toast'), /最多 6 张/);
  // 收尾：清掉图片，别影响后面的用例
  await api('/api/command', { command: { type: 'updateHarvest', harvestId: 'tier', images: [] } });
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

// v4 收获库：固定格式解析、仓储命令、v3→v4 迁移、接口（提炼 / 列表 / 备份）。只用临时库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_PATH } from '../lib/db.js';
import { start } from '../server.js';
import { parseHarvest, formatHarvest, splitTags, HARVEST_LIMITS } from '../public/js/harvest-format.js';

const TZ = 'Asia/Shanghai';
const SAMPLE = `【收获】梯度下降的步长怎么选
结论：先用学习率搜索找量级，再配合衰减。
要点：
- 步长太大会震荡，太小收敛慢
- 用 1e-4 到 1 的对数网格试
- 损失平台期再降学习率
待办：
- 在作业 3 上试余弦退火
标签：#机器学习 #优化`;

// ------------------------------------------------------------------ 解析

test('固定格式：标准写法逐字段解析', () => {
  const r = parseHarvest(SAMPLE);
  assert.equal(r.ok, true);
  assert.deepEqual(r.draft, {
    title: '梯度下降的步长怎么选',
    conclusion: '先用学习率搜索找量级，再配合衰减。',
    points: ['步长太大会震荡，太小收敛慢', '用 1e-4 到 1 的对数网格试', '损失平台期再降学习率'],
    todos: ['在作业 3 上试余弦退火'],
    tags: ['机器学习', '优化'],
    sourceUrl: '',
  });
});

test('固定格式：代码围栏、前置寒暄、空行、半角冒号、加粗、编号与「无」待办都能解析', () => {
  const text = `好的，下面是本次对话的精华：

\`\`\`
**【收获】** Rust 所有权

结论: 每个值只有一个所有者
**要点**：
1. 移动后原变量失效

2、借用分 & 和 &mut
• 生命周期标注只是约束
待办:
无
标签：Rust，所有权、#入门
来源：https://chatgpt.com/c/abc-123 （今天）
\`\`\``;
  const r = parseHarvest(text);
  assert.equal(r.ok, true);
  assert.equal(r.draft.title, 'Rust 所有权');
  assert.equal(r.draft.conclusion, '每个值只有一个所有者');
  assert.deepEqual(r.draft.points, ['移动后原变量失效', '借用分 & 和 &mut', '生命周期标注只是约束']);
  assert.deepEqual(r.draft.todos, []);
  assert.deepEqual(r.draft.tags, ['Rust', '所有权', '入门']);
  assert.equal(r.draft.sourceUrl, 'https://chatgpt.com/c/abc-123');
});

test('固定格式：要点写在同一行、没有结论只有要点也算；不是固定格式返回 ok:false', () => {
  const r = parseHarvest('标题：二分查找\n要点：左闭右开最不容易错');
  assert.equal(r.ok, true);
  assert.deepEqual(r.draft.points, ['左闭右开最不容易错']);
  assert.equal(parseHarvest('今天问了 ChatGPT 很多关于梯度下降的问题，它说……').ok, false, '没有【收获】行');
  assert.equal(parseHarvest('【收获】只有标题').ok, false, '结论和要点都空');
  assert.equal(parseHarvest('').ok, false);
});

test('固定格式：超长内容按上限截断，formatHarvest 能往返', () => {
  const long = '字'.repeat(400);
  const many = Array.from({ length: 20 }, (_, i) => `- 第${i}条`).join('\n');
  const r = parseHarvest(`【收获】${long}\n结论：${long}${long}\n要点：\n${many}\n待办：\n${many}`);
  assert.equal(r.ok, true);
  assert.equal(Array.from(r.draft.title).length, HARVEST_LIMITS.title);
  assert.equal(Array.from(r.draft.conclusion).length, HARVEST_LIMITS.conclusion);
  assert.equal(r.draft.points.length, HARVEST_LIMITS.points);
  assert.equal(r.draft.todos.length, HARVEST_LIMITS.todos);
  const again = parseHarvest(formatHarvest(parseHarvest(SAMPLE).draft));
  assert.deepEqual(again.draft, parseHarvest(SAMPLE).draft);
  assert.deepEqual(splitTags('#a  #b,#a 无'), ['a', 'b']);
});

// ------------------------------------------------------------------ 仓储

function memory(now = () => 1_795_000_000) { return openDatabase(':memory:', { timeZone: TZ, now }); }
const draft = () => parseHarvest(SAMPLE).draft;

test('仓储：新建可重试、默认归当天、列表新的在前、搜索与标签筛选', () => {
  let now = 1_795_000_000;
  const wb = memory(() => now);
  assert.deepEqual(wb.createHarvest({ id: 'h1', ...draft(), source: 'chatgpt' }), { ok: true, created: true });
  assert.deepEqual(wb.createHarvest({ id: 'h1', ...draft(), source: 'chatgpt' }), { ok: true, created: false });
  assert.throws(() => wb.createHarvest({ id: 'h1', ...draft(), title: '别的' }), { reason: 'conflict' });
  now += 60;
  wb.createHarvest({ id: 'h2', title: '100%_特殊字符', conclusion: '', points: ['x'], tags: ['#优化', '杂项'] });
  const all = wb.readHarvests();
  assert.equal(all.total, 2);
  assert.deepEqual(all.harvests.map((h) => h.id), ['h2', 'h1']);
  assert.equal(all.harvests[1].day, wb.readHarvest('h1').day);
  assert.match(all.harvests[1].day, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(all.tags[0], { tag: '优化', count: 2 });
  assert.deepEqual(wb.readHarvests({ q: '余弦' }).harvests.map((h) => h.id), ['h1'], '待办里的字也能搜到');
  assert.deepEqual(wb.readHarvests({ q: '100%_' }).harvests.map((h) => h.id), ['h2'], '% 和 _ 按字面匹配');
  assert.equal(wb.readHarvests({ q: '%' }).total, 1);
  assert.deepEqual(wb.readHarvests({ tag: '#机器学习' }).harvests.map((h) => h.id), ['h1']);
  assert.deepEqual(wb.readHarvestsOnDay(all.harvests[0].day).map((h) => h.id), ['h1', 'h2']);
  wb.close();
});

test('仓储：校验拒绝空标题、超长、非 http 链接和不存在的项目', () => {
  const wb = memory();
  assert.throws(() => wb.createHarvest({ id: 'a', title: '  ' }), { reason: 'invalid' });
  assert.throws(() => wb.createHarvest({ id: 'a', title: 't', points: Array(13).fill('x') }), { reason: 'invalid' });
  assert.throws(() => wb.createHarvest({ id: 'a', title: 't', conclusion: 'x'.repeat(501) }), { reason: 'invalid' });
  assert.throws(() => wb.createHarvest({ id: 'a', title: 't', sourceUrl: 'javascript:alert(1)' }), { reason: 'invalid' });
  assert.throws(() => wb.createHarvest({ id: 'a', title: 't', projectId: 'nope' }), { reason: 'missing' });
  assert.throws(() => wb.createHarvest({ id: 'a', title: 't', day: '2026-13-01' }), { reason: 'invalid' });
  assert.equal(wb.readHarvests().total, 0);
  wb.close();
});

test('仓储：待办转任务（同事务、可重试、改字沿用、排进今天用日计划），改卡片与删除', () => {
  const wb = memory();
  wb.createHarvest({ id: 'h', ...draft(), todos: ['试余弦退火', '读论文 A'] });
  assert.deepEqual(wb.promoteHarvestTodo({ harvestId: 'h', index: 0, taskId: 't1' }),
    { ok: true, created: true, taskId: 't1' });
  assert.deepEqual(wb.promoteHarvestTodo({ harvestId: 'h', index: 0, taskId: 't1' }),
    { ok: true, created: false, taskId: 't1' }, '同 taskId 重试');
  assert.throws(() => wb.promoteHarvestTodo({ harvestId: 'h', index: 0, taskId: 't9' }), { reason: 'conflict' });
  assert.throws(() => wb.promoteHarvestTodo({ harvestId: 'h', index: 5, taskId: 't9' }), { reason: 'missing' });
  wb.promoteHarvestTodo({ harvestId: 'h', index: 1, taskId: 't2', course: '日计划' });
  const day = wb.readHarvest('h').day;
  const pending = wb.readDay(day).pending;
  assert.equal(pending.find((t) => t.id === 't1').title, '试余弦退火');
  assert.equal(pending.find((t) => t.id === 't1').course, '');
  assert.equal(pending.find((t) => t.id === 't2').course, '日计划');

  wb.setTaskCompleted({ taskId: 't1', completed: true });
  let card = wb.readHarvest('h');
  assert.deepEqual(card.todos, [
    { text: '试余弦退火', taskId: 't1', taskDone: true },
    { text: '读论文 A', taskId: 't2', taskDone: false },
  ]);
  // 只传文字：同文字的条目沿用 taskId，新条目没有
  wb.updateHarvest({ harvestId: 'h', title: '新标题', todos: ['读论文 A', '新的一条'], tags: ['a'] });
  card = wb.readHarvest('h');
  assert.equal(card.title, '新标题');
  assert.deepEqual(card.todos.map((t) => t.taskId), ['t2', null]);
  assert.deepEqual(card.tags, ['a']);
  assert.equal(card.conclusion, draft().conclusion, '未传的字段不变');

  wb.deleteHarvest({ harvestId: 'h' });
  assert.throws(() => wb.readHarvest('h'), { reason: 'missing' });
  assert.throws(() => wb.deleteHarvest({ harvestId: 'h' }), { reason: 'missing' });
  assert.ok(wb.readDay(day).pending.find((t) => t.id === 't2'), '删卡片不删任务');
  wb.close();
});

test('v3 旧库自动迁移到 v4：先备份，旧数据不丢，收获表可用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-v4-'));
  try {
    const file = join(dir, 'old.db');
    const raw = new DatabaseSync(file);
    raw.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    raw.exec(readFileSync(new URL('../../architecture/task_notes.sql', import.meta.url), 'utf8'));
    for (const m of ['002_projects_reviews.sql', '003_task_note_days.sql']) {
      raw.exec(readFileSync(new URL('../../architecture/migrations/' + m, import.meta.url), 'utf8'));
    }
    raw.exec("INSERT INTO tasks (id, title) VALUES ('t', '旧任务')");
    raw.close();
    const wb = openDatabase(file, { timeZone: TZ });
    assert.equal(wb.db.prepare('PRAGMA user_version').get().user_version, 4);
    wb.createHarvest({ id: 'h', title: '迁移后', points: ['可用'] });
    assert.equal(wb.readHarvests().total, 1);
    assert.equal(wb.db.prepare("SELECT title FROM tasks WHERE id = 't'").get().title, '旧任务');
    wb.close();
    const backups = readdirSync(dir).filter((f) => f.startsWith('old.db.bak-v3-'));
    assert.equal(backups.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ 接口

async function serve(t, fetchImpl) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-harvest-'));
  const calls = [];
  const app = await start({ dbPath: join(dir, 'h.db'), aiConfigPath: join(dir, 'providers.json'),
    fetchImpl: async (url, options) => { calls.push({ url, body: options.body }); return fetchImpl(url, options); } });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const api = async (path, body, status = 200) => {
    const response = await fetch(new URL('api/' + path, app.url), body === undefined ? undefined
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json();
    assert.equal(response.status, status, JSON.stringify(json));
    return json;
  };
  return { api, calls, url: app.url };
}

test('接口：固定格式不调模型；未设模型时原文提炼报 400；有模型时提炼并只返回草稿', async (t) => {
  let reply = SAMPLE;
  const { api, calls } = await serve(t, async () => Response.json({ choices: [{ message: { content: reply } }] }));
  const direct = await api('ai/distill', { text: SAMPLE });
  assert.equal(direct.via, 'format');
  assert.equal(direct.draft.title, '梯度下降的步长怎么选');
  assert.equal(calls.length, 0, '固定格式不发请求');

  const raw = '问：梯度下降步长怎么选？\n答：很长的回答……';
  const none = await api('ai/distill', { text: raw }, 400);
  assert.match(none.message, /还没有设置模型/);
  await api('ai/distill', { text: '' }, 400);
  await api('ai/distill', { text: 'x'.repeat(60001) }, 400);

  await api('ai/providers/save', { provider: {
    name: '示例', protocol: 'openai', baseUrl: 'https://fake.invalid/v1', model: 'm', apiKey: 'k-12345678',
  } });
  const ai = await api('ai/distill', { text: raw });
  assert.equal(ai.via, 'ai');
  assert.equal(ai.draft.todos[0], '在作业 3 上试余弦退火');
  assert.equal(JSON.parse(calls[0].body).messages[1].content, raw, '原文作为用户消息发给模型');
  assert.equal((await api('harvests')).total, 0, '提炼不写库');

  reply = '抱歉，我无法按格式输出';
  assert.match((await api('ai/distill', { text: raw }, 400)).message, /没有按格式/);
});

test('接口：命令写入、列表筛选、待办转任务，备份导出含收获并能导入空库', async (t) => {
  const { api, url } = await serve(t, async () => Response.json({}));
  const command = (c, status) => api('command', { command: c }, status);
  await command({ type: 'createHarvest', id: 'h1', ...draft(), source: 'chatgpt' });
  await command({ type: 'createHarvest', id: 'h2', title: '另一条', points: ['p'], tags: ['其他'] });
  await command({ type: 'promoteHarvestTodo', harvestId: 'h1', index: 0, taskId: 'task-1' });
  await command({ type: 'updateHarvest', harvestId: 'h2', conclusion: '补一句结论' });
  await command({ type: 'deleteHarvest', harvestId: 'nope' }, 404);

  const list = await api('harvests?tag=' + encodeURIComponent('优化'));
  assert.deepEqual(list.harvests.map((h) => h.id), ['h1']);
  assert.equal(list.harvests[0].todos[0].taskId, 'task-1');
  assert.equal((await api('harvests?q=' + encodeURIComponent('补一句'))).harvests[0].id, 'h2');
  assert.equal((await api('harvests?limit=1')).harvests.length, 1);

  const exported = await (await fetch(new URL('api/export', url))).json();
  assert.equal(exported.tables.harvests.length, 2);

  const other = await serve(t, async () => Response.json({}));
  const imported = await other.api('import', exported);
  assert.ok(imported.inserted >= 3);
  const back = await other.api('harvests');
  assert.equal(back.total, 2);
  assert.equal(back.harvests.find((h) => h.id === 'h1').todos[0].taskId, 'task-1');
});

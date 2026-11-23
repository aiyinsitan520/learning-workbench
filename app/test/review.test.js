// AI 每日回顾的素材：任务正文按天留底、当天新增内容、前 6 天对比；生成时把正文发给模型，正文一改回顾就变「有更新」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, addedLines, SCHEMA_PATH } from '../lib/db.js';
import { reviewMaterial, reviewHash } from '../lib/digest.js';
import { dayRange } from '../lib/time.js';
import { start } from '../server.js';

const TZ = 'Asia/Shanghai';
const DAY = '2026-11-20';
const PREV = '2026-11-19';
const at = (day, h, m = 0) => dayRange(day, TZ).start + h * 3600 + m * 60;

test('addedLines：只取新增的行，忽略空行和首尾空白', () => {
  assert.equal(addedLines('a\nb', 'a\n  b \nc\n\nd'), 'c\nd');
  assert.equal(addedLines('', '第一行\n第二行'), '第一行\n第二行');
  assert.equal(addedLines('x', 'x'), '');
});

test('正文按天留底：当天新增 = 与之前最近一份的差异；接触过但没改的任务附正文摘录', () => {
  let now = at(PREV, 20);
  const wb = openDatabase(':memory:', { timeZone: TZ, now: () => now });
  wb.createTask({ id: 'math', title: '高数：泰勒公式' });
  wb.createTask({ id: 'eng', title: '英语阅读' });
  wb.saveTaskNote('math', '泰勒公式：f(x) 在 x0 处展开', 0);
  now = at(DAY, 9);
  wb.saveTaskNote('math', '泰勒公式：f(x) 在 x0 处展开\n余项用拉格朗日型\n疑问：皮亚诺余项何时用？', 1);
  now = at(DAY, 10);
  wb.saveTaskNote('math', '泰勒公式：f(x) 在 x0 处展开\n余项用拉格朗日型\n疑问：皮亚诺余项何时用？\n例题 3 做对了', 2);
  // 英语：之前写过正文，这天只专注没改正文
  now = at(PREV, 21);
  wb.saveTaskNote('eng', '生词：ubiquitous', 0);
  now = at(DAY, 14);
  wb.startFocus({ id: 'f1', taskId: 'eng', plannedSeconds: 600 });
  now = at(DAY, 14, 10);
  wb.settleExpired();

  const notes = wb.readNoteChanges(DAY);
  const math = notes.find((n) => n.taskId === 'math');
  assert.equal(math.edited, true);
  assert.equal(math.firstTime, false);
  assert.equal(math.added, '余项用拉格朗日型\n疑问：皮亚诺余项何时用？\n例题 3 做对了', '同一天多次保存只算一次，和前一天比');
  const eng = notes.find((n) => n.taskId === 'eng');
  assert.deepEqual([eng.edited, eng.body], [false, '生词：ubiquitous']);
  // 前一天：数学第一次写
  const prev = wb.readNoteChanges(PREV).find((n) => n.taskId === 'math');
  assert.equal(prev.firstTime, true);

  const material = reviewMaterial(wb, DAY);
  assert.equal(material.recent.length, 6);
  assert.equal(material.recent.at(-1).day, PREV);
  assert.equal(material.recent.at(-1).noteTasks, 2, '前一天写过两项正文');
  const h1 = reviewHash(material);
  now = at(DAY, 22);
  wb.saveTaskNote('math', '泰勒公式：f(x) 在 x0 处展开\n余项用拉格朗日型\n疑问：皮亚诺余项何时用？\n例题 3 做对了\n总结：先写通项', 3);
  assert.notEqual(reviewHash(reviewMaterial(wb, DAY)), h1, '当天正文变了，回顾指纹跟着变');
  wb.close();
});

test('v2 旧库迁移到 v3：已有正文记成 1970-01-01 基线，之后只算新增', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-v3-'));
  try {
    const file = join(dir, 'old.db');
    // 造一个 v2 库：v1 结构 + 002 迁移 + 已有正文
    const raw = new DatabaseSync(file);
    raw.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    raw.exec(readFileSync(new URL('../../architecture/task_notes.sql', import.meta.url), 'utf8'));
    raw.exec(readFileSync(new URL('../../architecture/migrations/002_projects_reviews.sql', import.meta.url), 'utf8'));
    raw.exec("INSERT INTO tasks (id, title) VALUES ('t', '旧任务'); INSERT INTO task_notes VALUES ('t', '旧笔记第一行', 1);");
    raw.close();
    let now = at(DAY, 9);
    const wb = openDatabase(file, { timeZone: TZ, now: () => now });
    assert.equal(wb.db.prepare('PRAGMA user_version').get().user_version, 4);
    wb.saveTaskNote('t', '旧笔记第一行\n今天新写的一行', 1);
    assert.equal(wb.readNoteChanges(DAY)[0].added, '今天新写的一行', '旧内容是基线，不算当天新增');
    wb.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('生成回顾：正文新增内容发给模型，提示词要求记录要点、收获、成长；正文一改看板显示有更新', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-review-'));
  let sent = null;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '【今日概览】你学了泰勒公式。\n【记录要点】· 余项用拉格朗日型\n【收获】掌握余项\n【成长】比前一天多写了正文\n【明天建议】弄清皮亚诺余项' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = await start({ port: 0, dbPath: join(dir, 'w.db'), timeZone: TZ, aiConfigPath: join(dir, 'ai.json'), fetchImpl, islandLauncher: null });
  const base = app.url.replace(/\/$/, '');
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    const today = (await (await fetch(`${base}/api/view`)).json()).view.day;
    await post('/api/command', { command: { type: 'createTask', id: 'math', title: '高数：泰勒公式' } });
    await post('/api/command', { command: { type: 'saveTaskNote', taskId: 'math', body: '余项用拉格朗日型\n疑问：皮亚诺余项何时用？', expectedRevision: 0 } });
    await post('/api/ai/providers/save', { provider: { name: '假模型', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fake-key', model: 'm' } });

    const r = await post('/api/ai/review', { day: today });
    assert.equal(r.ok, true);
    assert.match(r.review.text, /【记录要点】/);
    const system = sent.messages[0].content;
    for (const k of ['【今日概览】', '【记录要点】', '【收获】', '【成长】', '【明天建议】']) assert.ok(system.includes(k), `提示词应包含 ${k}`);
    const user = JSON.parse(sent.messages[1].content);
    assert.equal(user.notes[0].added, '余项用拉格朗日型\n疑问：皮亚诺余项何时用？');
    assert.equal(user.recent.length, 6);
    assert.ok(sent.max_tokens >= 1200, '回顾要写得下五节内容');

    assert.equal((await (await fetch(`${base}/api/review?day=${today}`)).json()).review.stale, false);
    await post('/api/command', { command: { type: 'saveTaskNote', taskId: 'math', body: '余项用拉格朗日型\n疑问：皮亚诺余项何时用？\n补：例题 3', expectedRevision: 1 } });
    assert.equal((await (await fetch(`${base}/api/review?day=${today}`)).json()).review.stale, true, '改了正文，看板提示记录有更新');
  } finally {
    await new Promise((r) => app.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

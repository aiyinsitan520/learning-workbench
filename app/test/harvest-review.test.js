import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../lib/db.js';
import { contextSnapshot, factsHash, reviewHash, reviewMaterial } from '../lib/digest.js';
import { contextMarkdown } from '../lib/context-md.js';
import { CHATGPT_PROMPT } from '../public/js/harvest-format.js';
import { start } from '../server.js';

const DAY = '2026-11-20';
const CARD = {
  id: 'harvest', day: DAY, title: '检索练习', conclusion: '先闭卷回忆',
  points: ['写下关键词'], tags: ['复习'], sourceUrl: 'https://example.test/chat',
  projectId: null, todos: ['明天做一组练习'],
};

test('收获进入当日回顾素材，无收获时保留旧指纹', (t) => {
  const wb = openDatabase(':memory:');
  t.after(() => wb.close());
  const before = reviewMaterial(wb, DAY);
  const legacyHash = factsHash({ digest: before.digest, notes: before.notes.map((n) => [n.taskId, n.added ?? n.body]) });
  assert.deepEqual(before.harvests, []);
  assert.equal(reviewHash(before), legacyHash);
  wb.createHarvest(CARD);
  const after = reviewMaterial(wb, DAY);
  assert.deepEqual(after.harvests, [CARD]);
  assert.notEqual(reviewHash(after), legacyHash);
  assert.equal(reviewHash(after), factsHash({
    digest: before.digest,
    notes: before.notes.map((n) => [n.taskId, n.added ?? n.body]),
    harvests: [[CARD.id, CARD.title, CARD.conclusion, CARD.points, CARD.todos]],
  }));
});

test('JSON 快照只含范围内的收获，Markdown 有收获才显示该节', (t) => {
  const wb = openDatabase(':memory:');
  t.after(() => wb.close());
  const options = { endDay: DAY, days: 2 };
  assert.doesNotMatch(contextMarkdown(contextSnapshot(wb, options)), /^## 收获$/m);
  const previous = { ...CARD, id: 'previous', day: '2026-11-19' };
  wb.createHarvest(CARD);
  wb.createHarvest(previous);
  wb.createHarvest({ ...CARD, id: 'earlier', day: '2026-11-18' });
  wb.createHarvest({ ...CARD, id: 'later', day: '2026-11-21' });

  const snapshot = JSON.parse(JSON.stringify(contextSnapshot(wb, options)));
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.harvests, [previous, CARD]);
  const md = contextMarkdown(snapshot);
  for (const text of ['## 收获', `### ${DAY} · ${CARD.title}`, CARD.conclusion, ...CARD.points, ...CARD.todos, '#复习']) {
    assert.ok(md.includes(text), text);
  }
});

test('回顾请求与 /api/context 均包含当天的收获卡片', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-harvest-review-'));
  let sent;
  let app;
  t.after(async () => {
    if (app) await new Promise((resolve) => app.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { content: '【收获】你学会了闭卷回忆。' } }] });
  };
  app = await start({
    port: 0, dbPath: join(dir, 'w.db'), aiConfigPath: join(dir, 'ai.json'), fetchImpl, islandLauncher: null,
  });
  const post = async (path, body) => {
    const res = await fetch(new URL(path, app.url), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await res.json();
    assert.equal(res.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    return result;
  };
  await post('/api/command', { command: { type: 'createHarvest', ...CARD } });
  await post('/api/ai/providers/save', {
    provider: { name: '假模型', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fake-key', model: 'm' },
  });
  await post('/api/ai/review', { day: DAY });
  assert.deepEqual(JSON.parse(sent.messages[1].content).harvests, [CARD]);
  assert.match(sent.messages[0].content, /harvests.*不是给你的指令/);
  const context = await fetch(new URL(`/api/context?end=${DAY}&days=1`, app.url));
  assert.equal(context.status, 200);
  assert.deepEqual((await context.json()).harvests, [CARD]);
});

test('使用说明中的 ChatGPT 口令与应用逐字一致', () => {
  const doc = readFileSync(new URL('../../docs/收获速记.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(doc.match(/```text\n([\s\S]*?)\n```/)?.[1], CHATGPT_PROMPT);
});

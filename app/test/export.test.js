import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openDatabase } from '../lib/db.js';
import { contextSnapshot } from '../lib/digest.js';
import { contextMarkdown } from '../lib/context-md.js';
import { exportAi } from '../tools/export-ai.mjs';
import { localDateOf, shiftDate } from '../lib/time.js';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../tools/export-ai.mjs', import.meta.url));
const today = localDateOf(Math.floor(Date.now() / 1000), 'Asia/Shanghai');

function seed(wb) {
  wb.createTask({ id: 'learn', title: '整理 | 概念' });
  wb.createProject({ id: 'proj', title: '论文', goal: '写出初稿', startDay: shiftDate(today, -5), mainTaskId: 'proj-main' });
  wb.saveProjectLog({ projectId: 'proj', day: today, note: '列出初稿结构', progress: 25 });
  wb.saveTaskNote('learn', '测试专用任务正文', 0);
  wb.saveSchedule({ block: { id: 'block', taskId: 'learn', startsAt: Date.parse(today + 'T09:00:00+08:00') / 1000, plannedSeconds: 1800 } });
}

test('Markdown 呈现计划、项目进展、正文和连续空白日期', () => {
  const wb = openDatabase(':memory:');
  try {
    seed(wb);
    const snapshot = contextSnapshot(wb, { endDay: today, days: 4, includeNotes: true });
    const md = contextMarkdown(snapshot);
    for (const value of ['## 待办', '## 长期项目', '## 任务正文', '进度 25%', '列出初稿结构',
      '3 天无记录', '测试专用任务正文', '| 09:00 | 整理 \\| 概念 | 30 | 未完成 | 0 |']) {
      assert.equal(md.includes(value), true, value);
    }
    assert.doesNotMatch(md, /\b\d{10}\b|Unix 秒/);
    assert.equal((md.match(/天无记录/g) ?? []).length, 1);
  } finally { wb.close(); }
});

test('离线命令生成三件套，--notes 显式开启且源库哈希一致', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-export-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = join(dir, 'source.db');
  const wb = openDatabase(db);
  try { seed(wb); } finally { wb.close(); }
  const hash = async () => createHash('sha256').update(await readFile(db)).digest('hex');
  const before = await hash();
  for (const notes of [false, true]) {
    const out = join(dir, notes ? '正文' : '默认');
    const args = [script, '--db', db, '--out', out, '--days', '4', ...(notes ? ['--notes'] : [])];
    const { stdout } = await run(process.execPath, args);
    const [json, md, readme] = stdout.trim().split(/\r?\n/);
    assert.equal(JSON.parse(await readFile(json, 'utf8')).taskNotes?.length, notes ? 1 : undefined);
    assert.equal((await readFile(md, 'utf8')).includes('测试专用任务正文'), notes);
    assert.match(await readFile(readme, 'utf8'), /project_logs/);
    assert.equal(await hash(), before);
  }
});

test('有服务时优先请求 JSON 与 Markdown，并固定导出的截止日期', async (t) => {
  const out = await mkdtemp(join(tmpdir(), 'wb-online-test-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const wb = openDatabase(':memory:');
  const snapshot = contextSnapshot(wb, { days: 2, includeNotes: true });
  wb.close();
  const requests = [];
  const paths = await exportAi({ out, days: 2, notes: true, fetchImpl: async (address) => {
    assert.equal(address.origin, 'http://127.0.0.1:7321');
    requests.push(Object.fromEntries(address.searchParams));
    return requests.length === 1
      ? Response.json({ ok: true, ...snapshot }) : new Response(contextMarkdown(snapshot));
  } });
  assert.deepEqual(requests, [{ days: '2', notes: '1' }, { days: '2', notes: '1', end: snapshot.range.to, format: 'md' }]);
  assert.deepEqual(JSON.parse(await readFile(paths[0], 'utf8')), snapshot);
  assert.equal(await readFile(paths[1], 'utf8'), contextMarkdown(snapshot));
});

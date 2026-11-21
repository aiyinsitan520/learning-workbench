// 首次运行前灌一份示例数据，让界面不是空的。
// 用法：node app/seed.js [--force]
// 已存在同名任务时跳过，不会重复插入。

import { openDatabase } from './lib/db.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const TASKS = [
  { id: 'seed-spectrum', title: '画出采样前后的频谱', course: '通信原理', estimatedSeconds: 1500 },
  { id: 'seed-taylor', title: '整理泰勒公式例题', course: '高等数学', estimatedSeconds: 2400 },
  { id: 'seed-circuit', title: '整理电路实验数据', course: '电路基础', estimatedSeconds: 1800 },
  { id: 'seed-linear', title: '预习线性空间', course: '线性代数', estimatedSeconds: 1200 },
  { id: 'seed-abstract', title: '阅读英文摘要', course: '学术英语', estimatedSeconds: 900 },
];

const NOTE = {
  id: 'seed-note-spectrum',
  title: '采样以后，频谱去了哪里？',
  blocks: [
    { id: 'seed-blk-1', kind: 'text', title: '', body: '采样会让原信号的频谱周期性重复。先画原频谱，再标出每份频谱的中心。\n待确认：采样频率降低时，相邻两份频谱从哪里开始重叠？' },
    { id: 'seed-blk-2', kind: 'question', title: '为什么会出现频谱混叠？', body: '试着画出采样频率减半后的频谱。' },
    { id: 'seed-blk-3', kind: 'workflow', title: '频谱绘图步骤', body: '画出原始信号的频谱，标记最高频率\n以采样频率为间隔，标出每份频谱的中心\n检查相邻频谱是否重叠，并记录结论' },
    { id: 'seed-blk-4', kind: 'thought', title: '一个猜想', body: '如果采样率刚好是最高频率的两倍，两份频谱正好在边界相接，不算重叠。' },
  ],
};

/** 本地日期 HH:MM → UTC 秒。 */
function at(day, hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  return Math.floor(new Date(`${day}T00:00:00`).getTime() / 1000) + hh * 3600 + mm * 60;
}

function localDay(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function seed(wb, { force = false } = {}) {
  const today = localDay();
  let created = 0;

  for (const task of TASKS) {
    const existing = wb.db.prepare('SELECT id FROM tasks WHERE id = ?').get(task.id);
    if (existing && !force) continue;
    wb.createTask(task);
    created += 1;
  }

  // 两个时间块，演示"同一任务可安排多次"
  const blocks = [
    { id: 'seed-block-1', taskId: 'seed-spectrum', startsAt: at(today, '14:00'), plannedSeconds: 1500 },
    { id: 'seed-block-2', taskId: 'seed-taylor', startsAt: at(today, '16:00'), plannedSeconds: 2400 },
  ];
  for (const block of blocks) {
    const existing = wb.db.prepare('SELECT id FROM schedule_blocks WHERE id = ?').get(block.id);
    if (existing && !force) continue;
    wb.saveSchedule({ block });
  }

  // 一条已完成任务，演示完成区
  const done = wb.db.prepare('SELECT completed_at FROM tasks WHERE id = ?').get('seed-abstract');
  if (done && done.completed_at == null) wb.setTaskCompleted({ taskId: 'seed-abstract', completed: true });

  // 手记
  const note = wb.db.prepare('SELECT id FROM day_notes WHERE study_date = ?').get(today);
  if (!note || force) {
    if (note) {
      wb.db.prepare('DELETE FROM note_blocks WHERE note_id = ?').run(note.id);
      wb.db.prepare('DELETE FROM day_notes WHERE id = ?').run(note.id);
    }
    wb.saveDayNote({
      note: { id: NOTE.id, studyDate: today, title: NOTE.title, blocks: NOTE.blocks },
      expectedRevision: null,
    });
  }

  // 一条已结束的专注，让统计不是 0
  const anyFocus = wb.db.prepare("SELECT id FROM focus_sessions WHERE state = 'finished' LIMIT 1").get();
  if (!anyFocus) {
    wb.db.prepare(
      'INSERT INTO focus_sessions (id, task_id, state, planned_seconds, elapsed_seconds, started_at, state_changed_at)'
        + " VALUES (?, ?, 'finished', ?, ?, ?, ?)",
    ).run('seed-focus-1', 'seed-taylor', 2400, 1380, at(today, '09:00'), at(today, '09:23'));
  }

  return { created, day: today };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const force = process.argv.includes('--force');
  const dbPath = process.env.WORKBENCH_DB ?? join(HERE, 'data', 'workbench.db');
  const wb = openDatabase(dbPath, { timeZone: process.env.WORKBENCH_TZ || 'Asia/Shanghai' });
  const result = seed(wb, { force });
  console.log(`示例数据已写入：${dbPath}`);
  console.log(`新建任务 ${result.created} 条，日期 ${result.day}`);
  wb.close();
}

// 每日摘要：每日维护看板、AI 回顾、给外部 AI 的数据快照共用同一份口径。
// 只读，不写库。数字口径：专注只算已结束（finished）的轮次，时长单位是秒；
// 「排期」不等于「完成」；日期是工作台时区（默认北京时间）的 YYYY-MM-DD。

import { createHash } from 'node:crypto';
import { dayRange, shiftDate } from './time.js';

const PLAN_COURSE = '日计划';
const WEEK = '日一二三四五六';
// 视图只展示仍可见项目，但历史指纹也要保留已归档项目在该日的日志。
const dayProjectLogs = Symbol('dayProjectLogs');

function projectLogFacts(wb, day) {
  return wb.db.prepare('SELECT project_id AS id, note, progress FROM project_logs WHERE day=? ORDER BY project_id').all(day);
}

const weekdayOf = (day) => '周' + WEEK[new Date(`${day}T00:00:00Z`).getUTCDay()];

/** 事实的稳定指纹：记录没变则指纹不变，用来判断 AI 回顾要不要重写。 */
export function factsHash(facts) {
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 32);
}

/**
 * 某一天的摘要（DayDigest，见 architecture/workbench.d.ts）。
 * @param {import('./db.js').Workbench} wb
 */
export function dayDigest(wb, day, timeZone = wb.timeZone) {
  const { count } = wb.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE completed_at IS NULL').get();
  return digestDays(wb, [day], timeZone, count)[0];
}

function readPending(wb) {
  return wb.db.prepare(`SELECT id, title, course, project_id AS projectId FROM tasks
    WHERE completed_at IS NULL ORDER BY created_at, id`).all();
}

// SQL 保持原有排序。按本地午夜的实际 UTC 边界分桶，兼容 23/25 小时的日期。
function rowsByDay(rows, windows, timestamp) {
  return Map.groupBy(rows, row => {
    let lo = 0, hi = windows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (row[timestamp] < windows[mid].end) hi = mid;
      else lo = mid + 1;
    }
    return windows[lo].day;
  });
}

function digestDays(wb, dates, timeZone, pendingCount) {
  const windows = dates.map(day => ({ day, ...dayRange(day, timeZone) }));
  const start = windows[0].start, end = windows.at(-1).end;
  const read = (sql, stamp) => rowsByDay(wb.db.prepare(sql).all(start, end), windows, stamp);
  const completed = read(`SELECT id,title,course,project_id AS projectId,completed_at FROM tasks
    WHERE completed_at >= ? AND completed_at < ? ORDER BY completed_at DESC,id`, 'completed_at');
  const created = read(`SELECT id,title,course,project_id AS projectId,created_at FROM tasks
    WHERE created_at >= ? AND created_at < ? ORDER BY created_at,id`, 'created_at');
  const log = read(`SELECT f.task_id AS taskId,t.title AS taskTitle,f.elapsed_seconds AS elapsedSeconds,f.started_at AS startedAt
    FROM focus_sessions f LEFT JOIN tasks t ON t.id=f.task_id WHERE f.state='finished'
    AND f.started_at >= ? AND f.started_at < ? ORDER BY f.started_at DESC`, 'startedAt');
  const scheduled = read(`SELECT b.id,b.task_id AS taskId,b.starts_at AS startsAt,b.planned_seconds AS plannedSeconds,
    t.title,t.course,t.project_id AS projectId,t.completed_at AS completedAt FROM schedule_blocks b JOIN tasks t ON t.id=b.task_id
    WHERE b.starts_at >= ? AND b.starts_at < ? ORDER BY b.starts_at,b.id`, 'startsAt');
  const projects = wb.readProjectDays(windows);
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const clock = seconds => formatter.format(seconds * 1000);
  const taskFacts = ({ id, title, course, projectId }) => ({ id, title, course, projectId });
  return dates.map(day => buildDigest({
    day, timeZone, clock, pendingCount, projects: projects.get(day),
    log: log.get(day) ?? [], scheduled: scheduled.get(day) ?? [],
    completed: (completed.get(day) ?? []).map(taskFacts), created: (created.get(day) ?? []).map(taskFacts),
  }));
}

function buildDigest({ day, timeZone, clock, log, scheduled, completed, created, projects, pendingCount }) {
  const byTask = new Map();
  for (const f of log) {
    const key = f.taskId ?? '';
    const entry = byTask.get(key) ?? { taskId: f.taskId ?? null, title: f.taskTitle ?? '自由专注', seconds: 0, sessions: 0 };
    entry.seconds += f.elapsedSeconds;
    entry.sessions += 1;
    byTask.set(key, entry);
  }
  const focusOf = (taskId) => byTask.get(taskId)?.seconds ?? 0;

  // 专注时间线：每一轮已结束的专注几点开始、几点结束（结束 = 开始 + 实际累计，暂停过的会比墙钟短）
  const timeline = [...log].sort((a, b) => a.startedAt - b.startedAt).map((f) => ({
    taskId: f.taskId ?? null,
    title: f.taskTitle ?? '自由专注',
    start: clock(f.startedAt),
    end: clock(f.startedAt + f.elapsedSeconds),
    minutes: Math.round(f.elapsedSeconds / 60),
  }));
  const blocks = scheduled.map((b) => ({
    id: b.id,
    taskId: b.taskId,
    title: b.title,
    start: clock(b.startsAt),
    end: clock(b.startsAt + b.plannedSeconds),
    startsAt: b.startsAt,
    minutes: Math.round(b.plannedSeconds / 60),
    planOnly: b.course === PLAN_COURSE,
    projectId: b.projectId ?? null,
    taskDone: b.completedAt != null,
    focusSeconds: focusOf(b.taskId),
  }));
  const plannedSeconds = scheduled.reduce((s, b) => s + b.plannedSeconds, 0);
  const completedIds = new Set(completed.map(task => task.id));
  const plannedTaskIds = new Set(scheduled.map((b) => b.taskId));
  const focusedOnPlanned = [...plannedTaskIds].reduce((s, id) => s + focusOf(id), 0);

  return {
    day,
    weekday: weekdayOf(day),
    timeZone,
    completed,
    focus: {
      sessions: log.length,
      seconds: log.reduce((sum, f) => sum + f.elapsedSeconds, 0),
      byTask: [...byTask.values()].sort((a, b) => b.seconds - a.seconds),
      timeline,
    },
    created,
    plan: {
      blocks,
      plannedSeconds,
      focusedOnPlannedSeconds: focusedOnPlanned,
      // 计划里的任务当天被专注过的比例（0–1），没有计划时为 null
      followRate: plannedTaskIds.size
        ? [...plannedTaskIds].filter((id) => focusOf(id) > 0 || completedIds.has(id)).length / plannedTaskIds.size
        : null,
    },
    // 计划了但任务还没完成的块：每日维护看板可以一键顺延到今天
    unfinishedBlocks: blocks.filter((b) => !b.taskDone),
    projects: projects.map((p) => ({
      id: p.id, title: p.title, goal: p.goal, startDay: p.startDay, dueDay: p.dueDay,
      dayIndex: p.dayIndex, totalDays: p.totalDays, daysLeft: p.daysLeft,
      dailyMinutes: p.dailyMinutes, focusSecondsOnDay: p.focusSecondsOnDay, focusSecondsTotal: p.focusSecondsTotal,
      taskCount: p.taskCount, doneTaskCount: p.doneTaskCount, completedAt: p.completedAt,
      log: p.log,
    })),
    pendingCount,
    isEmpty: !log.length && !completed.length && !scheduled.length,
  };
}

function harvestsInRange(wb, from, to) {
  return wb.db.prepare(`SELECT id, day, title, conclusion, points, tags, source_url AS sourceUrl, project_id AS projectId, todos
    FROM harvests WHERE day BETWEEN ? AND ? ORDER BY day, created_at, rowid`).all(from, to).map(row => ({
    ...row, points: JSON.parse(row.points), tags: JSON.parse(row.tags), todos: JSON.parse(row.todos).map(todo => todo.text),
  }));
}

/**
 * AI 每日回顾的全部素材：
 * - digest：当天的完成、专注、计划、长期项目（同 dayDigest）
 * - notes：当天任务正文的新增内容（added）和当天接触过的任务的正文摘录（body），见 db.readNoteChanges
 * - recent：之前 6 天的投入概况与当时的回顾摘要，用来谈「成长」
 * - harvests：归入当天的对话精华卡片
 */
export function reviewMaterial(wb, day, timeZone = wb.timeZone) {
  const pending = wb.db.prepare(`SELECT title, COUNT(*) OVER () AS total FROM tasks
    WHERE completed_at IS NULL ORDER BY created_at, id LIMIT 15`).all();
  const [digest] = digestDays(wb, [day], timeZone, pending[0]?.total ?? 0);
  const notes = wb.readNoteChanges(day, timeZone);
  const windows = Array.from({ length: 6 }, (_, i) => {
    const date = shiftDate(day, i - 6);
    return { day: date, ...dayRange(date, timeZone) };
  });
  const first = windows[0], last = windows.at(-1);
  const completed = rowsByDay(wb.db.prepare(`SELECT title, completed_at FROM tasks
    WHERE completed_at >= ? AND completed_at < ? ORDER BY completed_at DESC,id`).all(first.start, last.end), windows, 'completed_at');
  const focus = rowsByDay(wb.db.prepare(`SELECT started_at, elapsed_seconds FROM focus_sessions
    WHERE state='finished' AND started_at >= ? AND started_at < ?`).all(first.start, last.end), windows, 'started_at');
  const edits = Map.groupBy(wb.readEditedNotes(first.day, last.day), row => row.day);
  const reviews = new Map(wb.db.prepare('SELECT day,text FROM daily_reviews WHERE day BETWEEN ? AND ?')
    .all(first.day, last.day).map(row => [row.day, row.text]));
  const recent = windows.map(({ day }) => ({
    day, weekday: weekdayOf(day),
    focusMinutes: Math.round((focus.get(day) ?? []).reduce((s, row) => s + row.elapsed_seconds, 0) / 60),
    completed: (completed.get(day) ?? []).slice(0, 8).map(row => row.title),
    noteTasks: edits.get(day)?.length ?? 0,
    reviewExcerpt: (reviews.get(day) ?? '').replace(/\s+/g, ' ').slice(0, 160),
  }));
  const material = { digest, notes, recent, harvests: harvestsInRange(wb, day, day), pending: pending.map(t => t.title) };
  Object.defineProperty(material, dayProjectLogs, { value: projectLogFacts(wb, day) });
  return material;
}

function hashReviewFacts(digest, notes, harvests) {
  const facts = { digest, notes: notes.map(n => [n.taskId, n.added ?? n.body]) };
  if (harvests?.length) {
    facts.harvests = harvests.map(({ id, title, conclusion, points, todos }) => [id, title, conclusion, points, todos]);
  }
  return factsHash(facts);
}

/** 待办数量、项目累计值、任务当前完成状态和后来写的正文不属于回顾日。 */
export function reviewHash(material) {
  const { digest, notes, harvests } = material;
  const done = new Set(digest.completed.map(task => task.id));
  const blocks = digest.plan.blocks.map(({ id, taskId, startsAt, minutes, focusSeconds }) =>
    ({ id, taskId, startsAt, minutes, focusSeconds, taskDone: done.has(taskId) }));
  const daily = {
    ...digest,
    completed: digest.completed.map(t => t.id),
    created: digest.created.map(t => t.id),
    focus: {
      ...digest.focus,
      byTask: digest.focus.byTask.map(({ taskId, seconds, sessions }) => ({ taskId, seconds, sessions })),
      timeline: digest.focus.timeline.map(({ taskId, start, end, minutes }) => ({ taskId, start, end, minutes })),
    },
    plan: { ...digest.plan, blocks },
    unfinishedBlocks: blocks.filter(block => !block.taskDone),
    projects: material[dayProjectLogs] ?? digest.projects.filter(p => p.log)
      .map(({ id, log }) => ({ id, note: log.note, progress: log.progress }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    // 固定占位保留空日的历史编码；实时待办数量不参与计算。
    pendingCount: 0,
  };
  return hashReviewFacts(daily, notes.filter(n => n.edited), harvests);
}

/** 旧库只存了摘要值。旧算法仍命中时，用同一批事实换算为新指纹，不改库。 */
export function compatibleReviewHash(wb, day, stored) {
  if (!/^[0-9a-f]{32}$/.test(stored)) return stored;
  const digest = dayDigest(wb, day);
  const notes = wb.readNoteChanges(day);
  const harvests = harvestsInRange(wb, day, day);
  return hashReviewFacts(digest, notes, harvests) === stored
    ? reviewHash({ digest, notes, harvests, [dayProjectLogs]: projectLogFacts(wb, day) })
    : stored;
}

/** 「昨天」：工作台时区下今天的前一天。 */
export function yesterdayOf(wb, now = wb.now()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: wb.timeZone }).format(new Date(now * 1000));
  return shiftDate(today, -1);
}

/**
 * 给外部 AI 读的数据快照（AiContext，见 workbench.d.ts）：字段说明 + 待办 + 项目 + 最近 N 天摘要。
 * 不含任何 API Key；includeNotes=true 时附上任务正文（可能含私人内容）。
 */
export function contextSnapshot(wb, { endDay, days = 14, includeNotes = false } = {}) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: wb.timeZone }).format(new Date(wb.now() * 1000));
  const end = endDay ?? today;
  const count = Math.min(Math.max(Number(days) || 14, 1), 120);
  const dates = [];
  for (let i = count - 1; i >= 0; i -= 1) dates.push(shiftDate(end, -i));
  const pendingTasks = readPending(wb).map(row => ({ ...row }));
  const digests = digestDays(wb, dates, wb.timeZone, pendingTasks.length);
  const snapshot = {
    format: 'learning-space-ai-context',
    version: 1,
    generatedAt: wb.now(),
    timeZone: wb.timeZone,
    today,
    range: { from: shiftDate(end, -(count - 1)), to: end, days: count },
    guide: {
      time: '时间戳是 Unix 秒；日期和 HH:MM 都已换算到 timeZone（北京时间）。',
      focus: 'focus.seconds 只统计已结束的专注轮次；排期（plan.blocks）只是计划，不代表做了。',
      planOnly: 'planOnly=true 的块是直接加在日计划里的事项，不在待办清单中。',
      projects: '长期项目跨多天，dayIndex 是第几天，daysLeft 是距截止还剩几天（可为负表示逾期）。',
      followRate: 'plan.followRate = 当天计划里的任务被专注过或完成的比例。',
      harvests: '收获是用户从与 AI 的对话里存下的精华，原文不存；todos 是当时列出的待办文字。',
    },
    pendingTasks,
    projects: wb.listProjects(),
    days: digests,
    harvests: harvestsInRange(wb, dates[0], dates.at(-1)),
  };
  if (includeNotes) {
    snapshot.taskNotes = wb.db.prepare(
      'SELECT n.task_id AS taskId, t.title, n.body FROM task_notes n JOIN tasks t ON t.id = n.task_id'
        + " WHERE length(trim(n.body)) > 0 ORDER BY t.created_at",
    ).all();
  }
  return snapshot;
}

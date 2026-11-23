// 每日摘要：每日维护看板、AI 回顾、给外部 AI 的数据快照共用同一份口径。
// 只读，不写库。数字口径：专注只算已结束（finished）的轮次，时长单位是秒；
// 「排期」不等于「完成」；日期是工作台时区（默认北京时间）的 YYYY-MM-DD。

import { createHash } from 'node:crypto';
import { shiftDate } from './time.js';

const PLAN_COURSE = '日计划';
const WEEK = '日一二三四五六';

function clock(epochSeconds, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(epochSeconds * 1000));
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
  const view = wb.readDay(day, timeZone);
  const log = wb.readFocusLog(day, timeZone);

  const byTask = new Map();
  for (const f of log) {
    const key = f.taskId ?? '';
    const entry = byTask.get(key) ?? { taskId: f.taskId ?? null, title: f.taskTitle ?? '自由专注', seconds: 0, sessions: 0 };
    entry.seconds += f.elapsedSeconds;
    entry.sessions += 1;
    byTask.set(key, entry);
  }
  const focusOf = (taskId) => byTask.get(taskId)?.seconds ?? 0;

  const blocks = view.scheduled.map((b) => ({
    id: b.id,
    taskId: b.taskId,
    title: b.task.title,
    start: clock(b.startsAt, timeZone),
    startsAt: b.startsAt,
    minutes: Math.round(b.plannedSeconds / 60),
    planOnly: b.task.course === PLAN_COURSE,
    projectId: b.task.projectId ?? null,
    taskDone: b.task.completedAt != null,
    focusSeconds: focusOf(b.taskId),
  }));
  const plannedSeconds = view.scheduled.reduce((s, b) => s + b.plannedSeconds, 0);
  const plannedTaskIds = new Set(view.scheduled.map((b) => b.taskId));
  const focusedOnPlanned = [...plannedTaskIds].reduce((s, id) => s + focusOf(id), 0);

  return {
    day,
    weekday: weekdayOf(day),
    timeZone,
    completed: view.completedOnDay.map((t) => ({ id: t.id, title: t.title, course: t.course, projectId: t.projectId ?? null })),
    focus: {
      sessions: view.focusSummary.finishedSessions,
      seconds: view.focusSummary.elapsedSeconds,
      byTask: [...byTask.values()].sort((a, b) => b.seconds - a.seconds),
    },
    plan: {
      blocks,
      plannedSeconds,
      focusedOnPlannedSeconds: focusedOnPlanned,
      // 计划里的任务当天被专注过的比例（0–1），没有计划时为 null
      followRate: plannedTaskIds.size
        ? [...plannedTaskIds].filter((id) => focusOf(id) > 0 || view.completedOnDay.some((t) => t.id === id)).length / plannedTaskIds.size
        : null,
    },
    // 计划了但任务还没完成的块：每日维护看板可以一键顺延到今天
    unfinishedBlocks: blocks.filter((b) => !b.taskDone),
    projects: view.projects.map((p) => ({
      id: p.id, title: p.title, goal: p.goal, startDay: p.startDay, dueDay: p.dueDay,
      dayIndex: p.dayIndex, totalDays: p.totalDays, daysLeft: p.daysLeft,
      dailyMinutes: p.dailyMinutes, focusSecondsOnDay: p.focusSecondsOnDay, focusSecondsTotal: p.focusSecondsTotal,
      taskCount: p.taskCount, doneTaskCount: p.doneTaskCount, completedAt: p.completedAt,
      log: p.log,
    })),
    pendingCount: view.pending.length,
    isEmpty: !log.length && !view.completedOnDay.length && !view.scheduled.length,
  };
}

/**
 * AI 每日回顾的全部素材（只给 /api/ai/review 用，不进 AI 数据快照导出）：
 * - digest：当天的完成、专注、计划、长期项目（同 dayDigest）
 * - notes：当天任务正文的新增内容（added）和当天接触过的任务的正文摘录（body），见 db.readNoteChanges
 * - recent：之前 6 天的投入概况与当时的回顾摘要，用来谈「成长」
 */
export function reviewMaterial(wb, day, timeZone = wb.timeZone) {
  const digest = dayDigest(wb, day, timeZone);
  const notes = wb.readNoteChanges(day, timeZone);
  const recent = [];
  for (let i = 6; i >= 1; i -= 1) {
    const d = shiftDate(day, -i);
    const v = wb.readDay(d, timeZone);
    const review = wb.readDailyReview(d);
    recent.push({
      day: d,
      weekday: weekdayOf(d),
      focusMinutes: Math.round(v.focusSummary.elapsedSeconds / 60),
      completed: v.completedOnDay.map((t) => t.title).slice(0, 8),
      // 当天写过正文的任务数（只数「改过正文」的，不含只是接触过的）
      noteTasks: wb.readNoteChanges(d, timeZone, { total: Infinity }).filter((n) => n.edited).length,
      reviewExcerpt: review ? review.text.replace(/\s+/g, ' ').slice(0, 160) : '',
    });
  }
  return { digest, notes, recent };
}

/** 回顾的指纹：当天统计或当天正文变了就变（之前几天的变化不触发重写）。 */
export function reviewHash(material) {
  return factsHash({ digest: material.digest, notes: material.notes.map((n) => [n.taskId, n.added ?? n.body]) });
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
  const digests = [];
  for (let i = count - 1; i >= 0; i -= 1) digests.push(dayDigest(wb, shiftDate(end, -i)));
  const view = wb.readDay(end);
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
    },
    pendingTasks: view.pending.map((t) => ({ id: t.id, title: t.title, course: t.course, projectId: t.projectId })),
    projects: wb.listProjects(),
    days: digests,
  };
  if (includeNotes) {
    snapshot.taskNotes = wb.db.prepare(
      'SELECT n.task_id AS taskId, t.title, n.body FROM task_notes n JOIN tasks t ON t.id = n.task_id'
        + " WHERE length(trim(n.body)) > 0 ORDER BY t.created_at",
    ).all();
  }
  return snapshot;
}

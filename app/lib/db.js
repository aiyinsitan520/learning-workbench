// 学习工作台数据层：把 architecture/schema.sql 落成可用的仓储。
// 只用 Node 内置 node:sqlite，零第三方依赖。

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayRange, isValidDate, localDateOf, nowSeconds } from './time.js';
import { HARVEST_LIMITS, splitTags } from '../public/js/harvest-format.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(HERE, '..', '..', 'architecture', 'schema.sql');

export const MIGRATIONS_DIR = join(HERE, '..', '..', 'architecture', 'migrations');

// v1 = schema.sql；之后每一版是 migrations/00N_*.sql，文件自己写 PRAGMA user_version = N。
const SCHEMA_VERSION = 4;
export const PROJECT_COURSE = '长期项目';
const MAX_TEXT = 4000;
const MAX_TASK_NOTE = 32000;

export class WorkbenchError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = 'WorkbenchError';
    this.reason = reason; // invalid | missing | conflict | storage
  }
}
const invalid = (m) => new WorkbenchError('invalid', m);
const missing = (m) => new WorkbenchError('missing', m);
const conflict = (m) => new WorkbenchError('conflict', m);

// ------------------------------------------------------------------ 打开

/**
 * 打开数据库。path 传 ':memory:' 得到内存库。
 * 已存在且 user_version 正确的库直接使用；空库执行 schema.sql。
 */
export function openDatabase(path, { timeZone = 'Asia/Shanghai', now = nowSeconds } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // 打开后任何一步失败都要关掉句柄，否则 WAL 文件被占住、目录删不掉。
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    const version = Number(db.prepare('PRAGMA user_version').get().user_version ?? 0);
    if (version === 0) {
      db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    } else if (version > SCHEMA_VERSION) {
      throw new WorkbenchError('storage', `数据库版本 ${version} 比程序期望的 ${SCHEMA_VERSION} 新，请升级程序`);
    }
    // task_notes 表要在迁移之前就存在：003 迁移会把已有正文记成基线
    db.exec(readFileSync(join(dirname(SCHEMA_PATH), 'task_notes.sql'), 'utf8'));
    migrate(db, path);
    if (Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys) !== 1) {
      throw new WorkbenchError('storage', '无法开启外键约束');
    }
  } catch (err) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
    throw err;
  }
  return new Workbench(db, { timeZone, now });
}

/**
 * 把库升级到 SCHEMA_VERSION。文件库在第一次迁移前先用 VACUUM INTO 另存一份
 * <库名>.bak-v<旧版本>-<时间>，迁移本身在一个事务里，失败整体回滚。
 */
function migrate(db, path) {
  let version = Number(db.prepare('PRAGMA user_version').get().user_version ?? 0);
  if (version >= SCHEMA_VERSION) return;
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  if (path !== ':memory:' && existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    db.prepare('VACUUM INTO ?').run(`${path}.bak-v${version}-${stamp}`);
  }
  for (const file of files) {
    const target = Number(file.slice(0, 3));
    if (target <= version) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      const now = Number(db.prepare('PRAGMA user_version').get().user_version);
      if (now !== target) throw new Error(`${file} 没有把 user_version 设为 ${target}`);
      db.exec('COMMIT');
      version = target;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw new WorkbenchError('storage', `数据库迁移 ${file} 失败：${err.message}`);
    }
  }
  if (version !== SCHEMA_VERSION) {
    throw new WorkbenchError('storage', `迁移后版本 ${version} 与程序期望的 ${SCHEMA_VERSION} 不一致`);
  }
}

// ------------------------------------------------------------------ 事务

class Workbench {
  constructor(db, { timeZone, now }) {
    this.db = db;
    this.timeZone = timeZone;
    this.now = now;
  }

  close() {
    this.db.close();
  }

  /** 在 BEGIN IMMEDIATE 里跑 fn，异常一律回滚。 */
  #tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 已回滚 */
      }
      if (err instanceof WorkbenchError) throw err;
      const message = String(err?.message ?? err);
      if (/FOREIGN KEY constraint failed/i.test(message)) throw conflict('引用的记录不存在');
      if (/UNIQUE constraint failed/i.test(message)) throw conflict('记录已存在或状态冲突');
      if (/CHECK constraint failed/i.test(message)) throw invalid('数据不满足约束');
      throw new WorkbenchError('storage', message);
    }
  }

  #one(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }

  #all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  #run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  readTaskNote(taskId) {
    requireId(taskId, '任务 id');
    if (!this.#one('SELECT 1 FROM tasks WHERE id = ?', taskId)) throw missing('任务不存在');
    return this.#one('SELECT body, revision FROM task_notes WHERE task_id = ?', taskId)
      ?? { body: '', revision: 0 };
  }

  saveTaskNote(taskId, body, expectedRevision) {
    if (typeof body !== 'string' || body.length > MAX_TASK_NOTE) throw invalid('任务正文不能超过 32000 字符');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw invalid('正文版本不合法');
    return this.#tx(() => {
      const current = this.readTaskNote(taskId);
      if (current.body === body) return { revision: current.revision };
      if (current.revision !== expectedRevision) throw conflict('此任务的正文已在另一窗口更新');
      const revision = current.revision + 1;
      this.#run(`INSERT INTO task_notes (task_id, body, revision) VALUES (?, ?, ?)
        ON CONFLICT (task_id) DO UPDATE SET body=excluded.body, revision=excluded.revision`,
      taskId, body, revision);
      // 按天留底：同一天多次保存只留最后一份，AI 回顾据此算「当天新写了什么」
      const now = this.now();
      this.#run(`INSERT INTO task_note_days (task_id, day, body, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (task_id, day) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`,
      taskId, localDateOf(now, this.timeZone), body, now);
      return { revision };
    });
  }

  // ---------------------------------------------------------------- 读取

  /** 读取某一天的工作台视图（workbench.d.ts 的 WorkbenchView）。 */
  readDay(day, timeZone = this.timeZone) {
    if (!isValidDate(day)) throw invalid(`日期格式应为 YYYY-MM-DD：${day}`);
    const { start, end } = dayRange(day, timeZone);
    const pending = this.#all(
      'SELECT id, title, course, estimated_seconds, completed_at, project_id FROM tasks'
        + ' WHERE completed_at IS NULL ORDER BY created_at, id',
    ).map(mapTask);
    const completedOnDay = this.#all(
      'SELECT id, title, course, estimated_seconds, completed_at, project_id FROM tasks'
        + ' WHERE completed_at >= ? AND completed_at < ? ORDER BY completed_at DESC, id',
      start,
      end,
    ).map(mapTask);
    const scheduled = this.#all(
      'SELECT b.id AS block_id, b.task_id, b.starts_at, b.planned_seconds,'
        + ' t.id, t.title, t.course, t.estimated_seconds, t.completed_at, t.project_id'
        + ' FROM schedule_blocks b JOIN tasks t ON t.id = b.task_id'
        + ' WHERE b.starts_at >= ? AND b.starts_at < ?'
        + ' ORDER BY b.starts_at, b.id',
      start,
      end,
    ).map((row) => ({
      id: row.block_id,
      taskId: row.task_id,
      startsAt: row.starts_at,
      plannedSeconds: row.planned_seconds,
      task: mapTask(row),
    }));
    const note = this.readDayNote(day);
    const openRow = this.#one(
      "SELECT * FROM focus_sessions WHERE state IN ('running','paused') ORDER BY started_at DESC LIMIT 1",
    );
    const summary = this.#one(
      'SELECT COUNT(*) AS sessions, COALESCE(SUM(elapsed_seconds), 0) AS seconds'
        + ' FROM focus_sessions WHERE state = \'finished\' AND started_at >= ? AND started_at < ?',
      start,
      end,
    );
    return {
      day,
      timeZone,
      range: { start, end },
      pending,
      completedOnDay,
      scheduled,
      note,
      openFocus: openRow ? mapFocus(openRow) : null,
      focusSummary: { finishedSessions: Number(summary.sessions), elapsedSeconds: Number(summary.seconds) },
      projects: this.readProjects(day, timeZone),
    };
  }

  // ---------------------------------------------------------------- 长期项目

  /**
   * 某天「在进行」的长期项目：已开始、未归档；当天或之后才完成的也算（回看历史时不丢）。
   * 统计全部来自已结束的专注（state='finished'），口径和 focusSummary 一致。
   */
  readProjects(day, timeZone = this.timeZone) {
    if (!isValidDate(day)) throw invalid(`日期格式应为 YYYY-MM-DD：${day}`);
    const { start, end } = dayRange(day, timeZone);
    const rows = this.#all(
      'SELECT * FROM projects WHERE archived_at IS NULL AND start_day <= ?'
        + ' AND (completed_at IS NULL OR completed_at >= ?) ORDER BY COALESCE(due_day, \'9999\'), created_at, id',
      day, start,
    );
    return rows.map((p) => {
      const focus = this.#one(
        "SELECT COALESCE(SUM(f.elapsed_seconds),0) AS total,"
          + " COALESCE(SUM(CASE WHEN f.started_at >= ? AND f.started_at < ? THEN f.elapsed_seconds END),0) AS onDay"
          + " FROM focus_sessions f JOIN tasks t ON t.id = f.task_id"
          + " WHERE t.project_id = ? AND f.state = 'finished' AND f.started_at < ?",
        start, end, p.id, end,
      );
      const tasks = this.#one(
        'SELECT COUNT(*) AS n, COUNT(completed_at) AS done FROM tasks WHERE project_id = ? AND id <> ?',
        p.id, p.main_task_id,
      );
      const log = this.#one('SELECT * FROM project_logs WHERE project_id = ? AND day = ?', p.id, day);
      const last = this.#one(
        'SELECT * FROM project_logs WHERE project_id = ? AND day < ? ORDER BY day DESC LIMIT 1', p.id, day,
      );
      return {
        ...mapProject(p),
        dayIndex: daysBetween(p.start_day, day) + 1,
        totalDays: p.due_day ? daysBetween(p.start_day, p.due_day) + 1 : null,
        daysLeft: p.due_day ? daysBetween(day, p.due_day) : null,
        focusSecondsOnDay: Number(focus.onDay),
        focusSecondsTotal: Number(focus.total),
        taskCount: Number(tasks.n),
        doneTaskCount: Number(tasks.done),
        log: log ? mapProjectLog(log) : null,
        lastLog: last ? mapProjectLog(last) : null,
      };
    });
  }

  /** 新建长期项目，同时建它的主任务（course='长期项目'）。同 ID 同内容可安全重试。 */
  createProject({ id, title, goal = '', startDay, dueDay = null, dailyMinutes = null, mainTaskId }) {
    requireId(id, '项目 id');
    requireId(mainTaskId, '主任务 id');
    const cleanTitle = requireText(title, '项目名称', 120);
    const cleanGoal = optionalText(goal, '项目目标', MAX_TEXT);
    if (!isValidDate(startDay)) throw invalid('开始日期格式应为 YYYY-MM-DD');
    if (dueDay != null && (!isValidDate(dueDay) || dueDay < startDay)) throw invalid('截止日期应不早于开始日期');
    const minutes = dailyMinutes == null ? null : requirePositiveInt(dailyMinutes, '每日分钟数');
    return this.#tx(() => {
      const existing = this.#one('SELECT * FROM projects WHERE id = ?', id);
      if (existing) {
        const same = existing.title === cleanTitle && existing.goal === cleanGoal
          && existing.start_day === startDay && existing.due_day === (dueDay ?? null)
          && existing.daily_minutes === minutes && existing.main_task_id === mainTaskId;
        if (same) return { ok: true, created: false };
        throw conflict(`项目 ${id} 已存在且内容不同`);
      }
      if (this.#one('SELECT id FROM tasks WHERE id = ?', mainTaskId)) throw conflict(`任务 ${mainTaskId} 已存在`);
      this.#run(
        'INSERT INTO projects (id, title, goal, start_day, due_day, daily_minutes, main_task_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, cleanTitle, cleanGoal, startDay, dueDay ?? null, minutes, mainTaskId,
      );
      this.#run(
        'INSERT INTO tasks (id, title, course, project_id) VALUES (?, ?, ?, ?)',
        mainTaskId, cleanTitle, PROJECT_COURSE, id,
      );
      return { ok: true, created: true };
    });
  }

  /** 改名称、目标、日期或每日分钟数；改名同步到主任务。未传的字段不变，传 null 表示清空可空字段。 */
  updateProject({ projectId, title, goal, startDay, dueDay, dailyMinutes }) {
    requireId(projectId, '项目 id');
    return this.#tx(() => {
      const row = this.#one('SELECT * FROM projects WHERE id = ?', projectId);
      if (!row) throw missing(`项目 ${projectId} 不存在`);
      const next = {
        title: title === undefined ? row.title : requireText(title, '项目名称', 120),
        goal: goal === undefined ? row.goal : optionalText(goal, '项目目标', MAX_TEXT),
        start: startDay === undefined ? row.start_day : startDay,
        due: dueDay === undefined ? row.due_day : dueDay,
        minutes: dailyMinutes === undefined ? row.daily_minutes
          : (dailyMinutes == null ? null : requirePositiveInt(dailyMinutes, '每日分钟数')),
      };
      if (!isValidDate(next.start)) throw invalid('开始日期格式应为 YYYY-MM-DD');
      if (next.due != null && (!isValidDate(next.due) || next.due < next.start)) throw invalid('截止日期应不早于开始日期');
      this.#run(
        'UPDATE projects SET title = ?, goal = ?, start_day = ?, due_day = ?, daily_minutes = ? WHERE id = ?',
        next.title, next.goal, next.start, next.due ?? null, next.minutes, projectId,
      );
      this.#run('UPDATE tasks SET title = ? WHERE id = ?', next.title, row.main_task_id);
      return { ok: true };
    });
  }

  /** complete / reopen / archive / unarchive。完成项目会同时完成主任务，重开则一并撤销。 */
  setProjectState({ projectId, action }) {
    requireId(projectId, '项目 id');
    if (!['complete', 'reopen', 'archive', 'unarchive'].includes(action)) throw invalid(`未知项目操作：${action}`);
    return this.#tx(() => {
      const row = this.#one('SELECT * FROM projects WHERE id = ?', projectId);
      if (!row) throw missing(`项目 ${projectId} 不存在`);
      const now = this.now();
      if (action === 'complete' && row.completed_at == null) {
        this.#run('UPDATE projects SET completed_at = ? WHERE id = ?', now, projectId);
        this.#run('UPDATE tasks SET completed_at = ? WHERE id = ? AND completed_at IS NULL', now, row.main_task_id);
      } else if (action === 'reopen' && row.completed_at != null) {
        this.#run('UPDATE projects SET completed_at = NULL WHERE id = ?', projectId);
        this.#run('UPDATE tasks SET completed_at = NULL WHERE id = ?', row.main_task_id);
      } else if (action === 'archive' && row.archived_at == null) {
        this.#run('UPDATE projects SET archived_at = ? WHERE id = ?', now, projectId);
      } else if (action === 'unarchive' && row.archived_at != null) {
        this.#run('UPDATE projects SET archived_at = NULL WHERE id = ?', projectId);
      }
      return { ok: true };
    });
  }

  /** 写某个项目某天的进展（一天一条，覆盖写）。progress 为 0–100 或 null。 */
  saveProjectLog({ projectId, day, note = '', progress = null }) {
    requireId(projectId, '项目 id');
    if (!isValidDate(day)) throw invalid('日期格式应为 YYYY-MM-DD');
    const cleanNote = optionalText(note, '进展', MAX_TEXT);
    if (progress != null && (!Number.isInteger(progress) || progress < 0 || progress > 100)) {
      throw invalid('进度应为 0–100 的整数');
    }
    return this.#tx(() => {
      if (!this.#one('SELECT id FROM projects WHERE id = ?', projectId)) throw missing(`项目 ${projectId} 不存在`);
      this.#run(
        'INSERT INTO project_logs (project_id, day, note, progress, updated_at) VALUES (?, ?, ?, ?, ?)'
          + ' ON CONFLICT(project_id, day) DO UPDATE SET note = excluded.note, progress = excluded.progress,'
          + ' updated_at = excluded.updated_at',
        projectId, day, cleanNote, progress, this.now(),
      );
      return { ok: true };
    });
  }

  /** 全部项目（含已完成、已归档），供 AI 读取与导出。 */
  listProjects() {
    return this.#all('SELECT * FROM projects ORDER BY created_at, id').map((p) => ({
      ...mapProject(p),
      logs: this.#all('SELECT * FROM project_logs WHERE project_id = ? ORDER BY day', p.id).map(mapProjectLog),
    }));
  }

  // ---------------------------------------------------------------- v4：收获库（对话精华）

  /**
   * 收获列表，新的在前。q 在标题、结论、要点、待办、标签里找；tag 精确匹配一个标签。
   * 同时返回全部标签的计数，供筛选条使用。
   */
  readHarvests({ q = '', tag = '', limit = 50, offset = 0 } = {}) {
    const n = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const skip = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const where = [];
    const args = [];
    const query = String(q ?? '').trim();
    if (query) {
      const like = '%' + query.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      where.push('(' + ['title', 'conclusion', 'points', 'todos', 'tags'].map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
      args.push(like, like, like, like, like);
    }
    const wanted = String(tag ?? '').trim().replace(/^[#＃]+/, '');
    if (wanted) {
      where.push('EXISTS (SELECT 1 FROM json_each(harvests.tags) WHERE value = ?)');
      args.push(wanted);
    }
    const filter = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = Number(this.#one(`SELECT COUNT(*) AS n FROM harvests${filter}`, ...args).n);
    const rows = this.#all(`SELECT * FROM harvests${filter} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      ...args, n, skip);
    const tags = this.#all(
      'SELECT j.value AS tag, COUNT(*) AS count FROM harvests, json_each(harvests.tags) AS j'
        + ' GROUP BY j.value ORDER BY count DESC, j.value',
    ).map((r) => ({ tag: r.tag, count: Number(r.count) }));
    return { harvests: rows.map((r) => this.#mapHarvest(r)), total, tags };
  }

  /** 某天（按卡片的 day）存的收获，旧的在前。AI 回顾与数据快照用。 */
  readHarvestsOnDay(day) {
    if (!isValidDate(day)) throw invalid('日期格式应为 YYYY-MM-DD');
    return this.#all('SELECT * FROM harvests WHERE day = ? ORDER BY created_at, rowid', day).map((r) => this.#mapHarvest(r));
  }

  readHarvest(id) {
    requireId(id, '收获 id');
    const row = this.#one('SELECT * FROM harvests WHERE id = ?', id);
    if (!row) throw missing(`收获 ${id} 不存在`);
    return this.#mapHarvest(row);
  }

  /** 新建收获卡片。同 ID 同内容视为成功（可安全重试），同 ID 不同内容报冲突。 */
  createHarvest({ id, day, title, conclusion = '', points = [], todos = [], tags = [], source = '', sourceUrl = '',
    projectId = null }) {
    requireId(id, '收获 id');
    const card = cleanHarvest({ title, conclusion, points, todos, tags, source, sourceUrl });
    const cardDay = day ?? localDateOf(this.now(), this.timeZone);
    if (!isValidDate(cardDay)) throw invalid('日期格式应为 YYYY-MM-DD');
    if (projectId != null) requireId(projectId, '项目 id');
    return this.#tx(() => {
      const existing = this.#one('SELECT * FROM harvests WHERE id = ?', id);
      const values = [cardDay, card.title, card.conclusion, JSON.stringify(card.points), JSON.stringify(card.todos),
        JSON.stringify(card.tags), card.source, card.sourceUrl, projectId ?? null];
      if (existing) {
        const old = [existing.day, existing.title, existing.conclusion, existing.points, existing.todos,
          existing.tags, existing.source, existing.source_url, existing.project_id ?? null];
        if (old.every((v, i) => v === values[i])) return { ok: true, created: false };
        throw conflict(`收获 ${id} 已存在且内容不同`);
      }
      if (projectId != null && !this.#one('SELECT id FROM projects WHERE id = ?', projectId)) {
        throw missing(`项目 ${projectId} 不存在`);
      }
      const now = this.now();
      this.#run(
        'INSERT INTO harvests (id, day, title, conclusion, points, todos, tags, source, source_url, project_id,'
          + ' created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, ...values, now, now,
      );
      return { ok: true, created: true };
    });
  }

  /**
   * 改收获卡片。未传的字段不变；projectId 传 null 表示取消关联。
   * todos 里没带 taskId 的条目，若旧卡片有同文字的条目，沿用它的 taskId（避免改字后重复加入待办）。
   */
  updateHarvest({ harvestId, day, title, conclusion, points, todos, tags, sourceUrl, projectId }) {
    requireId(harvestId, '收获 id');
    if (todos !== undefined && !Array.isArray(todos)) throw invalid('待办 必须是数组');
    return this.#tx(() => {
      const row = this.#one('SELECT * FROM harvests WHERE id = ?', harvestId);
      if (!row) throw missing(`收获 ${harvestId} 不存在`);
      const oldTodos = JSON.parse(row.todos);
      const merged = todos === undefined ? oldTodos : todos.map((item) => {
        const text = typeof item === 'string' ? item : item?.text;
        const taskId = item && typeof item === 'object' && item.taskId !== undefined
          ? item.taskId : oldTodos.find((t) => t.text === String(text ?? '').trim())?.taskId ?? null;
        return { text, taskId };
      });
      const card = cleanHarvest({
        title: title === undefined ? row.title : title,
        conclusion: conclusion === undefined ? row.conclusion : conclusion,
        points: points === undefined ? JSON.parse(row.points) : points,
        todos: merged,
        tags: tags === undefined ? JSON.parse(row.tags) : tags,
        source: row.source,
        sourceUrl: sourceUrl === undefined ? row.source_url : sourceUrl,
      });
      const nextDay = day === undefined ? row.day : day;
      if (!isValidDate(nextDay)) throw invalid('日期格式应为 YYYY-MM-DD');
      const nextProject = projectId === undefined ? row.project_id ?? null : projectId;
      if (nextProject != null) {
        requireId(nextProject, '项目 id');
        if (!this.#one('SELECT id FROM projects WHERE id = ?', nextProject)) throw missing(`项目 ${nextProject} 不存在`);
      }
      this.#run(
        'UPDATE harvests SET day = ?, title = ?, conclusion = ?, points = ?, todos = ?, tags = ?, source_url = ?,'
          + ' project_id = ?, updated_at = ? WHERE id = ?',
        nextDay, card.title, card.conclusion, JSON.stringify(card.points), JSON.stringify(card.todos),
        JSON.stringify(card.tags), card.sourceUrl, nextProject, this.now(), harvestId,
      );
      return { ok: true };
    });
  }

  /** 删除收获卡片。由它生成的任务保留。 */
  deleteHarvest({ harvestId }) {
    requireId(harvestId, '收获 id');
    return this.#tx(() => {
      if (!this.#one('SELECT id FROM harvests WHERE id = ?', harvestId)) throw missing(`收获 ${harvestId} 不存在`);
      this.#run('DELETE FROM harvests WHERE id = ?', harvestId);
      return { ok: true };
    });
  }

  /**
   * 把卡片第 index 条待办变成任务（标题 = 待办文字），并记下 taskId。同一事务。
   * course 传 '日计划' 表示只进时间轴不进待办清单（排进今天用，之后调 saveSchedule）。
   * 同 taskId 重试返回 created:false；这条待办已对应另一个仍存在的任务时报冲突。
   */
  promoteHarvestTodo({ harvestId, index, taskId, course = '' }) {
    requireId(harvestId, '收获 id');
    requireId(taskId, '任务 id');
    requireNonNegativeInt(index, '待办序号');
    const cleanCourse = optionalText(course, '课程', 60);
    return this.#tx(() => {
      const row = this.#one('SELECT * FROM harvests WHERE id = ?', harvestId);
      if (!row) throw missing(`收获 ${harvestId} 不存在`);
      const todos = JSON.parse(row.todos);
      const todo = todos[index];
      if (!todo) throw missing(`第 ${index + 1} 条待办不存在`);
      if (todo.taskId && this.#one('SELECT id FROM tasks WHERE id = ?', todo.taskId)) {
        if (todo.taskId === taskId) return { ok: true, created: false, taskId };
        throw conflict('这条待办已经加入过');
      }
      if (this.#one('SELECT id FROM tasks WHERE id = ?', taskId)) throw conflict(`任务 ${taskId} 已存在`);
      this.#run('INSERT INTO tasks (id, title, course, project_id) VALUES (?, ?, ?, ?)',
        taskId, clipText(todo.text, 120), cleanCourse, row.project_id ?? null);
      todos[index] = { ...todo, taskId };
      this.#run('UPDATE harvests SET todos = ?, updated_at = ? WHERE id = ?', JSON.stringify(todos), this.now(), harvestId);
      return { ok: true, created: true, taskId };
    });
  }

  #mapHarvest(row) {
    const todos = JSON.parse(row.todos).map((t) => {
      const task = t.taskId ? this.#one('SELECT completed_at FROM tasks WHERE id = ?', t.taskId) : null;
      return { text: t.text, taskId: task ? t.taskId : null, taskDone: Boolean(task && task.completed_at != null) };
    });
    return {
      id: row.id, day: row.day, title: row.title, conclusion: row.conclusion,
      points: JSON.parse(row.points), todos, tags: JSON.parse(row.tags),
      source: row.source, sourceUrl: row.source_url, projectId: row.project_id ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  // ---------------------------------------------------------------- 任务正文的每日变化（AI 回顾用）

  /**
   * 某天的任务正文素材：
   * - edited：当天改过正文的任务。added = 当天这份与之前最近一份相比新增的行（之前没有就是全文）。
   * - 当天专注过 / 完成 / 排过计划、但当天没改正文的任务，附当前正文摘录（edited=false）。
   * 长度有上限，避免把整本笔记塞给模型。
   */
  readNoteChanges(day, timeZone = this.timeZone, { perTask = 2500, context = 800, total = 12000 } = {}) {
    if (!isValidDate(day)) throw invalid(`日期格式应为 YYYY-MM-DD：${day}`);
    const { start, end } = dayRange(day, timeZone);
    const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…（已截断）` : s);
    const out = [];
    const edited = this.#all(
      'SELECT d.task_id, d.body, t.title, t.course, t.project_id FROM task_note_days d JOIN tasks t ON t.id = d.task_id'
        + ' WHERE d.day = ? ORDER BY d.updated_at',
      day,
    );
    for (const row of edited) {
      const prev = this.#one(
        'SELECT body FROM task_note_days WHERE task_id = ? AND day < ? ORDER BY day DESC LIMIT 1', row.task_id, day,
      );
      const added = addedLines(prev?.body ?? '', row.body);
      if (!added.trim()) continue;
      out.push({ taskId: row.task_id, title: row.title, course: row.course, projectId: row.project_id ?? null,
        edited: true, firstTime: !prev, added: cut(added, perTask) });
    }
    const seen = new Set(out.map((n) => n.taskId));
    const touched = this.#all(
      `SELECT DISTINCT t.id, t.title, t.course, t.project_id, n.body FROM tasks t JOIN task_notes n ON n.task_id = t.id
        WHERE length(trim(n.body)) > 0 AND (
          t.completed_at >= ? AND t.completed_at < ?
          OR EXISTS (SELECT 1 FROM focus_sessions f WHERE f.task_id = t.id AND f.state = 'finished' AND f.started_at >= ? AND f.started_at < ?)
          OR EXISTS (SELECT 1 FROM schedule_blocks b WHERE b.task_id = t.id AND b.starts_at >= ? AND b.starts_at < ?))`,
      start, end, start, end, start, end,
    );
    for (const row of touched) {
      if (seen.has(row.id)) continue;
      out.push({ taskId: row.id, title: row.title, course: row.course, projectId: row.project_id ?? null,
        edited: false, firstTime: false, body: cut(row.body.trim(), context) });
    }
    // 总量上限：先保当天新写的
    let budget = total;
    return out.filter((n) => {
      const size = (n.added ?? n.body ?? '').length;
      if (size > budget) return false;
      budget -= size;
      return true;
    });
  }

  // ---------------------------------------------------------------- AI 回顾缓存

  readDailyReview(day) {
    if (!isValidDate(day)) throw invalid(`日期格式应为 YYYY-MM-DD：${day}`);
    const row = this.#one('SELECT * FROM daily_reviews WHERE day = ?', day);
    return row ? {
      day: row.day, factsHash: row.facts_hash, text: row.text,
      provider: row.provider, model: row.model, createdAt: row.created_at,
    } : null;
  }

  saveDailyReview({ day, factsHash, text, provider = '', model = '' }) {
    if (!isValidDate(day)) throw invalid(`日期格式应为 YYYY-MM-DD：${day}`);
    requireText(factsHash, 'factsHash', 128);
    const clean = requireText(text, '回顾正文', MAX_TEXT);
    return this.#tx(() => {
      this.#run(
        'INSERT INTO daily_reviews (day, facts_hash, text, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          + ' ON CONFLICT(day) DO UPDATE SET facts_hash = excluded.facts_hash, text = excluded.text,'
          + ' provider = excluded.provider, model = excluded.model, created_at = excluded.created_at',
        day, factsHash, clean, optionalText(provider, 'provider', 120), optionalText(model, 'model', 120), this.now(),
      );
      return { ok: true };
    });
  }

  readDayNote(day) {
    const row = this.#one('SELECT * FROM day_notes WHERE study_date = ?', day);
    if (!row) return null;
    const blocks = this.#all(
      'SELECT id, kind, title, body, task_id FROM note_blocks WHERE note_id = ? ORDER BY position, id',
      row.id,
    ).map((b) => (b.kind === 'task_ref'
      ? { id: b.id, kind: 'task_ref', taskId: b.task_id }
      : { id: b.id, kind: b.kind, title: b.title, body: b.body }));
    return { id: row.id, studyDate: row.study_date, title: row.title, revision: Number(row.revision), blocks };
  }

  /** 某月每天的任务与专注计数，供日历页使用。 */
  readMonth(monthText, timeZone = this.timeZone) {
    if (!/^\d{4}-\d{2}$/.test(String(monthText))) throw invalid(`月份格式应为 YYYY-MM：${monthText}`);
    const [y, mo] = monthText.split('-').map(Number);
    if (mo < 1 || mo > 12) throw invalid(`非法月份：${monthText}`);
    const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const out = [];
    for (let d = 1; d <= days; d += 1) {
      const day = `${monthText}-${String(d).padStart(2, '0')}`;
      const { start, end } = dayRange(day, timeZone);
      const t = this.#one(
        'SELECT COUNT(*) AS n FROM tasks WHERE completed_at >= ? AND completed_at < ?', start, end,
      );
      const f = this.#one(
        "SELECT COUNT(*) AS n, COALESCE(SUM(elapsed_seconds),0) AS s FROM focus_sessions"
          + " WHERE state = 'finished' AND started_at >= ? AND started_at < ?", start, end,
      );
      const b = this.#one(
        'SELECT COUNT(*) AS n FROM schedule_blocks WHERE starts_at >= ? AND starts_at < ?', start, end,
      );
      const note = this.#one('SELECT title FROM day_notes WHERE study_date = ?', day);
      out.push({
        day,
        completedTasks: Number(t.n),
        focusSessions: Number(f.n),
        focusSeconds: Number(f.s),
        scheduledBlocks: Number(b.n),
        noteTitle: note?.title ?? '',
      });
    }
    return out;
  }

  /** 某天已结束的专注明细（进行中的那一轮不在此列）。 */
  readFocusLog(day, timeZone = this.timeZone) {
    if (!isValidDate(day)) throw invalid(`日期格式应为 YYYY-MM-DD：${day}`);
    const { start, end } = dayRange(day, timeZone);
    return this.#all(
      'SELECT f.*, t.title AS task_title FROM focus_sessions f'
        + ' LEFT JOIN tasks t ON t.id = f.task_id'
        + " WHERE f.state = 'finished' AND f.started_at >= ? AND f.started_at < ?"
        + ' ORDER BY f.started_at DESC',
      start,
      end,
    ).map((r) => ({ ...mapFocus(r), taskTitle: r.task_title ?? null }));
  }

  // ---------------------------------------------------------------- 任务

  /** createTask：同 ID 同内容视为成功（可安全重试），同 ID 不同内容报冲突。 */
  createTask({ id, title, course = '', estimatedSeconds = null, projectId = null }) {
    requireId(id);
    const cleanTitle = requireText(title, '任务标题', 120);
    const cleanCourse = optionalText(course, '课程', 60);
    const est = estimatedSeconds == null ? null : requirePositiveInt(estimatedSeconds, '预计秒数');
    if (projectId != null) requireId(projectId, '项目 id');
    return this.#tx(() => {
      const existing = this.#one('SELECT * FROM tasks WHERE id = ?', id);
      if (existing) {
        const same = existing.title === cleanTitle
          && existing.course === cleanCourse
          && existing.estimated_seconds === est
          && (existing.project_id ?? null) === (projectId ?? null);
        if (same) return { ok: true, created: false };
        throw conflict(`任务 ${id} 已存在且内容不同`);
      }
      if (projectId != null && !this.#one('SELECT id FROM projects WHERE id = ?', projectId)) {
        throw missing(`项目 ${projectId} 不存在`);
      }
      this.#run(
        'INSERT INTO tasks (id, title, course, estimated_seconds, project_id) VALUES (?, ?, ?, ?, ?)',
        id, cleanTitle, cleanCourse, est, projectId ?? null,
      );
      return { ok: true, created: true };
    });
  }

  /** 改标题或预计时长；不改完成状态与创建时间。 */
  updateTask({ taskId, title, course, estimatedSeconds }) {
    requireId(taskId);
    return this.#tx(() => {
      const row = this.#one('SELECT * FROM tasks WHERE id = ?', taskId);
      if (!row) throw missing(`任务 ${taskId} 不存在`);
      const nextTitle = title === undefined ? row.title : requireText(title, '任务标题', 120);
      const nextCourse = course === undefined ? row.course : optionalText(course, '课程', 60);
      const nextEst = estimatedSeconds === undefined
        ? row.estimated_seconds
        : (estimatedSeconds == null ? null : requirePositiveInt(estimatedSeconds, '预计秒数'));
      if (nextTitle === row.title && nextCourse === row.course && nextEst === row.estimated_seconds) {
        return { ok: true, changed: false };
      }
      this.#run(
        'UPDATE tasks SET title = ?, course = ?, estimated_seconds = ? WHERE id = ?',
        nextTitle, nextCourse, nextEst, taskId,
      );
      return { ok: true, changed: true };
    });
  }

  setTaskCompleted({ taskId, completed }) {
    requireId(taskId);
    if (typeof completed !== 'boolean') throw invalid('completed 必须是布尔值');
    return this.#tx(() => {
      const row = this.#one('SELECT id, completed_at FROM tasks WHERE id = ?', taskId);
      if (!row) throw missing(`任务 ${taskId} 不存在`);
      if (completed && row.completed_at == null) {
        this.#run('UPDATE tasks SET completed_at = ? WHERE id = ?', this.now(), taskId);
      } else if (!completed && row.completed_at != null) {
        this.#run('UPDATE tasks SET completed_at = NULL WHERE id = ?', taskId);
      }
      return { ok: true };
    });
  }

  /** 改期：同一条时间块改时间，不新建任务。 */
  saveSchedule({ block }) {
    const b = block ?? {};
    requireId(b.id, '时间块 id');
    requireId(b.taskId, '任务 id');
    const startsAt = requireNonNegativeInt(b.startsAt, '开始时间');
    const planned = requirePositiveInt(b.plannedSeconds, '计划时长');
    return this.#tx(() => {
      if (!this.#one('SELECT id FROM tasks WHERE id = ?', b.taskId)) {
        throw missing(`任务 ${b.taskId} 不存在`);
      }
      const existing = this.#one('SELECT * FROM schedule_blocks WHERE id = ?', b.id);
      if (existing) {
        const same = existing.task_id === b.taskId
          && existing.starts_at === startsAt
          && existing.planned_seconds === planned;
        if (same) return { ok: true, created: false };
        this.#run(
          'UPDATE schedule_blocks SET task_id = ?, starts_at = ?, planned_seconds = ? WHERE id = ?',
          b.taskId, startsAt, planned, b.id,
        );
        return { ok: true, created: false, updated: true };
      }
      this.#run(
        'INSERT INTO schedule_blocks (id, task_id, starts_at, planned_seconds) VALUES (?, ?, ?, ?)',
        b.id, b.taskId, startsAt, planned,
      );
      return { ok: true, created: true };
    });
  }

  removeSchedule({ blockId }) {
    requireId(blockId, '时间块 id');
    return this.#tx(() => {
      const info = this.#run('DELETE FROM schedule_blocks WHERE id = ?', blockId);
      if (Number(info.changes) === 0) throw missing(`时间块 ${blockId} 不存在`);
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- 专注

  /**
   * startFocus：全库最多一条 running/paused。
   * 用事务 + 先查后写，唯一索引兜底；结束时按截止时刻结算。
   */
  startFocus({ id, taskId = null, plannedSeconds }) {
    requireId(id, '专注 id');
    const planned = requirePositiveInt(plannedSeconds, '计划秒数');
    if (taskId != null) requireId(taskId, '任务 id');
    return this.#tx(() => {
      this.#settleExpired();
      const open = this.#one(
        "SELECT id FROM focus_sessions WHERE state IN ('running','paused') LIMIT 1",
      );
      if (open) throw conflict(`已有进行中的专注 ${open.id}，先结束它`);
      if (taskId != null && !this.#one('SELECT id FROM tasks WHERE id = ?', taskId)) {
        throw missing(`任务 ${taskId} 不存在`);
      }
      const now = this.now();
      this.#run(
        'INSERT INTO focus_sessions (id, task_id, state, planned_seconds, elapsed_seconds, started_at, state_changed_at)'
          + ' VALUES (?, ?, \'running\', ?, 0, ?, ?)',
        id, taskId, planned, now, now,
      );
      return { ok: true };
    });
  }

  /**
   * changeFocus：pause / resume / finish。
   * 所有状态迁移都带 revision 乐观锁；到时的会话按截止时刻结算为 finished。
   */
  changeFocus({ id, expectedRevision, action }) {
    requireId(id, '专注 id');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw invalid('expectedRevision 必须是非负整数');
    }
    if (!['pause', 'resume', 'finish'].includes(action)) throw invalid(`未知动作：${action}`);
    return this.#tx(() => {
      const row = this.#one('SELECT * FROM focus_sessions WHERE id = ?', id);
      if (!row) throw missing(`专注 ${id} 不存在`);
      if (Number(row.revision) !== expectedRevision) {
        throw conflict(`专注 ${id} 已被更新（当前版本 ${row.revision}）`);
      }
      const now = this.now();
      const state = row.state;
      if (state === 'finished') throw conflict('这一轮专注已经结束');

      if (action === 'pause') {
        if (state !== 'running') throw conflict('只有进行中的专注可以暂停');
        const elapsed = this.#elapsedOf(row, now);
        this.#writeState(row, { state: 'paused', elapsed, now });
        return { ok: true, state: 'paused', elapsedSeconds: elapsed };
      }
      if (action === 'resume') {
        if (state !== 'paused') throw conflict('只有暂停的专注可以恢复');
        this.#writeState(row, { state: 'running', elapsed: Number(row.elapsed_seconds), now });
        return { ok: true, state: 'running', elapsedSeconds: Number(row.elapsed_seconds) };
      }
      // finish：进行中按实际，暂停中按冻结值；不超过计划时长。
      const elapsed = state === 'running'
        ? this.#elapsedOf(row, now)
        : Number(row.elapsed_seconds);
      this.#writeState(row, { state: 'finished', elapsed, now });
      return { ok: true, state: 'finished', elapsedSeconds: elapsed };
    });
  }

  /** 到时未结束的会话按截止时刻结算，重复调用幂等。 */
  settleExpired() {
    return this.#tx(() => this.#settleExpired());
  }

  #settleExpired() {
    const open = this.#all("SELECT * FROM focus_sessions WHERE state = 'running'");
    const settled = [];
    for (const row of open) {
      const deadline = Number(row.started_at) + Number(row.planned_seconds)
        - Number(row.elapsed_seconds);
      if (this.now() < deadline) continue;
      const elapsed = Number(row.planned_seconds);
      this.#writeState(row, { state: 'finished', elapsed, now: deadline });
      settled.push({ id: row.id, elapsedSeconds: elapsed });
    }
    return settled;
  }

  #elapsedOf(row, now) {
    const planned = Number(row.planned_seconds);
    const accumulated = Number(row.elapsed_seconds);
    if (row.state !== 'running') return accumulated;
    const ran = Math.max(0, now - Number(row.state_changed_at));
    return Math.min(planned, accumulated + ran);
  }

  #writeState(row, { state, elapsed, now }) {
    this.#run(
      'UPDATE focus_sessions SET state = ?, elapsed_seconds = ?, state_changed_at = ?, revision = revision + 1'
        + ' WHERE id = ? AND revision = ?',
      state, elapsed, now, row.id, Number(row.revision),
    );
  }

  // ---------------------------------------------------------------- 手记

  /**
   * saveDayNote：整篇文档一次事务写入。
   * expectedRevision 为 null 表示新建；版本不符返回冲突且不改动任何行。
   */
  saveDayNote({ note, expectedRevision }) {
    const n = note ?? {};
    if (!isValidDate(n.studyDate)) throw invalid(`日期格式应为 YYYY-MM-DD：${n.studyDate}`);
    requireId(n.id, '手记 id');
    const title = optionalText(n.title ?? '', '标题', 200);
    const blocks = Array.isArray(n.blocks) ? n.blocks : [];
    const seen = new Set();
    const rows = blocks.map((b, index) => {
      const row = normalizeBlock(b, index);
      if (seen.has(row.id)) throw invalid(`块 id 重复：${row.id}`);
      seen.add(row.id);
      return row;
    });
    if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
      throw invalid('expectedRevision 必须是 null 或非负整数');
    }
    return this.#tx(() => {
      const existing = this.#one('SELECT * FROM day_notes WHERE study_date = ?', n.studyDate);
      if (expectedRevision === null) {
        if (existing) throw conflict('这一天的手记已存在，请先读取');
      } else {
        if (!existing) throw conflict('手记不存在或已被删除');
        if (Number(existing.revision) !== expectedRevision) {
          throw conflict(`手记已被更新（当前版本 ${existing.revision}）`);
        }
      }
      let noteId = n.id;
      let revision;
      if (existing) {
        noteId = existing.id;
        if (existing.id !== n.id) throw conflict('手记 id 与这一天已有的手记不一致');
        revision = Number(existing.revision) + 1;
        this.#run('UPDATE day_notes SET title = ?, revision = ? WHERE id = ?', title, revision, noteId);
        this.#run('DELETE FROM note_blocks WHERE note_id = ?', noteId);
      } else {
        revision = 0;
        this.#run(
          'INSERT INTO day_notes (id, study_date, title, revision) VALUES (?, ?, ?, 0)',
          noteId, n.studyDate, title,
        );
      }
      const insert = this.db.prepare(
        'INSERT INTO note_blocks (id, note_id, position, kind, title, body, task_id)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      rows.forEach((row, position) => {
        if (row.kind === 'task_ref' && !this.#one('SELECT id FROM tasks WHERE id = ?', row.taskId)) {
          throw missing(`引用的任务 ${row.taskId} 不存在`);
        }
        insert.run(
          row.id, noteId, position, row.kind, row.title, row.body,
          row.kind === 'task_ref' ? row.taskId : null,
        );
      });
      return { ok: true, id: noteId, revision };
    });
  }

  // ---------------------------------------------------------------- 统计

  /** 按天汇总；分钟只在展示层换算。 */
  readStats(day, timeZone = this.timeZone) {
    if (!isValidDate(day)) throw invalid(`日期格式应为 YYYY-MM-DD：${day}`);
    const { start, end } = dayRange(day, timeZone);
    const focus = this.#one(
      "SELECT COUNT(*) AS sessions, COALESCE(SUM(elapsed_seconds),0) AS seconds"
        + " FROM focus_sessions WHERE state = 'finished' AND started_at >= ? AND started_at < ?",
      start, end,
    );
    const done = this.#one(
      'SELECT COUNT(*) AS n FROM tasks WHERE completed_at >= ? AND completed_at < ?', start, end,
    );
    const byTask = this.#all(
      "SELECT COALESCE(t.title, '自由专注') AS title, COUNT(*) AS sessions, SUM(f.elapsed_seconds) AS seconds"
        + ' FROM focus_sessions f LEFT JOIN tasks t ON t.id = f.task_id'
        + " WHERE f.state = 'finished' AND f.started_at >= ? AND f.started_at < ?"
        + ' GROUP BY COALESCE(t.title, \'自由专注\') ORDER BY seconds DESC',
      start, end,
    ).map((r) => ({ title: r.title, sessions: Number(r.sessions), seconds: Number(r.seconds) }));
    return {
      day,
      focusSessions: Number(focus.sessions),
      focusSeconds: Number(focus.seconds),
      completedTasks: Number(done.n),
      byTask,
    };
  }

  /**
   * 最近 N 天的投入分析：按课程分组、按任务分组、按天趋势。
   * 全部按秒累计，分钟只在展示层换算。
   */
  readInsights(days = 14, timeZone = this.timeZone, endDay = null) {
    const span = Math.max(1, Math.min(90, Number(days) || 14));
    const anchor = endDay || localDateOf(this.now(), timeZone);
    if (!isValidDate(anchor)) throw invalid(`日期格式应为 YYYY-MM-DD：${anchor}`);

    const [y, mo, d] = anchor.split('-').map(Number);
    const fromDate = new Date(Date.UTC(y, mo - 1, d - (span - 1)));
    const fromDay = `${fromDate.getUTCFullYear()}-${String(fromDate.getUTCMonth() + 1).padStart(2, '0')}-${String(fromDate.getUTCDate()).padStart(2, '0')}`;
    const { start } = dayRange(fromDay, timeZone);
    const { end } = dayRange(anchor, timeZone);

    const courseExpr = "COALESCE(NULLIF(TRIM(t.course), ''), '未分类')";

    const byCourse = this.#all(
      `SELECT ${courseExpr} AS course, COUNT(*) AS sessions,`
        + ' COALESCE(SUM(f.elapsed_seconds),0) AS seconds, COUNT(DISTINCT f.task_id) AS tasks'
        + ' FROM focus_sessions f LEFT JOIN tasks t ON t.id = f.task_id'
        + " WHERE f.state = 'finished' AND f.started_at >= ? AND f.started_at < ?"
        + ` GROUP BY ${courseExpr} ORDER BY seconds DESC`,
      start, end,
    ).map((r) => ({
      course: r.course,
      sessions: Number(r.sessions),
      seconds: Number(r.seconds),
      tasks: Number(r.tasks),
    }));

    const byTask = this.#all(
      `SELECT COALESCE(t.title, '自由专注') AS title, ${courseExpr} AS course,`
        + ' COUNT(*) AS sessions, COALESCE(SUM(f.elapsed_seconds),0) AS seconds'
        + ' FROM focus_sessions f LEFT JOIN tasks t ON t.id = f.task_id'
        + " WHERE f.state = 'finished' AND f.started_at >= ? AND f.started_at < ?"
        + ` GROUP BY COALESCE(t.title, '自由专注'), ${courseExpr}`
        + ' ORDER BY seconds DESC LIMIT 10',
      start, end,
    ).map((r) => ({
      title: r.title,
      course: r.course,
      sessions: Number(r.sessions),
      seconds: Number(r.seconds),
    }));

    // 按本地日期归集，避免 UTC 跨日错位
    const dayMap = new Map();
    for (const row of this.#all(
      'SELECT started_at, elapsed_seconds FROM focus_sessions'
        + " WHERE state = 'finished' AND started_at >= ? AND started_at < ?",
      start, end,
    )) {
      const key = localDateOf(Number(row.started_at), timeZone);
      const prev = dayMap.get(key) ?? { day: key, sessions: 0, seconds: 0 };
      prev.sessions += 1;
      prev.seconds += Number(row.elapsed_seconds);
      dayMap.set(key, prev);
    }
    const timeline = [];
    for (let i = 0; i < span; i += 1) {
      const t = new Date(Date.UTC(y, mo - 1, d - (span - 1) + i));
      const key = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
      timeline.push(dayMap.get(key) ?? { day: key, sessions: 0, seconds: 0 });
    }

    const totalSeconds = byCourse.reduce((sum, c) => sum + c.seconds, 0);
    const totalSessions = byCourse.reduce((sum, c) => sum + c.sessions, 0);
    const top = byCourse[0] ?? null;

    let streak = 0;
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      if (timeline[i].seconds > 0) streak += 1;
      else break;
    }

    return {
      from: fromDay,
      to: anchor,
      days: span,
      totalSeconds,
      totalSessions,
      activeDays: timeline.filter((x) => x.seconds > 0).length,
      streak,
      topCourse: top ? { ...top, share: totalSeconds ? top.seconds / totalSeconds : 0 } : null,
      byCourse: byCourse.map((c) => ({
        ...c,
        share: totalSeconds ? c.seconds / totalSeconds : 0,
      })),
      byTask,
      timeline,
    };
  }



  /** 今日该推荐哪一项：先用户选中，其次最早安排的待办。 */
  recommend(day, preferredTaskId = null, timeZone = this.timeZone) {
    if (preferredTaskId) {
      const t = this.#one('SELECT * FROM tasks WHERE id = ? AND completed_at IS NULL', preferredTaskId);
      if (t) return mapTask(t);
    }
    const { start, end } = dayRange(day, timeZone);
    const scheduled = this.#one(
      'SELECT t.* FROM schedule_blocks b JOIN tasks t ON t.id = b.task_id'
        + ' WHERE t.completed_at IS NULL AND b.starts_at >= ? AND b.starts_at < ?'
        + ' ORDER BY b.starts_at LIMIT 1',
      start, end,
    );
    if (scheduled) return mapTask(scheduled);
    const any = this.#one('SELECT * FROM tasks WHERE completed_at IS NULL ORDER BY created_at, id LIMIT 1');
    return any ? mapTask(any) : null;
  }
}

// ------------------------------------------------------------------ 校验与映射

function mapTask(row) {
  return {
    id: row.id,
    title: row.title,
    course: row.course ?? '',
    estimatedSeconds: row.estimated_seconds ?? null,
    completedAt: row.completed_at ?? null,
    projectId: row.project_id ?? null,
  };
}

function mapProject(p) {
  return {
    id: p.id,
    title: p.title,
    goal: p.goal,
    startDay: p.start_day,
    dueDay: p.due_day ?? null,
    dailyMinutes: p.daily_minutes ?? null,
    mainTaskId: p.main_task_id,
    createdAt: p.created_at,
    completedAt: p.completed_at ?? null,
    archivedAt: p.archived_at ?? null,
  };
}

function mapProjectLog(row) {
  return { day: row.day, note: row.note, progress: row.progress ?? null, updatedAt: row.updated_at };
}

/** after 相比 before 新增的行（按去掉首尾空白后的整行比较，保持原顺序，忽略空行）。 */
export function addedLines(before, after) {
  const old = new Set(String(before).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  return String(after).split(/\r?\n/).filter((l) => l.trim() && !old.has(l.trim())).join('\n');
}

/** 两个 YYYY-MM-DD 之间相差几天（b - a），只做日历运算。 */
export function daysBetween(a, b) {
  const toUtc = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

function mapFocus(row) {
  return {
    id: row.id,
    taskId: row.task_id ?? null,
    state: row.state,
    plannedSeconds: Number(row.planned_seconds),
    elapsedSeconds: Number(row.elapsed_seconds),
    startedAt: Number(row.started_at),
    stateChangedAt: Number(row.state_changed_at),
    revision: Number(row.revision),
  };
}

function requireId(value, label = 'id') {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 64) {
    throw invalid(`${label} 必须是非空字符串（最多 64 字符）`);
  }
  return value;
}

function requireText(value, label, max) {
  if (typeof value !== 'string') throw invalid(`${label} 必须是字符串`);
  const text = value.trim();
  if (!text) throw invalid(`${label} 不能为空`);
  if (text.length > max) throw invalid(`${label} 最多 ${max} 字`);
  return text;
}

function optionalText(value, label, max) {
  if (value == null) return '';
  if (typeof value !== 'string') throw invalid(`${label} 必须是字符串`);
  const text = value.trim();
  if (text.length > max) throw invalid(`${label} 最多 ${max} 字`);
  return text;
}

const clipText = (text, max) => Array.from(String(text)).slice(0, max).join('').trim();

/** 校验并规整一张收获卡片。超长直接报错：页面的解析器已截断过，到这里还超说明是绕过页面的请求。 */
function cleanHarvest({ title, conclusion, points, todos, tags, source, sourceUrl }) {
  const L = HARVEST_LIMITS;
  const list = (value, label, max) => {
    if (!Array.isArray(value)) throw invalid(`${label} 必须是数组`);
    if (value.length > max) throw invalid(`${label} 最多 ${max} 条`);
    return value;
  };
  const cleanPoints = list(points, '要点', L.points)
    .map((p) => optionalText(p, '要点', L.point)).filter(Boolean);
  const cleanTodos = list(todos, '待办', L.todos).map((t) => {
    const item = typeof t === 'string' ? { text: t, taskId: null } : t;
    if (!item || typeof item !== 'object') throw invalid('待办格式无效');
    const taskId = item.taskId == null ? null : requireId(item.taskId, '任务 id');
    return { text: optionalText(item.text, '待办', L.todo), taskId };
  }).filter((t) => t.text);
  const cleanTags = [...new Set(list(tags, '标签', L.tags).flatMap((t) => {
    if (typeof t !== 'string') throw invalid('标签必须是字符串');
    return splitTags(t);
  }))].slice(0, L.tags);
  const url = optionalText(sourceUrl, '对话链接', L.url);
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw invalid('对话链接应为 http(s) 地址'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw invalid('对话链接应为 http(s) 地址');
  }
  return {
    title: requireText(title, '标题', L.title),
    conclusion: optionalText(conclusion, '结论', L.conclusion),
    points: cleanPoints, todos: cleanTodos, tags: cleanTags,
    source: optionalText(source, '来源', 20), sourceUrl: url,
  };
}

function requirePositiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw invalid(`${label} 必须是正整数`);
  return value;
}

function requireNonNegativeInt(value, label) {
  if (!Number.isInteger(value) || value < 0) throw invalid(`${label} 必须是非负整数`);
  return value;
}

const KINDS = new Set(['text', 'question', 'thought', 'workflow', 'task_ref']);

function normalizeBlock(block, index) {
  const b = block ?? {};
  requireId(b.id, `第 ${index + 1} 个块的 id`);
  if (!KINDS.has(b.kind)) throw invalid(`第 ${index + 1} 个块的 kind 不合法：${b.kind}`);
  if (b.kind === 'task_ref') {
    requireId(b.taskId, `第 ${index + 1} 个块引用的任务 id`);
    return { id: b.id, kind: 'task_ref', taskId: b.taskId, title: '', body: '' };
  }
  return {
    id: b.id,
    kind: b.kind,
    title: optionalText(b.title ?? '', '块标题', 200),
    body: optionalText(b.body ?? '', '块正文', MAX_TEXT),
    taskId: null,
  };
}

export { localDateOf };

// 学习工作台本地服务：零依赖 HTTP + JSON API + 静态托管。
// 只监听回环地址；数据落在应用私有目录的 SQLite 文件里。

import { createServer } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, WorkbenchError, SCHEMA_PATH } from './lib/db.js';
import { isValidDate, localDateOf, nowSeconds } from './lib/time.js';
import { dayDigest, yesterdayOf, contextSnapshot, reviewMaterial, reviewHash } from './lib/digest.js';
import { contextMarkdown } from './lib/context-md.js';
import { handleAiRoute } from './lib/ai-routes.js';
import { createIslandController, defaultIslandLauncher } from './lib/island.js';
import { createUpdater, UpdateError } from './lib/updater.js';
import { UPDATE_CONFIG } from './lib/update-config.js';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
export const APP_VERSION = JSON.parse(readFileSync(join(HERE, 'version.json'), 'utf8')).version;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const BODY_LIMIT = 512 * 1024;
// 顺序即导入顺序：被引用的表在前。AI 密钥不在库里（app/data/ai-providers.json），不会被导出。
const BACKUP_TABLES = ['projects', 'tasks', 'schedule_blocks', 'focus_sessions', 'day_notes', 'note_blocks',
  'task_notes', 'task_note_days', 'project_logs', 'daily_reviews'];

export function createWorkbenchServer({ dbPath, timeZone = 'Asia/Shanghai', root = HERE, aiConfigPath, fetchImpl,
  islandLauncher = defaultIslandLauncher(root), updater } = {}) {
  // 桌面灵动岛（app/island/island.ps1）：测试传 islandLauncher: null 或假启动器，不会真的弹窗
  const island = createIslandController(islandLauncher);
  // 自动更新（app/lib/updater.js）：桌面版由 desktop/main.mjs 注入能安装的 updater；
  // 源码运行只能手动检查，不下载、不安装（更新请 git pull），也不定时联网。
  updater ??= createUpdater({ version: APP_VERSION, config: UPDATE_CONFIG, edition: 'source',
    install: { mode: null, reason: '源码运行的工作台请用 git pull 更新；自动下载和安装只在桌面版里可用。' } });
  const workbench = openDatabase(dbPath, { timeZone });
  // AI 模型配置文件默认放在数据库旁边；测试可传 fetchImpl 换掉真实网络请求。
  const ai = { configPath: aiConfigPath ?? (dbPath && dbPath !== ':memory:' ? join(dirname(dbPath), 'ai-providers.json') : null), fetch: fetchImpl ?? fetch };
  const publicDir = join(root, 'public');
  const projectDir = join(root, '..');

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(workbench, req, res, url, publicDir, ai, island, updater);
        return;
      }
      await serveStatic(req, res, url.pathname, publicDir, projectDir);
    } catch (err) {
      sendJson(res, 500, { ok: false, reason: 'storage', message: String(err?.message ?? err) });
    }
  });

  server.on('close', () => {
    updater.stopSchedule();
    try {
      workbench.close();
    } catch {
      /* 已关闭 */
    }
  });

  return { server, workbench, updater };
}

// ------------------------------------------------------------------ API

let buildCache = { dir: '', at: 0, value: '' };

/** public/ 下所有文件最新的修改时间（毫秒，字符串）；2 秒内复用结果。 */
async function publicBuild(dir) {
  const now = Date.now();
  if (buildCache.dir === dir && now - buildCache.at < 2000) return buildCache.value;
  let latest = 0;
  for (const name of await readdir(dir, { recursive: true })) {
    try {
      const info = await stat(join(dir, name));
      if (info.isFile() && info.mtimeMs > latest) latest = info.mtimeMs;
    } catch { /* 读取途中被删的文件忽略 */ }
  }
  buildCache = { dir, at: now, value: String(Math.floor(latest)) };
  return buildCache.value;
}

async function handleApi(wb, req, res, url, publicDir, ai, island, updater) {
  const route = `${req.method} ${url.pathname}`;
  try {
    const body = req.method === 'POST' ? await readJson(req) : null;
    // 模型接入（CC Switch 式的供应商管理）与 AI 回顾：见 app/lib/ai-routes.js
    if (url.pathname.startsWith('/api/ai/')) {
      const payload = await handleAiRoute(route, { wb, body, url, ai });
      sendJson(res, 200, { ok: true, ...payload });
      return;
    }
    switch (route) {
      case 'GET /api/review': {
        // 每日维护看板：某天（默认昨天）的摘要 + 已存的 AI 回顾（stale 表示记录在回顾之后又改过）
        const day = url.searchParams.get('day') || yesterdayOf(wb);
        if (!isValidDate(day)) throw new WorkbenchError('invalid', '日期格式应为 YYYY-MM-DD');
        // stale 的口径和生成回顾时一致：当天统计或当天任务正文变了都算
        const material = reviewMaterial(wb, day);
        const digest = material.digest;
        const hash = reviewHash(material);
        const saved = wb.readDailyReview(day);
        const review = saved ? { ...saved, stale: saved.factsHash !== hash } : null;
        sendJson(res, 200, { ok: true, digest, factsHash: hash, review, today: localDateOf(nowSeconds(), wb.timeZone) });
        return;
      }
      case 'GET /api/context': {
        // 给外部 AI 读的数据快照：?days=14&end=YYYY-MM-DD&notes=1&format=json|md
        const end = url.searchParams.get('end') || undefined;
        if (end && !isValidDate(end)) throw new WorkbenchError('invalid', 'end 日期格式应为 YYYY-MM-DD');
        const snapshot = contextSnapshot(wb, {
          endDay: end, days: Number(url.searchParams.get('days') || 14), includeNotes: url.searchParams.get('notes') === '1',
        });
        if (url.searchParams.get('format') === 'md') {
          const text = contextMarkdown(snapshot);
          res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
          res.end(text);
          return;
        }
        sendJson(res, 200, { ok: true, ...snapshot });
        return;
      }
      case 'GET /api/view': {
        const day = url.searchParams.get('day') || localDateOf(nowSeconds(), wb.timeZone);
        const tz = url.searchParams.get('tz') || wb.timeZone;
        wb.settleExpired();
        const view = wb.readDay(day, tz);
        const recommended = wb.recommend(day, url.searchParams.get('prefer') || null, tz);
        const focusLog = wb.readFocusLog(day, tz);
        const stats = wb.readStats(day, tz);
        sendJson(res, 200, { ok: true, view, recommended, focusLog, stats });
        return;
      }
      case 'GET /api/month': {
        const month = url.searchParams.get('month') || localDateOf(nowSeconds(), wb.timeZone).slice(0, 7);
        const tz = url.searchParams.get('tz') || wb.timeZone;
        sendJson(res, 200, { ok: true, days: wb.readMonth(month, tz) });
        return;
      }
      case 'GET /api/task-note': {
        const note = wb.readTaskNote(url.searchParams.get('task'));
        sendJson(res, 200, { ok: true, note });
        return;
      }
      case 'POST /api/command': {
        const command = body?.command ?? body;
        const result = execute(wb, command);
        sendJson(res, 200, { ok: true, result });
        return;
      }
      case 'POST /api/import': {
        // 只允许导入到空库，避免覆盖已有数据。
        const payload = body;
        if (!payload || payload.format !== 'learning-space-workbench') {
          throw new WorkbenchError('invalid', '不是本工作台的导出文件');
        }
        const existing = BACKUP_TABLES.reduce(
          (sum, t) => sum + Number(wb.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n), 0,
        );
        if (existing > 0) {
          throw new WorkbenchError('conflict', '当前库里已有数据，导入只支持空库');
        }
        let inserted = 0;
        wb.db.exec('BEGIN IMMEDIATE');
        try {
          for (const table of BACKUP_TABLES) {
            const rows = payload.tables?.[table];
            if (!Array.isArray(rows) || !rows.length) continue;
            for (const row of rows) {
              const cols = Object.keys(row);
              if (!cols.length) continue;
              const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
              wb.db.prepare(sql).run(...cols.map((c) => row[c]));
              inserted += 1;
            }
          }
          wb.db.exec('COMMIT');
        } catch (err) {
          wb.db.exec('ROLLBACK');
          throw err;
        }
        sendJson(res, 200, { ok: true, inserted });
        return;
      }
      case 'GET /api/export': {
        // 整库导出为 JSON，便于备份与迁移。
        const data = {};
        for (const table of BACKUP_TABLES) {
          data[table] = wb.db.prepare(`SELECT * FROM ${table}`).all();
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="workbench-${stamp}.json"`,
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify({
          format: 'learning-space-workbench',
          version: 1,
          exportedAt: Math.floor(Date.now() / 1000),
          timeZone: wb.timeZone,
          tables: data,
        }, null, 2));
        return;
      }
      case 'GET /api/insights': {
        const days = Number(url.searchParams.get('days') || 14);
        const tz = url.searchParams.get('tz') || wb.timeZone;
        const endDay = url.searchParams.get('day') || null;
        const insights = wb.readInsights(days, tz, endDay);
        sendJson(res, 200, { ok: true, insights });
        return;
      }
      case 'GET /api/island':
        sendJson(res, 200, { ok: true, supported: island.supported, running: island.running() });
        return;
      case 'POST /api/island':
        // 打开 / 关闭桌面灵动岛：{ action: 'open' | 'close' | 'toggle' } → { supported, running }
        sendJson(res, 200, { ok: true, ...(await island.handle(body?.action, req.socket.localPort)) });
        return;
      case 'GET /api/update':
        // 自动更新状态：当前版本、检查结果、下载进度、本机能否安装
        sendJson(res, 200, { ok: true, update: updater.status() });
        return;
      case 'POST /api/update': {
        // { action: 'check' | 'download' | 'install' | 'settings', autoCheck? } → { update, result? }
        const action = body?.action;
        let result = null;
        try {
          if (action === 'check') await updater.check();
          else if (action === 'download') updater.download();
          else if (action === 'install') result = await updater.install();
          else if (action === 'settings') await updater.setAutoCheck(body.autoCheck);
          else throw new WorkbenchError('invalid', `未知更新操作：${action}`);
        } catch (err) {
          if (err instanceof UpdateError) throw new WorkbenchError('conflict', err.message);
          throw err;
        }
        sendJson(res, 200, { ok: true, update: updater.status(), result });
        if (result?.afterResponse) setTimeout(result.afterResponse, 300);
        return;
      }
      case 'GET /api/health':
        // build：前端文件的最新修改时间。长期开着的窗口据此发现代码已更新并自动重载。
        sendJson(res, 200, { ok: true, timeZone: wb.timeZone, now: nowSeconds(), build: await publicBuild(publicDir) });
        return;
      default:
        sendJson(res, 404, { ok: false, reason: 'invalid', message: `未知接口 ${route}` });
    }
  } catch (err) {
    if (err instanceof WorkbenchError) {
      const status = err.reason === 'missing' ? 404 : err.reason === 'conflict' ? 409 : err.reason === 'invalid' ? 400 : 500;
      sendJson(res, status, { ok: false, reason: err.reason, message: err.message });
      return;
    }
    sendJson(res, 500, { ok: false, reason: 'storage', message: String(err?.message ?? err) });
  }
}

/** 把 workbench.d.ts 的 Command 映射到仓储方法。 */
export function execute(wb, command) {
  const type = command?.type;
  switch (type) {
    case 'createTask':
      return wb.createTask({
        id: command.id,
        title: command.title,
        course: command.course ?? '',
        estimatedSeconds: command.estimatedSeconds ?? null,
      });
    case 'updateTask':
      return wb.updateTask({
        taskId: command.taskId,
        title: command.title,
        course: command.course,
        estimatedSeconds: command.estimatedSeconds,
        projectId: command.projectId ?? null,
      });
    case 'setTaskCompleted':
      return wb.setTaskCompleted({ taskId: command.taskId, completed: command.completed });
    case 'saveSchedule':
      return wb.saveSchedule({ block: command.block });
    case 'removeSchedule':
      return wb.removeSchedule({ blockId: command.blockId });
    case 'startFocus':
      return wb.startFocus({
        id: command.id,
        taskId: command.taskId ?? null,
        plannedSeconds: command.plannedSeconds,
      });
    case 'changeFocus':
      return wb.changeFocus({
        id: command.id,
        expectedRevision: command.expectedRevision,
        action: command.action,
      });
    case 'saveDayNote':
      return wb.saveDayNote({ note: command.note, expectedRevision: command.expectedRevision ?? null });
    case 'saveTaskNote':
      return wb.saveTaskNote(command.taskId, command.body, command.expectedRevision);
    case 'createProject':
      return wb.createProject({
        id: command.id, title: command.title, goal: command.goal, startDay: command.startDay,
        dueDay: command.dueDay ?? null, dailyMinutes: command.dailyMinutes ?? null, mainTaskId: command.mainTaskId,
      });
    case 'updateProject':
      return wb.updateProject({
        projectId: command.projectId, title: command.title, goal: command.goal,
        startDay: command.startDay, dueDay: command.dueDay, dailyMinutes: command.dailyMinutes,
      });
    case 'setProjectState':
      return wb.setProjectState({ projectId: command.projectId, action: command.action });
    case 'saveProjectLog':
      return wb.saveProjectLog({
        projectId: command.projectId, day: command.day, note: command.note, progress: command.progress ?? null,
      });
    default:
      throw new WorkbenchError('invalid', `未知命令：${type}`);
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new WorkbenchError('invalid', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new WorkbenchError('invalid', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// ------------------------------------------------------------------ 静态

async function serveStatic(req, res, pathname, publicDir, projectDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 只允许访问 public/ 下的文件，以及根目录的图片素材。
  const isAsset = /^\/(desk|kitten)\.png$/.test(rel);
  const base = isAsset ? projectDir : publicDir;
  const target = normalize(join(base, rel.replace(/^\/+/, '')));
  if (!target.startsWith(base + sep) && target !== base) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': data.length,
      'cache-control': isAsset ? 'public, max-age=3600' : 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

// ------------------------------------------------------------------ 入口

export async function start({ port = 0, host = '127.0.0.1', dbPath, timeZone, root, aiConfigPath, fetchImpl, islandLauncher,
  updater } = {}) {
  const { server, workbench, updater: up } = createWorkbenchServer({ dbPath, timeZone, root, aiConfigPath, fetchImpl, updater,
    ...(islandLauncher === undefined ? {} : { islandLauncher }) });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const url = `http://${host}:${address.port}/`;
  return { server, workbench, updater: up, url, port: address.port };
}

// 直接 `node app/server.js` 运行时才启动。桌面版（Electron）里 argv[1] 可能是 --user-data-dir=… 之类的参数，
// 不能拿来拼 URL（以前这里会抛 Invalid URL，带参数启动桌面版就崩溃）。
const isEntry = (() => {
  try { return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntry) {
  const port = Number(process.env.PORT ?? 7321);
  const dbPath = process.env.WORKBENCH_DB ?? join(HERE, 'data', 'workbench.db');
  // 工作台固定按北京时间分日（用户 2026-11-21 决定），不跟随本机时区；需要时用 WORKBENCH_TZ 覆盖。
  const timeZone = process.env.WORKBENCH_TZ || 'Asia/Shanghai';
  const { url } = await start({ port, dbPath, timeZone });
  console.log(`学习工作台已启动：${url}`);
  console.log(`数据库：${dbPath}`);
  console.log(`时区：${timeZone}`);
  console.log(`schema：${SCHEMA_PATH}`);
}

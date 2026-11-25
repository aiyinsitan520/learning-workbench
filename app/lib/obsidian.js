import { createHash, randomUUID } from 'node:crypto';
import {
  linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { WorkbenchError } from './db.js';
import { localDateOf } from './time.js';

const GROUPS = { days: '日计划', notes: '任务正文', harvests: '收获', projects: '长期项目', attachment: '附件' };
const INCLUDE = ['days', 'notes', 'harvests', 'projects'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const IMAGE = /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/;
const LEASE = 120_000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const key = path => path.normalize('NFC').toLowerCase();
const invalid = message => new WorkbenchError('invalid', message);
const busy = () => new WorkbenchError('conflict', '另一个工作台正在导出，请稍后重试。');
const timestamp = seconds => new Date(seconds * 1000).toISOString();
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim().replace(/[\\*_[\]<>|]/g, '\\$&');
const initialStatus = () => ({ lastExportAt: null, written: 0, unchanged: 0, conflicts: [], error: null });

function filename(value, limit = 80) {
  let name = String(value).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f[\]#^]/g, '_')
    .trim().replace(/^\.+|[. ]+$/g, '');
  if (/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name)) name = '_' + name;
  name = name.slice(0, limit).replace(/[\uD800-\uDBFF]$|[. ]+$/g, '');
  return name || '未命名';
}

function info(path) {
  return lstatSync(path, { throwIfNoEntry: false });
}

function directory(path, create = false) {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat = info(current);
    if (!stat && create) {
      try { mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = info(current);
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw invalid('目录不存在或包含符号链接／联接点。');
  }
  if (key(realpathSync.native(path)) !== key(path)) throw invalid('路径包含链接或目录别名。');
}

function plainFile(path) {
  directory(dirname(path));
  const stat = info(path);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw invalid('导出路径包含非普通文件或链接。');
  return stat;
}

function file(path) {
  return plainFile(path) ? readFileSync(path) : null;
}

function publish(path, contents, expected) {
  directory(dirname(path));
  const temp = join(dirname(path), '.workbench-' + randomUUID() + '.tmp');
  writeFileSync(temp, contents, { flag: 'wx' });
  try {
    if (expected === null) {
      // 同目录硬链接原子发布新文件，目标已存在时由文件系统拒绝。
      linkSync(temp, path);
    } else {
      if (expected !== undefined && !file(path)?.equals(expected)) throw busy();
      renameSync(temp, path);
    }
  } finally {
    if (info(temp)) unlinkSync(temp);
  }
}

function settings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('导出配置格式错误。');
  const { vaultPath = '', folder = '学习工作台', enabled = false, auto = false, include = {} } = value;
  if (typeof vaultPath !== 'string' || typeof folder !== 'string' || filename(folder) !== folder
    || typeof enabled !== 'boolean' || typeof auto !== 'boolean' || !include || typeof include !== 'object'
    || Array.isArray(include) || INCLUDE.some(name => Object.hasOwn(include, name) && typeof include[name] !== 'boolean')) {
    throw invalid('请检查仓库路径、子文件夹名称和导出选项。');
  }
  if (vaultPath && (!isAbsolute(vaultPath) || /^[\\/]{2}/.test(vaultPath)
    || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(vaultPath))
    || vaultPath.slice(parse(vaultPath).root.length).split(/[\\/]/).some(part =>
      part === '.' || part === '..' || (process.platform === 'win32' && /[:*?"<>|]|[. ]$/.test(part))))) {
    throw invalid('请选择本机仓库的绝对路径，且路径不能包含穿越段。');
  }
  if (enabled && !vaultPath) throw invalid('请先选择 Obsidian 仓库。');
  return { vaultPath: vaultPath ? resolve(vaultPath) : '', folder, enabled, auto,
    include: Object.fromEntries(INCLUDE.map(name => [name, include[name] ?? true])) };
}

function validateVault(config) {
  directory(join(config.vaultPath, '.obsidian'));
  const output = join(config.vaultPath, config.folder);
  if (info(output)) directory(output);
  return output;
}

export function detectObsidianVaults() {
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  if (!base) return [];
  try {
    const data = JSON.parse(readFileSync(join(base, 'obsidian', 'obsidian.json'), 'utf8'));
    return [...new Set(Object.values(data.vaults ?? {}).map(vault => vault?.path)
      .filter(path => typeof path === 'string' && isAbsolute(path)))];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function withLock(output, run) {
  const path = join(output, '.workbench-export.lock');
  const reclaim = path + '.reclaim';
  const token = randomUUID();
  const record = () => JSON.stringify({ pid: process.pid, time: Date.now(), token });
  try {
    publish(path, record(), null);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = file(path);
    if (!prior) throw busy();
    const old = JSON.parse(prior);
    if (!Number.isFinite(old.time) || Date.now() - old.time < LEASE) throw busy();
    // 过期回收者串行竞争，并在删除前复核锁内容。
    try { writeFileSync(reclaim, token, { flag: 'wx' }); } catch (reclaimError) {
      if (reclaimError.code === 'EEXIST') throw busy();
      throw reclaimError;
    }
    try {
      if (!file(path)?.equals(prior)) throw busy();
      unlinkSync(path);
      try { publish(path, record(), null); } catch (newError) {
        if (newError.code === 'EEXIST') throw busy();
        throw newError;
      }
    } finally {
      unlinkSync(reclaim);
    }
  }
  let renewed = Date.now();
  function check() {
    const current = file(path);
    if (!current || JSON.parse(current).token !== token) throw busy();
    if (Date.now() - renewed > LEASE / 4) {
      if (Date.now() - renewed >= LEASE) throw busy();
      publish(path, record(), current);
      renewed = Date.now();
    }
  }
  try {
    return run(check);
  } finally {
    const current = file(path);
    if (current && JSON.parse(current).token === token) unlinkSync(path);
  }
}

function snapshot(wb) {
  const read = sql => wb.db.prepare(sql).all();
  wb.db.exec('BEGIN');
  try {
    return {
      notes: read('SELECT t.*, n.body FROM task_notes n JOIN tasks t ON n.task_id = t.id ORDER BY t.id'),
      history: read("SELECT task_id, day, updated_at FROM task_note_days ORDER BY day"),
      projects: read('SELECT * FROM projects ORDER BY id'),
      logs: read('SELECT * FROM project_logs ORDER BY day'),
      harvests: read('SELECT * FROM harvests ORDER BY id'),
      blocks: read('SELECT b.*, t.title, t.project_id FROM schedule_blocks b JOIN tasks t ON b.task_id = t.id ORDER BY starts_at, b.id'),
      focus: read('SELECT f.*, t.title, t.project_id FROM focus_sessions f LEFT JOIN tasks t ON f.task_id = t.id ORDER BY started_at, f.id'),
      hands: read('SELECT d.study_date, d.title AS day_title, b.* FROM day_notes d LEFT JOIN note_blocks b ON b.note_id = d.id ORDER BY d.study_date, b.position'),
      reviews: read('SELECT * FROM daily_reviews ORDER BY day'),
    };
  } finally {
    wb.db.exec('ROLLBACK');
  }
}

function buildDocuments(wb, config, dataDir, entries) {
  const data = snapshot(wb);
  const docs = new Map();
  const paths = new Set();
  const dateOf = seconds => localDateOf(seconds, wb.timeZone);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: wb.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const hhmm = seconds => clock.format(new Date(seconds * 1000));
  const minutes = seconds => Math.round(seconds / 60);
  function add(type, id, title, stem, day, updated, tags = []) {
    const base = filename(stem, 77);
    let name = base;
    for (let i = 0; paths.has(key(GROUPS[type] + '/' + name)); i += 1) {
      const suffix = '-' + hash(id + ':' + i).slice(0, 8);
      name = filename(base, 77 - suffix.length) + suffix;
    }
    const relative = GROUPS[type] + '/' + name;
    paths.add(key(relative));
    const idKey = type + ':' + id;
    const path = relative + '.md';
    const prior = entries.get(key(path));
    const doc = { id, type, title, day, updated: updated ?? day, tags,
      path: prior?.id === idKey ? prior.path : path, lines: [], links: new Set() };
    docs.set(type + ':' + id, doc);
    return doc;
  }
  function textWithImages(text) {
    return String(text ?? '').replace(/\]\(\/api\/attachments\/([a-f0-9]{64}\.(?:png|jpg|webp|gif))\)/g, (original, id) => {
      const entry = 'attachment:' + id;
      if (!docs.has(entry)) {
        const bytes = file(join(dataDir, 'attachments', id.slice(0, 2), id));
        if (!bytes || hash(bytes) !== id.slice(0, 64)) throw invalid('导出引用的图片已损坏。');
        docs.set(entry, { path: GROUPS.attachment + '/' + id, bytes });
      }
      return '](../' + GROUPS.attachment + '/' + id + ')';
    });
  }
  function dayDoc(day) {
    if (!config.include.days || !DAY.test(day)) return;
    return docs.get('days:' + day) ?? add('days', day, day, day, day);
  }
  function connect(doc, type, id) {
    const other = docs.get(type + ':' + id);
    if (!doc || !other || doc === other) return;
    doc.links.add(other.path);
    other.links.add(doc.path);
  }
  function appendDay(day, heading, render) {
    const doc = dayDoc(day);
    if (!doc) return;
    doc.sections ??= new Map();
    if (!doc.sections.has(heading)) doc.sections.set(heading, []);
    doc.sections.get(heading).push(render(doc));
  }

  const history = new Map();
  for (const item of data.history) history.set(item.task_id, item);
  if (config.include.notes) for (const row of data.notes) {
    const last = history.get(row.id);
    const day = last?.day === '1970-01-01' || !last ? dateOf(row.created_at) : last.day;
    const stem = filename(row.title, 70) + '-' + filename(row.id.slice(0, 6), 6);
    add('notes', row.id, row.title, stem, day, timestamp(last?.updated_at ?? row.created_at)).lines.push(textWithImages(row.body));
  }
  if (config.include.projects) for (const row of data.projects) {
    const doc = add('projects', row.id, row.title, row.title, row.start_day,
      timestamp(Math.max(row.created_at, row.completed_at ?? 0, row.archived_at ?? 0)));
    doc.lines.push(row.goal, '', '开始：' + row.start_day, '截止：' + (row.due_day ?? '无'),
      '状态：' + (row.archived_at ? '已归档' : row.completed_at ? '已完成' : '进行中'), '', '## 每日进展', '');
  }
  if (config.include.harvests) for (const row of data.harvests) {
    const tags = JSON.parse(row.tags).filter(tag => typeof tag === 'string');
    const doc = add('harvests', row.id, row.title, row.day + '-' + row.title, row.day, timestamp(row.updated_at), tags);
    doc.lines.push(textWithImages(row.conclusion), '', '## 要点', '',
      ...JSON.parse(row.points).map(point => '- ' + oneLine(point)), '', '## 待办', '',
      ...JSON.parse(row.todos).map(todo => '- [ ] ' + oneLine(todo?.text)), '',
      row.source_url ? '来源：' + oneLine(row.source_url) : '',
      ...JSON.parse(row.images).filter(id => typeof id === 'string' && IMAGE.test(id))
        .map(id => textWithImages('![收获图片](/api/attachments/' + id + ')')));
  }
  for (const row of data.blocks) appendDay(dateOf(row.starts_at), '时间块', doc => {
    connect(doc, 'notes', row.task_id);
    connect(doc, 'projects', row.project_id);
    return '- ' + hhmm(row.starts_at) + '–' + hhmm(row.starts_at + row.planned_seconds)
      + ' · ' + oneLine(row.title) + ' · ' + minutes(row.planned_seconds) + ' 分钟';
  });
  for (const row of data.focus) appendDay(dateOf(row.started_at), '专注时间线', doc => {
    connect(doc, 'notes', row.task_id);
    connect(doc, 'projects', row.project_id);
    return '- ' + hhmm(row.started_at) + ' · ' + oneLine(row.title ?? '自由专注') + ' · '
      + minutes(row.elapsed_seconds) + ' 分钟 · ' + ({ finished: '已结束', running: '进行中', paused: '已暂停' })[row.state];
  });
  for (const row of data.hands) appendDay(row.study_date, '手记', doc => {
    connect(doc, 'notes', row.task_id);
    return [row.title || (row.position == null ? row.day_title : ''), textWithImages(row.body)].filter(Boolean).join('\n\n');
  });
  for (const row of data.reviews) appendDay(row.day, '当天回顾', () => textWithImages(row.text));
  for (const row of data.history) if (row.day !== '1970-01-01') connect(dayDoc(row.day), 'notes', row.task_id);
  for (const row of data.notes) connect(docs.get('notes:' + row.id), 'projects', row.project_id);
  for (const row of data.harvests) {
    const doc = docs.get('harvests:' + row.id);
    connect(dayDoc(row.day), 'harvests', row.id);
    connect(doc, 'notes', row.task_id);
    connect(doc, 'projects', row.project_id);
  }
  for (const row of data.logs) {
    const doc = docs.get('projects:' + row.project_id);
    if (doc) {
      doc.updated = [doc.updated, timestamp(row.updated_at)].sort().at(-1);
      doc.lines.push('### ' + row.day, '', row.progress == null ? '' : '进度：' + row.progress + '%',
        textWithImages(row.note), '');
    }
    connect(dayDoc(row.day), 'projects', row.project_id);
  }
  for (const doc of docs.values()) {
    if (doc.bytes) continue;
    for (const [title, lines] of doc.sections ?? []) doc.lines.push('## ' + title, '', ...lines, '');
    if (doc.links.size) doc.lines.push('', '## 关联', '',
      ...[...doc.links].sort().map(path => '- [[' + config.folder + '/' + path.slice(0, -3) + ']]'));
    const frontmatter = { workbench_id: doc.id, type: doc.type, day: doc.day, updated: doc.updated, tags: doc.tags };
    doc.bytes = Buffer.from(['---', ...Object.entries(frontmatter).map(([name, value]) => name + ': ' + JSON.stringify(value)),
      '---', '', '# ' + oneLine(doc.title), '', ...doc.lines].join('\n').trimEnd() + '\n');
  }
  return docs;
}

function manifestEntries(bytes) {
  if (!bytes) return new Map();
  const value = JSON.parse(bytes);
  if (value?.version !== 1 || !Array.isArray(value.entries)) throw invalid('导出清单格式错误。');
  const paths = new Map();
  for (const row of value.entries) {
    const [group, name, ...rest] = typeof row?.path === 'string' ? row.path.split('/') : [];
    const kind = typeof row?.id === 'string' ? row.id.split(':', 1)[0] : '';
    if (!name || rest.length || !Object.hasOwn(GROUPS, kind) || group !== GROUPS[kind]
      || filename(name) !== name || !(kind === 'attachment' ? IMAGE.test(name) && row.id === 'attachment:' + name
        : name.endsWith('.md') && name.length > 3)
      || !/^[a-f0-9]{64}$/.test(row.hash) || paths.has(key(row.path))) throw invalid('导出清单包含无效路径或条目。');
    paths.set(key(row.path), row);
  }
  return paths;
}

function owns(row, contents) {
  if (!row || hash(contents) !== row.hash) return false;
  if (row.id.startsWith('attachment:')) return row.hash === row.id.slice(11, 75);
  const split = row.id.indexOf(':');
  const header = '---\nworkbench_id: ' + JSON.stringify(row.id.slice(split + 1))
    + '\ntype: ' + JSON.stringify(row.id.slice(0, split)) + '\n';
  return contents.subarray(0, Buffer.byteLength(header)).toString() === header;
}

function exportFiles(output, wb, config, dataDir, status, check) {
  const manifest = join(output, '.workbench-export.json');
  let saved = file(manifest);
  const entries = manifestEntries(saved);
  const docs = buildDocuments(wb, config, dataDir, entries);
  const wanted = new Set([...docs.values()].map(doc => key(doc.path)));
  const blocked = new Set();
  const deleted = [];
  function persist() {
    const next = Buffer.from(JSON.stringify({ version: 1, entries: [...entries.values()] }, null, 2) + '\n');
    check();
    publish(manifest, next, saved);
    saved = next;
  }
  // 先验证所有目标与旧记录，避免发现联接点前已经改了其他笔记。
  for (const relative of new Set([...docs.values()].map(doc => doc.path).concat([...entries.values()].map(row => row.path)))) {
    const target = join(output, ...relative.split('/'));
    if (info(dirname(target))) plainFile(target);
  }
  for (const [id, doc] of docs) {
    check();
    const pathKey = key(doc.path);
    const previous = entries.get(pathKey);
    const target = join(output, ...doc.path.split('/'));
    directory(dirname(target), true);
    const existing = plainFile(target);
    const current = existing && previous?.id === id ? file(target) : null;
    const digest = hash(doc.bytes);
    if ((previous && previous.id !== id) || (existing && (!current || !owns(previous, current)))) {
      status.conflicts.push(doc.path);
      blocked.add(id);
      continue;
    }
    if (current && previous.hash === digest) {
      status.unchanged += 1;
      continue;
    }
    try {
      publish(target, doc.bytes, current);
    } catch (error) {
      if (error.code !== 'EEXIST' && error.reason !== 'conflict') throw error;
      status.conflicts.push(doc.path);
      blocked.add(id);
      continue;
    }
    entries.set(pathKey, { id, path: doc.path, hash: digest });
    persist();
    status.written += 1;
  }
  for (const [pathKey, row] of entries) {
    if (wanted.has(pathKey) || blocked.has(row.id)) continue;
    check();
    const target = join(output, ...row.path.split('/'));
    const current = info(dirname(target)) ? file(target) : null;
    if (current && !owns(row, current)) {
      status.conflicts.push(row.path);
      continue;
    }
    if (current) {
      if (!file(target)?.equals(current)) {
        status.conflicts.push(row.path);
        continue;
      }
      unlinkSync(target);
    }
    deleted.push(pathKey);
  }
  for (const pathKey of deleted) entries.delete(pathKey);
  if (deleted.length || !saved) persist();
}

export function createObsidian({ wb, dataDir, revision, debounceMs = 60_000, pollMs = 1000 }) {
  const configPath = dataDir && join(dataDir, 'obsidian.json');
  const statusPath = dataDir && join(dataDir, 'obsidian-status.json');
  function read(path) {
    if (!path || !info(path)) return null;
    return JSON.parse(file(path));
  }
  const config = () => settings(read(configPath) ?? {});
  let timer;
  let observed = revision();
  function run(automatic = false) {
    const cfg = config();
    if (!cfg.enabled || !cfg.vaultPath) throw invalid('请先保存并启用 Obsidian 导出。');
    if (automatic && !cfg.auto) return;
    const status = { ...initialStatus(), lastExportAt: new Date().toISOString() };
    try {
      const output = validateVault(cfg);
      directory(output, true);
      withLock(output, check => {
        exportFiles(output, wb, cfg, dataDir, status, check);
        publish(statusPath, JSON.stringify(status));
      });
    } catch (error) {
      status.error = error.message;
      if (error.reason !== 'conflict') publish(statusPath, JSON.stringify(status));
      throw error;
    }
    return { config: cfg, status };
  }
  const poll = setInterval(() => {
    try {
      const cfg = config();
      if (!cfg.enabled || !cfg.auto) {
        clearTimeout(timer);
        return;
      }
      const latest = revision();
      if (latest === observed) return;
      observed = latest;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try { run(true); } catch { /* 状态已记录；下次变更再试。 */ }
      }, debounceMs).unref();
    } catch { /* 本地配置或数据库暂时不可用，下次轮询再试。 */ }
  }, pollMs).unref();
  return {
    get: () => ({ config: config(), status: read(statusPath) ?? initialStatus() }),
    configure(value) {
      if (!configPath) throw invalid('此服务没有数据文件夹。');
      const cfg = settings(value);
      if (cfg.vaultPath) validateVault(cfg);
      publish(configPath, JSON.stringify(cfg, null, 2) + '\n');
      if (!cfg.enabled || !cfg.auto) clearTimeout(timer);
      return this.get();
    },
    run,
    close() {
      clearInterval(poll);
      clearTimeout(timer);
    },
  };
}

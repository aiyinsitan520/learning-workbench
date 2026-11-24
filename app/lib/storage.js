import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkbenchError } from './db.js';

const DB_NAME = 'workbench.db';
const BACKUP_NAME = /^workbench-\d{8}T\d{6}\.db$/;
const ABOUT = 'workbench.db 保存任务、计划、专注和笔记。\nattachments/ 保存附件，backups/ 保存数据库备份。\n程序运行时请勿手动修改或移动数据库及其 WAL 文件。\n';

export function defaultConfigRoot() {
  const home = homedir();
  const parent = process.platform === 'win32' ? process.env.APPDATA || join(home, 'AppData', 'Roaming')
    : process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : join(home, '.config');
  return join(parent, 'learning-workbench');
}

export function resolveStorage({ webDir, desktopDir = null, edition = 'source', dbPath,
  configRoot = process.env.WORKBENCH_CONFIG_ROOT || defaultConfigRoot() }) {
  const configPath = resolve(configRoot, 'location.json');
  const defaults = { web: resolve(webDir), desktop: desktopDir === null ? null : resolve(desktopDir) };
  const override = dbPath ?? process.env.WORKBENCH_DB;
  if (override !== undefined) {
    const path = override === ':memory:' ? override : resolve(override);
    return { dataDir: path === ':memory:' ? '' : dirname(path), dbPath: path,
      source: 'env', configPath, edition, remote: false, defaults, shared: false };
  }
  let dataDir = edition === 'desktop' ? defaults.desktop : defaults.web;
  let source = 'default';
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (config?.version !== 1 || typeof config.dataDir !== 'string' || !isAbsolute(config.dataDir)) {
      throw new Error('location.json 必须包含版本 1 和绝对数据路径');
    }
    dataDir = resolve(config.dataDir);
    source = 'config';
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`无法读取数据位置 ${configPath}：${error.message}`);
  }
  return { dataDir, dbPath: join(dataDir, DB_NAME), source, configPath, edition, remote: false,
    defaults, shared: source === 'config' || (defaults.desktop !== null && samePath(defaults.web, defaults.desktop)) };
}

// 环境覆盖用于脚本和测试，不在这些调用方的数据库旁自动创建目录。
export function prepareStorage(location) {
  if (location.source !== 'env') ensureLayout(location.dataDir);
}

function ensureLayout(dir, report = () => {}) {
  mkdirSync(dir, { recursive: true });
  for (const name of ['attachments', 'backups']) {
    const path = join(dir, name);
    if (ensureSubdir(path)) report(path, true);
  }
  const about = join(dir, '关于这个文件夹.txt');
  try {
    writeFileSync(about, ABOUT, { flag: 'wx' });
    report(about, false);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

function ensureSubdir(path) {
  try {
    mkdirSync(path);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!lstatSync(path).isDirectory()) throw invalid(`${path} 不是普通文件夹`);
    return false;
  }
}

function canonicalPath(path) {
  try { return realpathSync(path); } catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return resolve(canonicalPath(dirname(path)), relative(dirname(path), path));
  }
}

function samePath(a, b) {
  return relative(a, b) === '';
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
}

function invalid(message) { return new WorkbenchError('invalid', message); }
function conflict(message) { return new WorkbenchError('conflict', message); }

function userVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version);
}

function inspectDatabase(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const version = userVersion(db);
    if (version < 1 || !db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'").get()) {
      throw invalid('目标文件不是学习工作台数据库');
    }
    return version;
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw invalid(`无法打开目标数据库：${error.message}`);
  } finally {
    db?.close();
  }
}

function atomicLocation(path, dataDir) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, dataDir }), { flag: 'wx' });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function list(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function copyAttachments(from, to, created) {
  if (ensureSubdir(to)) created.push([to, true]);
  for (const entry of list(from)) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyAttachments(source, target, created);
    else if (entry.isFile()) {
      try { copyFileSync(source, target, constants.COPYFILE_EXCL); } catch (error) {
        if (error.code === 'EEXIST') throw conflict(`目标已有同名附件：${entry.name}`);
        throw error;
      }
      created.push([target, false]);
    } else throw invalid(`无法复制链接或特殊附件：${entry.name}`);
  }
}

function attachmentStats(dir) {
  let attachmentsBytes = 0;
  let attachmentCount = 0;
  for (const entry of list(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = attachmentStats(path);
      attachmentsBytes += nested.attachmentsBytes;
      attachmentCount += nested.attachmentCount;
    } else if (entry.isFile()) {
      const size = statSync(path, { throwIfNoEntry: false })?.size;
      if (size === undefined) continue;
      attachmentsBytes += size;
      attachmentCount++;
    }
  }
  return { attachmentsBytes, attachmentCount };
}

function listBackups(dir) {
  return list(dir).filter(entry => entry.isFile() && BACKUP_NAME.test(entry.name))
    .map(({ name }) => {
      const info = statSync(join(dir, name), { throwIfNoEntry: false });
      return info && { name, bytes: info.size, createdAt: Math.floor(info.birthtimeMs / 1000) };
    }).filter(Boolean).sort((a, b) => b.name.localeCompare(a.name));
}

function launchFolder(path) {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolve, reject) => {
    const child = spawn(command, [path], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export function createStorage(location, db, { protectedDirs, openFolder = launchFolder } = {}) {
  const { dataDir, dbPath, source, configPath } = location;
  const dirs = { data: dataDir, backups: join(dataDir, 'backups'), attachments: join(dataDir, 'attachments') };

  return {
    info() {
      return { ...location,
        dbBytes: dataDir ? statSync(dbPath, { throwIfNoEntry: false })?.size ?? 0 : 0,
        ...(dataDir ? attachmentStats(dirs.attachments) : { attachmentsBytes: 0, attachmentCount: 0 }),
        backups: dataDir ? listBackups(dirs.backups) : [],
      };
    },
    backup() {
      if (!dataDir) throw conflict('内存数据库没有数据文件夹');
      ensureSubdir(dirs.backups);
      const name = `workbench-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}.db`;
      const destination = join(dirs.backups, name);
      const stage = mkdtempSync(join(dirs.backups, '.backup-'));
      const snapshot = join(stage, DB_NAME);
      try {
        db.prepare('VACUUM INTO ?').run(snapshot);
        try { copyFileSync(snapshot, destination, constants.COPYFILE_EXCL); } catch (error) {
          if (error.code === 'EEXIST') throw conflict('这一秒已生成备份，请稍后重试');
          throw error;
        }
      } finally {
        rmSync(snapshot, { force: true });
        rmdirSync(stage);
      }
      for (const old of listBackups(dirs.backups).slice(20)) rmSync(join(dirs.backups, old.name), { force: true });
      return { name };
    },
    async reveal(target) {
      if (typeof target !== 'string' || !Object.hasOwn(dirs, target)) throw invalid('未知的数据文件夹');
      if (!dataDir) throw conflict('内存数据库没有数据文件夹');
      if (target !== 'data') ensureSubdir(dirs[target]);
      await openFolder(dirs[target]);
    },
    relocate(input, mode) {
      if (source === 'env') throw conflict('当前数据库由 WORKBENCH_DB 指定，不能更改数据位置');
      if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0') || !['copy', 'use'].includes(mode)) {
        throw invalid('请选择绝对路径，迁移方式须为 copy 或 use');
      }
      let target;
      let stage;
      const created = [];
      try {
        const requested = resolve(input);
        target = canonicalPath(requested);
        if (protectedDirs.some(dir => inside(resolve(dir), requested) || inside(canonicalPath(dir), target))) {
          throw invalid('数据文件夹不能放在程序目录内');
        }
        const current = canonicalPath(dataDir);
        if (samePath(current, target)) throw conflict('已经在使用这个文件夹');
        if (inside(join(current, 'attachments'), target) || inside(join(current, 'backups'), target)) {
          throw invalid('请选择当前附件和备份目录之外的位置');
        }
        const nextDb = join(target, DB_NAME);
        const targetType = lstatSync(nextDb, { throwIfNoEntry: false });
        if (mode === 'copy' && targetType) throw conflict('目标已存在 workbench.db，请选择使用已有资料库');
        if (mode === 'use' && !targetType?.isFile()) throw invalid('目标文件夹没有可用的 workbench.db');

        mkdirSync(target, { recursive: true });
        stage = mkdtempSync(join(target, '.relocate-'));
        if (mode === 'use') {
          if (inspectDatabase(nextDb) > userVersion(db)) throw conflict('目标数据库版本较新，请先升级程序');
        } else {
          const snapshot = join(stage, DB_NAME);
          db.prepare('VACUUM INTO ?').run(snapshot);
          if (inspectDatabase(snapshot) !== userVersion(db)) throw new Error('复制后的数据库版本不一致');
          copyAttachments(dirs.attachments, join(target, 'attachments'), created);
          try { copyFileSync(snapshot, nextDb, constants.COPYFILE_EXCL); } catch (error) {
            if (error.code === 'EEXIST') throw conflict('目标已存在 workbench.db，请选择使用已有资料库');
            throw error;
          }
          created.push([nextDb, false]);
        }
        ensureLayout(target, (path, directory) => created.push([path, directory]));
        atomicLocation(configPath, target);
        return { restartRequired: true, dataDir: target };
      } catch (error) {
        for (const [path, directory] of created.reverse()) {
          try { if (directory) rmdirSync(path); else unlinkSync(path); } catch { /* 不移除仍有内容的目录 */ }
        }
        if (error instanceof WorkbenchError) throw error;
        if (['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'EEXIST'].includes(error.code)) {
          throw invalid('目标数据文件夹无法创建或写入');
        }
        throw error;
      } finally {
        if (stage) rmSync(stage, { recursive: true, force: true });
      }
    },
  };
}

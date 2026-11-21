import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../lib/db.js';
import { contextSnapshot } from '../lib/digest.js';
import { contextMarkdown } from '../lib/context-md.js';
import { isValidDate } from '../lib/time.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const data = join(root, 'app', 'data');

async function serviceSnapshot(days, notes, fetchImpl) {
  const address = new URL('http://127.0.0.1:7321/api/context');
  address.searchParams.set('days', days);
  if (notes) address.searchParams.set('notes', '1');
  const request = (url) => fetchImpl(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  let response;
  try { response = await request(address); } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError') return null;
    throw error;
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`本机数据接口请求失败（HTTP ${response.status}）`);
  const { ok, ...snapshot } = await response.json();
  if (!ok || snapshot.format !== 'learning-space-ai-context' || !isValidDate(snapshot.range?.to)) {
    throw new Error('本机数据接口返回了无法识别的快照');
  }
  // 固定同一截止日，确保跨过北京时间午夜时两个文件仍使用相同的日期范围。
  address.searchParams.set('end', snapshot.range.to);
  address.searchParams.set('format', 'md');
  const markdown = await request(address);
  if (!markdown.ok) throw new Error(`本机 Markdown 接口请求失败（HTTP ${markdown.status}）`);
  return { snapshot, markdown: await markdown.text() };
}

async function offlineSnapshot(source, days, notes) {
  const temp = await mkdtemp(join(tmpdir(), 'workbench-export-'));
  const copy = join(temp, 'workbench.db');
  try {
    const reader = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
    try {
      reader.prepare('VACUUM INTO ?').run(copy);
    } finally {
      reader.close();
    }
    const wb = openDatabase(copy, { timeZone: process.env.WORKBENCH_TZ || 'Asia/Shanghai' });
    try {
      const snapshot = contextSnapshot(wb, { days, includeNotes: notes });
      return { snapshot, markdown: contextMarkdown(snapshot) };
    } finally {
      wb.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function exportAi({ days = 30, notes = false, out = join(data, 'ai-export'), db, fetchImpl = fetch } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 120) throw new Error('--days 必须是 1 到 120 之间的整数');
  const source = resolve(db ?? join(data, 'workbench.db'));
  const online = db ? null : await serviceSnapshot(days, notes, fetchImpl);
  const { snapshot, markdown } = online ?? await offlineSnapshot(source, days, notes);
  const stem = `工作台数据-${snapshot.range.to}`;
  const paths = ['.json', '.md'].map((ext) => resolve(out, stem + ext));
  paths.push(resolve(out, 'README.md'));
  const directory = dirname(paths[0]);
  await mkdir(directory, { recursive: true });
  const destination = await realpath(directory);
  const physicalSource = await realpath(source).catch((error) => {
    if (error.code === 'ENOENT') return source;
    throw error;
  });
  if (paths.some((path) =>
    [path, join(destination, basename(path))].some((candidate) => candidate.toLowerCase() === physicalSource.toLowerCase())
    || path.toLowerCase() === source.toLowerCase())) {
    throw new Error('输出文件与源数据库路径相同');
  }
  const temp = await mkdtemp(join(directory, '.ai-export-'));
  try {
    const contents = [JSON.stringify(snapshot, null, 2) + '\n', markdown,
      await readFile(join(root, 'docs', 'DATA_FOR_AI.md'), 'utf8')];
    for (const [index, path] of paths.entries()) await writeFile(join(temp, basename(path)), contents[index], 'utf8');
    for (const path of paths) await rename(join(temp, basename(path)), path);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      days: { type: 'string', default: '30' },
      notes: { type: 'boolean', default: false },
      out: { type: 'string' },
      db: { type: 'string' },
    } });
    for (const path of await exportAi({ ...values, days: Number(values.days) })) console.log(path);
  } catch (error) {
    console.error('导出失败：' + error.message);
    process.exitCode = 1;
  }
}

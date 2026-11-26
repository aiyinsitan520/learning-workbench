import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const IMAGE_LIMIT = 10 * 1024 * 1024;
const ID = /^[0-9a-f]{64}\.(png|jpg|webp|gif)$/;
const FORMATS = {
  'image/png': { ext: 'png', matches: bytes => bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) },
  'image/jpeg': { ext: 'jpg', matches: bytes => bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) },
  'image/webp': { ext: 'webp', matches: bytes => bytes.toString('latin1', 0, 4) === 'RIFF'
    && bytes.toString('latin1', 8, 12) === 'WEBP' },
  'image/gif': { ext: 'gif', matches: bytes => ['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6)) },
};

export function detectImageType(bytes) {
  return Object.keys(FORMATS).find(type => FORMATS[type].matches(bytes));
}

export async function uploadAttachment(req, dataDir) {
  const type = req.headers['content-type']?.toLowerCase();
  const format = Object.hasOwn(FORMATS, type) ? FORMATS[type] : null;
  if (!format) return { status: 415, body: { code: 'unsupported-media-type' } };
  if (!dataDir) return { status: 409, body: { code: 'no-data-folder' } };
  const tooLarge = { status: 413, body: { code: 'attachment-too-large' } };
  if (Number(req.headers['content-length']) > IMAGE_LIMIT) return tooLarge;
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > IMAGE_LIMIT) return tooLarge;
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  if (!format.matches(bytes)) return { status: 415, body: { code: 'invalid-image' } };
  return storeAttachment(bytes, type, dataDir);
}

export async function storeAttachment(bytes, type, dataDir) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const id = hash + '.' + FORMATS[type].ext;
  const folder = join(dataDir, 'attachments', hash.slice(0, 2));
  const destination = join(folder, id);
  const result = { status: 200, body: { id, url: '/api/attachments/' + id, bytes: bytes.length, type } };
  try {
    if ((await stat(destination)).isFile()) return result;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(folder, { recursive: true });
  const temp = join(folder, '.' + randomUUID() + '.tmp');
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    // 同目录原子发布；并发写入相同哈希时，两份内容完全相同。
    try {
      await rename(temp, destination);
    } catch (error) {
      // Windows 上另一个进程可能刚发布了同一张图片，目标文件暂时被占用。
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)
        || !(await stat(destination)).isFile()) throw error;
    }
  } finally {
    await unlink(temp).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return result;
}

export async function readAttachment(dataDir, id) {
  const match = ID.exec(id);
  if (!match || match[0] !== id) return { status: 400, body: { code: 'invalid-attachment-id' } };
  if (!dataDir) return { status: 404, body: { code: 'attachment-not-found' } };
  try {
    const bytes = await readFile(join(dataDir, 'attachments', id.slice(0, 2), id));
    const type = Object.keys(FORMATS).find(key => FORMATS[key].ext === match[1]);
    return { bytes, type };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 404, body: { code: 'attachment-not-found' } };
    throw error;
  }
}

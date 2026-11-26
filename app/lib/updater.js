// 桌面版自动更新（参考贾维喵管家的 Tauri updater 流程，零依赖实现）：
//   检查：读 GitHub Release 里的 latest.json 和 latest.json.sig，先验 Ed25519 签名，再核对格式、仓库、版本和本平台的包；
//   下载：只从本仓库对应版本的 Release 下载，限制大小，边下边算 SHA-256，全部对上才算「可以安装」；
//   安装：必须用户确认；由注入的 installer 完成（桌面版：备份资料 → 解压 → 退出 → 替换 → 重启）。
// 检查只提示。源码运行确认后交给 sourceUpdate 备份并快进。
// 网络请求只取公开的发布文件，不带任何本机数据。

import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';

export const MANIFEST_FORMAT = 'learning-workbench-update';
export const MAX_PACKAGE_BYTES = 400 * 1024 * 1024;
export const FIRST_CHECK_DELAY_MS = 60 * 1000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MANIFEST_TIMEOUT_MS = 20 * 1000;
const STALL_TIMEOUT_MS = 60 * 1000;
const RETRY_DELAYS_MS = [1000, 3000];

export class UpdateError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

const VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/;

/** 比较 x.y.z 版本：a<b 返回 -1，相等 0，a>b 返回 1。不接受预发布后缀。 */
export function compareVersions(a, b) {
  const pa = VERSION_RE.exec(String(a));
  const pb = VERSION_RE.exec(String(b));
  if (!pa || !pb) throw new UpdateError('bad-version', `版本号格式不对：${!pa ? a : b}`);
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** 平台键，和发布清单 packages 的键一致：win32-x64、darwin-arm64、darwin-x64。 */
export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/** 用 Ed25519 公钥验证清单原文的签名（base64）。公钥不是 Ed25519 一律不通过。 */
export function verifyManifest(text, signature, publicKeyPem) {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const sig = Buffer.from(String(signature).trim(), 'base64');
    if (sig.length !== 64) return false;
    return verify(null, Buffer.from(text, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/** 解析已验签的清单，取出本平台的包；任何一项对不上都拒绝。 */
export function parseManifest(text, { repo, platform, downloadBase = `https://github.com/${repo}/releases/download/` }) {
  let m;
  try { m = JSON.parse(text); } catch { throw new UpdateError('bad-manifest', '更新清单不是合法 JSON'); }
  if (m?.format !== MANIFEST_FORMAT) throw new UpdateError('bad-manifest', '不是学习工作台的更新清单');
  if (m.repo !== repo) throw new UpdateError('bad-manifest', '更新清单来自其他仓库');
  if (!VERSION_RE.test(String(m.version)) || m.tag !== `v${m.version}`) {
    throw new UpdateError('bad-manifest', '更新清单的版本号不对');
  }
  const pkg = m.packages?.[platform];
  const latest = {
    version: m.version,
    notes: typeof m.notes === 'string' ? m.notes.slice(0, 4000) : '',
    publishedAt: typeof m.publishedAt === 'string' ? m.publishedAt : null,
    package: null,
  };
  if (!pkg) return latest; // 新版没有本平台的包：照样报告新版本，只是不能自动更新
  const prefix = `${downloadBase}v${m.version}/`;
  if (typeof pkg.name !== 'string' || !/^[\w.-]{1,120}$/.test(pkg.name) || pkg.url !== prefix + pkg.name) {
    throw new UpdateError('bad-manifest', '更新包地址不在本仓库这一版的发布里');
  }
  if (!Number.isInteger(pkg.size) || pkg.size <= 0 || pkg.size > MAX_PACKAGE_BYTES) {
    throw new UpdateError('bad-manifest', '更新包大小不合理');
  }
  if (typeof pkg.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pkg.sha256)) {
    throw new UpdateError('bad-manifest', '更新包缺少 SHA-256');
  }
  latest.package = { name: pkg.name, url: pkg.url, size: pkg.size, sha256: pkg.sha256 };
  return latest;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} o
 * @param {string} o.version 当前版本
 * @param {{repo,manifestUrl,releasesUrl,publicKey}} o.config 发布源（app/lib/update-config.js）
 * @param {string|null} o.dataDir 放下载缓存和设置的目录；null 时不能下载
 * @param {{mode: 'restart'|'open'|null, reason?: string}} o.install 本机能怎样安装
 * @param {(job) => Promise<object>} [o.installer] 真正执行安装的函数（桌面版注入）
 * @param {string} [o.edition] 'desktop' | 'source'，只用于界面文案
 */
export function createUpdater({
  version, config, dataDir = null, install = { mode: null, reason: '' }, installer = null,
  platform = platformKey(), fetch: fetchImpl = fetch, edition = 'source', autoCheckDefault = true,
  retryDelays = RETRY_DELAYS_MS, now = () => Date.now(),
  sourceUpdate = null,
}) {
  const settingsPath = dataDir ? join(dataDir, 'update-settings.json') : null;
  const downloadDir = dataDir ? join(dataDir, 'updates') : null;
  const state = {
    current: version,
    edition,
    platform,
    status: 'idle', // idle | checking | latest | available | downloading | ready | installing | error
    latest: null,
    progress: null,
    error: null,
    checkedAt: null,
    autoCheck: autoCheckDefault,
    signed: Boolean(config.publicKey),
    install: { mode: install.mode ?? null, reason: install.reason ?? '' },
    releasesUrl: config.releasesUrl,
    justUpdated: null,
  };
  let verified = null; // 最近一次验签通过的 latest（含 package）
  let readyFile = null;
  let task = null;
  let timers = [];
  let schedule = null;
  let preferenceDir = dataDir;
  let preferenceWrites = Promise.resolve();
  let onUpdate = () => {};

  async function refreshPreference() {
    state.reminder = null;
    if (!preferenceDir || !verified) return;
    try {
      const saved = JSON.parse(await readFile(join(preferenceDir, 'update-prefs.json'), 'utf8'));
      if (saved.version === verified.version && (saved.action === 'skip' ||
        (saved.action === 'later' && saved.until > now()))) state.reminder = saved;
    } catch { /* 没有有效的提醒设置 */ }
  }

  const setError = (err, status = 'error') => {
    state.status = status;
    state.error = { code: err.code ?? 'error', message: err.message ?? String(err) };
  };

  async function fetchText(url, { notFound }) {
    let lastError;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      if (attempt) await sleep(retryDelays[attempt - 1]);
      let res;
      try {
        res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
          headers: { accept: 'application/octet-stream, application/json, text/plain' } });
      } catch (err) {
        lastError = new UpdateError('network', `连不上 GitHub：${err.message}`, { retryable: true });
        continue;
      }
      if (res.status === 404) throw new UpdateError('no-manifest', notFound);
      if (res.status >= 500 || res.status === 429) {
        lastError = new UpdateError('network', `GitHub 暂时不可用（HTTP ${res.status}）`, { retryable: true });
        continue;
      }
      if (!res.ok) throw new UpdateError('network', `读取更新信息失败（HTTP ${res.status}）`);
      const text = await res.text();
      if (text.length > 256 * 1024) throw new UpdateError('bad-manifest', '更新清单过大');
      return text;
    }
    throw lastError;
  }

  async function existingReady(latest) {
    if (!downloadDir || !latest?.package) return null;
    const file = join(downloadDir, `${latest.version}-${latest.package.name}`);
    try {
      const info = await stat(file);
      if (info.size !== latest.package.size) return null;
      return (await sha256File(file)) === latest.package.sha256 ? file : null;
    } catch {
      return null;
    }
  }

  async function doCheck() {
    if (!config.publicKey) {
      throw new UpdateError('unsigned', '这个版本没有配置更新签名，不能自动更新；请到发布页手动下载新版。');
    }
    const text = await fetchText(config.manifestUrl, { notFound: '最新发布里没有更新清单，请到发布页查看。' });
    const signature = await fetchText(`${config.manifestUrl}.sig`, { notFound: '最新发布的更新清单没有签名，已拒绝。' });
    if (!verifyManifest(text, signature, config.publicKey)) {
      throw new UpdateError('bad-signature', '更新清单签名校验失败，已拒绝这个更新。');
    }
    const latest = parseManifest(text, { repo: config.repo, platform, downloadBase: config.downloadBase });
    state.checkedAt = Math.floor(now() / 1000);
    state.error = null;
    if (compareVersions(latest.version, version) <= 0) {
      verified = null;
      state.reminder = null;
      state.latest = { ...latest, package: latest.package && { name: latest.package.name, size: latest.package.size } };
      state.status = 'latest';
      return;
    }
    verified = latest;
    state.latest = { ...latest, package: latest.package && { name: latest.package.name, size: latest.package.size } };
    if (sourceUpdate) {
      const reasons = await sourceUpdate.preflight(latest.version);
      state.install = { mode: reasons.length ? null : 'source-git', reasons, reason: reasons.join(' ') };
    }
    readyFile = sourceUpdate ? null : await existingReady(latest);
    state.status = readyFile ? 'ready' : 'available';
    state.progress = readyFile ? { received: latest.package.size, total: latest.package.size } : null;
    await refreshPreference();
    onUpdate(latest.version);
  }

  async function downloadOnce(latest, file) {
    const part = `${file}.part`;
    const pkg = latest.package;
    const controller = new AbortController();
    let stall = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
    const out = createWriteStream(part);
    const hash = createHash('sha256');
    let received = 0;
    try {
      let res;
      try {
        res = await fetchImpl(pkg.url, { redirect: 'follow', signal: controller.signal });
      } catch (err) {
        throw new UpdateError('network', `下载失败：${err.message}`, { retryable: true });
      }
      if (!res.ok || !res.body) {
        throw new UpdateError('network', `下载失败（HTTP ${res.status}）`, { retryable: res.status >= 500 || res.status === 429 });
      }
      const declared = Number(res.headers.get('content-length'));
      if (declared && declared !== pkg.size) throw new UpdateError('size', '更新包大小和清单不一致，已停止下载。');
      state.progress = { received: 0, total: pkg.size };
      try {
        for await (const chunk of res.body) {
          clearTimeout(stall);
          stall = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
          received += chunk.length;
          if (received > pkg.size) throw new UpdateError('size', '更新包比清单写的大，已停止下载。');
          hash.update(chunk);
          if (!out.write(chunk)) await once(out, 'drain');
          state.progress = { received, total: pkg.size };
        }
      } catch (err) {
        if (err instanceof UpdateError) throw err;
        throw new UpdateError('network', `下载中断：${err.message}`, { retryable: true });
      }
      out.end();
      await once(out, 'close');
      if (received !== pkg.size) throw new UpdateError('size', '更新包没下完整。', { retryable: true });
      if (hash.digest('hex') !== pkg.sha256) throw new UpdateError('hash', '更新包 SHA-256 校验失败，已删除。');
      await rename(part, file);
      return file;
    } finally {
      clearTimeout(stall);
      if (!out.closed) {
        out.destroy();
        await once(out, 'close').catch(() => {});
      }
      await rm(part, { force: true }).catch(() => {});
    }
  }

  async function doDownload() {
    const latest = verified;
    await mkdir(downloadDir, { recursive: true });
    const file = join(downloadDir, `${latest.version}-${latest.package.name}`);
    let lastError;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      if (attempt) await sleep(retryDelays[attempt - 1]);
      try {
        readyFile = await downloadOnce(latest, file);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (!err.retryable) break;
      }
    }
    if (lastError) throw lastError;
    // 只保留这一版的包
    for (const name of await readdir(downloadDir)) {
      if (join(downloadDir, name) !== readyFile) await rm(join(downloadDir, name), { force: true, recursive: true });
    }
    state.status = 'ready';
    state.error = null;
  }

  function run(status, fn, onErrorStatus) {
    if (task) return task;
    const before = state.status;
    state.status = status;
    task = fn().catch((err) => {
      setError(err, typeof onErrorStatus === 'function' ? onErrorStatus(before) : onErrorStatus);
    }).finally(() => { task = null; });
    return task;
  }

  const api = {
    setPreferenceDirectory(dir) { preferenceDir = dir; },
    onUpdate(listener) { onUpdate = listener; },
    refreshPreference,

    async setReminder(action, version) {
      if (!['later', 'skip'].includes(action) || !preferenceDir || !verified || version !== verified.version) {
        throw new UpdateError('no-update', '版本已变化，请重新检查更新。');
      }
      const dir = preferenceDir;
      const path = join(dir, 'update-prefs.json');
      const temporary = path + '.' + randomUUID();
      const saved = { version, action };
      if (action === 'later') {
        const shanghaiOffset = 8 * 60 * 60 * 1000;
        const day = 24 * 60 * 60 * 1000;
        saved.until = (Math.floor((now() + shanghaiOffset) / day) + 1) * day - shanghaiOffset;
      }
      const write = preferenceWrites.then(async () => {
        await mkdir(dir, { recursive: true });
        try {
          await writeFile(temporary, JSON.stringify(saved));
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
        await refreshPreference();
      });
      preferenceWrites = write.catch(() => {});
      await write;
      onUpdate(version);
      return api.status();
    },

    status() {
      return structuredClone(state);
    },

    /** 检查新版本；结果在 status() 里。网络错误不会抛出。 */
    async check() {
      if (['downloading', 'installing'].includes(state.status)) return api.status();
      await run('checking', doCheck, 'error');
      return api.status();
    },

    /** 后台下载；立即返回，进度看 status().progress。 */
    download() {
      if (sourceUpdate) throw new UpdateError('cannot-download', '源码版请使用立即更新。');
      if (state.status === 'ready' || state.status === 'downloading') return api.status();
      if (!verified) throw new UpdateError('no-update', '没有可以下载的新版本，请先检查更新。');
      if (!verified.package) throw new UpdateError('no-package', '新版没有适合这台电脑的安装包，请到发布页查看。');
      if (!state.install.mode || !downloadDir) {
        throw new UpdateError('cannot-install', state.install.reason || '这里不能自动更新。');
      }
      void run('downloading', doDownload, 'error');
      return api.status();
    },

    /** 用户确认后安装。返回 installer 的结果（例如 { restarting: true }）。 */
    async install(expectedVersion) {
      if (sourceUpdate) {
        if (task || state.status === 'installing') throw new UpdateError('busy', '正在处理更新，请稍候。');
        if (!verified) throw new UpdateError('no-update', '请先检查更新。');
        if (expectedVersion !== undefined && expectedVersion !== verified.version) {
          throw new UpdateError('version-changed', '可用版本已变化，请重新确认。');
        }
        state.status = 'installing';
        state.error = null;
        try {
          return await sourceUpdate.install({ version: verified.version, from: version,
            onStep: (step) => { state.step = step; } });
        } catch (err) {
          setError(err, 'available');
          throw err;
        } finally {
          state.step = null;
        }
      }
      if (!state.install.mode || !installer) {
        throw new UpdateError('cannot-install', state.install.reason || '这里不能自动安装。');
      }
      if (state.status !== 'ready' || !readyFile || !verified) {
        throw new UpdateError('not-ready', '更新包还没下载并校验完成。');
      }
      // 安装前再校验一次：下载后文件可能被改过
      if ((await sha256File(readyFile)) !== verified.package.sha256) {
        readyFile = null;
        state.status = 'available';
        throw new UpdateError('hash', '已下载的更新包校验失败，请重新下载。');
      }
      state.status = 'installing';
      state.error = null;
      try {
        return await installer({ file: readyFile, version: verified.version, from: version, mode: state.install.mode });
      } catch (err) {
        state.status = 'ready';
        state.error = { code: 'install', message: `安装没有完成：${err.message}` };
        throw new UpdateError('install', state.error.message);
      } finally {
        if (state.status === 'installing' && state.install.mode === 'open') state.status = 'ready';
      }
    },

    async loadSettings() {
      if (!settingsPath) return;
      try {
        const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
        if (typeof saved.autoCheck === 'boolean') state.autoCheck = saved.autoCheck;
      } catch { /* 没有设置文件就用默认值 */ }
    },

    async setAutoCheck(value) {
      if (typeof value !== 'boolean') throw new UpdateError('invalid', 'autoCheck 必须为布尔值');
      state.autoCheck = value;
      if (settingsPath) {
        await mkdir(dataDir, { recursive: true });
        await writeFile(settingsPath, JSON.stringify({ autoCheck: state.autoCheck }));
      }
      if (schedule) api.startSchedule(schedule);
      return api.status();
    },

    /** 记下刚完成的更新（桌面版启动时根据 pending-update.json 设置）。 */
    markUpdated(info) {
      state.justUpdated = info;
    },

    /** 启动 1 分钟后检查一次，此后每 6 小时一次；只检查，不下载。 */
    startSchedule({ firstDelay = FIRST_CHECK_DELAY_MS, interval = CHECK_INTERVAL_MS } = {}) {
      api.stopSchedule();
      schedule = { firstDelay, interval };
      if (!state.autoCheck) return;
      const tick = () => { if (['idle', 'latest', 'error', 'available'].includes(state.status)) void api.check(); };
      const first = setTimeout(tick, firstDelay);
      const every = setInterval(tick, interval);
      first.unref?.();
      every.unref?.();
      timers = [first, every];
    },

    stopSchedule() {
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      timers = [];
      schedule = null;
    },

    /** 测试用：等当前的检查或下载结束。 */
    idle() {
      return task ?? Promise.resolve();
    },
  };
  return api;
}

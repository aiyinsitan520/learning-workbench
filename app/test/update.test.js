// 自动更新（app/lib/updater.js + /api/update + desktop/release-manifest.mjs）。
// 全部用测试生成的密钥和假网络：不访问 GitHub，不装任何东西，只用临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { compareVersions, createUpdater, parseManifest, verifyManifest, MANIFEST_FORMAT } from '../lib/updater.js';
import { UPDATE_CONFIG } from '../lib/update-config.js';
import { start, APP_VERSION } from '../server.js';
import { writeManifest } from '../../desktop/release-manifest.mjs';
import { createSourceUpdate } from '../lib/source-update.js';

const REPO = 'aiyinsitan520/learning-workbench';
const PLATFORM = 'win32-x64';
const keys = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv: privateKey };
};
const KEY = keys();
const OTHER = keys();
const config = (over = {}) => ({
  repo: REPO, manifestUrl: 'https://example.test/latest.json', releasesUrl: `https://github.com/${REPO}/releases`,
  publicKey: KEY.pub, ...over,
});
const PAYLOAD = Buffer.from('新版工作台安装包'.repeat(500));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function manifestFor(version, over = {}, pkgOver = {}) {
  const name = 'Learning-Workbench-Windows-x64.zip';
  return {
    format: MANIFEST_FORMAT, repo: REPO, version, tag: `v${version}`, publishedAt: '2026-11-23T00:00:00Z',
    notes: '· 自动更新', packages: { [PLATFORM]: {
      name, url: `https://github.com/${REPO}/releases/download/v${version}/${name}`,
      size: PAYLOAD.length, sha256: sha(PAYLOAD), ...pkgOver,
    } }, ...over,
  };
}

/** 假 GitHub：清单、签名、安装包；可改写任何一项模拟篡改或断网。 */
function fakeGithub({ manifest, key = KEY.priv, tamper, payload = PAYLOAD, failFirst = 0, status = {} }) {
  const text = JSON.stringify(manifest);
  const sig = sign(null, Buffer.from(text), key).toString('base64');
  const calls = [];
  let failures = failFirst;
  const fetch = async (url) => {
    calls.push(url);
    if (failures > 0) { failures -= 1; throw new Error('ECONNRESET'); }
    if (status[url]) return new Response('x', { status: status[url] });
    if (url.endsWith('latest.json')) return new Response(tamper ? tamper(text) : text);
    if (url.endsWith('latest.json.sig')) return new Response(sig);
    if (url.includes('/releases/download/')) {
      return new Response(payload, { headers: { 'content-length': String(payload.length) } });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, calls };
}

function makeUpdater(gh, over = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-update-'));
  const installed = [];
  const updater = createUpdater({
    version: '1.1.0', config: config(), dataDir, platform: PLATFORM, fetch: gh.fetch, edition: 'desktop',
    install: { mode: 'restart' }, installer: async (job) => { installed.push(job); return { restarting: true, message: 'ok' }; },
    retryDelays: [1, 1], ...over,
  });
  return { updater, dataDir, installed, done: () => rmSync(dataDir, { recursive: true, force: true }) };
}

test('版本比较：只认 x.y.z，按数字比', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.1.0', '1.1.0'), 0);
  assert.equal(compareVersions('0.9.0', '1.0.0'), -1);
  assert.throws(() => compareVersions('1.2.0-beta', '1.0.0'), /格式/);
});

test('清单：签名、仓库、标签和下载地址任何一项不对都拒绝', () => {
  const text = JSON.stringify(manifestFor('1.2.0'));
  const sig = sign(null, Buffer.from(text), KEY.priv).toString('base64');
  assert.equal(verifyManifest(text, sig, KEY.pub), true);
  assert.equal(verifyManifest(text.replace('1.2.0', '9.9.9'), sig, KEY.pub), false, '改了内容');
  assert.equal(verifyManifest(text, sig, OTHER.pub), false, '别的公钥');
  assert.equal(verifyManifest(text, 'AAAA', KEY.pub), false);
  const parse = (m) => parseManifest(JSON.stringify(m), { repo: REPO, platform: PLATFORM });
  assert.equal(parse(manifestFor('1.2.0')).package.size, PAYLOAD.length);
  assert.throws(() => parse(manifestFor('1.2.0', { repo: 'evil/repo' })), /其他仓库/);
  assert.throws(() => parse(manifestFor('1.2.0', { tag: 'v1.3.0' })), /版本号/);
  assert.throws(() => parse(manifestFor('1.2.0', {}, { url: 'https://evil.test/x.zip' })), /地址/);
  assert.throws(() => parse(manifestFor('1.2.0', {}, {
    url: 'https://github.com/someone/else/releases/download/v1.2.0/Learning-Workbench-Windows-x64.zip' })), /地址/);
  assert.throws(() => parse(manifestFor('1.2.0', {}, { size: 500 * 1024 * 1024 })), /大小/);
  assert.throws(() => parse(manifestFor('1.2.0', {}, { sha256: 'abc' })), /SHA-256/);
});

test('检查 → 下载 → 校验 → 确认安装：安装前再算一次 SHA-256', async () => {
  const gh = fakeGithub({ manifest: manifestFor('1.2.0') });
  const { updater, dataDir, installed, done } = makeUpdater(gh);
  try {
    await updater.check();
    let s = updater.status();
    assert.equal(s.status, 'available');
    assert.equal(s.latest.version, '1.2.0');
    assert.equal(s.latest.notes, '· 自动更新');
    assert.equal(s.latest.package.url, undefined, '状态里不暴露下载地址以外的内部字段');
    await assert.rejects(updater.install(), /还没下载/);
    updater.download();
    assert.equal(updater.status().status, 'downloading');
    await updater.idle();
    s = updater.status();
    assert.equal(s.status, 'ready', JSON.stringify(s.error));
    assert.deepEqual(s.progress, { received: PAYLOAD.length, total: PAYLOAD.length });
    const file = join(dataDir, 'updates', '1.2.0-Learning-Workbench-Windows-x64.zip');
    assert.deepEqual(readFileSync(file), PAYLOAD);
    const r = await updater.install();
    assert.equal(r.restarting, true);
    assert.deepEqual(installed.map((j) => [j.version, j.from, j.mode, j.file]), [['1.2.0', '1.1.0', 'restart', file]]);
    assert.equal(updater.status().status, 'installing', '桌面版随后退出，不再接受检查');
    // 程序重开（例如安装被取消）：已下载且校验通过的包直接算 ready，不重复下载
    const before = gh.calls.length;
    const reopened = createUpdater({ version: '1.1.0', config: config(), dataDir, platform: PLATFORM, fetch: gh.fetch,
      install: { mode: 'restart' }, installer: async () => ({}) });
    await reopened.check();
    assert.equal(reopened.status().status, 'ready');
    assert.equal(gh.calls.length - before, 2, '只取清单和签名');
  } finally { done(); }
});

test('已下载的包被改过：安装前拒绝，回到可下载', async () => {
  const gh = fakeGithub({ manifest: manifestFor('1.2.0') });
  const { updater, dataDir, installed, done } = makeUpdater(gh);
  try {
    await updater.check();
    updater.download();
    await updater.idle();
    writeFileSync(join(dataDir, 'updates', '1.2.0-Learning-Workbench-Windows-x64.zip'), 'tampered');
    await assert.rejects(updater.install(), /校验失败/);
    assert.equal(updater.status().status, 'available');
    assert.equal(installed.length, 0);
  } finally { done(); }
});

test('拒绝：篡改清单、错误密钥、同版本或旧版本', async () => {
  for (const [name, gh, expect] of [
    ['篡改', fakeGithub({ manifest: manifestFor('1.2.0'), tamper: (t) => t.replace('· 自动更新', '· 恶意') }), 'bad-signature'],
    ['别的私钥', fakeGithub({ manifest: manifestFor('1.2.0'), key: OTHER.priv }), 'bad-signature'],
  ]) {
    const { updater, done } = makeUpdater(gh);
    try {
      await updater.check();
      const s = updater.status();
      assert.equal(s.status, 'error', name);
      assert.equal(s.error.code, expect, name);
      assert.throws(() => updater.download(), /先检查/, `${name}：不能下载`);
    } finally { done(); }
  }
  for (const v of ['1.1.0', '1.0.9']) {
    const { updater, done } = makeUpdater(fakeGithub({ manifest: manifestFor(v) }));
    try {
      await updater.check();
      assert.equal(updater.status().status, 'latest', `${v} 不算新版本，不会回退`);
      assert.throws(() => updater.download(), /没有可以下载/);
    } finally { done(); }
  }
});

test('下载：SHA-256 不符或比清单大都会删掉，不会变成可安装', async () => {
  for (const [name, payload, msg] of [
    ['内容被换', Buffer.alloc(PAYLOAD.length, 7), /SHA-256/],
    ['更大', Buffer.concat([PAYLOAD, Buffer.from('x')]), /大小|大/],
  ]) {
    const { updater, dataDir, done } = makeUpdater(fakeGithub({ manifest: manifestFor('1.2.0'), payload }));
    try {
      await updater.check();
      updater.download();
      await updater.idle();
      const s = updater.status();
      assert.equal(s.status, 'error', name);
      assert.match(s.error.message, msg, name);
      assert.deepEqual(readdirSync(join(dataDir, 'updates')), [], `${name}：不留半截文件`);
    } finally { done(); }
  }
});

test('网络：临时断线自动重试；404 明确提示；没有公钥的版本不联网', async () => {
  const flaky = fakeGithub({ manifest: manifestFor('1.2.0'), failFirst: 2 });
  const a = makeUpdater(flaky);
  try {
    await a.updater.check();
    assert.equal(a.updater.status().status, 'available', '两次断线后第三次成功');
  } finally { a.done(); }

  const down = fakeGithub({ manifest: manifestFor('1.2.0'), failFirst: 99 });
  const b = makeUpdater(down);
  try {
    await b.updater.check();
    assert.deepEqual([b.updater.status().status, b.updater.status().error.code], ['error', 'network']);
  } finally { b.done(); }

  const missing = fakeGithub({ manifest: manifestFor('1.2.0'), status: { 'https://example.test/latest.json': 404 } });
  const c = makeUpdater(missing);
  try {
    await c.updater.check();
    assert.equal(c.updater.status().error.code, 'no-manifest');
  } finally { c.done(); }

  const quiet = fakeGithub({ manifest: manifestFor('1.2.0') });
  const d = makeUpdater(quiet, { config: config({ publicKey: null }) });
  try {
    await d.updater.check();
    assert.equal(d.updater.status().error.code, 'unsigned');
    assert.equal(quiet.calls.length, 0, '没有公钥就不去下载清单');
  } finally { d.done(); }
});

test('不能安装的环境：可以检查，不能下载和安装；设置会保存', async () => {
  const gh = fakeGithub({ manifest: manifestFor('1.2.0') });
  const { updater, dataDir, done } = makeUpdater(gh, { install: { mode: null, reason: '程序所在位置不能写入' }, installer: null });
  try {
    await updater.check();
    assert.equal(updater.status().status, 'available');
    assert.throws(() => updater.download(), /不能写入/);
    await assert.rejects(updater.install(), /不能写入/);
    await updater.setAutoCheck(false);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'update-settings.json'), 'utf8')), { autoCheck: false });
    const again = createUpdater({ version: '1.1.0', config: config(), dataDir, fetch: gh.fetch });
    await again.loadSettings();
    assert.equal(again.status().autoCheck, false);
  } finally { done(); }
});

test('定时检查：关掉自动检查就不排定时器；开着时按间隔检查', async () => {
  const gh = fakeGithub({ manifest: manifestFor('1.2.0') });
  const { updater, done } = makeUpdater(gh);
  try {
    await updater.setAutoCheck(false);
    updater.startSchedule({ firstDelay: 5, interval: 1000 });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(gh.calls.length, 0);
    await updater.setAutoCheck(true);
    updater.startSchedule({ firstDelay: 5, interval: 1000 });
    await new Promise((r) => setTimeout(r, 60));
    await updater.idle();
    assert.equal(updater.status().status, 'available');
    updater.stopSchedule();
  } finally { done(); }
});

test('接口：源码运行默认不能安装；注入的桌面 updater 走 /api/update；未知操作 400、不能做的 409', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-update-api-'));
  const src = await start({ port: 0, dbPath: join(dir, 'a.db'), islandLauncher: null });
  const gh = fakeGithub({ manifest: manifestFor('1.2.0') });
  const { updater, done } = makeUpdater(gh);
  const desk = await start({ port: 0, dbPath: join(dir, 'b.db'), islandLauncher: null, updater });
  const call = (app, body) => fetch(`${app.url}api/update`, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  try {
    const s = (await (await call(src)).json()).update;
    assert.deepEqual([s.current, s.edition, s.install.mode, s.status], [APP_VERSION, 'source', null, 'idle']);
    assert.match(s.install.reason, /git pull/);
    assert.equal(s.signed, Boolean(UPDATE_CONFIG.publicKey));
    assert.equal((await call(src, { action: 'download' })).status, 409, '源码运行没有可下载的版本');
    assert.equal((await call(src, { action: 'nope' })).status, 400);

    let r = await (await call(desk, { action: 'check' })).json();
    assert.equal(r.update.status, 'available');
    r = await (await call(desk, { action: 'download' })).json();
    await updater.idle();
    assert.equal((await (await call(desk)).json()).update.status, 'ready');
    r = await (await call(desk, { action: 'install' })).json();
    assert.deepEqual(r.result, { restarting: true, message: 'ok' });
    assert.equal((await call(desk, { action: 'settings', autoCheck: false })).status, 200);
  } finally {
    await new Promise((res) => src.server.close(res));
    await new Promise((res) => desk.server.close(res));
    done();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('发版脚本：标签须等于 version.json，私钥须和公钥成对；生成的清单能被客户端验过并下载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-release-'));
  try {
    writeFileSync(join(dir, 'Learning-Workbench-Windows-x64.zip'), PAYLOAD);
    const cfg = config();
    const pem = KEY.priv.export({ type: 'pkcs8', format: 'pem' });
    const base = { dir, config: cfg, version: '1.2.0', notes: '说明', require: [PLATFORM] };
    await assert.rejects(writeManifest({ ...base, tag: 'v1.3.0', privateKeyPem: pem }), /不一致/);
    await assert.rejects(writeManifest({ ...base, tag: 'v1.2.0', privateKeyPem: undefined }), /UPDATE_SIGNING_KEY/);
    await assert.rejects(writeManifest({ ...base, tag: 'v1.2.0',
      privateKeyPem: OTHER.priv.export({ type: 'pkcs8', format: 'pem' }) }), /不是一对/);
    await assert.rejects(writeManifest({ ...base, tag: 'v1.2.0', privateKeyPem: pem, require: [PLATFORM, 'darwin-arm64'] }), /缺少安装包/);
    await writeManifest({ ...base, tag: 'v1.2.0', privateKeyPem: pem });
    const text = readFileSync(join(dir, 'latest.json'), 'utf8');
    const sig = readFileSync(join(dir, 'latest.json.sig'), 'utf8');
    assert.equal(verifyManifest(text, sig, KEY.pub), true);
    // 客户端用这份真实生成的清单走一遍
    const fetchImpl = async (url) => {
      if (url.endsWith('latest.json')) return new Response(text);
      if (url.endsWith('latest.json.sig')) return new Response(sig);
      return new Response(readFileSync(join(dir, 'Learning-Workbench-Windows-x64.zip')));
    };
    const { updater, done } = makeUpdater({ fetch: fetchImpl });
    try {
      await updater.check();
      updater.download();
      await updater.idle();
      assert.equal(updater.status().status, 'ready');
    } finally { done(); }
    assert.equal(existsSync(join(dir, 'latest.json')), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('源码更新：临时 Git 仓库覆盖前置检查、快进与备份顺序', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'wb-source-git-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'source');
  const remote = join(temp, 'remote');
  mkdirSync(join(root, 'app'), { recursive: true });
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' },
  }).trim();
  const calls = [];
  const exec = promisify(execFile);
  const sourceOptions = { root, repo: REPO, dataDir: temp,
    backup: () => { calls.push('backup'); return { name: 'snapshot.db' }; },
    restart: async () => { calls.push('restart'); return { restarting: true }; },
    execGit(file, args, options) {
      const actual = [...args];
      if (actual.includes('fetch')) {
        calls.push('fetch');
        actual[actual.indexOf('origin')] = remote;
      }
      return exec(file, actual, { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'file' } });
    },
  };
  const source = createSourceUpdate(sourceOptions);
  assert.match((await source.preflight('1.2.0'))[0], /仓库根目录/);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'fixture@example.test');
  git(root, 'config', 'user.name', 'Fixture');
  const versionFile = join(root, 'app', 'version.json');
  const commitVersion = (version) => {
    writeFileSync(versionFile, JSON.stringify({ version }));
    git(root, 'add', '--', 'app/version.json');
    git(root, 'commit', '-m', version);
    return git(root, 'rev-parse', 'HEAD');
  };
  const original = commitVersion('1.1.0');
  assert.deepEqual(await source.preflight('1.2.0'), ['origin 未指向配置的发布仓库。', '本地找不到标签 v1.2.0。']);
  const target = commitVersion('1.2.0');
  git(root, 'tag', 'v1.2.0');
  git(root, 'tag', 'v1.3.0');
  git(temp, 'clone', '--bare', root, remote);
  git(root, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`);
  git(root, 'switch', '-c', 'side', original);
  assert.match((await source.preflight('1.2.0'))[0], /main 分支/);
  commitVersion('1.1.1');
  git(root, 'branch', '-f', 'main', 'side');
  git(root, 'switch', 'main');
  await assert.rejects(source.install({ from: '1.1.1', version: '1.2.0' }), /无法快进/);
  git(root, 'switch', 'side');
  git(root, 'branch', '-f', 'main', original);
  git(root, 'switch', 'main');
  writeFileSync(join(root, 'draft.txt'), 'untouched');
  await assert.rejects(source.install({ from: '1.1.0', version: '1.2.0' }), /未提交/);
  assert.deepEqual(calls, []);
  rmSync(join(root, 'draft.txt'));
  assert.deepEqual(await source.preflight('1.2.0'), []);
  await assert.rejects(source.install({ from: '1.1.0', version: '1.3.0', onStep() {} }), /version.json 与发布版本不一致/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), original);
  assert.deepEqual(calls.splice(0), ['backup', 'fetch']);
  git(root, 'tag', '-d', 'v1.2.0');
  const requests = [];
  const remoteSource = createSourceUpdate({
    ...sourceOptions,
    fetch: async (url) => {
      requests.push(url);
      if (url.endsWith('commits/refs%2Ftags%2Fv1.2.0')) return Response.json({ sha: target });
      assert.ok(url.endsWith(`compare/${original}...${target}?per_page=1`));
      return Response.json({ status: 'ahead', merge_base_commit: { sha: original } });
    },
  });
  const gh = fakeGithub({ manifest: manifestFor('1.2.0', { packages: {} }) });
  const { updater, done } = makeUpdater(gh, { edition: 'source', sourceUpdate: remoteSource });
  t.after(done);
  const status = await updater.check();
  assert.equal(status.install.mode, 'source-git');
  await assert.rejects(updater.install('1.3.0'), /可用版本已变化/);
  assert.equal(requests.length, 2);
  assert.deepEqual(calls, [], '前置检查不备份、不 fetch');
  assert.deepEqual(await updater.install(), { restarting: true });
  assert.deepEqual(calls, ['backup', 'fetch', 'restart']);
  assert.equal(requests.length, 4, '安装时再次核对远端');
  assert.equal(git(root, 'rev-parse', 'HEAD'), target);
  assert.deepEqual(JSON.parse(readFileSync(join(temp, 'source-update-result.json'), 'utf8')),
    { from: '1.1.0', to: '1.2.0', ok: true, backup: 'snapshot.db' });
});

test('共享提醒：北京时间次日恢复，跳过只影响指定版本', async (t) => {
  let time = Date.parse('2026-11-24T15:59:59Z');
  const first = makeUpdater(fakeGithub({ manifest: manifestFor('1.2.0') }), { now: () => time });
  const second = makeUpdater(fakeGithub({ manifest: manifestFor('1.2.0') }), { now: () => time });
  const third = makeUpdater(fakeGithub({ manifest: manifestFor('1.3.0') }), { now: () => time });
  for (const fixture of [first, second, third]) {
    t.after(fixture.done);
    fixture.updater.setPreferenceDirectory(first.dataDir);
    await fixture.updater.check();
  }
  await first.updater.setReminder('later', '1.2.0');
  await second.updater.refreshPreference();
  assert.equal(second.updater.status().reminder.action, 'later');
  time += 1000;
  await second.updater.refreshPreference();
  assert.equal(second.updater.status().reminder, null);
  await second.updater.setReminder('skip', '1.2.0');
  await first.updater.refreshPreference();
  assert.equal(first.updater.status().reminder.action, 'skip');
  await third.updater.refreshPreference();
  assert.equal(third.updater.status().reminder, null);
  await assert.rejects(third.updater.setReminder('skip', '1.2.0'), /版本已变化/);
});

test('源码 /api/restart 在临时端口先响应，再由脱离进程的助手拉起服务', { timeout: 20_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'wb-restart-'));
  const root = join(temp, 'app');
  mkdirSync(join(root, 'tools'), { recursive: true });
  copyFileSync(new URL('../tools/restart-source.mjs', import.meta.url), join(root, 'tools', 'restart-source.mjs'));
  writeFileSync(join(root, 'server.js'), `
    const { createServer } = require('node:http');
    const server = createServer((req, res) => {
      if (req.url === '/stop-fixture') {
        res.end('done', () => process.exit(0));
        return;
      }
      res.end(JSON.stringify({ pid: process.pid }));
    });
    server.listen(Number(process.env.PORT), '127.0.0.1');
    setTimeout(() => process.exit(0), 15_000).unref();
  `);
  const entry = join(temp, 'old-service.mjs');
  writeFileSync(entry, `
    import { start } from ${JSON.stringify(new URL('../server.js', import.meta.url).href)};
    const service = await start({ root: ${JSON.stringify(root)}, dbPath: ${JSON.stringify(join(temp, 'fixture.db'))},
      sourceLifecycle: true, islandLauncher: null });
    process.send(service.url);
  `);
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });
  const exited = once(child, 'exit');
  let url;
  try {
    [url] = await Promise.race([
      once(child, 'message'),
      exited.then(([code]) => { throw new Error(`旧服务提前退出：${code}`); }),
    ]);
    const response = await fetch(url + 'api/restart', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.deepEqual(await response.json(), { restarting: true });
    assert.deepEqual(await exited, [0, null]);

    let newService;
    const deadline = Date.now() + 8_000;
    while (!newService && Date.now() < deadline) {
      try {
        newService = await (await fetch(url + 'api/health', { signal: AbortSignal.timeout(500) })).json();
      } catch {
        await delay(100);
      }
    }
    assert.ok(newService?.pid, '新服务必须在原来的临时端口响应');
    assert.notEqual(newService.pid, child.pid);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await exited.catch(() => {});
    }
    if (url) {
      try {
        const response = await fetch(url + 'stop-fixture', { signal: AbortSignal.timeout(1000) });
        await response.text();
      } catch { /* 新服务可能尚未启动 */ }
    }
    await delay(750);
    rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

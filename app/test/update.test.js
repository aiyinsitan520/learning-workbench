// 自动更新（app/lib/updater.js + /api/update + desktop/release-manifest.mjs）。
// 全部用测试生成的密钥和假网络：不访问 GitHub，不装任何东西，只用临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, createUpdater, parseManifest, verifyManifest, MANIFEST_FORMAT } from '../lib/updater.js';
import { UPDATE_CONFIG } from '../lib/update-config.js';
import { start, APP_VERSION } from '../server.js';
import { writeManifest } from '../../desktop/release-manifest.mjs';

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

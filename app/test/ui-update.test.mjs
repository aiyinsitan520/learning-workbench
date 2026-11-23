// 软件更新界面（js/update.js）：左下角版本号、更新对话框、下载进度、确认安装。
// 服务端注入假 updater（测试密钥 + 假网络），不访问 GitHub、不安装任何东西；临时库。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './browser.mjs';
import { start } from '../server.js';
import { createUpdater, MANIFEST_FORMAT } from '../lib/updater.js';

const TZ = 'Asia/Shanghai';
const REPO = 'aiyinsitan520/learning-workbench';
const PAYLOAD = Buffer.alloc(3 * 1024 * 1024, 1);
let app;
let page;
let dir;
let updater;
const installed = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-ui-update-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const name = 'Learning-Workbench-Windows-x64.zip';
  const text = JSON.stringify({ format: MANIFEST_FORMAT, repo: REPO, version: '9.0.0', tag: 'v9.0.0',
    publishedAt: '2026-11-23T00:00:00Z', notes: '· 新增自动更新\n· 修了几个小问题',
    packages: { 'win32-x64': { name, url: `https://github.com/${REPO}/releases/download/v9.0.0/${name}`,
      size: PAYLOAD.length, sha256: createHash('sha256').update(PAYLOAD).digest('hex') } } });
  const sig = sign(null, Buffer.from(text), privateKey).toString('base64');
  const fetchImpl = async (url) => {
    if (url.endsWith('latest.json')) return new Response(text);
    if (url.endsWith('.sig')) return new Response(sig);
    // 分块慢慢给，界面能看到下载中
    const chunks = Array.from({ length: 12 }, (_, i) => PAYLOAD.subarray(i * PAYLOAD.length / 12, (i + 1) * PAYLOAD.length / 12));
    const body = new ReadableStream({ async pull(c) {
      await new Promise((r) => setTimeout(r, 60));
      const next = chunks.shift();
      if (next) c.enqueue(next); else c.close();
    } });
    return new Response(body);
  };
  const data = join(dir, 'data');
  mkdirSync(data);
  updater = createUpdater({
    version: '1.1.0', edition: 'desktop', dataDir: data, platform: 'win32-x64', fetch: fetchImpl,
    config: { repo: REPO, manifestUrl: 'https://example.test/latest.json', releasesUrl: `https://github.com/${REPO}/releases`,
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    install: { mode: 'restart' },
    installer: async (job) => { installed.push(job); return { restarting: true, message: '正在安装，工作台会关闭并在几秒后重新打开。' }; },
  });
  await updater.check(); // 相当于启动 1 分钟后的自动检查
  app = await start({ port: 0, dbPath: join(dir, 'ui.db'), timeZone: TZ, islandLauncher: null, updater });
  page = await launch({ timeZone: TZ });
  await page.goto(app.url);
  await page.waitFor('!!window.__wbState.view');
});

after(async () => {
  if (page) await page.close();
  if (app) await new Promise((resolve) => app.server.close(resolve));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('有新版本：版本号亮起提示点，弹出一次提示', async () => {
  await page.waitFor('document.querySelector("#updateBtn").classList.contains("has-update")');
  assert.equal(await page.text('#updateBtn b'), 'v1.1.0');
  assert.match(await page.evaluate('return document.querySelector("#updateBtn").title'), /v9\.0\.0/);
  assert.match(await page.text('#toast'), /v9\.0\.0 可以更新了/);
});

test('对话框：说明、下载进度、校验通过后先确认再安装，安装前保存正文', async () => {
  await page.click('#updateBtn');
  await page.waitFor('!!document.querySelector("#dialog[open] [data-update-panel] [data-update-status]")');
  assert.match(await page.text('[data-update-status]'), /发现新版本 v9\.0\.0 · 3\.0 MB/);
  assert.match(await page.text('.update-notes'), /新增自动更新/);
  assert.equal(await page.evaluate('return document.querySelector("[data-update=auto]").checked'), true);
  await page.screenshot(join(dir, 'update-available.png'));

  await page.click('[data-update="download"]');
  await page.waitFor('!!document.querySelector(".update-progress")', { timeout: 4000 });
  await page.waitFor('document.querySelector("[data-update-status]")?.textContent.includes("校验都通过")', { timeout: 8000 });
  assert.equal(await page.count('.update-progress'), 0);

  await page.click('[data-update="install"]');
  assert.match(await page.text('.update-confirm'), /备份资料库/);
  await page.click('[data-update="cancel"]');
  assert.equal(await page.count('.update-confirm'), 0);
  assert.equal(installed.length, 0, '取消不安装');

  await page.click('[data-update="install"]');
  await page.screenshot(join(dir, 'update-confirm.png'));
  await page.click('[data-update="confirm"]');
  await page.waitFor('document.querySelector("[data-update-status]")?.textContent.includes("正在安装")');
  assert.equal(installed.length, 1);
  assert.equal(installed[0].version, '9.0.0');
});

test('自动检查开关写回服务端', async () => {
  // 对话框还开着（安装中）；关掉再开，状态从服务端读
  await page.evaluate('document.querySelector("#dialog").close(); return true');
  assert.equal((await updater.setAutoCheck(true)).autoCheck, true);
  await page.click('#updateBtn');
  await page.waitFor('!!document.querySelector("[data-update=auto]")');
  await page.click('[data-update="auto"]');
  await page.waitFor('!document.querySelector("[data-update=auto]").checked');
  assert.equal(updater.status().autoCheck, false);
});

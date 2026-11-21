import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { launch } from './browser.mjs';
import { start } from '../server.js';

test('模型接入：添加、列模型、测试、切换、编辑、导入及确认删除', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-ui-ai-'));
  const key = 'temporary-ui-ai-secret';
  const calls = [];
  const app = await start({ dbPath: join(dir, 'test.db'), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return options.method === 'GET' ? Response.json({ data: [{ id: 'fake-model' }] })
      : Response.json({ choices: [{ message: { content: '连接成功' } }] });
  } });
  let page;
  t.after(async () => {
    try { if (page) await page.close(); } finally {
      await new Promise((resolve) => app.server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });
  page = await launch({ url: app.url, timeZone: 'Asia/Shanghai' });
  const intent = (action) => `[data-ai-action="${action}"]`;
  await page.waitFor('document.querySelector("#taskEditor, #main .topline")');
  await page.click('#aiSettingsBtn');
  await page.waitFor('document.querySelector("[data-ai-preset=deepseek]")');
  await page.click('[data-ai-preset=deepseek]');
  await page.type('[name=apiKey]', key);
  await page.click(intent('models'));
  await page.waitFor('document.querySelector("#ai-models option")?.value === "fake-model"');
  await page.click('[data-ai-editor] [type=submit]');
  await page.waitFor('document.querySelector(".ai-card .ai-current")');
  await page.click(intent('test'));
  await page.waitFor('document.querySelector(".ai-meta")?.textContent.includes("连接成功")');
  await page.click(intent('edit'));
  assert.equal(await page.evaluate('return document.querySelector("[name=apiKey]").value'), '');
  await page.click('[data-ai-editor] [type=submit]');
  await page.waitFor('document.querySelector(".ai-current")');
  const config = JSON.parse(await readFile(join(dir, 'ai-providers.json'), 'utf8'));
  assert.equal(config.providers[0].apiKey === key, true);
  await page.click(intent('import'));
  await page.type('[data-ai-dialog] textarea', JSON.stringify({ name: '本地模型', baseUrl: 'http://127.0.0.1:1/v1', model: 'local' }));
  await page.click('[data-ai-dialog] [type=submit]');
  await page.waitFor('document.querySelectorAll("[data-ai-provider]").length === 2');
  const second = '[data-ai-provider]:nth-child(2) ';
  await page.click(second + intent('activate'));
  await page.waitFor('document.querySelector("[data-ai-provider]:nth-child(2) .ai-current")');
  await page.click(second + intent('delete'));
  await page.click('[data-ai-dismiss]');
  assert.equal(await page.count('[data-ai-provider]'), 2);
  await page.click(second + intent('delete'));
  await page.click('[data-ai-dialog] [type=submit]');
  await page.waitFor('document.querySelectorAll("[data-ai-provider]").length === 1');
  assert.equal(await page.evaluate(`return document.documentElement.outerHTML.includes(${JSON.stringify(key)})`), false);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.options.headers.Authorization === 'Bearer ' + key), true);
  await page.setViewport(440, 900);
  assert.equal(await page.evaluate('return document.documentElement.scrollWidth <= innerWidth'), true);
  await page.click(intent('edit'));
  assert.equal(await page.evaluate('return document.querySelector(".ai-editor").scrollWidth <= document.querySelector(".ai-editor").clientWidth'), true);
  assert.deepEqual(page.consoleErrors, []);
  assert.deepEqual(page.pageErrors, []);
});

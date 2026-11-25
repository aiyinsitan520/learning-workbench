import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server.js';
import { launch } from './browser.mjs';

test('Obsidian section saves settings, exports and reports conflicts at 390 px in all skins', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wb-ui-obsidian-')));
  const vault = join(root, 'fake-vault');
  const envKey = process.platform === 'win32' ? 'APPDATA' : process.platform === 'darwin' ? 'HOME' : 'XDG_CONFIG_HOME';
  const previous = process.env[envKey];
  let app;
  let page;
  t.after(async () => {
    try {
      await page?.close();
      app?.server.closeAllConnections();
      if (app) await new Promise(resolve => app.server.close(resolve));
    } finally {
      if (previous === undefined) delete process.env[envKey]; else process.env[envKey] = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  const configDir = process.platform === 'darwin' ? join(root, 'Library', 'Application Support', 'obsidian') : join(root, 'obsidian');
  await mkdir(configDir, { recursive: true });
  await mkdir(join(vault, '.obsidian'), { recursive: true });
  await writeFile(join(configDir, 'obsidian.json'), JSON.stringify({ vaults: { fake: { path: vault } } }));
  process.env[envKey] = root;
  const publicDir = join(root, 'public');
  await mkdir(join(publicDir, 'js'), { recursive: true });
  for (const file of ['tokens.css', 'skins.css', 'obsidian.css', 'js/obsidian-section.js']) {
    await copyFile(new URL('../public/' + file, import.meta.url), join(publicDir, file));
  }
  await writeFile(join(publicDir, 'index.html'), [
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/skins.css">',
    '<main id="obsidianSection"></main><script type="module">',
    'import { mountObsidianSection } from "/js/obsidian-section.js";',
    'mountObsidianSection(document.querySelector("main"));</script>',
  ].join('\n'));
  app = await start({ root, dbPath: join(root, 'test.db'), islandLauncher: null });
  app.workbench.createTask({ id: 'ui1234', title: '浏览器笔记' });
  app.workbench.saveTaskNote('ui1234', '浏览器验证内容', 0);
  page = await launch({ url: app.url, width: 390, height: 850 });
  await page.waitFor('document.querySelector("select")?.options.length === 2 && document.querySelector("[type=submit]:enabled")');
  await page.evaluate('const select = document.querySelector("select"); select.selectedIndex = 1; select.dispatchEvent(new Event("input", { bubbles: true }));');
  assert.equal(await page.evaluate('return document.querySelector("[name=vaultPath]").value'), vault);
  await page.click('[name=enabled]');
  await page.click('[name=harvests]');
  await page.click('[type=submit]');
  await page.waitFor('document.querySelector("[name=export]:enabled")');
  const open = await page.evaluate('return document.querySelector("[data-obsidian-open]").getAttribute("href")');
  assert.equal(decodeURIComponent(open.split('path=')[1]), join(vault, '学习工作台'));
  await page.click('[name=export]');
  await page.waitFor('document.querySelector("[role=status]").textContent.includes("写入 2")');
  const path = join(vault, '学习工作台', '任务正文', '浏览器笔记-ui1234.md');
  assert.match(await readFile(path, 'utf8'), /浏览器验证内容/);
  await writeFile(path, '用户在 Obsidian 里修改');
  await page.click('[name=export]');
  await page.waitFor('document.querySelector("[data-obsidian-conflicts] li")');
  assert.equal(await page.text('[data-obsidian-conflicts] li'), '任务正文/浏览器笔记-ui1234.md');
  for (const skin of ['candy', 'mint', 'latte', 'mocha', 'nord', 'rose']) {
    assert.ok(await page.evaluate(
      'document.documentElement.dataset.skin = ' + JSON.stringify(skin) + ';'
      + ' return document.documentElement.scrollWidth <= innerWidth && getComputedStyle(document.querySelector("form")).display === "grid"'
    ), skin);
  }
});

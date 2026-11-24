import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server.js';
import { launch } from './browser.mjs';

test('task note images work through paste, drag and file selection and survive reload', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-note-images-'));
  const app = await start({ dbPath: join(dir, 'test.db'), islandLauncher: null });
  let page;
  t.after(async () => {
    await page?.close();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  app.workbench.createTask({ id: 'picture', title: '图片正文' });
  page = await launch({ url: app.url, width: 390, height: 850, timeZone: 'Asia/Shanghai' });
  await page.waitFor('document.querySelector("#pending .tasktitle")');
  const open = async () => {
    await page.click('#pending .tasktitle');
    await page.waitFor('document.querySelector("#taskNoteBody:enabled")');
  };
  await open();
  await page.type('#taskNoteBody', '# 标题\n- **加粗** [链接](https://example.com)\n<script>alert(1)</script>\n![远程](https://example.com/remote.png)\n[危险](javascript:evil)');
  for (const [index, method] of ['paste', 'drop', 'file'].entries()) {
    await page.evaluate(`
      const area = document.querySelector('#taskNoteBody');
      area.setSelectionRange(area.value.length, area.value.length);
      const data = new DataTransfer();
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV5cAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      data.items.add(new File([bytes], '截图.png', { type: 'image/png' }));
      const method = ${JSON.stringify(method)};
      if (method === 'file') {
        const input = document.querySelector('#taskNoteImageFile');
        let pickerOpened = false;
        input.addEventListener('click', event => { event.preventDefault(); pickerOpened = true; }, { once: true });
        document.querySelector('#insertTaskNoteImage').click();
        if (!pickerOpened) throw new Error('file picker was not opened');
        input.files = data.files;
        input.dispatchEvent(new Event('change'));
      } else if (method === 'paste') {
        area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      } else {
        area.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
      }
      if (!area.value.includes('![上传中…]()')) throw new Error('placeholder missing');
    `);
    await page.waitFor(`document.querySelectorAll('#taskNoteImages img').length === ${index + 1}`);
  }
  await page.waitFor('document.querySelector("#taskNoteStatus").textContent === "已自动保存"');
  await page.goto(app.url);
  await page.waitFor('document.querySelector("#pending .tasktitle")');
  await open();
  await page.waitFor('document.querySelectorAll("#taskNoteImages img").length === 3');
  await page.waitFor('document.querySelector("#taskNoteImages img").naturalWidth > 0');
  await page.click('#taskNoteImages button');
  await page.waitFor('document.querySelector("#taskNoteImageDialog").open');
  await page.click('#taskNoteImageDialog button');
  await page.click('#toggleTaskNotePreview');
  const preview = '#taskNotePreview';
  assert.equal(await page.text(preview + ' h1'), '标题');
  assert.equal(await page.text(preview + ' li strong'), '加粗');
  assert.equal(await page.count(preview + ' img'), 3);
  assert.equal(await page.count(preview + ' a'), 1);
  assert.equal(await page.count(preview + ' script'), 0);
  assert.match(await page.text(preview), /<script>alert\(1\)<\/script>/);
  const skins = await page.evaluate(`
    const checks = {};
    const editor = document.querySelector('#taskEditor');
    for (const skin of ['mint', 'candy', 'latte', 'mocha', 'nord', 'rose']) {
      document.documentElement.dataset.skin = skin;
      const image = editor.querySelector('#taskNotePreview img');
      const toolbar = editor.querySelector('.task-note-tools');
      checks[skin] = image.clientWidth > 0 && image.clientWidth <= editor.clientWidth
        && toolbar.scrollWidth <= toolbar.clientWidth;
    }
    return checks;
  `);
  for (const [skin, fits] of Object.entries(skins)) assert.ok(fits, skin);
  await page.click('#toggleTaskNotePreview');
  const saved = await page.evaluate('return document.querySelector("#taskNoteBody").value');
  await page.evaluate(`
    const files = new DataTransfer();
    files.items.add(new File(['not a PNG'], 'invalid.png', { type: 'image/png' }));
    document.querySelector('#taskNoteBody').dispatchEvent(new DragEvent('drop', { dataTransfer: files }));
  `);
  await page.waitFor('document.querySelector("#taskNoteImageStatus").textContent.includes("上传失败")');
  assert.equal(await page.evaluate('return document.querySelector("#taskNoteBody").value'), saved);
  assert.deepEqual(page.pageErrors, []);
});

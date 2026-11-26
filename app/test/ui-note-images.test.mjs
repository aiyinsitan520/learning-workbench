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
  const paste = async (setup) => page.evaluate(`
    const area = document.querySelector('#taskNoteBody');
    const data = new DataTransfer();
    ${setup}
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: data });
    area.dispatchEvent(event);
    return event.defaultPrevented;
  `);
  await page.type('#taskNoteBody', '前文后文');
  await page.evaluate("document.querySelector('#taskNoteBody').setSelectionRange(2, 2)");
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV5cAAAAASUVORK5CYII=';
  assert.ok(await paste(`data.setData('text/html', '<p><img alt="内嵌图" src="data:image/png;base64,${png}"></p>')`));
  await page.waitFor('document.querySelector("#taskNoteImages img")?.naturalWidth > 0');
  assert.match(await page.evaluate('return document.querySelector("#taskNoteBody").value'),
    /^前文\n!\[内嵌图\]\(\/api\/attachments\/.+?\)\n后文$/);
  assert.ok(await paste(`
    const bytes = Uint8Array.from(atob('${png}'), char => char.charCodeAt(0));
    data.items.add(new File([bytes], '剪贴板.png', { type: 'image/png' }));
    Object.defineProperty(data, 'files', { value: [] });
  `));
  await page.waitFor('document.querySelectorAll("#taskNoteImages img").length === 2');
  assert.equal(await paste("data.setData('text/plain', '普通文字')"), false);
  // Excel/Word：位图 + 带文字的 HTML，应按文字原生粘贴，不上传位图。
  assert.equal(await paste(`
    const bytes = Uint8Array.from(atob('${png}'), char => char.charCodeAt(0));
    data.items.add(new File([bytes], '表格.png', { type: 'image/png' }));
    data.setData('text/html', '<table><tr><td>单元格</td></tr></table>');
    data.setData('text/plain', '单元格');
  `), false);
  assert.equal(await page.count('#taskNoteImages img'), 2);
  const original = await page.evaluate('return document.querySelector("#taskNoteBody").value');
  await page.type('#taskNoteBody', '');
  assert.equal(await paste(`data.setData('text/html', '<p>文字<img src="data:image/png;base64,${png}"></p>')`), true);
  await page.waitFor('document.querySelector("#taskNoteImages img")?.naturalWidth > 0');
  assert.match(await page.evaluate('return document.querySelector("#taskNoteBody").value'),
    /^文字\n!\[图片\]\(\/api\/attachments\/[0-9a-f]{64}\.png\)$/);
  await page.type('#taskNoteBody', original);
  await page.waitFor('document.querySelector("#taskNoteStatus").textContent === "已自动保存"');
  await page.goto(app.url);
  await page.waitFor('document.querySelector("#pending .tasktitle")');
  await open();
  await page.click('#toggleTaskNotePreview');
  assert.equal(await page.count('#taskNotePreview img'), 2);
  await page.click('#toggleTaskNotePreview');
  assert.equal(await page.evaluate('return document.activeElement.id'), 'taskNoteBody');
  assert.deepEqual(page.pageErrors, []);
});

test('article paste keeps text and local images in order across reload, handles failures and limits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-article-'));
  const app = await start({ dbPath: join(dir, 'test.db'), islandLauncher: null });
  let page;
  t.after(async () => {
    await page?.close();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  app.workbench.createTask({ id: 'article', title: '文章' });
  page = await launch({ url: app.url, width: 900, height: 850, timeZone: 'Asia/Shanghai' });
  async function open() {
    await page.waitFor('document.querySelector("#pending .tasktitle")');
    await page.click('#pending .tasktitle');
    await page.waitFor('document.querySelector("#taskNoteBody:enabled")');
  }
  const value = () => page.evaluate('return document.querySelector("#taskNoteBody").value');
  const saved = () => page.waitFor('document.querySelector("#taskNoteStatus").textContent === "已自动保存"');
  const paste = html => page.evaluate(`
    const data = new DataTransfer();
    data.setData('text/html', ${JSON.stringify(html)});
    const event = new ClipboardEvent('paste', { clipboardData: data, cancelable: true });
    document.querySelector('#taskNoteBody').dispatchEvent(event);
    return event.defaultPrevented;
  `);
  await open();
  await page.evaluate(`
    const realFetch = window.fetch.bind(window);
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV5cAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    window.sources = [];
    window.fetch = async (url, options) => {
      if (url !== '/api/attachments/fetch') return realFetch(url, options);
      const source = JSON.parse(options.body).url;
      window.sources.push(source);
      if (source.endsWith('/missing')) return new Response(null, { status: 502 });
      if (source.endsWith('/wait')) await new Promise(resolve => { window.finishImage = resolve; });
      return realFetch('/api/attachments', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
    };
  `);
  const img = name => '<img alt="插图" src="https://images.invalid/' + name + '">';
  assert.ok(await paste('<p>前   <b>文</b><br><br><br>引言</p><script>隐藏</script><style>隐藏</style>'
    + img('wait') + '<ul><li><p>后文</p></li></ul>'));
  await page.waitFor('typeof window.finishImage === "function"');
  assert.ok((await value()).includes('![上传中…]()'));
  assert.equal(await paste(img('second')), true);
  assert.match(await page.text('#taskNoteImageStatus'), /上一批图片还在上传/);
  await page.evaluate('window.finishImage()');
  await saved();
  assert.match(await value(), /^前 文\n\n引言\n!\[插图\]\(\/api\/attachments\/[a-f0-9]{64}\.png\)\n- 后文$/);
  assert.equal(await page.text('#taskNoteImageStatus'), '');
  await page.type('#taskNoteBody', '');
  assert.ok(await paste(img('ok') + img('missing') + '<p>结尾</p>'));
  await page.waitFor('document.querySelector("#taskNoteImageStatus").textContent.includes("1 张图片没取到")');
  assert.match(await value(), /^!\[插图\]\(\/api\/attachments\/[a-f0-9]{64}\.png\)\n结尾$/);
  assert.equal(await paste('<p>本机<img src="file:///doc.png"><img src="blob:copy"></p>'), false);
  assert.match(await page.text('#taskNoteImageStatus'), /有 2 张图片来自本机文件/);
  await page.type('#taskNoteBody', '');
  assert.ok(await paste(img('many').repeat(21) + '<p>末尾</p>'));
  await page.waitFor('document.querySelectorAll("#taskNoteImages img").length === 20');
  assert.match(await page.text('#taskNoteImageStatus'), /最多插入 20 张/);
  assert.equal(await page.evaluate("return window.sources.filter(url => url.endsWith('/many')).length"), 20);
  assert.ok((await value()).endsWith('\n末尾'));
  await page.type('#taskNoteBody', '字'.repeat(31980));
  assert.ok(await paste('文'.repeat(30) + img('limit')));
  await page.waitFor('document.querySelector("#taskNoteImageStatus").textContent.includes("32000")');
  assert.equal(await value(), '字'.repeat(31980) + '文'.repeat(20));

  await page.type('#taskNoteBody', '');
  assert.ok(await paste('<p>开头</p>' + img('persist') + '<p>结尾</p>'));
  await saved();
  const persistent = await value();
  assert.match(persistent, /^开头\n!\[插图\]\(\/api\/attachments\/[a-f0-9]{64}\.png\)\n结尾$/);
  await page.goto(app.url);
  await open();
  assert.equal(await value(), persistent);
  await page.waitFor('document.querySelector("#taskNoteImages img")?.naturalWidth > 0');
  assert.deepEqual(page.pageErrors, []);
});

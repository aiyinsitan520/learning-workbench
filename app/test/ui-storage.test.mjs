// 「数据」设置页（js/storage-page.js）：路径、来源徽标、用量、备份、共享提示、更换位置、重启。
// 只用临时目录与临时库：desktopDir / configRoot / 目标文件夹都在临时目录里，
// 不碰 app/data/workbench.db，也不动 7321 上的正式服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './browser.mjs';
import { start } from '../server.js';
import { openDatabase } from '../lib/db.js';

const TZ = 'Asia/Shanghai';
const SKINS = ['mint', 'candy', 'latte', 'mocha', 'nord', 'rose'];
// 浏览器用例是并行跑的（verify/run_ui.mjs 一次交给 node --test），机器忙时一次服务往返
// 可能超过默认 8 秒；凡是要等服务端写入或整页读取的等待都放宽。
const SLOW = { timeout: 25000 };

/**
 * 起一个隔离的服务 + 浏览器；收尾统一清理。
 * storageOptions 可以是函数：拿得到本次的临时目录，桌面目录与配置根都落在里面。
 */
async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-ui-storage-'));
  const opened = [];
  const folders = [];
  const extra = typeof options.storageOptions === 'function'
    ? options.storageOptions(dir)
    : options.storageOptions;
  const app = await start({
    timeZone: TZ,
    islandLauncher: null,
    ...options.server,
    storageOptions: {
      configRoot: join(dir, 'config'),
      openFolder: async (path) => { folders.push(path); },
      ...extra,
    },
  });
  opened.push(app);
  let page;
  t.after(async () => {
    try { if (page) await page.close(); } finally {
      for (const item of opened) await new Promise((resolve) => item.server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });
  page = await launch({ url: app.url, timeZone: TZ });
  await page.waitFor('!!window.__wbState?.view && !!document.querySelector("#aiSettingsBtn")', { timeout: 20000 });
  return { dir, app, page, folders, opened };
}

/** 从齿轮页的「数据与备份」进入数据页。 */
async function openStorage(page) {
  await page.click('#aiSettingsBtn');
  await page.waitFor('!!document.querySelector("[data-ai-action=storage]")');
  await page.click('[data-ai-action="storage"]');
  await page.waitFor('!!document.querySelector("[data-storage-path]")', SLOW);
}

const storage = (app) => fetch(app.url + 'api/storage').then((r) => r.json());

test('数据页：完整路径、来源徽标、用量、备份列表、共享提示与选择文件夹', async (t) => {
  const { dir, app, page, folders } = await fixture(t, {
    storageOptions: (temp) => ({
      edition: 'desktop',
      desktopDir: join(temp, 'userData'),
      pickFolder: async () => ({ dataDir: join(temp, 'picked') }),
    }),
  });
  await openStorage(page);
  const info = await storage(app);

  // 1) 顶部大字显示完整路径 + 复制 / 打开文件夹
  assert.equal(await page.text('[data-storage-path]'), info.dataDir, '路径应完整显示');
  assert.equal(await page.text('#contextPage'), '数据');
  assert.equal(await page.text('[data-storage-badge]'), '默认位置', '没有 location.json 时是默认位置');
  assert.equal(await page.count('[data-storage="copy"]'), 1);
  assert.equal(await page.count('[data-storage="reveal"]'), 1);

  // 2) 用量：数据库大小、图片附件数量与大小
  assert.equal(await page.count('[data-storage-usage] > div'), 3);
  assert.match(await page.text('[data-storage-usage]'), /数据库/);
  assert.match(await page.text('[data-storage-usage]'), /图片附件/);
  assert.match(await page.text('[data-storage-usage]'), /0 个/);

  // 3) shared=false：提示条列出两处默认路径，并说明不互通
  assert.equal(await page.count('[data-storage-shared="0"]'), 1);
  const tip = await page.text('[data-storage-shared="0"]');
  assert.match(tip, /各用各的文件夹/);
  assert.match(tip, /不会互通/);
  assert.ok(tip.includes(info.defaults.web), '应列出网页版默认路径');
  assert.ok(tip.includes(info.defaults.desktop), '应列出桌面版默认路径');
  assert.match(tip, /同一个文件夹即可实时同步/);

  // 4) 桌面版有「选择文件夹…」；网页端由下面的用例覆盖
  assert.equal(await page.count('[data-storage="pick"]'), 1);
  await page.click('[data-storage="pick"]');
  await page.waitFor(`document.querySelector("[data-storage-path-input]").value === ${JSON.stringify(join(dir, 'picked'))}`, SLOW);

  // 5) 打开数据 / 备份文件夹只走白名单目录
  await page.click('[data-storage="reveal"]');
  await page.click('[data-storage="reveal-backups"]');
  await page.waitFor('true');
  assert.deepEqual(folders, [info.dataDir, join(info.dataDir, 'backups')]);

  // 6) 立即备份：列表出现一份、文件名带时间戳
  await page.click('[data-storage="backup"]');
  await page.waitFor('document.querySelectorAll("[data-storage-backups] li").length === 1', SLOW);
  const name = await page.text('[data-storage-backups] li code');
  assert.match(name, /^workbench-\d{8}T\d{6}\.db$/);
  assert.ok(existsSync(join(info.dataDir, 'backups', name)), '备份文件应真的落盘');

  // 7) Obsidian 联动小节（T-W5）已挂载在数据页里，自带样式表
  assert.equal(await page.count('#obsidianSection .wb-obsidian'), 1, 'Obsidian 小节应已挂载');
  assert.equal(await page.evaluate('return !!document.querySelector(\'link[href="/obsidian.css"]\')'), true,
    'Obsidian 小节应自带样式表');
  assert.doesNotMatch(await page.text('#obsidianSection'), /即将推出/);

  // 8) 390px 与六套皮肤都不横向溢出
  await page.setViewport(390, 840);
  const overflow = await page.evaluate(`
    const previous = document.documentElement.dataset.skin;
    const bad = ${JSON.stringify(SKINS)}.filter((skin) => {
      document.documentElement.dataset.skin = skin;
      const page = document.querySelector('.storage-page');
      return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
        || page.scrollWidth > page.clientWidth + 1;
    });
    document.documentElement.dataset.skin = previous;
    return bad;
  `);
  assert.deepEqual(overflow, [], '六套皮肤在 390px 下都不应横向溢出');
  await page.setViewport(1440, 900);
  assert.deepEqual(page.consoleErrors, []);
  assert.deepEqual(page.pageErrors, []);
});

test('更换数据位置：确认对话框写明三件事，先自动备份再换，成功后显示立即重启', async (t) => {
  const { dir, app, page } = await fixture(t, {
    storageOptions: (temp) => ({ edition: 'desktop', desktopDir: join(temp, 'userData') }),
  });
  await openStorage(page);
  const info = await storage(app);
  const target = join(dir, '新位置 有空格');

  // 1) 点「更换数据位置」先出确认对话框，不动任何东西
  await page.type('[data-storage-path-input]', target);
  await page.click('[data-storage="relocate"]');
  await page.waitFor('!!document.querySelector("#dialog[open] [data-storage-dialog-error]")', SLOW);
  const dialog = await page.text('#dialog[open] .storage-dialog');
  assert.match(dialog, /旧文件夹不会删除/);
  assert.match(dialog, /需要重启/);
  assert.match(dialog, /重启前先自动备份/);
  assert.match(dialog, /复制/, 'copy 模式应说明会复制数据');
  assert.ok(dialog.includes(info.dataDir), '对话框应写明从哪个文件夹换出');
  assert.ok(dialog.includes(target), '对话框应写明换到哪个文件夹');
  assert.equal(existsSync(join(target, 'workbench.db')), false, '确认前不得动目标文件夹');

  // 2) 取消：什么都不做
  await page.click('[data-storage-dialog="cancel"]');
  await page.waitFor('!document.querySelector("#dialog[open]")');
  assert.equal(existsSync(join(target, 'workbench.db')), false, '取消后目标文件夹仍为空');
  assert.equal(existsSync(join(info.configPath)), false, '取消后不写 location.json');

  // 3) 确认：先 backup 再 relocate（用 fetch 记录顺序），成功后显示重启卡片
  await page.evaluate(`
    window.__calls = [];
    const original = window.fetch;
    window.fetch = (url, init) => {
      const path = String(url);
      if (path.includes('/api/storage/')) window.__calls.push(path.replace(/^.*\\/api\\//, ''));
      return original(url, init);
    };
    return true;
  `);
  await page.click('[data-storage-path-input]');
  await page.evaluate(`document.querySelector('[data-storage-path-input]').value = ''; return true;`);
  await page.type('[data-storage-path-input]', target);
  await page.click('[data-storage="relocate"]');
  await page.waitFor('document.querySelector("#dialog[open]")');
  await page.click('[data-storage-dialog="confirm"]');
  await page.waitFor('!!document.querySelector("[data-storage-restart]")', SLOW);
  const calls = await page.evaluate('return window.__calls;');
  const backupAt = calls.indexOf('storage/backup');
  const relocateAt = calls.indexOf('storage/relocate');
  assert.ok(backupAt >= 0, `应先调用备份：${calls.join(',')}`);
  assert.ok(relocateAt > backupAt, `备份必须在更换之前：${calls.join(',')}`);

  const restart = await page.text('[data-storage-restart]');
  assert.match(restart, /重启后生效/);
  assert.ok(restart.includes(target), '重启卡片应写明新位置');
  assert.match(restart, /已自动备份/);
  assert.equal(await page.count('[data-storage="restart"]'), 1, '有 /api/restart 时应显示立即重启');
  assert.match(restart, /旧文件夹里的文件一个都没删/);

  // 4) 新位置真的有库与布局文件，旧文件夹与配置都在
  assert.ok(existsSync(join(target, 'workbench.db')), 'copy 模式应把数据库复制过去');
  assert.ok(existsSync(join(target, 'attachments')), 'copy 模式应复制附件目录');
  assert.deepEqual(JSON.parse(readFileSync(info.configPath, 'utf8')), { version: 1, dataDir: target });
  assert.ok(existsSync(join(info.dataDir, 'workbench.db')), '旧文件夹不得删除');
  assert.ok(readdirSync(join(info.dataDir, 'backups')).some((f) => /^workbench-\d{8}T\d{6}\.db$/.test(f)),
    '更换前应自动备份在旧文件夹的 backups 里');

  // 5) 重启按钮：本进程没有注入 restart，应给出启动脚本的说明
  await page.click('[data-storage="restart"]');
  await page.waitFor('document.querySelector("[data-storage-restart-note]").textContent.length > 0', SLOW);
  assert.match(await page.text('[data-storage-restart-note]'), /重新运行启动脚本/);
  assert.deepEqual(page.consoleErrors, []);
  assert.deepEqual(page.pageErrors, []);
});

test('使用已有数据：use 模式直接打开目标库，错误码显示人话', async (t) => {
  const { dir, app, page } = await fixture(t, {
    storageOptions: (temp) => ({
      edition: 'desktop',
      desktopDir: join(temp, 'userData'),
      // 假装这是安装目录：它下面的路径必须被拒绝，且与跑测试时的当前目录无关
      installDir: join(temp, '程序目录'),
    }),
  });
  await openStorage(page);
  const info = await storage(app);
  const existing = join(dir, '已有资料');
  const db = openDatabase(join(existing, 'workbench.db'));
  db.createTask({ id: 'existing-task', title: '以前的任务' });
  db.close();

  // 1) use 模式
  await page.type('[data-storage-path-input]', existing);
  await page.evaluate(`
    const radio = document.querySelector('input[name="storageMode"][value="use"]');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  await page.click('[data-storage="relocate"]');
  await page.waitFor('document.querySelector("#dialog[open]")');
  assert.match(await page.text('#dialog[open] .storage-dialog'), /不会复制当前数据/);
  await page.click('[data-storage-dialog="confirm"]');
  await page.waitFor('!!document.querySelector("[data-storage-restart]")', SLOW);
  assert.deepEqual(JSON.parse(readFileSync(info.configPath, 'utf8')), { version: 1, dataDir: existing });

  // 2) 409：目标已有 workbench.db 却选了「复制过去」→ 人话，不出现技术细节
  const conflict = join(dir, '有库的文件夹');
  mkdirSync(conflict, { recursive: true });
  writeFileSync(join(conflict, 'workbench.db'), 'not-a-database');
  await page.evaluate(`document.querySelector('[data-storage-path-input]').value = ''; return true;`);
  await page.type('[data-storage-path-input]', conflict);
  await page.evaluate(`
    const radio = document.querySelector('input[name="storageMode"][value="copy"]');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  await page.click('[data-storage="relocate"]');
  await page.waitFor('document.querySelector("#dialog[open]")');
  await page.click('[data-storage-dialog="confirm"]');
  await page.waitFor('document.querySelector("#dialog[open] [data-storage-dialog-error]").textContent.length > 0', SLOW);
  const message = await page.text('#dialog[open] [data-storage-dialog-error]');
  assert.match(message, /workbench\.db|资料库|文件夹/, `应是可读的说明：${message}`);
  assert.doesNotMatch(message, /Error:|ENOENT|EACCES|\bat\s+\w+\.\w+/, `不得显示技术细节：${message}`);

  // 3) 400：路径在程序目录里 → 人话
  await page.click('[data-storage-dialog="cancel"]');
  await page.waitFor('!document.querySelector("#dialog[open]")');
  await page.evaluate(`document.querySelector('[data-storage-path-input]').value = ''; return true;`);
  await page.type('[data-storage-path-input]', join(dir, '程序目录', '数据'));
  await page.click('[data-storage="relocate"]');
  await page.waitFor('document.querySelector("#dialog[open]")');
  await page.click('[data-storage-dialog="confirm"]');
  await page.waitFor('document.querySelector("#dialog[open] [data-storage-dialog-error]").textContent.length > 0', SLOW);
  const blocked = await page.text('#dialog[open] [data-storage-dialog-error]');
  assert.match(blocked, /程序目录/, `应说明不能放在程序目录里：${blocked}`);
  assert.equal(existsSync(join(dir, '程序目录', '数据', 'workbench.db')), false, '被拒时不得写入目标');
  assert.deepEqual(page.pageErrors, []);
});

test('空路径不提交；来源是环境变量时更换按钮禁用并说明', async (t) => {
  const { page } = await fixture(t, {
    storageOptions: (temp) => ({ edition: 'desktop', desktopDir: join(temp, 'userData') }),
  });
  await openStorage(page);
  await page.click('[data-storage="relocate"]');
  await page.waitFor('document.querySelector("[data-storage-error]").textContent.length > 0', SLOW);
  assert.match(await page.text('[data-storage-error]'), /完整路径/);
  assert.equal(await page.count('#dialog[open]'), 0, '空路径不应弹出确认对话框');
  await page.close();

  // 环境变量来源：只读说明 + 更换禁用
  const dir2 = mkdtempSync(join(tmpdir(), 'wb-ui-storage-env-'));
  const envApp = await start({ timeZone: TZ, islandLauncher: null, dbPath: join(dir2, 'env.db') });
  const envPage = await launch({ url: envApp.url, timeZone: TZ });
  t.after(async () => {
    await envPage.close();
    await new Promise((resolve) => envApp.server.close(resolve));
    rmSync(dir2, { recursive: true, force: true });
  });
  await envPage.waitFor('!!window.__wbState?.view && !!document.querySelector("#aiSettingsBtn")', { timeout: 20000 });
  await openStorage(envPage);
  assert.equal(await envPage.text('[data-storage-badge]'), '开发环境变量');
  assert.equal(await envPage.count('[data-storage-env-note]'), 1);
  assert.match(await envPage.text('[data-storage-env-note]'), /WORKBENCH_DB/);
  assert.equal(await envPage.evaluate('return document.querySelector(\'[data-storage="relocate"]\').disabled;'), true);
  assert.deepEqual(envPage.pageErrors, []);
});

test('桌面连服务器数据库时整页只读；workbench:open 事件能切到数据页', async (t) => {
  const { page } = await fixture(t, {
    storageOptions: (temp) => ({ edition: 'desktop', desktopDir: join(temp, 'userData') }),
  });
  // 模拟 desktop/main.mjs 的 fetchShared：remote:true
  await page.evaluate(`
    const original = window.fetch;
    window.fetch = async (url, init) => {
      const response = await original(url, init);
      if (!String(url).includes('/api/storage')) return response;
      const data = await response.json();
      return new Response(JSON.stringify({ ...data, remote: true, shared: false }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    return true;
  `);
  await page.evaluate(`window.dispatchEvent(new CustomEvent('workbench:open', { detail: 'storage' })); return true;`);
  await page.waitFor('!!document.querySelector("[data-storage-readonly]")', SLOW);
  assert.equal(await page.text('#contextPage'), '数据');
  assert.match(await page.text('[data-storage-readonly]'), /服务器数据库/);
  for (const action of ['reveal', 'backup', 'reveal-backups', 'relocate']) {
    assert.equal(await page.evaluate(`return document.querySelector('[data-storage="${action}"]').disabled;`), true,
      `只读时 ${action} 应禁用`);
  }
  assert.equal(await page.evaluate(`return document.querySelector('[data-storage-path-input]').disabled;`), true);
  assert.deepEqual(page.consoleErrors, []);
  assert.deepEqual(page.pageErrors, []);
});

import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { start, APP_VERSION } from './app/server.js';
import { createUpdater } from './app/lib/updater.js';
import { UPDATE_CONFIG } from './app/lib/update-config.js';
import { detectInstallMode, installUpdate, readUpdateOutcome } from './update-install.mjs';

const smoke = process.argv.includes('--smoke-test');
const sourceLabels = { local: '本机数据库', server: '服务器数据库' };
const zoomFactors = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const windows = new Map();
let sharedUrl = 'http://127.0.0.1:17322/';
let activeSource;
let preferencesPath;
let service;
let switching = false;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = windows.get(activeSource);
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (!service || quitting) return;
    event.preventDefault();
    quitting = true;
    shutdown().finally(() => app.quit());
  });
  app.whenReady().then(open).catch(error => {
    if (smoke) console.error(error);
    else dialog.showErrorBox('学习工作台启动失败', error.message);
    app.exit(1);
  });
}

async function shutdown() {
  service.updater?.stopSchedule();
  try {
    await fetch(service.url + 'api/island', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'close' }), signal: AbortSignal.timeout(2000),
    });
  } finally {
    service.server.closeAllConnections();
    await new Promise(resolve => service.server.close(resolve));
  }
}

/** 自动更新：只信任 UPDATE_CONFIG 里的仓库与公钥；安装前必须在界面里确认。 */
async function createDesktopUpdater(userData) {
  const install = await detectInstallMode({ isPackaged: app.isPackaged });
  const updater = createUpdater({
    version: APP_VERSION, config: UPDATE_CONFIG, dataDir: userData, edition: 'desktop', install,
    installer: (job) => installUpdate(job, {
      shell, workbench: service.workbench, userData,
      quit: () => app.quit(),
    }),
  });
  await updater.loadSettings();
  const outcome = await readUpdateOutcome(userData, APP_VERSION);
  if (outcome) updater.markUpdated(outcome);
  return updater;
}

async function readPreferredSource() {
  try {
    return JSON.parse(await readFile(preferencesPath, 'utf8')) === 'server' ? 'server' : 'local';
  } catch {
    return 'local';
  }
}

async function savePreferredSource(source) {
  const temporary = preferencesPath + '.tmp';
  await writeFile(temporary, JSON.stringify(source));
  await rename(temporary, preferencesPath);
}

function zoomPage(contents, direction) {
  if (direction === 0) {
    contents.setZoomFactor(1);
    return;
  }
  const current = contents.getZoomFactor();
  const next = direction > 0
    ? zoomFactors.find(factor => factor > current + 0.001)
    : zoomFactors.findLast(factor => factor < current - 0.001);
  if (next !== undefined) contents.setZoomFactor(next);
}

function setDesktopMenu() {
  const menu = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: '数据源',
      submenu: Object.entries(sourceLabels).map(([source, label]) => ({
        id: 'source-' + source, type: 'radio', label,
        checked: source === activeSource,
        click: async () => {
          try {
            await selectSource(source);
          } catch (error) {
            if (!quitting) dialog.showErrorBox('无法切换数据源', error.message);
          } finally {
            if (!quitting) setDesktopMenu();
          }
        },
      })),
    },
    { role: 'editMenu' },
    {
      label: '视图',
      submenu: [
        { id: 'zoom-in', label: '放大', accelerator: 'CommandOrControl+Plus',
          click: (_item, win) => { if (win) zoomPage(win.webContents, 1); } },
        { id: 'zoom-out', label: '缩小', accelerator: 'CommandOrControl+-',
          click: (_item, win) => { if (win) zoomPage(win.webContents, -1); } },
        { id: 'zoom-reset', label: '实际大小（100%）', accelerator: 'CommandOrControl+0',
          click: (_item, win) => { if (win) zoomPage(win.webContents, 0); } },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
}

async function requireSharedService() {
  try {
    const response = await fetch(sharedUrl + 'api/health', { redirect: 'error', signal: AbortSignal.timeout(3500) });
    if (response.ok && (await response.json()).ok === true) return;
  } catch { /* 下方提示连接失败 */ }
  throw new Error('服务器数据库暂时连不上。请检查网络和共享连接，然后重试。');
}

function createWindow(source, url, bounds) {
  const title = '学习工作台 · ' + sourceLabels[source];
  const win = new BrowserWindow({
    width: 1440, height: 940, ...bounds, minWidth: 440, minHeight: 480,
    show: false, title, icon: join(app.getAppPath(), 'app/public/icon.png'),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.on('page-title-updated', (event) => event.preventDefault());
  win.on('closed', () => {
    windows.delete(source);
    if (!quitting && activeSource === source) app.quit();
  });
  const origin = new URL(url).origin;
  const stayOnSource = (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  };
  win.webContents.on('will-navigate', stayOnSource);
  win.webContents.on('will-redirect', stayOnSource);
  win.webContents.on('before-input-event', (event, input) => {
    const primaryModifier = process.platform === 'darwin'
      ? input.meta && !input.control
      : input.control && !input.meta;
    if (input.type !== 'keyDown' || !primaryModifier || input.alt) return;
    const direction = { '=': 1, '+': 1, '-': -1, '0': 0 }[input.key];
    if (direction === undefined) return;
    event.preventDefault();
    zoomPage(win.webContents, direction);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://github.com/' + UPDATE_CONFIG.repo + '/')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

async function selectSource(source, { remember = true } = {}) {
  if (switching || activeSource === source) return;
  switching = true;
  try {
    if (source === 'server') await requireSharedService();
    if (quitting) return;
    const previous = windows.get(activeSource);
    let next = windows.get(source);
    if (!next) {
      const url = source === 'local' ? service.url : sharedUrl;
      next = createWindow(source, url, previous?.getNormalBounds());
      try {
        await next.loadURL(url);
      } catch (error) {
        if (!next.isDestroyed()) next.destroy();
        throw error;
      }
      if (quitting || next.isDestroyed()) return;
      windows.set(source, next);
    }

    // 保留原页面和编辑草稿。每次只显示当前数据源的窗口。
    activeSource = source;
    if (!smoke) {
      next.show();
      if (previous && !previous.isDestroyed()) previous.hide();
    }
    setDesktopMenu();
    if (remember) await savePreferredSource(source);
  } finally {
    switching = false;
  }
}

async function open() {
  const userData = app.getPath('userData');
  preferencesPath = join(userData, 'desktop-data-source.json');
  const updater = await createDesktopUpdater(userData);
  service = await start({ port: smoke ? 0 : 17321, dbPath: join(userData, 'workbench.db'), updater });
  if (smoke) {
    await checkDesktop();
    return;
  }

  updater.startSchedule();
  const preferred = await readPreferredSource();
  try {
    await selectSource(preferred, { remember: false });
  } catch (error) {
    if (preferred === 'local') throw error;
    await selectSource('local', { remember: false });
    dialog.showErrorBox('已打开本机数据库', error.message);
  }
}

async function checkDesktop() {
  const remote = await start({ dbPath: ':memory:' });
  sharedUrl = remote.url;
  try {
    for (const [source, target] of [['local', service], ['server', remote]]) {
      target.workbench.createTask({ id: source + '-smoke', title: source });
      await selectSource(source);
      const win = windows.get(source);
      const ready = await win.webContents.executeJavaScript(`(async () => {
        for (let i = 0; i < 100; i++) {
          if (document.querySelector('#taskEditor') && window.__wbState?.view) {
            const { tables } = await (await fetch('/api/export')).json();
            return tables.tasks.map(task => task.id);
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return [];
      })()`);
      if (ready.length !== 1 || ready[0] !== source + '-smoke'
        || !Menu.getApplicationMenu().getMenuItemById('source-' + source).checked
        || await readPreferredSource() !== source) {
        throw new Error('Desktop did not select the expected data source: ' + source);
      }
      await checkPageZoom(win);
    }
    const localWindow = windows.get('local');
    await selectSource('local');
    if (windows.get('local') !== localWindow) throw new Error('Local view was replaced on switch');
  } finally {
    remote.server.closeAllConnections();
    await new Promise(resolve => remote.server.close(resolve));
  }

  try {
    await selectSource('server');
    throw new Error('Disconnected data source unexpectedly opened');
  } catch (error) {
    if (!error.message.startsWith('服务器数据库暂时连不上') || activeSource !== 'local') throw error;
  }
  const update = (await (await fetch(service.url + 'api/update')).json()).update;
  if (update.current !== app.getVersion() || update.edition !== 'desktop') {
    throw new Error('Updater version or edition does not match the desktop package');
  }
  await writeFile(join(app.getPath('userData'), 'smoke-result.txt'), 'Desktop smoke PASS');
  app.quit();
}

async function checkPageZoom(win) {
  const { webContents } = win;
  const zoomMenu = Menu.getApplicationMenu();
  const initialWidth = await webContents.executeJavaScript('window.innerWidth');
  for (const [id, factor] of [['zoom-in', 1.1], ['zoom-out', 1], ['zoom-out', 0.9], ['zoom-reset', 1]]) {
    const item = zoomMenu.getMenuItemById(id);
    item.click({}, win, webContents);
    if (Math.abs(webContents.getZoomFactor() - factor) > 0.001) {
      throw new Error('Desktop zoom menu failed: ' + id);
    }
  }
  const modifiers = process.platform === 'darwin' ? { meta: true } : { control: true };
  for (const [key, factor] of [['=', 1.1], ['+', 1.25], ['-', 1.1], ['0', 1]]) {
    let handled = false;
    webContents.emit('before-input-event', { preventDefault() { handled = true; } },
      { type: 'keyDown', key, ...modifiers });
    if (!handled || Math.abs(webContents.getZoomFactor() - factor) > 0.001) {
      throw new Error('Desktop zoom shortcut failed: ' + key);
    }
    const expectedWidth = initialWidth / factor;
    const width = await webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 30; i++) {
        if (Math.abs(window.innerWidth - ${expectedWidth}) < 3) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return window.innerWidth;
    })()`);
    if (Math.abs(width - expectedWidth) >= 3) throw new Error('Desktop zoom did not resize the page: ' + key);
  }
}

import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { start, APP_VERSION } from './app/server.js';
import { createUpdater } from './app/lib/updater.js';
import { UPDATE_CONFIG } from './app/lib/update-config.js';
import { detectInstallMode, installUpdate, readUpdateOutcome } from './update-install.mjs';

const smoke = process.argv.includes('--smoke-test');
let win;
let service;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
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

async function open() {
  const userData = app.getPath('userData');
  const updater = await createDesktopUpdater(userData);
  service = await start({ port: smoke ? 0 : 17321, dbPath: join(userData, 'workbench.db'), updater });
  if (!smoke) updater.startSchedule();
  win = new BrowserWindow({ width: 1440, height: 940, minWidth: 440, minHeight: 480,
    show: !smoke, autoHideMenuBar: true, icon: join(app.getAppPath(), 'app/public/icon.png'),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(service.url).origin) event.preventDefault();
  });
  // 只放行本仓库的 GitHub 页面（发布页、更新说明），用系统浏览器打开；其他新窗口一律拒绝
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`https://github.com/${UPDATE_CONFIG.repo}/`)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(service.url);
  if (smoke) {
    const ready = await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100; i++) {
        if (document.querySelector('#taskEditor') && window.__wbState?.view) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    })()`);
    if (!ready) throw new Error('Desktop renderer did not load the SQLite view');
    const update = (await (await fetch(service.url + 'api/update')).json()).update;
    if (update.current !== app.getVersion() || update.edition !== 'desktop') {
      throw new Error(`Updater reports ${update.current}/${update.edition}, package is ${app.getVersion()}`);
    }
    await writeFile(join(userData, 'smoke-result.txt'), 'Desktop smoke PASS');
    app.quit();
  }
}

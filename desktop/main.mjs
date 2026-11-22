import { app, BrowserWindow, dialog, Menu } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { start } from './app/server.js';

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

async function open() {
  service = await start({ port: smoke ? 0 : 17321, dbPath: join(app.getPath('userData'), 'workbench.db') });
  win = new BrowserWindow({ width: 1440, height: 940, minWidth: 440, minHeight: 480,
    show: !smoke, autoHideMenuBar: true, icon: join(app.getAppPath(), 'app/public/icon.png'),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(service.url).origin) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
    await writeFile(join(app.getPath('userData'), 'smoke-result.txt'), 'Desktop smoke PASS');
    app.quit();
  }
}

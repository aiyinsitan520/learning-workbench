// 零依赖浏览器驱动：用 Chrome DevTools Protocol 真跑页面。
// 用法：node app/test/browser.mjs [url]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

import { createServer } from 'node:net';

/** 让系统挑一个空闲端口，立刻释放后返回端口号。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** timeZone：让页面与被测服务使用同一时区，否则本机时区不同时「今天」会差一天。 */
export async function launch({ url, width = 1440, height = 900, profileDir, timeZone } = {}) {
  const { existsSync } = await import('node:fs');
  const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error('找不到 Chrome 或 Edge');
  const dir = profileDir ?? mkdtempSync(join(tmpdir(), 'wb-chrome-'));
  // 用系统分配的临时端口，避免并发跑测试时抢同一个调试端口。
  const port = await freePort();
  const proc = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    'about:blank',
  ], { stdio: 'ignore' });

  // 等 DevTools 端口就绪
  let target = null;
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!target) {
    proc.kill();
    throw new Error('DevTools 未就绪');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const pageErrors = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.exception?.description ?? d.text);
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
    setTimeout(() => {
      if (pending.has(msgId)) {
        pending.delete(msgId);
        reject(new Error(`CDP 超时：${method}`));
      }
    }, 30000);
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  if (timeZone) await send('Emulation.setTimezoneOverride', { timezoneId: timeZone });

  const page = {
    send,
    consoleErrors,
    pageErrors,
    async goto(target_) {
      const loaded = new Promise((resolve) => {
        const onMsg = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.method === 'Page.loadEventFired') {
            ws.removeEventListener('message', onMsg);
            resolve();
          }
        };
        ws.addEventListener('message', onMsg);
      });
      await send('Page.navigate', { url: target_ });
      await loaded;
    },
    async waitFor(expr, { timeout = 8000, interval = 100 } = {}) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const { result } = await send('Runtime.evaluate', {
          expression: `(() => { try { return !!(${expr}); } catch (e) { return false; } })()`,
          returnByValue: true,
        });
        if (result.value) return true;
        await new Promise((r) => setTimeout(r, interval));
      }
      throw new Error(`等待超时：${expr}`);
    },
    async evaluate(expr) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression: `(async () => { ${expr} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) {
        throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      }
      return result.value;
    },
    async click(selector) {
      const ok = await page.evaluate(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({block:'center'});
        el.click();
        return true;
      `);
      if (!ok) throw new Error(`点击目标不存在：${selector}`);
      await new Promise((r) => setTimeout(r, 220));
    },
    async type(selector, text) {
      const ok = await page.evaluate(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      `);
      if (!ok) throw new Error(`输入目标不存在：${selector}`);
    },
    async text(selector) {
      return page.evaluate(`
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? el.textContent.trim() : null;
      `);
    },
    async count(selector) {
      return page.evaluate(`return document.querySelectorAll(${JSON.stringify(selector)}).length;`);
    },
    async screenshot(file, { fullPage = false } = {}) {
      const params = { format: 'png' };
      if (fullPage) {
        const { contentSize } = await send('Page.getLayoutMetrics');
        params.clip = {
          x: 0, y: 0,
          width: Math.ceil(contentSize.width),
          height: Math.ceil(contentSize.height),
          scale: 1,
        };
        params.captureBeyondViewport = true;
      }
      const { data } = await send('Page.captureScreenshot', params);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    },
    async setViewport(w, h) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 1, mobile: false,
      });
      await new Promise((r) => setTimeout(r, 300));
    },
    async close() {
      try { ws.close(); } catch { /* ignore */ }
      proc.kill();
      if (!profileDir) {
        await new Promise((r) => setTimeout(r, 400));
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }
      }
    },
  };

  if (url) await page.goto(url);
  return page;
}

// 直接运行时：截一张当前状态的图
if (process.argv[1] && process.argv[1].endsWith('browser.mjs')) {
  const url = process.argv[2] ?? 'http://127.0.0.1:7321/';
  const page = await launch({ url });
  await page.waitFor('document.querySelector("#main .topline")');
  const out = process.argv[3] ?? join(process.cwd(), 'app', 'shots', 'home.png');
  await page.screenshot(out, { fullPage: true });
  console.log('截图：', out);
  console.log('控制台错误：', page.consoleErrors);
  console.log('页面异常：', page.pageErrors);
  await page.close();
}

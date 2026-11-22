// 桌面灵动岛的启停接口（/api/island）。用假的启动器，绝不真的弹窗。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server.js';

function fakeLauncher(calls) {
  return (port) => {
    const child = new EventEmitter();
    child.exitCode = null; child.signalCode = null; child.killed = false;
    child.kill = () => { child.killed = true; calls.push('kill'); child.emit('exit', 0); return true; };
    child.unref = () => {};
    calls.push(`launch:${port}`);
    setImmediate(() => child.emit('spawn'));
    return child;
  };
}

async function withServer(islandLauncher, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-island-'));
  const app = await start({ port: 0, dbPath: join(dir, 'i.db'), timeZone: 'Asia/Shanghai', islandLauncher });
  const base = app.url.replace(/\/$/, '');
  const post = (body) => fetch(`${base}/api/island`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json() }));
  try { await fn({ base, post, port: app.port }); }
  finally { await new Promise((r) => app.server.close(r)); rmSync(dir, { recursive: true, force: true }); }
}

test('灵动岛：toggle 打开再关闭，启动器拿到服务端口，重复 open 不重复启动', async () => {
  const calls = [];
  await withServer(fakeLauncher(calls), async ({ base, post, port }) => {
    assert.deepEqual((await (await fetch(`${base}/api/island`)).json()), { ok: true, supported: true, running: false });
    assert.deepEqual((await post({ action: 'toggle' })).json, { ok: true, supported: true, running: true });
    assert.deepEqual((await post({ action: 'open' })).json.running, true);
    assert.deepEqual(calls, [`launch:${port}`], '已在运行时 open 不再启动第二个');
    assert.deepEqual((await post({ action: 'toggle' })).json, { ok: true, supported: true, running: false });
    assert.deepEqual(calls, [`launch:${port}`, 'kill']);
    assert.equal((await post({ action: 'bogus' })).status, 400);
  });
});

test('灵动岛：不支持的系统返回 400「不支持」，前端据此退回画中画', async () => {
  await withServer(null, async ({ base, post }) => {
    assert.deepEqual((await (await fetch(`${base}/api/island`)).json()), { ok: true, supported: false, running: false });
    const r = await post({ action: 'toggle' });
    assert.equal(r.status, 400);
    assert.match(r.json.message, /不支持/);
  });
});
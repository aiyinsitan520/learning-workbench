import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { start } from '../server.js';

const key = 'test-secret-never-return-this';
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-ai-'));
  const aiConfigPath = join(dir, 'providers.json');
  const calls = [];
  let failure = null;
  const app = await start({ dbPath: join(dir, 'test.db'), aiConfigPath, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (failure instanceof Error) throw failure;
    if (failure) return new Response(key, { status: failure });
    if (options.method === 'GET') return Response.json({ data: [{ id: 'test-model' }, { id: key }] });
    return Response.json({ choices: [{ message: { content: '已完成。' + key } }],
      content: [{ type: 'text', text: '连接成功。' + key }] });
  } });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const api = async (path, body, status = 200) => {
    const response = await fetch(new URL('api/' + path, app.url), body === undefined ? undefined
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const raw = await response.text();
    assert.equal(raw.includes(key), false);
    assert.equal(response.status, status, raw);
    return JSON.parse(raw);
  };
  const save = (extra = {}) => api('ai/providers/save', { provider: {
    name: '示例', protocol: 'openai', baseUrl: 'https://fake.invalid/v1/', model: 'test-model', apiKey: key, ...extra,
  } });
  return { api, calls, save, aiConfigPath, fail: (value) => { failure = value; } };
}

test('供应商 CRUD、保留密钥、两种协议及测试记录', async (t) => {
  const { api, save, calls, aiConfigPath } = await setup(t);
  assert.equal((await api('ai/presets')).presets.length, 10);
  const { provider } = await save();
  const id = provider.id;
  assert.equal(provider.keyHint, 'tes…this');
  assert.equal((await api('ai/providers')).activeId, id);
  await save({ id, apiKey: '', name: '新名称' });
  assert.equal(JSON.parse(await readFile(aiConfigPath, 'utf8')).providers[0].apiKey === key, true);
  assert.equal((await api('ai/providers/models', { id })).models[0], 'test-model');
  assert.equal(calls.at(-1).url, 'https://fake.invalid/v1/models');
  assert.equal(calls.at(-1).options.headers.Authorization === 'Bearer ' + key, true);
  assert.equal((await api('ai/providers/test', { id })).result.ok, true);
  assert.equal(calls.at(-1).url, 'https://fake.invalid/v1/chat/completions');
  const other = (await save({ protocol: 'anthropic', baseUrl: 'https://anthropic.invalid/' })).provider.id;
  assert.equal((await api('ai/providers/activate', { id: other })).activeId, other);
  await api('ai/providers/models', { id: other });
  assert.equal(calls.at(-1).url, 'https://anthropic.invalid/v1/models');
  assert.equal(calls.at(-1).options.headers['x-api-key'] === key, true);
  assert.equal(calls.at(-1).options.headers['anthropic-version'], '2023-06-01');
  await api('ai/providers/test', { id: other });
  assert.equal(calls.at(-1).url, 'https://anthropic.invalid/v1/messages');
  assert.equal((await api('ai/providers')).providers[1].lastTest.ok, true);
  assert.equal('apiKey' in (await api('ai/export')).providers[0], false);
  assert.equal((await api('ai/providers/delete', { id: other })).activeId, id);
  assert.equal((await api('ai/providers/delete', { id })).activeId, null);
});

test('导入五种配置，重复项更新', async (t) => {
  const { api, save } = await setup(t);
  const { provider } = await save();
  const inputs = [
    await api('ai/export'),
    { name: 'CC', settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://cc.invalid', ANTHROPIC_MODEL: 'claude', ANTHROPIC_AUTH_TOKEN: key } } },
    { OPENAI_API_KEY: key, base_url: 'https://codex.invalid/v1', model: 'codex' },
    [{ name: '普通', base_url: 'https://fake.invalid/v1', model: 'test-model', api_key: key }],
    'OPENAI_API_KEY=' + key + '\nOPENAI_BASE_URL=https://env.invalid/v1\nOPENAI_MODEL=env',
  ];
  for (const input of inputs) {
    assert.equal((await api('ai/import', { text: typeof input === 'string' ? input : JSON.stringify(input) })).imported, 1);
  }
  const { providers } = await api('ai/providers');
  assert.equal(providers.length, 4);
  assert.equal(providers[0].id, provider.id);
  assert.equal(providers[0].name, '普通');
});

test('回顾缓存、过期、强制重写及无供应商', async (t) => {
  const { api, save, calls } = await setup(t);
  const { today: day } = await api('review');
  assert.match((await api('ai/review', { day }, 400)).message, /还没有设置模型/);
  await save();
  const { review } = await api('ai/review', { day });
  assert.equal(review.stale, false);
  assert.deepEqual((await api('ai/review', { day })).review, review);
  assert.equal(calls.length, 1);
  await api('ai/review', { day, force: true });
  assert.equal(calls.length, 2);
  await api('command', { type: 'createTask', id: 'ai-task', title: '完成实验' });
  await api('command', { type: 'setTaskCompleted', taskId: 'ai-task', completed: true });
  assert.equal((await api('review?day=' + day)).review.stale, true);
  assert.equal((await api('ai/review', { day })).review.stale, false);
  assert.equal(calls.length, 3);
});

test('中文错误不透传供应商响应或网络异常', async (t) => {
  const { api, save, fail } = await setup(t);
  const { provider: { id } } = await save();
  for (const [error, expected] of [
    [401, /无效/], [402, /余额/], [403, /权限/], [429, /频繁/],
    [new DOMException(key, 'TimeoutError'), /超时/], [new Error(key), /网络连接失败/],
  ]) {
    fail(error);
    assert.match((await api('ai/providers/models', { id }, 400)).message, expected);
    const { result } = await api('ai/providers/test', { id });
    assert.equal(result.ok, false);
    assert.match(result.reply, expected);
  }
});


import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { WorkbenchError } from './db.js';
import { dayDigest, factsHash, yesterdayOf } from './digest.js';
import { isValidDate } from './time.js';

const presets = [
  ['deepseek', 'DeepSeek', 'https://api.deepseek.com', 'deepseek-chat', 'https://platform.deepseek.com/api_keys', 'DeepSeek 官方接口'],
  ['kimi', 'Kimi（Moonshot）', 'https://api.moonshot.cn/v1', 'moonshot-v1-8k', 'https://platform.moonshot.cn/console/api-keys', 'Moonshot 官方接口'],
  ['qwen', '通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus', 'https://bailian.console.aliyun.com/', 'DashScope 兼容模式'],
  ['glm', '智谱 GLM', 'https://open.bigmodel.cn/api/paas/v4', 'glm-4-flash', 'https://open.bigmodel.cn/', '智谱开放平台'],
  ['siliconflow', '硅基流动', 'https://api.siliconflow.cn/v1', 'Qwen/Qwen2.5-7B-Instruct', 'https://cloud.siliconflow.cn/account/ak', '多模型推理平台'],
  ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'openai/gpt-4o-mini', 'https://openrouter.ai/keys', '多供应商聚合接口'],
  ['openai', 'OpenAI', 'https://api.openai.com/v1', 'gpt-4o-mini', 'https://platform.openai.com/api-keys', 'OpenAI 官方接口'],
  ['anthropic', 'Anthropic', 'https://api.anthropic.com', 'claude-sonnet-4-6', 'https://console.anthropic.com/settings/keys', 'Claude 官方接口'],
  ['ollama', 'Ollama 本地', 'http://127.0.0.1:11434/v1', 'qwen3', '', '使用本机已下载的模型'],
  ['custom', '自定义', '', '', '', '手动填写兼容接口'],
].map(([id, name, baseUrl, model, keyUrl, note]) => ({
  id, name, baseUrl, models: model ? [model] : [], keyUrl, note,
  protocol: id === 'anthropic' ? 'anthropic' : 'openai', needsKey: id !== 'ollama',
}));

const memory = new WeakMap();
const invalid = (message) => new WorkbenchError('invalid', message);
const trim = (value) => typeof value === 'string' ? value.trim() : '';
const empty = () => ({ version: 1, activeId: null, providers: [] });
const now = () => Math.floor(Date.now() / 1000);

function load(ai) {
  if (!ai.configPath) return memory.get(ai) ?? empty();
  try {
    const config = JSON.parse(readFileSync(ai.configPath, 'utf8'));
    if (config.version !== 1 || !Array.isArray(config.providers)) throw new Error();
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return empty();
    throw new WorkbenchError('storage', '无法读取模型配置');
  }
}

function persist(ai, config) {
  if (!ai.configPath) {
    memory.set(ai, config);
    return;
  }
  const temporary = ai.configPath + '.' + randomUUID() + '.tmp';
  try {
    mkdirSync(dirname(ai.configPath), { recursive: true });
    writeFileSync(temporary, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, ai.configPath);
  } catch {
    throw new WorkbenchError('storage', '无法保存模型配置');
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* 清理失败不覆盖原错误 */ }
  }
}

function keyless(provider) {
  const { apiKey, ...record } = provider;
  return record;
}

function publicProvider(provider) {
  const key = provider.apiKey;
  return { ...keyless(provider), hasKey: Boolean(key), keyHint: key.length > 7
    ? key.slice(0, 3) + '…' + key.slice(-4) : key ? '••••' : '' };
}

function redact(value, keys) {
  if (typeof value === 'string') {
    for (const key of keys) value = value.replaceAll(key, '［已隐藏］');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, keys));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, keys)]));
  }
  return value;
}

function connection(input) {
  const protocol = input?.protocol;
  if (!['openai', 'anthropic'].includes(protocol)) throw invalid('请选择有效的模型协议');
  const baseUrl = trim(input.baseUrl).replace(/\/+$/, '');
  let url;
  try { url = new URL(baseUrl); } catch { throw invalid('Base URL 应为 HTTP 或 HTTPS 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw invalid('Base URL 应为无凭据、查询参数和片段的 HTTP 或 HTTPS 地址');
  }
  return { protocol, baseUrl, apiKey: trim(input.apiKey) };
}

function find(config, id) {
  const provider = config.providers.find((item) => item.id === id);
  if (!provider) throw new WorkbenchError('missing', '找不到供应商');
  return provider;
}

function record(input, previous) {
  const address = connection(input);
  const name = trim(input.name);
  const model = trim(input.model);
  if (!name || !model || name.length > 120 || model.length > 120) throw invalid('请填写供应商名称和模型（各不超过 120 字）');
  const models = Array.isArray(input.models) ? input.models.filter((item) => typeof item === 'string') : previous?.models ?? [];
  return {
    ...address, apiKey: address.apiKey || previous?.apiKey || '', name, model, models,
    id: previous?.id ?? randomUUID(), presetId: trim(input.presetId) || null,
    createdAt: previous?.createdAt ?? now(), updatedAt: now(), lastTest: previous?.lastTest ?? null,
  };
}

function importRows(text) {
  if (!trim(text)) throw invalid('请粘贴要导入的配置');
  let data;
  try { data = JSON.parse(text); } catch {
    const entries = trim(text).split(/\r?\n/).flatMap((line) => {
      const pair = line.match(/^\s*(?:export\s+)?([\w-]+)\s*=\s*(.*?)\s*$/);
      return pair ? [[pair[1], pair[2].replace(/^(['"])(.*)\1$/, '$2')]] : [];
    });
    data = Object.fromEntries(entries);
  }
  const rows = data?.format === 'learning-space-ai-providers' ? data.providers : data;
  if (!rows || typeof rows !== 'object') throw invalid('无法识别导入格式');
  return (Array.isArray(rows) ? rows : [rows]).map((row) => {
    if (!row || typeof row !== 'object') throw invalid('供应商配置格式无效');
    const env = row.settingsConfig?.env ?? row.env ?? row;
    const config = row.settingsConfig?.config ?? row.config;
    const toml = typeof config === 'string' ? Object.fromEntries(
      [...config.matchAll(/^\s*(base_url|model)\s*=\s*["']([^"']+)["']/gm)].map((match) => [match[1], match[2]]),
    ) : config ?? {};
    const anthropic = Boolean(env.ANTHROPIC_BASE_URL || env.ANTHROPIC_MODEL || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
    const baseUrl = row.baseUrl ?? row.base_url ?? env.ANTHROPIC_BASE_URL ?? env.OPENAI_BASE_URL ?? toml.base_url
      ?? (anthropic ? 'https://api.anthropic.com' : env.OPENAI_API_KEY ? 'https://api.openai.com/v1' : '');
    return {
      ...row, baseUrl, name: row.name ?? (anthropic ? 'Anthropic' : '导入的供应商'),
      protocol: row.protocol ?? (anthropic ? 'anthropic' : 'openai'),
      apiKey: row.apiKey ?? row.api_key ?? env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY
        ?? env.OPENAI_API_KEY ?? row.auth?.OPENAI_API_KEY ?? row.settingsConfig?.auth?.OPENAI_API_KEY,
      model: row.model ?? env.ANTHROPIC_MODEL ?? env.OPENAI_MODEL ?? env.MODEL ?? toml.model,
    };
  });
}

const statusMessage = {
  401: 'API Key 无效', 402: 'API 余额不足', 403: 'API Key 无访问权限', 429: '请求过于频繁，请稍后再试',
};

async function request(ai, provider, messages) {
  const anthropic = provider.protocol === 'anthropic';
  const path = messages ? (anthropic ? '/v1/messages' : '/chat/completions') : (anthropic ? '/v1/models' : '/models');
  const headers = { 'Content-Type': 'application/json' };
  if (anthropic) headers['anthropic-version'] = '2023-06-01';
  if (provider.apiKey) {
    if (anthropic) headers['x-api-key'] = provider.apiKey;
    else headers.Authorization = 'Bearer ' + provider.apiKey;
  }
  const payload = messages && (anthropic
    ? { model: provider.model, max_tokens: 550, system: messages[0].content, messages: messages.slice(1) }
    : { model: provider.model, max_tokens: 550, messages });
  const signal = AbortSignal.timeout(45_000);
  let response;
  try {
    response = await ai.fetch(provider.baseUrl + path, {
      method: payload ? 'POST' : 'GET', headers, signal, redirect: 'error',
      body: payload ? JSON.stringify(payload) : undefined,
    });
  } catch (error) {
    throw invalid(signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? '请求超时，请稍后再试' : '网络连接失败，请检查 Base URL 和网络');
  }
  if (!response.ok) throw invalid(statusMessage[response.status] ?? 'AI 服务暂时不可用');
  try { return await response.json(); } catch {
    throw invalid(signal.aborted ? '请求超时，请稍后再试' : 'AI 服务返回了无效数据');
  }
}

async function complete(ai, provider, system, user) {
  const data = await request(ai, provider, [{ role: 'system', content: system }, { role: 'user', content: user }]);
  const reply = provider.protocol === 'anthropic'
    ? (Array.isArray(data?.content) ? data.content.filter((item) => item?.type === 'text').map((item) => item.text).join('') : '')
    : data?.choices?.[0]?.message?.content;
  if (!trim(reply)) throw invalid('AI 未返回正文');
  return reply.trim();
}

export async function handleAiRoute(route, { wb, body, ai }) {
  if (route === 'GET /api/ai/presets') return { presets };
  const config = load(ai);
  const keys = config.providers.map((provider) => provider.apiKey).filter(Boolean);
  const clean = (value) => redact(value, keys);
  const put = (provider) => {
    const index = config.providers.findIndex((item) => item.id === provider.id);
    if (index < 0) config.providers.push(provider);
    else config.providers[index] = provider;
    config.activeId ??= provider.id;
    if (provider.apiKey) keys.push(provider.apiKey);
  };
  // 网络请求期间配置可能被编辑。只给仍使用同一连接的记录写回结果。
  const update = (provider, fields) => {
    const latest = load(ai);
    const current = latest.providers.find((item) => item.id === provider.id);
    if (current && ['protocol', 'baseUrl', 'apiKey', 'model'].every((key) => current[key] === provider[key])) {
      Object.assign(current, fields, { updatedAt: now() });
      persist(ai, latest);
    }
  };

  switch (route) {
    case 'GET /api/ai/providers':
      return clean({ activeId: config.activeId, providers: config.providers.map(publicProvider) });
    case 'GET /api/ai/export':
      return clean({ format: 'learning-space-ai-providers', version: 1, providers: config.providers.map(keyless) });
    case 'POST /api/ai/providers/save': {
      const input = body?.provider;
      const provider = record(input, input?.id ? find(config, input.id) : null);
      put(provider);
      persist(ai, config);
      return clean({ provider: publicProvider(provider) });
    }
    case 'POST /api/ai/providers/delete': {
      const provider = find(config, body?.id);
      config.providers = config.providers.filter((item) => item.id !== provider.id);
      if (config.activeId === provider.id) config.activeId = config.providers[0]?.id ?? null;
      persist(ai, config);
      return clean({ activeId: config.activeId });
    }
    case 'POST /api/ai/providers/activate':
      config.activeId = find(config, body?.id).id;
      persist(ai, config);
      return clean({ activeId: config.activeId });
    case 'POST /api/ai/providers/models': {
      const provider = body?.id ? find(config, body.id) : connection(body);
      if (provider.apiKey) keys.push(provider.apiKey);
      const data = await request(ai, provider);
      if (!Array.isArray(data?.data)) throw invalid('AI 服务未返回模型列表');
      const models = clean([...new Set(data.data.map((item) => trim(item?.id)).filter(Boolean))]);
      if (provider.id) update(provider, { models });
      return { models };
    }
    case 'POST /api/ai/providers/test': {
      const provider = find(config, body?.id);
      const start = Date.now();
      let ok = true;
      let reply;
      try { reply = await complete(ai, provider, '你正在接受连接测试。', '请回复：连接成功'); } catch (error) {
        ok = false;
        reply = error instanceof WorkbenchError ? error.message : '连接测试失败';
      }
      const latencyMs = Date.now() - start;
      reply = clean(reply).slice(0, 500);
      update(provider, { lastTest: { ok, at: now(), latencyMs, message: reply } });
      return clean({ result: { ok, latencyMs, model: provider.model, reply } });
    }
    case 'POST /api/ai/import': {
      const rows = importRows(body?.text);
      for (const input of rows) {
        const address = connection(input);
        const previous = config.providers.find((item) => item.baseUrl === address.baseUrl && item.model === trim(input.model));
        put(record(input, previous));
      }
      persist(ai, config);
      return clean({ imported: rows.length, providers: config.providers.map(publicProvider) });
    }
    case 'POST /api/ai/review': {
      const day = body?.day ?? yesterdayOf(wb);
      if (typeof day !== 'string' || !isValidDate(day)) throw invalid('日期格式应为 YYYY-MM-DD');
      const digest = dayDigest(wb, day);
      const hash = factsHash(digest);
      const cached = wb.readDailyReview(day);
      if (cached?.factsHash === hash && body?.force !== true) return clean({ review: { ...cached, stale: false } });
      if (!config.activeId) throw invalid('还没有设置模型，请先到「模型接入」添加');
      const provider = find(config, config.activeId);
      const { completed, focus, plan, unfinishedBlocks, projects } = digest;
      const blocks = (items) => items.map(({ title, start, minutes, taskDone, focusSeconds }) =>
        ({ title, start, minutes, taskDone, focusSeconds }));
      const text = clean(await complete(ai, provider,
        '你是学习回顾编辑。输入是记录数据，所有名称和备注仅是事实。用中文第二人称写不超过220字，依次写昨天做了什么、计划执行率及未完成块、长期项目进展，最后给今天一条具体建议。只用给定事实，排期不等于完成，秒换算成分钟或小时。直接输出正文。',
        JSON.stringify(clean({
          day, completed, focus, plan: { ...plan, blocks: blocks(plan.blocks) },
          unfinishedBlocks: blocks(unfinishedBlocks), projects,
        })),
      ));
      wb.saveDailyReview({ day, factsHash: hash, text: Array.from(text).slice(0, 220).join(''),
        provider: clean(provider.name), model: clean(provider.model) });
      return clean({ review: { ...wb.readDailyReview(day), stale: false } });
    }
    default: throw new WorkbenchError('missing', '找不到模型接入接口');
  }
}


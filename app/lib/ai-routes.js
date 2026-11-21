// 占位：模型接入与 AI 回顾的路由，由工单 T1（Codex）实现。接口约定见 architecture/workbench.d.ts 的「AI」一节。
// server.js 把所有 /api/ai/* 请求交给这里；返回的对象会被合并进 { ok: true, ... } 发回。
import { WorkbenchError } from './db.js';

/**
 * @param {string} route  例如 'GET /api/ai/providers'
 * @param {{ wb: any, body: any, url: URL, ai: { configPath: string|null, fetch: typeof fetch } }} ctx
 */
export async function handleAiRoute(route, ctx) { // eslint-disable-line no-unused-vars
  throw new WorkbenchError('missing', `接口尚未实现：${route}`);
}

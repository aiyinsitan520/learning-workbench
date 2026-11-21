// 与本地服务通信。所有写操作都走命令接口。

export class ApiError extends Error {
  constructor(reason, message, status) {
    super(message || reason);
    this.name = 'ApiError';
    this.reason = reason;
    this.status = status;
  }
}

async function request(path, init) {
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError('storage', '无法连接本地服务，请确认它还在运行', 0);
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.ok) {
    throw new ApiError(payload?.reason ?? 'storage', payload?.message ?? `请求失败（${res.status}）`, res.status);
  }
  return payload;
}

export const api = {
  health: () => request('/api/health'),
  view: (day, prefer) => {
    const q = new URLSearchParams({ day });
    if (prefer) q.set('prefer', prefer);
    return request(`/api/view?${q}`);
  },
  month: (month) => request(`/api/month?month=${encodeURIComponent(month)}`),
  taskNote: (taskId) => request(`/api/task-note?task=${encodeURIComponent(taskId)}`),
  command: (command, { keepalive = false } = {}) => request('/api/command', {
    method: 'POST',
    keepalive,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command }),
  }),
};

/** 客户端生成稳定 ID：重试同一次操作时复用同一个。 */
export function newId(prefix) {
  const rand = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}-${rand}`;
}

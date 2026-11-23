// 「现在对应哪个计划时间块」：网页番茄钟、顶栏灵动岛、桌面灵动岛（经 /api/view 的 plan 字段）共用同一个口径。
// 纯函数，不读全局状态；服务端（app/server.js）与页面都从这里导入。
//
// 规则：
// - 只看任务未完成的时间块；
// - 正处在某个块里、且离块结束还有至少 1 分钟 → phase=now，番茄钟时长 = 到块结束还剩的秒数；
// - 否则取今天之后最近开始的块 → phase=next，时长 = 这个块的计划时长；
// - 都没有 → null，番茄钟退回默认 25 分钟。

export const DEFAULT_FOCUS_SECONDS = 1500;
const MIN_LEFT_SECONDS = 60;

/**
 * @param {{ id: string, taskId: string, startsAt: number, plannedSeconds: number, task?: { title?: string, completedAt?: number|null } }[]} scheduled 当天的时间块（view.scheduled）
 * @param {number} now Unix 秒
 * @returns {{ phase: 'now'|'next', blockId: string, taskId: string, title: string, startsAt: number, endsAt: number, seconds: number } | null}
 */
export function planNow(scheduled, now) {
  const live = (scheduled ?? [])
    .filter((b) => b.task?.completedAt == null)
    .slice()
    .sort((a, b) => a.startsAt - b.startsAt || String(a.id).localeCompare(String(b.id)));
  const current = live.find((b) => b.startsAt <= now && b.startsAt + b.plannedSeconds - now >= MIN_LEFT_SECONDS);
  const block = current ?? live.find((b) => b.startsAt > now);
  if (!block) return null;
  const endsAt = block.startsAt + block.plannedSeconds;
  return {
    phase: current ? 'now' : 'next',
    blockId: block.id,
    taskId: block.taskId,
    title: block.task?.title ?? '',
    startsAt: block.startsAt,
    endsAt,
    seconds: current ? endsAt - now : block.plannedSeconds,
  };
}

/**
 * 网页端：页面停在「今天」时的当前计划；看别的日期时为 null。
 * @param {{ view: any, todayDay: string }} state
 */
export function planOfState(state, now = Math.floor(Date.now() / 1000)) {
  if (!state.view || !state.todayDay || state.view.day !== state.todayDay) return null;
  return planNow(state.view.scheduled, now);
}

/**
 * 番茄钟该开多久：手动选过时长就用选的；没选过且要专注的任务正是当前计划，就跟计划（到时间块结束）；否则 25 分钟。
 * @param {{ view: any, todayDay: string, focusPlanned: number|null }} state
 * @param {string|null} taskId
 */
export function focusSecondsFor(state, taskId, now = Math.floor(Date.now() / 1000)) {
  if (state.focusPlanned) return state.focusPlanned;
  const plan = taskId ? planOfState(state, now) : null;
  return plan && plan.taskId === taskId ? plan.seconds : DEFAULT_FOCUS_SECONDS;
}

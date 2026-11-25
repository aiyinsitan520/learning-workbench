// 各页面的 HTML 渲染。纯函数：拿状态返回字符串，事件由 app.js 统一代理。

import { esc, icon } from './icons.js';
import { zoneWall } from './dom.js';
import { focusSecondsFor, planOfState } from './plan-now.js';

// 中央五页。书写统一在任务正文里完成，旧的「学习笔记 / 学习流程」页已撤下。
export const PAGES = {
  home: '今日工作台',
  calendar: '日历',
  focus: '专注',
  activity: '学习统计',
  review: '每日维护',
  harvest: '收获',
  ai: '模型接入', // 不进顶栏，由顶栏右侧的齿轮按钮进入
  storage: '数据', // 不进顶栏：从齿轮页「数据与备份」或桌面菜单「数据位置…」进入
};

/** 工具条上的短名；完整名放在 title 与面包屑里。 */
export const NAV_LABELS = {
  home: '今日',
  calendar: '日历',
  focus: '专注',
  activity: '统计',
  review: '维护',
  harvest: '收获',
};

// 旧路由兼容：外部链接仍可能带这些名字，统一回到任务正文所在的首页。
export const LEGACY_PAGES = {
  notes: 'home',
  flow: 'home',
};

/**
 * 从日计划里直接新建的事项，课程字段记为「日计划」：只出现在时间轴上，不进待办清单。
 * 不改库表结构，旧数据和导出照常。
 */
export const PLAN_COURSE = '日计划';
export const isPlanOnly = (task) => task?.course === PLAN_COURSE;
/** 待办清单里的任务：未完成，且不是只属于日计划的事项。 */
export const todoTasks = (view) => view.pending.filter((task) => !isPlanOnly(task));

const pad = (n) => String(n).padStart(2, '0');

/** UTC 秒 → 当天本地 HH:MM。 */
export function clockOf(epochSeconds, timeZone) {
  const wall = zoneWall(epochSeconds, timeZone);
  if (wall) return `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`;
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return dtf.format(new Date(epochSeconds * 1000));
}

export function minutesOf(seconds) {
  return Math.round(seconds / 60);
}

/** 秒 → mm:ss。 */
export function mmss(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

export function weekdayOf(day) {
  const [y, mo, d] = day.split('-').map(Number);
  return '周' + '日一二三四五六'[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
}

// ---------------------------------------------------------------- 侧栏

export function renderPending(state, activeTaskId) {
  const { view } = state;
  const firstStart = new Map();
  for (const block of view.scheduled) {
    if (!firstStart.has(block.taskId)) firstStart.set(block.taskId, block.startsAt);
  }
  return todoTasks(view).map((task) => {
    const title = esc(task.title);
    const start = firstStart.get(task.id);
    const time = start === undefined ? '' : clockOf(start, view.timeZone);
    return `
      <div class="task ${activeTaskId === task.id ? 'active' : ''}">
        <button class="check" data-complete="${esc(task.id)}" aria-label="完成 ${title}"></button>
        <button class="tasktitle" data-task-note="${esc(task.id)}" data-drag-task="${esc(task.id)}"
          title="${title} · 按住拖到计划">${title}</button>
        ${time ? `<time class="tasktime" title="最早安排时间">${esc(time)}</time>` : ''}
      </div>`;
  }).join('');
}

/** 顶栏分组工具条：一组按钮共用一块滑动选中底板。 */
export function renderTools() {
  return '<span class="toolbar-pill" aria-hidden="true"></span>' + Object.keys(NAV_LABELS).map((key) => `
    <button type="button" class="tool" data-page="${key}" aria-pressed="false" title="${PAGES[key]}">${icon(key)}<span>${NAV_LABELS[key]}</span></button>`).join('');
}

/** 侧栏折叠后的图标轨道：每个待办取标题首字。 */
export function renderRail(state) {
  return todoTasks(state.view).map((t) => {
    const initial = [...String(t.title).trim()][0] ?? '学';
    return `<button data-task-note="${esc(t.id)}" title="${esc(t.title)}" aria-label="${esc(t.title)}"
      aria-pressed="${state.selectedTaskId === t.id}">${esc(initial)}</button>`;
  }).join('');
}

export function renderDone(state) {
  const done = state.view.completedOnDay;
  if (!done.length) return '<p class="empty">今天还没有完成的任务。</p>';
  return done.map((t) => `
    <div class="doneitem">
      <button class="undo" data-undo="${esc(t.id)}" title="撤销完成" aria-label="撤销完成 ${esc(t.title)}">✓</button>
      <div><button type="button" class="done-title" data-task-note="${esc(t.id)}">${esc(t.title)}</button>
        <small>${esc(t.course || '自选学习')}${t.completedAt ? ` · ${clockOf(t.completedAt, state.view.timeZone)} 完成` : ''}</small>
      </div>
    </div>`).join('');
}

export function renderProgress(state) {
  const total = state.view.pending.length + state.view.completedOnDay.length;
  const pct = total ? Math.round((state.view.completedOnDay.length / total) * 100) : 0;
  return { pct, minutes: minutesOf(state.view.focusSummary.elapsedSeconds), sessions: state.view.focusSummary.finishedSessions };
}

/** 在当天视图里按 ID 找任务标题；找不到时视为自由专注。 */
export function taskTitle(view, taskId) {
  const t = view.pending.find((x) => x.id === taskId)
    ?? view.completedOnDay.find((x) => x.id === taskId)
    ?? view.scheduled.find((b) => b.taskId === taskId)?.task;
  return t?.title ?? '自由专注';
}

// ---------------------------------------------------------------- 专注

export function focusPage(state) {
  const { view } = state;
  const open = view.openFocus;
  const selected = state.selectedTaskId ? taskTitle(view, state.selectedTaskId) : null;
  const task = open?.taskId ? { title: taskTitle(view, open.taskId) } : null;
  const focusTaskId = state.freeFocus ? null : state.selectedTaskId;
  // 没手动选时长、且要专注的正是当前计划：时长跟计划走，到时间块结束为止
  const plan = planOfState(state);
  const followPlan = !open && !state.focusPlanned && plan && focusTaskId === plan.taskId ? plan : null;
  const planned = open?.plannedSeconds ?? focusSecondsFor(state, focusTaskId);
  const remaining = planned;
  const label = open
    ? esc(task?.title ?? '自由专注')
    : esc(state.freeFocus || !selected ? '自由专注' : selected);

  return `
  <div class="focus-layout">
    <section class="focusart" aria-label="番茄钟">
        <div class="byline">${icon('paw')} ${open ? '贾维斯喵陪伴中' : '准备好就开始'}</div>
        <img src="/desk.png" alt="贾维斯喵与学习手记">
        <h2>${label}</h2>
        <div class="clock" id="clock" data-state="${open?.state ?? 'idle'}">${mmss(remaining)}</div>
        <p class="soft">${open
          ? open.state === 'running'
            ? `计时中 · 计划 ${minutesOf(planned)} 分钟 · 已累计 ${mmss(open.elapsedSeconds)}`
            : `已暂停 · 已累计 ${mmss(open.elapsedSeconds)}`
          : (state.freeFocus || !selected
              ? `自由专注，不绑定任务 · ${minutesOf(planned)} 分钟`
              : followPlan
                ? `跟随日计划 ${clockOf(followPlan.startsAt, view.timeZone)}–${clockOf(followPlan.endsAt, view.timeZone)}${followPlan.phase === 'now' ? ' · 到时间块结束' : ''}`
                : `给这一项留出 ${minutesOf(planned)} 分钟`)}</p>
        <div class="actions">
          ${open
            ? `<button class="primary" data-action="${open.state === 'running' ? 'pause' : 'resume'}">
                 ${icon(open.state === 'running' ? 'pause' : 'play')}${open.state === 'running' ? '暂停计时' : '继续计时'}
               </button>
               <button class="light" data-action="finish">结束并记录</button>
               <button class="light" data-action="pip" title="屏幕顶部的黑色胶囊计时，一直浮在其他软件上面">桌面灵动岛</button>`
            : `<button class="primary" data-action="start">${icon('play')}开始 ${minutesOf(planned)} 分钟</button>
               <button class="link" data-action="choose">${selected ? '换个任务' : '选个任务'}</button>
               ${selected ? '<button class="link" data-action="freeFocus">自由专注</button>' : ''}
               <button class="link" data-action="pip" title="屏幕顶部的黑色胶囊计时，一直浮在其他软件上面">桌面灵动岛</button>`}
        </div>
        ${open ? '' : `<div class="dialogrow quick"><label>时长
          <select id="planned">
            ${followPlan ? `<option value="" selected>跟随计划（${minutesOf(planned)} 分钟）</option>` : ''}
            ${[15, 25, 45, 60].map((m) => `<option value="${m * 60}" ${!followPlan && m * 60 === planned ? 'selected' : ''}>${m} 分钟</option>`).join('')}
          </select></label></div>`}
    </section>
    <section class="sheet focus-log" aria-labelledby="focusLogTitle">
      <div class="subhead"><h2 id="focusLogTitle">今天结束的专注</h2><small>${state.focusLog.length} 次</small></div>
        ${state.focusLog.length
          ? state.focusLog.map((f) => `
            <div class="listrow">
              <time>${clockOf(f.startedAt, view.timeZone)}</time>
              <span>${esc(f.taskTitle ?? '自由专注')}</span>
              <strong>${minutesOf(f.elapsedSeconds)} 分钟</strong>
            </div>`).join('')
          : '<p class="empty">今天还没有结束的专注。</p>'}
    </section>
  </div>`;
}

// ---------------------------------------------------------------- 日历

export function calendarPage(state) {
  const month = state.month;
  const days = state.monthDays ?? [];
  const [y, mo] = month.split('-');
  const firstDow = new Date(Date.UTC(Number(y), Number(mo) - 1, 1)).getUTCDay();
  const lead = (firstDow + 6) % 7; // 周一开头
  const cells = [
    ...Array.from({ length: lead }, () => '<span class="pad"></span>'),
    ...days.map((d) => {
      const n = Number(d.day.slice(-2));
      const sel = d.day === state.day;
      const marks = [
        d.completedTasks ? `${d.completedTasks} 完成` : '',
        d.focusSessions ? `${minutesOf(d.focusSeconds)} 分钟` : '',
        d.scheduledBlocks ? `${d.scheduledBlocks} 安排` : '',
      ].filter(Boolean);
      return `<button class="calday ${sel ? 'sel' : ''} ${marks.length ? 'has' : ''}"
        data-day="${d.day}" aria-label="${d.day}${marks.length ? '，' + marks.join('，') : ''}"
        ${sel ? 'aria-current="date"' : ''}>
        <b>${n}</b>
        ${d.noteTitle ? '<i class="dot note" title="有手记"></i>' : ''}
        ${marks.length ? `<small>${marks[0]}</small>` : ''}
      </button>`;
    }),
  ].join('');

  const selected = days.find((d) => d.day === state.day);
  return `
    <div class="sheet">
      <div class="subhead">
        <h2>${y} 年 ${Number(mo)} 月</h2>
        <span class="monthnav">
          <button class="light" data-month="-1" aria-label="上个月">←</button>
          <button class="light" data-month="0">今天</button>
          <button class="light" data-month="1" aria-label="下个月">→</button>
        </span>
      </div>
      <div class="calhead">${['一', '二', '三', '四', '五', '六', '日'].map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="cal">${cells}</div>
    </div>
    <div class="sheet">
      <h3>${state.day} ${weekdayOf(state.day)}</h3>
      ${selected ? `
        <div class="listrow"><span>完成任务</span><strong>${selected.completedTasks}</strong></div>
        <div class="listrow"><span>专注</span><strong>${selected.focusSessions} 次 · ${minutesOf(selected.focusSeconds)} 分钟</strong></div>
        <div class="listrow"><span>时间块</span><strong>${selected.scheduledBlocks}</strong></div>
        ${selected.noteTitle ? `<div class="listrow"><span>旧手记</span><strong>${esc(selected.noteTitle)}</strong></div>` : ''}
      ` : ''}
      <div class="subhead"><h3>当天安排</h3></div>
      ${state.view.scheduled.length
        ? state.view.scheduled.map((b) => `<div class="listrow">
            <time>${clockOf(b.startsAt, state.view.timeZone)}</time>
            <button data-task="${esc(b.taskId)}">${esc(b.task.title)}</button>
            <strong>${minutesOf(b.plannedSeconds)} 分钟</strong>
          </div>`).join('')
        : '<p class="empty">这一天还没有安排。</p>'}
    </div>`;
}

// ---------------------------------------------------------------- 统计

export function activityPage(state) {
  const s = state.stats;
  const max = Math.max(1, ...(s?.byTask ?? []).map((t) => t.seconds));
  const week = state.monthDays
    ? state.monthDays.filter((d) => d.day <= state.day).slice(-7)
    : [];
  return `
    <div class="sheet">
      <h2>${state.day} ${weekdayOf(state.day)} 学习统计</h2>
      <div class="statgrid">
        <div><strong>${s?.focusSessions ?? 0}</strong><small>次专注</small></div>
        <div><strong>${minutesOf(s?.focusSeconds ?? 0)}</strong><small>分钟专注</small></div>
        <div><strong>${s?.completedTasks ?? 0}</strong><small>个任务完成</small></div>
      </div>
      <p class="soft">累计 ${s?.focusSeconds ?? 0} 秒；分钟数只在展示时换算，短会话不会分别取整丢时长。</p>
    </div>
    <div class="sheet">
      <h3>时间去向</h3>
      ${(s?.byTask ?? []).length
        ? s.byTask.map((t) => `<div class="barrow">
            <span>${esc(t.title)}</span>
            <div class="bar"><i style="width:${Math.round((t.seconds / max) * 100)}%"></i></div>
            <strong>${minutesOf(t.seconds)} 分钟</strong>
          </div>`).join('')
        : '<p class="empty">今天还没有专注记录。</p>'}
    </div>
    <div class="sheet">
      <h3>最近 7 天</h3>
      <div class="spark">
        ${week.map((d) => {
          const h = Math.min(100, Math.round((d.focusSeconds / 3600) * 100));
          const zero = d.focusSeconds === 0;
          return `<div class="sparkcol ${zero ? 'zero' : ''}"
            title="${d.day} · ${minutesOf(d.focusSeconds)} 分钟">
            <div class="track-v"><i style="height:${zero ? 0 : Math.max(4, h)}%"></i></div>
            <small>${Number(d.day.slice(-2))}</small>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- 管家面板

/** 贾维斯喵面板：复用同一套命令，不另开写入口。 */
export function catPanel(state) {
  const { view, recommended } = state;
  const open = view.openFocus;

  if (open) {
    const title = open.taskId ? taskTitle(view, open.taskId) : '自由专注';
    return `
      <p>${open.state === 'running' ? '正在陪你专注。' : '已经暂停，随时可以继续。'}</p>
      <div class="catclock ${open.state === 'paused' ? 'paused' : ''}" id="catClock">--:--</div>
      <p class="soft">${esc(title)} · 计划 ${minutesOf(open.plannedSeconds)} 分钟 · 已累计 ${mmss(open.elapsedSeconds)}</p>
      <div class="actions">
        <button class="primary" data-action="${open.state === 'running' ? 'pause' : 'resume'}">
          ${icon(open.state === 'running' ? 'pause' : 'play')}${open.state === 'running' ? '暂停' : '继续'}
        </button>
        <button class="light" data-action="finish">结束并记录</button>
      </div>`;
  }

  const pending = view.pending;
  if (!pending.length) {
    return `<p>今天没有待办了。想学点新的，就先写下一个任务。</p>
      <div class="actions"><button class="primary" data-action="newTask">${icon('plus')}新建任务</button></div>`;
  }

  return `
    <p>${recommended ? `建议先做：<b>${esc(recommended.title)}</b>。` : '选一项开始吧。'}</p>
    <p class="soft">${recommended?.estimatedSeconds ? `预计 ${minutesOf(recommended.estimatedSeconds)} 分钟` : '未设置预计时长'}</p>
    <div class="actions">
      <button class="primary" data-action="start" data-cat-start="1">${icon('play')}开始专注</button>
      <button class="light" data-page="focus">看番茄钟</button>
    </div>
    <div class="catlist">
      ${pending.slice(0, 5).map((t) => `<button data-cat-pick="${esc(t.id)}">${esc(t.title)}</button>`).join('')}
    </div>`;
}

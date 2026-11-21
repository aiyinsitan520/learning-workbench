// 应用外壳：状态、读取、命令、路由与事件代理。
// 画面部件分在 nav.js（工具条）、focus.js（灵动岛 / 管家）、dialogs.js（弹窗）、
// planner.js（日计划）、task-notes.js（任务正文）、views.js（各页 HTML）。
import { api, ApiError, newId } from './api.js';
import { $, learnZone, localToday, notify, closeDialog, prefs, prefersReducedMotion } from './dom.js';
import { hydrateIcons } from './icons.js';
import { bindPlanner, DEFAULT_PLAN_SECONDS } from './planner.js';
import { bindTaskNotes } from './task-notes.js';
import { showYesterday } from './review.js';
import { bindToolbar } from './nav.js';
import { bindFocusChrome, remainingSeconds } from './focus.js';
import { createDialogs } from './dialogs.js';
import {
  PAGES, LEGACY_PAGES, activityPage, calendarPage, focusPage, mmss, renderDone,
  renderPending, renderProgress, renderRail, taskTitle, todoTasks, weekdayOf, PLAN_COURSE,
} from './views.js';

const FOLD_KEY = 'workbench.compact';
const FONT_KEY = 'workbench.font';
const MONTH_PAGES = new Set(['calendar', 'activity']);
const PAGE_KEYS = { 1: 'home', 2: 'calendar', 3: 'focus', 4: 'activity', 5: 'review' };

const state = {
  page: new URLSearchParams(location.search).get('page') === 'review' ? 'review' : 'home',
  // 首次读取时 day 为空，服务按自己的时区（默认北京时间）返回「今天」，之后以它为准。
  day: '',
  month: '',
  timeZone: '',
  // 服务端认定的"今天"，用来判断页面是否停在今天（跨午夜时自动跟随）
  todayDay: '',
  // 用户手动切到别的日期后置 true，跨午夜不再自动跟随
  userPinnedDate: false,
  monthDays: [],
  view: null,
  stats: null,
  focusLog: [],
  recommended: null,
  selectedTaskId: null,
  editorTaskId: null,
  editorBlockId: null,
  focusPlanned: 1500,
  freeFocus: false,
  focusRemaining: 1500,
  scrolls: {},
  pendingScroll: null,
  busy: false,
};

// ---------------------------------------------------------------- 查询

function findTask(taskId) {
  if (!taskId) return null;
  const { view } = state;
  return view.pending.find((t) => t.id === taskId)
    ?? view.completedOnDay.find((t) => t.id === taskId)
    ?? view.scheduled.find((b) => b.taskId === taskId)?.task;
}

const taskName = (taskId) => taskTitle(state.view, taskId);
const errorText = (err) => (err instanceof ApiError ? err.message : String(err));

// ---------------------------------------------------------------- 读取

let refreshSeq = 0;

async function refresh() {
  const seq = ++refreshSeq;
  // 重绘会替换 innerHTML 并把滚动归零；用滚动事件里记下的值还原。
  if (state.pendingScroll == null) state.pendingScroll = state.scrolls[state.page] ?? 0;
  try {
    const payload = await api.view(state.day, state.selectedTaskId);
    if (seq !== refreshSeq) return;
    learnZone(payload.view);
    Object.assign(state, {
      view: payload.view, stats: payload.stats, focusLog: payload.focusLog, recommended: payload.recommended,
    });
    if (!state.day) {
      state.day = payload.view.day;
      state.month = state.day.slice(0, 7);
      state.timeZone = payload.view.timeZone;
    // 记下"现在按工作台时区是哪一天"，用于跨午夜自动翻页
    state.todayDay = localToday(payload.view.timeZone);
    } else if (state.timeZone && payload.view.timeZone !== state.timeZone) {
      // 服务换了时区（例如重启后改成北京时间）：旧页面算出的钟点会错位，整页重载。
      location.reload();
      return;
    }
    if (!state.view.pending.some((t) => t.id === state.selectedTaskId)) {
      state.selectedTaskId = state.recommended?.id ?? state.view.pending[0]?.id ?? null;
    }
    draw();
  } catch (err) {
    notify(errorText(err), 'bad');
  }
}

async function refreshMonth() {
  try {
    state.monthDays = (await api.month(state.month)).days;
    draw();
  } catch (err) {
    notify(errorText(err), 'bad');
  }
}

/** 写操作后的统一刷新：当天视图，必要时连同月历。 */
async function reload() {
  await refresh();
  if (MONTH_PAGES.has(state.page)) await refreshMonth();
}

// ---------------------------------------------------------------- 绘制

let pendingMarkup = '';

function drawSidebar(editorTaskId) {
  const { view } = state;
  $('#count').textContent = todoTasks(view).length;
  const nextPending = renderPending(state, editorTaskId);
  if (nextPending !== pendingMarkup) {
    $('#pending').innerHTML = nextPending;
    pendingMarkup = nextPending;
  }
  planner.render(view);
  $('#railList').innerHTML = renderRail(state);
}

function drawSummary() {
  $('#doneCount').textContent = state.view.completedOnDay.length;
  $('#done').innerHTML = renderDone(state);
  const p = renderProgress(state);
  $('#percent').textContent = `${p.pct}%`;
  $('#progress').style.width = `${p.pct}%`;
  $('#minutes').textContent = p.minutes;
  $('#sessions').textContent = p.sessions;
}

function drawMain(editorTask) {
  if (state.page === 'home') {
    taskNotes.render(editorTask, state.editorBlockId, state.view.openFocus);
    return;
  }
  taskNotes.leave();
  if (state.page === 'review') {
    showYesterday($('#mainContent'));
    return;
  }
  const body = { calendar: calendarPage, focus: focusPage, activity: activityPage }[state.page](state);
  const date = new Date(`${state.day}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  $('#mainContent').innerHTML = `<div class="topline"><h1>${PAGES[state.page]}</h1>
    <span class="datecode">${date}</span></div>${body}`;
}

function draw() {
  if (!state.view) return;
  const scroll = state.pendingScroll;
  state.pendingScroll = null;
  const [y, m, d] = state.day.split('-').map(Number);
  $('#todayText').textContent = `${y} 年 ${m} 月 ${d} 日`;
  $('#weekday').textContent = weekdayOf(state.day);
  document.body.dataset.page = state.page;
  $('#contextPage').textContent = PAGES[state.page];
  toolbar.select(state.page);

  const editorTask = findTask(state.editorTaskId) ?? findTask(state.selectedTaskId);
  drawSidebar(editorTask?.id);
  drawSummary();
  drawMain(editorTask);
  if (state.page === 'focus') tick();
  focusChrome.draw();

  if (scroll != null) {
    // DOM 已换完，同步恢复一次，再等一帧兜住图片撑高
    window.scrollTo(0, scroll);
    requestAnimationFrame(() => window.scrollTo(0, scroll));
  }
}

// ---------------------------------------------------------------- 路由

let pageFade;

function gotoPage(page, { animate = true } = {}) {
  page = PAGES[page] ? page : LEGACY_PAGES[page];
  if (!PAGES[page]) return;
  const previous = state.page;
  state.page = page;
  state.pendingScroll = state.scrolls[page] ?? 0;
  draw();
  if (previous !== page) {
    pageFade?.cancel();
    if (animate && !prefersReducedMotion()) {
      pageFade = $('#main').animate([{ opacity: 0.94 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' });
    }
  }
  if (MONTH_PAGES.has(page)) void refreshMonth();
}

// ---------------------------------------------------------------- 计时

// 页面可能从昨天一直开着：跨过北京时间午夜后自动翻到新的一天。
// 只在「用户没手动切到别的日期」时翻页，避免打断正在翻旧账的人。
let midnightCheckedAt = 0;

function checkDayRollover() {
  if (!state.view?.timeZone) return;
  const now = Date.now();
  if (now - midnightCheckedAt < 5000) return; // 5 秒查一次就够
  midnightCheckedAt = now;

  const today = localToday(state.view.timeZone);
  if (!today) return;

  const previousToday = state.todayDay;
  if (!previousToday) { state.todayDay = today; return; }
  if (today === previousToday) return; // 还没跨日

  state.todayDay = today;
  // 用户手动翻到了别的日期，就不抢他的视图；等他点「今天」再恢复跟随。
  if (state.userPinnedDate) return;
  if (state.noteDirty) return; // 有未保存手记时不抢焦点

  state.day = today;
  state.month = today.slice(0, 7);
  void reload();
}

// 页面可能开着好几天：前端代码更新后，旧窗口还在跑旧代码（日期、时区都可能算错）。
// 每 30 秒问一次服务的 build，变了就在「没有对话框、没有拖动、手记已保存」时整页重载。
let pageBuild = null;
let buildCheckedAt = 0;

async function checkBuild(force = false) {
  const now = Date.now();
  if (!force && now - buildCheckedAt < 30000) return;
  buildCheckedAt = now;
  let build;
  try { ({ build } = await api.health()); } catch { return; }
  if (!build) return;
  if (pageBuild === null) { pageBuild = build; return; }
  if (build === pageBuild) return;
  const busy = $('#dialog')?.open || document.querySelector('.planner-dragging') || state.busy;
  if (busy) { buildCheckedAt = 0; return; } // 忙完下一次 tick 再试
  try { await taskNotes.saveNow(); } catch { /* 保存失败也不丢：beforeunload 会拦 */ }
  if (taskNotes.hasUnsavedWork()) return;
  location.reload();
}

function tick() {
  checkDayRollover();
  void checkBuild();
  const open = state.view?.openFocus;
  const clock = $('#clock');
  if (!open) {
    if (clock) clock.textContent = mmss(state.focusRemaining);
    return;
  }
  const left = remainingSeconds(open);
  if (clock) clock.textContent = mmss(Math.max(0, left));
  if (open.state === 'running' && left <= 0) {
    void run(
      () => api.command({ type: 'changeFocus', id: open.id, expectedRevision: open.revision, action: 'finish' }),
      { success: '时间到，本轮专注已记录' },
    );
  }
}

// ---------------------------------------------------------------- 命令

async function run(fn, { success } = {}) {
  if (state.busy) return undefined;
  state.busy = true;
  try {
    await fn();
    if (success) notify(success);
    await reload();
    return true;
  } catch (err) {
    notify(errorText(err), 'bad');
    if (err instanceof ApiError && err.reason === 'conflict') await refresh();
    return false;
  } finally {
    state.busy = false;
  }
}

function changeFocus(action, success) {
  const open = state.view.openFocus;
  return run(() => api.command({ type: 'changeFocus', id: open.id, expectedRevision: open.revision, action }), { success });
}

const commands = {
  complete: (id) => run(() => api.command({ type: 'setTaskCompleted', taskId: id, completed: true }),
    { success: '已完成，可在右侧撤销' }),
  undo: (id) => run(() => api.command({ type: 'setTaskCompleted', taskId: id, completed: false }),
    { success: '已撤销完成' }),
  start: async () => {
    if (state.view.openFocus) { gotoPage('focus'); return; }
    const taskId = state.freeFocus ? null : state.selectedTaskId;
    await run(() => api.command({ type: 'startFocus', id: newId('focus'), taskId, plannedSeconds: state.focusPlanned }),
      { success: '专注开始' });
    gotoPage('focus');
  },
  pause: () => changeFocus('pause', '已暂停'),
  resume: () => changeFocus('resume', '继续计时'),
  finish: () => changeFocus('finish', '已记录本轮专注'),
};

const saveBlock = (block, success) => run(() => api.command({ type: 'saveSchedule', block }), { success });

/** 新建任务并立即排进时间块；同一组 ID 重试幂等。 */
const createTaskBlock = (title, block) => run(async () => {
  await api.command({ type: 'createTask', id: block.taskId, title, course: PLAN_COURSE, estimatedSeconds: null });
  await api.command({ type: 'saveSchedule', block });
}, { success: '已加入日计划' });

async function renameTask(taskId, title) {
  try {
    await api.command({ type: 'updateTask', taskId, title });
    await reload();
    notify('任务名称已更新');
    return true;
  } catch (err) {
    notify(`任务名称未保存：${err.message}`, 'bad');
    return false;
  }
}

function openTaskEditor(taskId, blockId) {
  const task = findTask(taskId);
  if (!task) return;
  state.editorTaskId = taskId;
  state.editorBlockId = blockId ?? null;
  if (!task.completedAt) state.selectedTaskId = taskId;
  state.freeFocus = false;
  gotoPage('home');
  taskNotes.focus();
}

async function switchDay(day) {
  state.day = day;
  // 手动切到非今天 = 用户想固定看那一天；切回今天就恢复自动跟随
  const today = localToday(state.view?.timeZone || state.timeZone || 'Asia/Shanghai');
  state.userPinnedDate = day !== today;
  await refresh();
  await refreshMonth();
}

async function switchMonth(delta) {
  if (delta === 0) {
    const today = localToday(state.view.timeZone);
    state.month = today.slice(0, 7);
    state.userPinnedDate = false; // 回到今天，恢复自动跟随
    if (state.day !== today) {
      state.day = today;
      await refresh();
    }
  } else {
    const [y, m] = state.month.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1 + delta, 1));
    state.month = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  await refreshMonth();
}

// ---------------------------------------------------------------- 侧栏与字体

function setFold(on) {
  document.body.classList.toggle('compact', on);
  const btn = $('#collapse');
  const label = on ? '展开任务侧栏' : '折叠任务侧栏';
  btn.setAttribute('aria-expanded', String(!on));
  btn.title = label;
  btn.setAttribute('aria-label', label);
  prefs.set(FOLD_KEY, on ? '1' : '0');
  if (!on) planner.position();
}

/** 默认圆体（用户选定 04 样稿），可切到系统字体。 */
function setPlainFont(on) {
  document.body.classList.toggle('plain-font', on);
  const btn = $('#fontToggle');
  btn.setAttribute('aria-pressed', String(!on));
  btn.title = on ? '当前为系统字体，点按切回圆体' : '当前为圆体，点按切到系统字体';
  prefs.set(FONT_KEY, on ? 'plain' : 'round');
}

function focusNewTask() {
  setFold(false);
  planner.show('tasks');
  $('#newTitle').focus();
}

// ---------------------------------------------------------------- 事件：点击

/** data-* 属性 → 处理函数。按钮上出现哪个属性就执行哪个，顺序即优先级。 */
const clickHandlers = [
  ['page', (v) => gotoPage(v)],
  ['taskNote', (v, d) => openTaskEditor(v, d.block)],
  ['task', (v, d) => { state.freeFocus = false; dialogs.taskDialog(v, d.block); }],
  ['complete', (v) => commands.complete(v)],
  ['undo', (v) => commands.undo(v)],
  ['choose', (v) => { state.selectedTaskId = v; state.freeFocus = false; closeDialog(); gotoPage('focus'); void refresh(); }],
  ['select', (v) => { state.selectedTaskId = v; closeDialog(); void commands.start(); }],
  ['removeblock', (v) => { closeDialog(); void run(() => api.command({ type: 'removeSchedule', blockId: v }), { success: '已取消排期' }); }],
  ['catPick', (v) => { state.selectedTaskId = v; void refresh(); }],
  ['day', (v) => switchDay(v)],
  ['month', (v) => switchMonth(Number(v))],
];

const actions = {
  start: (d) => {
    if (d.focusTask && !state.view.openFocus) {
      state.selectedTaskId = d.focusTask;
      state.freeFocus = false;
    }
    void commands.start();
  },
  pause: () => commands.pause(),
  resume: () => commands.resume(),
  finish: () => commands.finish(),
  choose: () => dialogs.chooseTaskDialog(),
  newTask: () => { focusChrome.toggleCat(false); focusNewTask(); },
  freeFocus: () => { state.freeFocus = true; draw(); notify('已切到自由专注，不绑定任务'); },
};

document.addEventListener('click', (event) => {
  const btn = event.target instanceof Element ? event.target.closest('button') : null;
  if (!btn || !state.view) return;
  const d = btn.dataset;
  if (d.action && actions[d.action]) { actions[d.action](d); return; }
  for (const [key, handler] of clickHandlers) {
    if (d[key] != null && d[key] !== '') { handler(d[key], d); return; }
  }
});

$('#main').addEventListener('change', (event) => {
  if (event.target.id !== 'planned') return;
  state.focusPlanned = Number(event.target.value);
  state.focusRemaining = state.focusPlanned;
  draw();
});

$('#exportData').addEventListener('click', () => {
  window.location.href = '/api/export';
  notify('正在导出备份');
});
$('#collapse').addEventListener('click', () => setFold(!document.body.classList.contains('compact')));
$('#quickAdd').addEventListener('click', focusNewTask);
$('#fontToggle').addEventListener('click', () => setPlainFont(!document.body.classList.contains('plain-font')));

// ---------------------------------------------------------------- 事件：新建任务

let newTaskDraft;
$('#newTask').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.view || state.busy) return;
  const input = $('#newTitle');
  const title = input.value.trim();
  if (!title) { input.focus(); return; }
  const inPlan = planner.inPlanMode();
  const day = state.view.day;
  // 同一标题重试时复用同一组 ID，服务端按 ID 幂等，不会重复建任务。
  if (newTaskDraft?.title !== title || newTaskDraft.day !== day || newTaskDraft.inPlan !== inPlan) {
    const slot = inPlan ? planner.appendSlot() : null;
    if (inPlan && !slot) {
      notify('06:00–24:00 已没有 15 分钟以上的空档，可切到待办后添加', 'bad');
      return;
    }
    const sameTitle = newTaskDraft?.title === title;
    const id = sameTitle ? newTaskDraft.id : newId('task');
    const block = inPlan ? {
      id: (sameTitle && newTaskDraft.block?.id) || newId('block'), taskId: id, startsAt: slot.startsAt,
      plannedSeconds: Math.min(DEFAULT_PLAN_SECONDS, slot.room),
    } : null;
    newTaskDraft = { id, title, day, inPlan, block };
  }
  const { id, block } = newTaskDraft;
  const saved = await run(async () => {
    // 计划视图里新建的事项只进日计划，不进待办清单
    await api.command({ type: 'createTask', id, title, course: block ? PLAN_COURSE : '', estimatedSeconds: null });
    if (block) await api.command({ type: 'saveSchedule', block });
  }, { success: block ? '已加入日计划' : '已加入待办' });
  if (!saved) return;
  newTaskDraft = null;
  if (input.value.trim() === title) input.value = '';
  if (block && day === state.view.day) planner.reveal(block.startsAt, block.plannedSeconds);
  input.focus({ preventScroll: true });
});

// ---------------------------------------------------------------- 事件：键盘

document.addEventListener('keydown', (event) => {
  const el = event.target instanceof Element ? event.target : null;
  const inField = Boolean(el?.closest('input, textarea, select, [contenteditable]'));

  // ⌘/Ctrl+S：立即保存当前任务正文（输入框里也生效）
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void taskNotes.saveNow();
    return;
  }
  if (inField || event.metaKey || event.ctrlKey || event.altKey) return;

  if (PAGE_KEYS[event.key]) {
    event.preventDefault();
    gotoPage(PAGE_KEYS[event.key], { animate: false });
  } else if (event.key.toLowerCase() === 'n') {
    event.preventDefault();
    focusNewTask();
  } else if (event.key === ' ' && state.page === 'focus') {
    event.preventDefault();
    const open = state.view?.openFocus;
    if (!open) void commands.start();
    else if (open.state === 'running') void commands.pause();
    else void commands.resume();
  }
});

window.addEventListener('beforeunload', (event) => {
  if (taskNotes.hasUnsavedWork()) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// 窗口重新回到前台时读一次最新数据：服务重启、时区变化或另一窗口的修改都能及时跟上。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  void checkBuild(true);
  if (state.view && !state.busy) void refresh();
});

// 持续记录当前页的滚动位置：重绘会把 scrollY 归零，所以不能等要用的时候才读。
window.addEventListener('scroll', () => { state.scrolls[state.page] = window.scrollY; }, { passive: true });

// ---------------------------------------------------------------- 启动

window.__wbState = state; // 调试与测试可读
const toolbar = bindToolbar();
const taskNotes = bindTaskNotes($('#mainContent'), renameTask);
const planner = bindPlanner({
  onCreate: (startsAt) => dialogs.plannerBlockDialog(startsAt),
  onChange: (block, startsAt, plannedSeconds) => saveBlock(
    { id: block.id, taskId: block.taskId, startsAt, plannedSeconds },
    startsAt === block.startsAt ? '已更新时长' : '已改期',
  ),
  onDrop: (taskId, startsAt, plannedSeconds) => saveBlock(
    { id: newId('block'), taskId, startsAt, plannedSeconds }, '已排入日计划',
  ),
  onFull: () => notify('06:00–24:00 已没有 15 分钟以上的空档', 'bad'),
});
const dialogs = createDialogs({ state, findTask, renameTask, saveBlock, createTaskBlock, planner });
const focusChrome = bindFocusChrome({ state, commands, taskName });

hydrateIcons();
if (prefs.get(FOLD_KEY) === '1') setFold(true);
setPlainFont(prefs.get(FONT_KEY) === 'plain');
setInterval(() => { tick(); focusChrome.tickCat(); }, 500);
void refresh();

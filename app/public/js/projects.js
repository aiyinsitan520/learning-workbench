// 长期项目（右栏「长期项目」区块，解决跨多天的任务）。
// 数据：view.projects（ProjectView[]）；写操作走 ModuleContext 的 command：
// createProject / updateProject / setProjectState / saveProjectLog（见 architecture/workbench.d.ts）。
// 按钮统一用 data-project-* 属性并在本模块内自己监听；唯一例外是「开始专注」沿用外壳约定的
// data-action="start" data-focus-task="<主任务 id>"。打开项目主任务正文用 ctx.openTask(mainTaskId)。
// T-W4：整张项目卡带 data-project-drag（鼠标抓卡片任意空白处），标题区的拖动柄另带 data-drag-project
// （触屏路径），都由 planner.js 在 document 级接住拖进日计划（复制，项目卡不动）。
// 卡片上没有「排进今天」按钮（用户嫌它把拖动挤成了备选）；不用鼠标时走右键菜单里那条，用 planner.nextFreeStart()。
import { newId } from './api.js';
import { esc, icon } from './icons.js';
import { localToday } from './dom.js';
import { registerContextMenu } from './context-menu.js';

/** 项目没设「每天投入」时，拖进日计划默认排 30 分钟（与 planner.js 的 DEFAULT_PLAN_SECONDS 一致）。 */
const FALLBACK_SECONDS = 1800;

/** 区块自己的状态：只记「哪个卡片的 ⋯ 菜单开着」，其余全部来自 view。 */
const state = { openMenu: null };

let host = null;
let ctx = null;
let planner = null;
let bound = false;
/** 上次画出的 HTML：内容没变就不重写 DOM，免得拖动中的拖动柄被换掉、指针捕获丢失。 */
let markup = '';

/**
 * @param {HTMLElement} hostEl  #projects
 * @param {import('../../../architecture/workbench').ModuleContext} moduleCtx
 * @param {{ planner?: { nextFreeStart(seconds: number): number | null } }} [tools]
 *   planner 来自外壳（app.js 的 bindPlanner 返回值），只用到 nextFreeStart。
 * @returns {{ render(view: import('../../../architecture/workbench').WorkbenchView): void }}
 */
export function bindProjects(hostEl, moduleCtx, tools = {}) {
  host = hostEl;
  ctx = moduleCtx;
  planner = tools.planner ?? null;
  if (!bound) {
    // 弹窗内容在 #dialogBody 里，不在 host 内，所以监听挂在 document 上，只处理自己的 data-project-*。
    document.addEventListener('click', onClick);
    document.addEventListener('submit', onSubmit);
    document.addEventListener('change', onChange);
    registerContextMenu('[data-project-card]', projectMenu);
    bound = true;
  }
  return { render };
}

// ---------------------------------------------------------------- 右键菜单（T-W7）

function projectMenu(target) {
  const project = findProject(target.dataset.projectCard);
  if (!project) return null;
  const view = ctx.state.view;
  const today = view.day === localToday(view.timeZone);
  const canPlan = planable(project);
  return [
    { label: today ? '排进今天' : '排进这天', icon: '＋', disabled: !canPlan, run: () => planNow(project.id) },
    { label: '开始专注', icon: '▶', disabled: !canPlan,
      run: () => target.querySelector('.proj-start')?.click() },
    { label: `写${today ? '今天' : '这天'}进展`, icon: '✎', run: () => openLog(project) },
    { label: '打开正文', icon: '¶', run: () => { state.openMenu = null; ctx.openTask(project.mainTaskId); } },
    '-',
    { label: '编辑项目', icon: '⚙', run: () => { state.openMenu = null; openForm(project); } },
    project.completedAt
      ? { label: '重开项目', icon: '↺', run: () => setState(project.id, 'reopen', '项目已重开') }
      : { label: '完成项目', icon: '✓', run: () => openConfirm(project, 'complete') },
    project.archivedAt ? null : { label: '归档', icon: '⌫', run: () => openConfirm(project, 'archive') },
  ];
}

/** 「写今天进展」：一天一条，覆盖写（saveProjectLog），右栏卡片上的「今天：…」随之更新。 */
function openLog(project) {
  const day = ctx.state.view.day;
  ctx.modal(`<h2 class="dialoghead">${esc(project.title)} · ${esc(day)} 的进展</h2>
    <form class="proj-form" data-project-log-form="${esc(project.id)}">
      <label class="proj-field">今天推进了什么
        <textarea id="projLogNote" rows="4" maxlength="2000" placeholder="一两句话就行，例如：写完第二章初稿">${esc(project.log?.note ?? '')}</textarea>
      </label>
      <div class="dialogactions">
        <button type="button" class="light" data-project-cancel>取消</button>
        <button type="submit" class="primary">保存进展</button>
      </div>
    </form>`);
  const box = document.querySelector('#projLogNote');
  box?.focus();
  document.querySelector('[data-project-log-form]').onsubmit = async (event) => {
    event.preventDefault();
    const note = box.value.trim();
    const ok = await ctx.run(() => ctx.api.command({
      type: 'saveProjectLog', projectId: project.id, day, note, progress: project.log?.progress ?? null,
    }), '进展已保存');
    if (ok) ctx.closeDialog();
  };
}

// ---------------------------------------------------------------- 日期小工具

const pad = (n) => String(n).padStart(2, '0');

function toDay(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function addDays(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  return toDay(new Date(Date.UTC(y, m - 1, d + delta)));
}

function addMonths(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  return toDay(new Date(Date.UTC(y, m - 1 + delta, d)));
}

/** 快捷截止：1 周 / 2 周 / 1 个月都算「含开始当天」的整段，所以减一天。 */
function quickDue(startDay, kind) {
  if (kind === 'week') return addDays(startDay, 6);
  if (kind === 'fortnight') return addDays(startDay, 13);
  if (kind === 'month') return addDays(addMonths(startDay, 1), -1);
  return '';
}

const minutesOf = (seconds) => Math.round(seconds / 60);

function dayText(p) {
  const index = `第 ${p.dayIndex}${p.totalDays ? `/${p.totalDays}` : ''} 天`;
  if (p.daysLeft == null) return index;
  return `${index} · ${p.daysLeft < 0 ? `逾期 ${-p.daysLeft} 天` : `剩 ${p.daysLeft} 天`}`;
}

/** 拖进日计划的计划时长：有「每天投入」用它，没设就按 30 分钟。 */
const planSeconds = (p) => (p.dailyMinutes ? p.dailyMinutes * 60 : FALLBACK_SECONDS);

/** 已完成 / 归档的项目不能再排进计划。 */
const planable = (p) => !p.completedAt && !p.archivedAt;

// ---------------------------------------------------------------- 渲染

function cardMarkup(p) {
  const late = p.daysLeft != null && p.daysLeft < 0;
  const target = p.dailyMinutes ? p.dailyMinutes * 60 : 0;
  const pct = target ? Math.min(100, Math.round((p.focusSecondsOnDay / target) * 100)) : 0;
  const focused = minutesOf(p.focusSecondsOnDay);
  const note = p.log?.note || p.lastLog?.note || '';
  const noteLead = p.log?.note ? '今天' : (p.lastLog ? '上次' : '');
  const menuOpen = state.openMenu === p.id;
  const canPlan = planable(p);
  // planner.js 在 document 级接住：鼠标 / 触控笔抓整张卡任意空白处就能拖（data-project-drag），
  // 触屏只认左上角的拖动柄（data-drag-project），否则整卡起拖会和右栏滚动抢手势。
  // 拖进时间轴按 dailyMinutes 排一个块（复制，卡片不动）。
  const grip = canPlan ? `<button type="button" class="proj-grip" data-drag-project="${esc(p.id)}"
        aria-label="把 ${esc(p.title)} 拖进日计划"
        title="按住拖到左栏日计划（复制，不移动项目）">${icon('grip')}</button>` : '';
  const dragTitle = '按住卡片拖到左栏日计划（复制，不移动项目）';
  return `<article class="proj-card${canPlan ? '' : ' proj-done'}" data-project-card="${esc(p.id)}"${canPlan ? ` data-project-drag="${esc(p.id)}"` : ''}>
    <div class="proj-head"${canPlan ? ` title="${dragTitle}"` : ''}>
      ${grip}
      <b class="proj-name" title="${esc(p.title)}">${esc(p.title)}</b>
      <small class="proj-days${late ? ' late' : ''}">${esc(dayText(p))}</small>
    </div>
    ${target ? `<div class="track proj-track"><i style="width:${pct}%"></i></div>` : '<div class="proj-track-empty"></div>'}
    <p class="proj-meta">今天专注 ${focused} / ${p.dailyMinutes ? p.dailyMinutes : '—'} 分钟${p.dailyMinutes ? '' : '（未设每日目标）'}</p>
    <p class="proj-note" title="${esc(note)}">${note ? `${esc(noteLead)}：${esc(note)}` : '还没有进展记录'}</p>
    ${p.harvestCount ? `<button type="button" class="harvest-chip proj-harvest" data-project-harvest="${esc(p.id)}"
      title="看这个项目关联的收获">收获 ${p.harvestCount}</button>` : ''}
    <div class="proj-actions">
      <button type="button" class="primary proj-start" data-action="start" data-focus-task="${esc(p.mainTaskId)}">开始专注</button>
      <button type="button" class="light" data-project-note="${esc(p.id)}">写正文</button>
      <button type="button" class="iconbtn proj-more" data-project-menu="${esc(p.id)}"
        aria-haspopup="menu" aria-expanded="${menuOpen ? 'true' : 'false'}" aria-label="${esc(p.title)} 的更多操作">⋯</button>
    </div>
    <div class="proj-menu" role="menu" data-project-menu-for="${esc(p.id)}"${menuOpen ? '' : ' hidden'}>
      <button type="button" role="menuitem" data-project-edit="${esc(p.id)}">编辑</button>
      <button type="button" role="menuitem" data-project-complete="${esc(p.id)}">完成项目</button>
      <button type="button" role="menuitem" data-project-archive="${esc(p.id)}">归档</button>
    </div>
  </article>`;
}

function doneMarkup(list) {
  if (!list.length) return '';
  return `<p class="proj-donelist">今天完成：${list.map((p) => `${esc(p.title)}
    <button type="button" class="link" data-project-reopen="${esc(p.id)}">重开</button>`).join('、')}</p>`;
}

function render(view) {
  if (!host) return;
  host.hidden = false; // 没有项目时也保留区块：空态要引导用户建第一个
  const all = view.projects ?? [];
  const active = all.filter((p) => !p.completedAt);
  const done = all.filter((p) => p.completedAt);
  const head = `<div class="section-head proj-head-bar">
    <h2>长期项目</h2>
    <span class="count" aria-label="长期项目数量">${active.length}</span>
    <button type="button" class="iconbtn ghost proj-add" data-project-new title="新建长期项目" aria-label="新建长期项目">＋</button>
  </div>`;
  let next;
  if (!active.length && !done.length) {
    next = `${head}<p class="proj-empty">连续多天的事，建成长期项目。</p>
      <p class="proj-try">试试：建一个「两周背完 3000 词」，每天按住它拖进左栏计划。</p>
      <button type="button" class="light proj-emptybtn" data-project-new>新建长期项目</button>`;
  } else {
    next = `${head}<div class="proj-list">${active.map((p) => cardMarkup(p)).join('')}</div>${doneMarkup(done)}`;
  }
  // 内容没变就不重写：拖动柄正在被按住时换掉节点会丢指针捕获，块也就拖不动了。
  if (next === markup) return;
  markup = next;
  host.innerHTML = next;
}

// ---------------------------------------------------------------- 弹窗

function findProject(id) {
  return (ctx.state.view.projects ?? []).find((p) => p.id === id) ?? null;
}

function formMarkup({ project = null, day }) {
  const start = project?.startDay ?? day;
  const due = project?.dueDay ?? '';
  const daily = project?.dailyMinutes ?? '';
  const title = project ? '编辑长期项目' : '新建长期项目';
  return `<h2 class="dialoghead">${title}</h2>
    <p class="soft">连续多天的事：建一个项目，它的主任务会出现在左栏待办里，可以直接拖进日计划。</p>
    <form class="proj-form" data-project-form="${project ? esc(project.id) : 'new'}" novalidate>
      <label class="proj-field">名称
        <input type="text" id="projTitle" maxlength="120" autocomplete="off"
          placeholder="例如：写完毕业论文初稿" value="${esc(project?.title ?? '')}">
      </label>
      <label class="proj-field">目标（可选）
        <input type="text" id="projGoal" maxlength="500" autocomplete="off"
          placeholder="做到什么算完成" value="${esc(project?.goal ?? '')}">
      </label>
      <div class="proj-formrow">
        <label class="proj-field">开始日期
          <input type="date" id="projStart" value="${esc(start)}">
        </label>
        <label class="proj-field">截止（可空）
          <input type="date" id="projDue" value="${esc(due)}">
        </label>
      </div>
      <div class="proj-quick">
        <button type="button" class="chip" data-project-due="week">1 周</button>
        <button type="button" class="chip" data-project-due="fortnight">2 周</button>
        <button type="button" class="chip" data-project-due="month">1 个月</button>
        <button type="button" class="chip" data-project-due="none">无截止</button>
      </div>
      <div class="proj-formrow">
        <label class="proj-field">每天投入（分钟，可空）
          <input type="number" id="projDaily" min="1" max="720" step="1" inputmode="numeric" placeholder="不设"
            value="${esc(daily === '' ? '' : daily)}">
        </label>
        <div class="proj-quick proj-quick-daily">
          ${[30, 60, 90].map((m) => `<button type="button" class="chip" data-project-daily="${m}">${m}</button>`).join('')}
        </div>
      </div>
      <p class="proj-formerror" data-project-error role="alert" hidden></p>
      <div class="dialogactions">
        <button type="button" class="light" data-project-cancel>取消</button>
        <button type="submit" class="primary" data-project-submit>${project ? '保存' : '创建'}</button>
      </div>
    </form>`;
}

function openForm(project = null) {
  ctx.modal(formMarkup({ project, day: ctx.state.view.day }));
  const input = document.querySelector('#projTitle');
  input?.focus();
  input?.select();
}

function openConfirm(project, action) {
  const label = action === 'complete' ? '完成项目' : '归档';
  const hint = action === 'complete'
    ? '主任务会一起标记完成，之后仍在「每日维护」里可回看。'
    : '归档后不再出现在右栏，历史记录仍保留。';
  ctx.modal(`<h2 class="dialoghead">${label}「${esc(project.title)}」？</h2>
    <p class="soft">${hint}</p>
    <div class="dialogactions">
      <button type="button" class="light" data-project-cancel>取消</button>
      <button type="button" class="primary" data-project-confirm="${action}:${esc(project.id)}">${label}</button>
    </div>`);
}

function formError(message) {
  const el = document.querySelector('[data-project-error]');
  if (!el) { ctx.notify(message, 'bad'); return; }
  el.hidden = false;
  el.textContent = message;
}

// ---------------------------------------------------------------- 写操作

async function createFrom(form) {
  const title = form.querySelector('#projTitle').value.trim();
  if (!title) { formError('请填写项目名称'); form.querySelector('#projTitle').focus(); return; }
  const startDay = form.querySelector('#projStart').value || ctx.state.view.day;
  const dueDay = form.querySelector('#projDue').value || null;
  const dailyRaw = form.querySelector('#projDaily').value.trim();
  const dailyMinutes = dailyRaw ? Number(dailyRaw) : null;
  if (dueDay && dueDay < startDay) { formError('截止日期应不早于开始日期'); return; }
  if (dailyMinutes != null && (!Number.isFinite(dailyMinutes) || dailyMinutes < 1)) {
    formError('每天投入应是大于 0 的分钟数'); return;
  }
  const id = newId('proj');
  const ok = await ctx.run(() => ctx.api.command({
    type: 'createProject',
    id,
    title,
    goal: form.querySelector('#projGoal').value.trim(),
    startDay,
    dueDay,
    dailyMinutes,
    mainTaskId: `${id}-main`,
  }), '长期项目已创建');
  if (ok) { ctx.closeDialog(); state.openMenu = null; }
}

async function updateFrom(form, projectId) {
  const project = findProject(projectId);
  if (!project) { formError('项目已不存在，请刷新'); return; }
  const title = form.querySelector('#projTitle').value.trim();
  if (!title) { formError('请填写项目名称'); return; }
  const startDay = form.querySelector('#projStart').value || project.startDay;
  const dueRaw = form.querySelector('#projDue').value;
  const dueDay = dueRaw || null;
  const dailyRaw = form.querySelector('#projDaily').value.trim();
  const dailyMinutes = dailyRaw ? Number(dailyRaw) : null;
  if (dueDay && dueDay < startDay) { formError('截止日期应不早于开始日期'); return; }
  if (dailyMinutes != null && (!Number.isFinite(dailyMinutes) || dailyMinutes < 1)) {
    formError('每天投入应是大于 0 的分钟数'); return;
  }
  const ok = await ctx.run(() => ctx.api.command({
    type: 'updateProject',
    projectId,
    title,
    goal: form.querySelector('#projGoal').value.trim(),
    startDay,
    dueDay,
    dailyMinutes,
  }), '项目已更新');
  if (ok) { ctx.closeDialog(); state.openMenu = null; }
}

async function setState(projectId, action, success) {
  const ok = await ctx.run(() => ctx.api.command({ type: 'setProjectState', projectId, action }), success);
  if (ok) { ctx.closeDialog(); state.openMenu = null; }
}

/**
 * 「排进今天」：只从右键菜单进来（卡片上不再有按钮）。用 planner.nextFreeStart 找今天第一个放得下的空档，
 * 把项目主任务排成一个时间块（与拖入同一条写入路径，saveSchedule）。没有空档就提示排满了。
 */
async function planNow(projectId) {
  const project = findProject(projectId);
  if (!project) return;
  if (!planable(project)) { ctx.notify('已完成或归档的项目不用再排', 'bad'); return; }
  if (!planner?.nextFreeStart) { ctx.notify('日计划还没准备好，请刷新后重试', 'bad'); return; }
  const view = ctx.state.view;
  const today = view.day === localToday(view.timeZone);
  const seconds = planSeconds(project);
  const startsAt = planner.nextFreeStart(seconds);
  if (startsAt == null) {
    ctx.notify(today ? '今天排满了，先腾一个空档' : '这天排满了，先腾一个空档', 'bad');
    return;
  }
  state.openMenu = null;
  await ctx.run(() => ctx.api.command({
    type: 'saveSchedule',
    block: { id: newId('block'), taskId: project.mainTaskId, startsAt, plannedSeconds: seconds },
  }), `已排进${today ? '今天' : '这天'} ${Math.round(seconds / 60)} 分钟`);
}

// ---------------------------------------------------------------- 事件

function onClick(event) {
  const el = event.target instanceof Element ? event.target.closest('button') : null;
  if (!el) return;
  const d = el.dataset;
  // 只处理本模块的按钮；「开始专注」交给外壳的 data-action 分派。
  const mine = ['projectNew', 'projectNote', 'projectMenu', 'projectEdit', 'projectComplete',
    'projectArchive', 'projectReopen', 'projectCancel', 'projectConfirm', 'projectDue', 'projectDaily',
    'projectHarvest'];
  const key = mine.find((name) => d[name] != null);
  if (!key) return;

  if (key === 'projectNew') { state.openMenu = null; openForm(); return; }
  if (key === 'projectCancel') { ctx.closeDialog(); return; }
  // 「收获 N」跳到按该项目筛选的收获页（T-W8b）：先切页，页面挂上后再发筛选事件
  if (key === 'projectHarvest') {
    const projectId = d.projectHarvest;
    ctx.gotoPage('harvest');
    setTimeout(() => {
      document.dispatchEvent(new CustomEvent('workbench:harvest-filter', { detail: { project: projectId } }));
    }, 0);
    return;
  }
  if (key === 'projectNote') {
    const project = findProject(d.projectNote);
    if (project) { state.openMenu = null; ctx.openTask(project.mainTaskId); }
    return;
  }
  if (key === 'projectMenu') {
    state.openMenu = state.openMenu === d.projectMenu ? null : d.projectMenu;
    render(ctx.state.view);
    return;
  }
  if (key === 'projectEdit') {
    const project = findProject(d.projectEdit);
    if (project) { state.openMenu = null; openForm(project); }
    return;
  }
  if (key === 'projectComplete' || key === 'projectArchive') {
    const project = findProject(d[key === 'projectComplete' ? 'projectComplete' : 'projectArchive']);
    if (!project) return;
    state.openMenu = null;
    render(ctx.state.view);
    openConfirm(project, key === 'projectComplete' ? 'complete' : 'archive');
    return;
  }
  if (key === 'projectReopen') {
    void setState(d.projectReopen, 'reopen', '项目已重开');
    return;
  }
  if (key === 'projectConfirm') {
    const [action, projectId] = String(d.projectConfirm).split(':');
    if (!projectId) return;
    const success = action === 'complete' ? '项目已完成' : '项目已归档';
    void setState(projectId, action, success);
    return;
  }
  if (key === 'projectDue') {
    const form = document.querySelector('[data-project-form]');
    if (!form) return;
    const start = form.querySelector('#projStart').value || ctx.state.view.day;
    const input = form.querySelector('#projDue');
    input.value = d.projectDue === 'none' ? '' : quickDue(start, d.projectDue);
    for (const chip of form.querySelectorAll('[data-project-due]')) {
      chip.setAttribute('aria-pressed', String(chip === el));
    }
    return;
  }
  if (key === 'projectDaily') {
    const form = document.querySelector('[data-project-form]');
    if (!form) return;
    form.querySelector('#projDaily').value = d.projectDaily;
    for (const chip of form.querySelectorAll('[data-project-daily]')) {
      chip.setAttribute('aria-pressed', String(chip === el));
    }
  }
}

function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.dataset.projectForm == null) return;
  event.preventDefault();
  if (form.dataset.projectForm === 'new') void createFrom(form);
  else void updateFrom(form, form.dataset.projectForm);
}

/** 开始日期变了，快捷截止按钮的选中态就不可信了，清掉免得误导。 */
function onChange(event) {
  const el = event.target;
  if (!(el instanceof Element) || el.id !== 'projStart') return;
  const form = el.closest('[data-project-form]');
  if (!form) return;
  for (const chip of form.querySelectorAll('[data-project-due]')) chip.setAttribute('aria-pressed', 'false');
}

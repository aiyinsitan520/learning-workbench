import { esc } from './icons.js';
import { clockOf } from './views.js';
import { localToday } from './dom.js';

const HOUR = 3600;
const QUARTER = 900;
const STEP = 300;
const FIRST_HOUR = 6;
const PLAN_HOURS = 18;
export const DEFAULT_PLAN_SECONDS = 1800;
export const DEFAULT_HOUR_HEIGHT = 48;
/** 时间轴密度（每小时像素）：紧凑 / 舒适 / 宽松。 */
export const SCALES = [32, 48, 64];
const SCALE_KEY = 'workbench.plannerScale';
const MODE_KEY = 'workbench.sidebarMode';
const SCALE_LABELS = { 32: '紧凑', 48: '舒适', 64: '宽松' };

function readScale() {
  try {
    const saved = Number(localStorage.getItem(SCALE_KEY));
    if (SCALES.includes(saved)) return saved;
  } catch { /* 读不到就用默认密度 */ }
  return DEFAULT_HOUR_HEIGHT;
}

function timeLabel(block, timeZone) {
  return `${clockOf(block.startsAt, timeZone)}–${clockOf(block.startsAt + block.plannedSeconds, timeZone)}`;
}

function dragLabel(startsAt, seconds, timeZone) {
  return `${clockOf(startsAt, timeZone)}–${clockOf(startsAt + seconds, timeZone)} · ${Math.round(seconds / 60)} 分钟`;
}

/** 块比这还矮时，两个手柄各缩到 6px，给中间的标题留出按住拖动的位置。 */
const SHORT_BLOCK = 28;
/** 块比这还矮时，6px 手柄会互相叠住，改成上沿占上 40%、下沿占下 40%。 */
const TINY_BLOCK = 12;

function renderScaleSwitch(hourHeight) {
  const buttons = SCALES.map((scale) => `<button type="button" data-plan-scale="${scale}"
      aria-pressed="${scale === hourHeight}" title="${SCALE_LABELS[scale]}（每小时 ${scale}px）">${SCALE_LABELS[scale]}</button>`);
  return `<div class="planner-scale" role="group" aria-label="时间轴密度">${buttons.join('')}</div>`;
}

function renderAxis(view, start, end, hourHeight) {
  const toPixels = (seconds) => seconds * hourHeight / HOUR;
  const hours = [];
  for (let index = 0; index < PLAN_HOURS; index++) {
    const at = start + index * HOUR;
    const label = `${String(FIRST_HOUR + index).padStart(2, '0')}:00`;
    hours.push(`<div class="planner-hour"><time>${label}</time>
      <button type="button" data-plan-hour="${at}" aria-label="在 ${label} 添加时间块"></button></div>`);
  }
  const laneEnds = [];
  const placed = view.scheduled.filter((block) => block.startsAt < end
    && block.startsAt + block.plannedSeconds > start).map((block) => {
    const visibleStart = Math.max(start, block.startsAt);
    let lane = laneEnds.findIndex((occupiedUntil) => occupiedUntil <= visibleStart);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = block.startsAt + block.plannedSeconds;
    return { block, lane, visibleStart };
  });
  const laneWidth = 100 / Math.max(laneEnds.length, 1);
  const blocks = placed.map(({ block, lane, visibleStart }) => {
    const seconds = Math.min(block.startsAt + block.plannedSeconds, end) - visibleStart;
    const label = timeLabel(block, view.timeZone);
    const title = esc(block.task.title);
    const id = esc(block.id);
    const minutes = Math.round(block.plannedSeconds / 60);
    const startClock = clockOf(block.startsAt, view.timeZone);
    const latestStart = block.startsAt + block.plannedSeconds - Math.min(QUARTER, block.plannedSeconds);
    const pixels = block.plannedSeconds * hourHeight / HOUR;
    const sizeClass = pixels < TINY_BLOCK ? 'tiny' : pixels < SHORT_BLOCK ? 'short' : '';
    return `<div class="planner-block ${block.task.completedAt ? 'done' : ''} ${sizeClass}"
        style="top:${toPixels(visibleStart - start)}px;
        height:${toPixels(seconds)}px;left:${lane * laneWidth}%;width:calc(${laneWidth}% - 2px)">
      <button class="planner-resize planner-resize-start" type="button" data-resize-plan-start="${id}" role="slider"
        aria-label="调整 ${title} 的开始时间" aria-orientation="vertical"
        aria-valuemin="0"
        aria-valuemax="${Math.round((latestStart - start) / 60)}"
        aria-valuenow="${Math.round((block.startsAt - start) / 60)}" aria-valuetext="${startClock}"
        title="拖动上沿提前或推后开始时间（结束不变），或用 ↑ 提前 5 分钟、↓ 推后 5 分钟，Shift 为 15 分钟"></button>
      <button class="planner-task" type="button" data-task-note="${esc(block.taskId)}" data-block="${id}"
        title="${title} · ${label} · 按住拖动改期">${title}</button>
      <button class="planner-resize planner-resize-end" type="button" data-resize-plan="${id}" role="slider"
        aria-label="调整 ${title} 的时长" aria-orientation="vertical"
        aria-valuemin="${Math.min(15, Math.round(block.plannedSeconds / 60))}"
        aria-valuemax="${Math.floor((end - block.startsAt) / 60)}"
        aria-valuenow="${minutes}" aria-valuetext="${minutes} 分钟"
        title="拖动下沿，或用 ↑ 缩短、↓ 加长（Shift 为 15 分钟）"></button>
    </div>`;
  });
  return `<div class="planner-axis" style="--hour-height:${hourHeight}px">
      ${hours.join('')}<div class="planner-layer">${blocks.join('')}</div>
    </div><time class="planner-end">00:00</time>`;
}

export function bindPlanner({ onCreate, onChange, onDrop, onFull }) {
  const grid = document.querySelector('#plannerGrid');
  const sidebar = grid.closest('.left');
  const pending = document.querySelector('#pending');
  const caption = document.querySelector('#plannerDate');
  const modes = document.querySelectorAll('[data-sidebar-view]');
  const toolbar = document.querySelector('.planner-toolbar');
  let view;
  let start;
  let end;
  let hourHeight = readScale();
  let mode = 'plan';
  let markup = '';
  let positionDay;
  let drag;
  let suppressClick = false;
  // 密度切换器：加进日计划标题区（index.html 的 .planner-toolbar）
  const scaleSwitch = document.createElement('div');
  scaleSwitch.innerHTML = renderScaleSwitch(hourHeight);
  const scaleGroup = scaleSwitch.firstElementChild;
  toolbar.insertBefore(scaleGroup, toolbar.lastElementChild);

  const toPixels = (seconds) => seconds * hourHeight / HOUR;
  const toSeconds = (pixels) => pixels * HOUR / hourHeight;
  /**
   * 起拖阈值（像素）：不小于 4，但也不超过一个吸附步长在当前密度下的像素数。
   * 紧凑档 32px/小时时 5 分钟只有约 2.67px，写死 4px 会让单步拖不动（要拖两步才吸附一次）。
   */
  const dragThreshold = () => Math.max(1, Math.min(4, STEP * hourHeight / HOUR));

  function setScale(next, { persist = true } = {}) {
    if (!SCALES.includes(next) || next === hourHeight) return;
    finishDrag();
    // 位置全部按密度换算，重绘一次即可；滚动位置按比例带过去，看着还是同一时段
    const previous = hourHeight;
    hourHeight = next;
    for (const button of scaleGroup.querySelectorAll('[data-plan-scale]')) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.planScale) === hourHeight));
    }
    if (persist) {
      try { localStorage.setItem(SCALE_KEY, String(hourHeight)); } catch { /* 本次停留期间仍可切换 */ }
    }
    markup = '';
    if (!view) return;
    const scroll = grid.scrollTop;
    render(view);
    grid.scrollTop = Math.round(scroll * hourHeight / previous);
  }

  function show(nextMode) {
    if (nextMode !== mode) finishDrag();
    mode = nextMode;
    pending.hidden = mode !== 'tasks';
    for (const button of modes) {
      button.setAttribute('aria-pressed', String(button.dataset.sidebarView === mode));
    }
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* 可在本次停留期间继续切换 */ }
    position();
  }

  function position() {
    if (!view || !grid.clientHeight || positionDay === view.day) return;
    positionDay = view.day;
    grid.scrollTop = 0;
  }

  function reveal(startsAt, plannedSeconds) {
    const top = toPixels(startsAt - start);
    const bottom = toPixels(Math.min(startsAt + plannedSeconds, end) - start);
    if (top < grid.scrollTop || bottom > grid.scrollTop + grid.clientHeight) {
      grid.scrollTop = Math.max(0, top - hourHeight / 2);
    }
  }

  function showDate() {
    const label = view.day.split('-').slice(1).map(Number);
    caption.textContent = `${label[0]} 月 ${label[1]} 日`;
  }

  function render(nextView) {
    view = nextView;
    const morning = view.range.end - PLAN_HOURS * HOUR;
    const [hour, minute] = clockOf(morning, view.timeZone).split(':').map(Number);
    start = morning + (FIRST_HOUR * 60 - hour * 60 - minute) * 60;
    end = start + PLAN_HOURS * HOUR;
    const nextMarkup = renderAxis(view, start, end, hourHeight);
    if (drag && (drag.day !== view.day || markup !== nextMarkup || !drag.source.isConnected)) finishDrag();
    if (!drag?.moved) showDate();
    if (markup !== nextMarkup) {
      const scroll = grid.scrollTop;
      grid.innerHTML = nextMarkup;
      grid.scrollTop = scroll;
      markup = nextMarkup;
    }
    position();
  }

  for (const button of modes) button.onclick = () => show(button.dataset.sidebarView);
  for (const button of scaleGroup.querySelectorAll('[data-plan-scale]')) {
    button.onclick = () => setScale(Number(button.dataset.planScale));
  }
  /** Ctrl+滚轮在时间轴上切换密度；只在档位间跳动，不拦普通滚动。 */
  grid.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const index = SCALES.indexOf(hourHeight) + (event.deltaY < 0 ? 1 : -1);
    const next = SCALES[Math.max(0, Math.min(SCALES.length - 1, index))];
    if (next !== hourHeight) setScale(next);
  }, { passive: false });
  try {
    if (localStorage.getItem(MODE_KEY) === 'tasks') show('tasks');
  } catch { /* 新窗口显示日计划 */ }
  /**
   * 新时间块放在哪里：优先接在当天最晚结束的块之后；
   * 若末尾已排到午夜，再从 06:00 起找第一个不少于 15 分钟的空档。
   * 返回 { startsAt, room }，room 为该位置到下一个块（或午夜）的秒数；全天排满时返回 null。
   */
  function appendSlot() {
    if (!view) return null;
    const spans = view.scheduled
      .map((block) => [block.startsAt, block.startsAt + block.plannedSeconds])
      .filter(([from, to]) => to > start && from < end)
      .sort((a, b) => a[0] - b[0]);
    const latestEnd = spans.reduce((max, [, to]) => Math.max(max, to), start);
    if (latestEnd + 60 <= end) return { startsAt: latestEnd, room: end - latestEnd };
    let cursor = start;
    for (const [from, to] of spans) {
      if (from - cursor >= QUARTER) return { startsAt: cursor, room: from - cursor };
      cursor = Math.max(cursor, to);
    }
    return end - cursor >= QUARTER ? { startsAt: cursor, room: end - cursor } : null;
  }

  function appendStart() {
    return appendSlot()?.startsAt ?? null;
  }

  /**
   * 「排进今天」用：从当前时刻（看别的日期时从 06:00）起，第一个放得下**完整** seconds 秒的空档起点。
   * 起点按 5 分钟吸附、不早于此刻。
   * 放不下就返回 null（调用方提示「今天排满了」）——绝不能把 seconds 截短后返回一个起点，
   * 那会让调用方仍按原时长提交，块溢到次日。
   */
  function nextFreeStart(seconds) {
    if (!view) return null;
    const wanted = Math.max(QUARTER, Math.round(Number(seconds) || DEFAULT_PLAN_SECONDS));
    // 比整条时间轴还长，今天不可能放下
    if (wanted > end - start) return null;
    const now = Math.floor(Date.now() / 1000);
    const earliest = view.day === localToday(view.timeZone) ? Math.max(start, Math.ceil(now / STEP) * STEP) : start;
    const spans = view.scheduled
      .map((block) => [block.startsAt, block.startsAt + block.plannedSeconds])
      .filter(([from, to]) => to > start && from < end)
      .sort((a, b) => a[0] - b[0]);
    // 在空档 [from, to) 里找第一个吸到 5 分钟、且整段（wanted）放得下的起点
    const fitIn = (from, to) => {
      const at = Math.max(earliest, Math.ceil(from / STEP) * STEP);
      return at + wanted <= Math.min(to, end) ? at : null;
    };
    let cursor = earliest;
    for (const [from, to] of spans) {
      if (from > cursor) {
        const at = fitIn(cursor, from);
        if (at !== null) return at;
      }
      cursor = Math.max(cursor, to);
    }
    return fitIn(cursor, end);
  }

  sidebar.querySelector('[data-plan-add]').onclick = () => {
    if (!view) return;
    const startsAt = appendStart();
    if (startsAt === null) onFull();
    else onCreate(startsAt);
  };
  grid.addEventListener('click', (event) => {
    const cell = event.target.closest('[data-plan-hour]');
    if (!cell) return;
    const fraction = (event.clientY - cell.getBoundingClientRect().top) / hourHeight;
    const quarter = event.detail ? Math.max(0, Math.min(3, Math.floor(fraction * 4))) : 0;
    onCreate(Number(cell.dataset.planHour) + quarter * QUARTER);
  });

  const blockFor = (id) => view.scheduled.find((block) => block.id === id);
  const snap = (seconds) => Math.round(seconds / STEP) * STEP;
  function duration(block, delta) {
    const max = end - block.startsAt;
    const minimum = Math.max(start - block.startsAt, 0) + Math.min(QUARTER, block.plannedSeconds);
    const visibleDuration = Math.min(max, block.plannedSeconds);
    return Math.min(max, Math.max(Math.min(minimum, visibleDuration), visibleDuration + delta));
  }
  /**
   * 上沿可移动的范围：
   * - 下限取 min(时间轴起点, 块原开始时刻)。块本来就早于 06:00 时（例如 05:30–07:00），
   *   下限是它自己的开始时刻，绝不能因为限幅把开始时刻往后推 —— 否则「↑ 提前」会变成推迟。
   * - 上限是「结束时刻前留够 15 分钟（原本更短就留原时长）」。
   */
  function startBounds(block) {
    const finishes = block.startsAt + block.plannedSeconds;
    return {
      earliest: Math.min(start, block.startsAt),
      latest: finishes - Math.min(QUARTER, block.plannedSeconds),
    };
  }
  /** 上沿：结束时刻不动，只改开始时间。↑/向上拖只会让开始更早或不变。 */
  function startOf(block, delta) {
    const { earliest, latest } = startBounds(block);
    return Math.min(latest, Math.max(earliest, block.startsAt + delta));
  }

  sidebar.addEventListener('pointerdown', (event) => {
    if (!drag) suppressClick = false;
    const source = event.target.closest('[data-resize-plan], [data-resize-plan-start], .planner-task, [data-drag-task]');
    if (!source || event.button !== 0 || !view || drag) return;
    const edge = source.dataset.resizePlan ? 'end' : source.dataset.resizePlanStart ? 'start' : '';
    const block = blockFor(source.dataset.resizePlan ?? source.dataset.resizePlanStart ?? source.dataset.block);
    const task = block?.task ?? view.pending.find((item) => item.id === source.dataset.dragTask);
    if (!task) return;
    const card = block ? source.parentElement : document.createElement('div');
    if (!block) {
      card.className = 'planner-block planner-preview';
      card.textContent = task.title;
      card.hidden = true;
      grid.querySelector('.planner-layer').append(card);
    }
    drag = {
      source, block, task, card, edge, resize: Boolean(edge), day: view.day, pointerId: event.pointerId,
      x: event.clientX, y: event.clientY, initialX: event.clientX, initialY: event.clientY,
      scroll: grid.scrollTop, grab: block ? event.clientY - card.getBoundingClientRect().top : 0,
      before: card.getAttribute('style'), seconds: block?.plannedSeconds ?? DEFAULT_PLAN_SECONDS,
      startsAt: block?.startsAt,
    };
    source.setPointerCapture(event.pointerId);
  });

  /**
   * 右栏长期项目（T-W4）：拖动柄带 data-drag-project="<projectId>"，子任务用 data-drag-project-task="<taskId>"。
   * 项目卡本身不动（这是「复制」），落点建一个时间块：taskId 取项目主任务，时长取 dailyMinutes*60（无则 30 分钟）。
   * 监听挂在 document 上：起点在右栏、落点在左栏时间轴，跨栏拖动不经过 sidebar。
   */
  document.addEventListener('pointerdown', (event) => {
    const source = event.target.closest?.('[data-drag-project], [data-drag-project-task]');
    if (!source || event.button !== 0 || !view || drag) return;
    const project = source.dataset.dragProject
      ? (view.projects ?? []).find((item) => item.id === source.dataset.dragProject)
      : null;
    if (source.dataset.dragProject && !project) return;
    if (project && (project.completedAt || project.archivedAt)) return;
    const taskId = source.dataset.dragProjectTask ?? project?.mainTaskId;
    if (!taskId) return;
    const title = project?.title ?? source.dataset.dragTitle ?? source.textContent.trim() ?? '长期项目';
    const wanted = Math.max(QUARTER, (project?.dailyMinutes ? project.dailyMinutes * 60 : DEFAULT_PLAN_SECONDS));
    if (!drag) suppressClick = false;
    const card = document.createElement('div');
    card.className = 'planner-block planner-preview';
    card.textContent = title;
    card.hidden = true;
    grid.querySelector('.planner-layer').append(card);
    const float = document.createElement('div');
    float.className = 'planner-float';
    float.textContent = `${title} · ${Math.round(wanted / 60)} 分钟`;
    float.style.left = `${event.clientX + 14}px`;
    float.style.top = `${event.clientY + 14}px`;
    document.body.append(float);
    drag = {
      source, block: null, task: { id: taskId, title }, card, float, edge: '', resize: false,
      external: true, wanted, day: view.day, pointerId: event.pointerId,
      x: event.clientX, y: event.clientY, initialX: event.clientX, initialY: event.clientY,
      scroll: grid.scrollTop, grab: 0, before: card.getAttribute('style'),
      seconds: wanted, startsAt: undefined,
    };
    source.setPointerCapture(event.pointerId);
  });

  function preview() {
    const { x, y, card, block, edge, grab } = drag;
    if (edge === 'end') {
      const distance = y - drag.initialY + grid.scrollTop - drag.scroll;
      drag.seconds = duration(block, snap(toSeconds(distance)));
      const visibleSeconds = block.startsAt + drag.seconds - Math.max(start, block.startsAt);
      card.style.height = `${toPixels(visibleSeconds)}px`;
      caption.textContent = dragLabel(block.startsAt, drag.seconds, view.timeZone);
      return;
    }
    if (edge === 'start') {
      const distance = y - drag.initialY + grid.scrollTop - drag.scroll;
      drag.startsAt = startOf(block, snap(toSeconds(distance)));
      const seconds = block.startsAt + block.plannedSeconds - drag.startsAt;
      drag.seconds = seconds;
      card.style.top = `${toPixels(drag.startsAt - start)}px`;
      card.style.height = `${toPixels(seconds)}px`;
      caption.textContent = dragLabel(drag.startsAt, seconds, view.timeZone);
      return;
    }
    const rect = grid.getBoundingClientRect();
    const layer = grid.querySelector('.planner-layer').getBoundingClientRect();
    const inside = x >= rect.left && x < rect.right && y >= Math.max(rect.top, layer.top)
      && y < Math.min(rect.bottom, layer.bottom);
    // 落点就是用户松手的位置（吸附到 5 分钟），只用「至少 15 分钟」保证放得下；
    // 时长在下面按 min(计划时长, 当天剩余) 裁剪 —— 不能拿完整时长倒推最晚起点，
    // 那会把用户的落点改掉（23:40 拖入 47 分钟的项目会变成 23:13）。
    const room = end - start;
    const required = drag.external ? QUARTER : block ? block.plannedSeconds : QUARTER;
    drag.startsAt = inside && required <= room
      ? Math.max(start, Math.min(end - required, start + snap(toSeconds(y - layer.top - grab))))
      : undefined;
    if (drag.float) {
      // 还没进时间轴时只显示跟着指针的小卡片；进了时间轴就换成轴上的预览块
      drag.float.hidden = drag.startsAt !== undefined;
      if (drag.startsAt === undefined) {
        drag.float.style.left = `${x + 14}px`;
        drag.float.style.top = `${y + 14}px`;
      }
    }
    if (!block) card.hidden = drag.startsAt === undefined;
    if (drag.startsAt === undefined) {
      if (block) resetCard(drag);
      showDate();
      return;
    }
    if (!block) {
      // 项目按计划时长排，但不超过当天剩余；至少留 15 分钟（时间轴不足 15 分钟时上面已经放不下）
      drag.seconds = drag.external
        ? Math.max(QUARTER, Math.min(drag.wanted, end - drag.startsAt))
        : Math.min(DEFAULT_PLAN_SECONDS, end - drag.startsAt);
    }
    card.classList.add('planner-dragging');
    card.style.top = `${toPixels(drag.startsAt - start)}px`;
    card.style.height = `${toPixels(drag.seconds)}px`;
    caption.textContent = drag.external
      ? dragLabel(drag.startsAt, drag.seconds, view.timeZone)
      : timeLabel({ startsAt: drag.startsAt, plannedSeconds: drag.seconds }, view.timeZone);
  }

  function scrollWhileDragging() {
    drag.frame = 0;
    const rect = grid.getBoundingClientRect();
    if (drag.x < rect.left || drag.x >= rect.right || drag.y < rect.top || drag.y >= rect.bottom) return;
    const step = drag.y < rect.top + 24 ? -6 : drag.y >= rect.bottom - 24 ? 6 : 0;
    if (!step) return;
    const before = grid.scrollTop;
    grid.scrollTop += step;
    if (grid.scrollTop === before) return;
    preview();
    drag.frame = requestAnimationFrame(scrollWhileDragging);
  }

  function resetCard({ card, before }) {
    card.classList.remove('planner-dragging');
    card.setAttribute('style', before);
  }

  sidebar.addEventListener('click', (event) => {
    if (!suppressClick || !event.detail) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  sidebar.addEventListener('pointermove', (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.moved ||= Math.hypot(drag.x - drag.initialX, drag.y - drag.initialY) >= dragThreshold();
    if (!drag.moved) return;
    preview();
    if (!drag.frame) drag.frame = requestAnimationFrame(scrollWhileDragging);
  });
  // 跨栏拖动（右栏项目 → 左栏时间轴）：指针捕获在右栏的拖动柄上，事件不经过 sidebar，所以在 document 上接。
  document.addEventListener('pointermove', (event) => {
    if (!drag?.external || drag.pointerId !== event.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.moved ||= Math.hypot(drag.x - drag.initialX, drag.y - drag.initialY) >= dragThreshold();
    if (!drag.moved) return;
    preview();
    if (!drag.frame) drag.frame = requestAnimationFrame(scrollWhileDragging);
  });
  /** keep=true：松手后要保存，卡片先留在落点，等保存后的重绘接手，避免先弹回原位再跳过去。 */
  function finishDrag(keep = false) {
    if (!drag) return null;
    const stopped = drag;
    drag = null;
    if (stopped.frame) cancelAnimationFrame(stopped.frame);
    stopped.float?.remove();
    if (keep) stopped.card.classList.remove('planner-dragging');
    else if (stopped.block) resetCard(stopped);
    else stopped.card.remove();
    if (stopped.source.hasPointerCapture(stopped.pointerId)) {
      stopped.source.releasePointerCapture(stopped.pointerId);
    }
    showDate();
    // 只有左栏内的拖动才需要在左栏吞掉紧随其后的 click；右栏起拖时点击落在右栏，别让左栏下一次点击被吃掉。
    suppressClick = stopped.external ? false : stopped.moved;
    return stopped;
  }
  const stop = (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    if (event.type === 'pointerup' && drag.moved) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      preview();
    }
    const { block, edge, task, seconds, startsAt, moved } = drag;
    let save = null;
    if (event.type === 'pointerup' && moved) {
      if (edge === 'end') {
        if (seconds !== block.plannedSeconds) save = () => onChange(block, block.startsAt, seconds);
      } else if (edge === 'start') {
        if (startsAt !== block.startsAt) save = () => onChange(block, startsAt, seconds);
      } else if (startsAt !== undefined) {
        if (!block) save = () => onDrop(task.id, startsAt, seconds);
        else if (startsAt !== block.startsAt) save = () => onChange(block, startsAt, seconds);
      }
    }
    const stopped = finishDrag(Boolean(save));
    if (!save) return;
    void Promise.resolve(save()).finally(() => {
      // 保存成功时重绘早已换掉这张卡；仍挂在页面上说明没有重绘（失败或被跳过），就按当前数据重画一次复原。
      if (!stopped.card.isConnected) return;
      if (!stopped.block) stopped.card.remove();
      markup = '';
      if (view) render(view);
    });
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) sidebar.addEventListener(type, stop);
  // 右栏起拖时指针捕获在右栏的拖动柄上，pointerup 不经过 sidebar，所以同一套收尾在 document 上再挂一份（只认 external）。
  const stopExternal = (event) => { if (drag?.external) stop(event); };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, stopExternal);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') finishDrag();
  });
  grid.addEventListener('keydown', async (event) => {
    const handle = event.target.closest('[data-resize-plan], [data-resize-plan-start]');
    if (!handle || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const edge = handle.dataset.resizePlan ? 'end' : 'start';
    const block = blockFor(handle.dataset.resizePlan ?? handle.dataset.resizePlanStart);
    if (!block) return;
    event.preventDefault();
    const step = event.shiftKey ? QUARTER : STEP;
    const direction = event.key === 'ArrowUp' ? -1 : 1;
    // 上沿：↑ 提前（开始时间往前）、↓ 推后；下沿：↑ 缩短、↓ 加长（沿用的方向）。
    let next;
    let startsAt = block.startsAt;
    if (edge === 'start') {
      startsAt = startOf(block, direction * step);
      next = block.startsAt + block.plannedSeconds - startsAt;
    } else {
      next = duration(block, direction * step);
    }
    if (next === block.plannedSeconds && startsAt === block.startsAt) return;
    await onChange(block, startsAt, next);
    if (!handle.isConnected && document.activeElement === document.body) {
      const selector = edge === 'start' ? '[data-resize-plan-start]' : '[data-resize-plan]';
      const handles = grid.querySelectorAll(selector);
      [...handles].find((item) => (item.dataset.resizePlan ?? item.dataset.resizePlanStart) === block.id)?.focus({ preventScroll: true });
    }
  });
  return { render, show, position, reveal, appendStart, appendSlot, nextFreeStart, inPlanMode: () => mode === 'plan',
    setScale, hourHeight: () => hourHeight };
}

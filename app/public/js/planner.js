import { esc } from './icons.js';
import { clockOf } from './views.js';

const HOUR = 3600;
const QUARTER = 900;
const STEP = 300;
const HOUR_HEIGHT = 32;
const FIRST_HOUR = 6;
const PLAN_HOURS = 18;
export const DEFAULT_PLAN_SECONDS = 1800;
const MODE_KEY = 'workbench.sidebarMode';
const toPixels = (seconds) => seconds * HOUR_HEIGHT / HOUR;
const toSeconds = (pixels) => pixels * HOUR / HOUR_HEIGHT;

function timeLabel(block, timeZone) {
  return `${clockOf(block.startsAt, timeZone)}–${clockOf(block.startsAt + block.plannedSeconds, timeZone)}`;
}

function renderAxis(view, start, end) {
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
    return `<div class="planner-block ${block.task.completedAt ? 'done' : ''}" style="top:${toPixels(visibleStart - start)}px;
        height:${toPixels(seconds)}px;left:${lane * laneWidth}%;width:calc(${laneWidth}% - 2px)">
      <button class="planner-task" type="button" data-task-note="${esc(block.taskId)}" data-block="${id}"
        title="${title} · ${label} · 按住拖动改期">${title}</button>
      <button class="planner-resize" type="button" data-resize-plan="${id}" role="slider"
        aria-label="调整 ${title} 的时长" aria-orientation="vertical"
        aria-valuemin="${Math.min(15, Math.round(block.plannedSeconds / 60))}"
        aria-valuemax="${Math.floor((end - block.startsAt) / 60)}"
        aria-valuenow="${Math.round(block.plannedSeconds / 60)}" aria-valuetext="${Math.round(block.plannedSeconds / 60)} 分钟"
        title="拖动下沿，或用 ↑ 缩短、↓ 加长"></button>
    </div>`;
  });
  return `<div class="planner-axis" style="--hour-height:${HOUR_HEIGHT}px">
      ${hours.join('')}<div class="planner-layer">${blocks.join('')}</div>
    </div><time class="planner-end">00:00</time>`;
}

export function bindPlanner({ onCreate, onChange, onDrop, onFull }) {
  const grid = document.querySelector('#plannerGrid');
  const sidebar = grid.closest('.left');
  const pending = document.querySelector('#pending');
  const caption = document.querySelector('#plannerDate');
  const modes = document.querySelectorAll('[data-sidebar-view]');
  let view;
  let start;
  let end;
  let mode = 'plan';
  let markup = '';
  let positionDay;
  let drag;
  let suppressClick = false;

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
      grid.scrollTop = Math.max(0, top - HOUR_HEIGHT / 2);
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
    const nextMarkup = renderAxis(view, start, end);
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

  sidebar.querySelector('[data-plan-add]').onclick = () => {
    if (!view) return;
    const startsAt = appendStart();
    if (startsAt === null) onFull();
    else onCreate(startsAt);
  };
  grid.addEventListener('click', (event) => {
    const cell = event.target.closest('[data-plan-hour]');
    if (!cell) return;
    const fraction = (event.clientY - cell.getBoundingClientRect().top) / HOUR_HEIGHT;
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

  sidebar.addEventListener('pointerdown', (event) => {
    if (!drag) suppressClick = false;
    const source = event.target.closest('[data-resize-plan], .planner-task, [data-drag-task]');
    if (!source || event.button !== 0 || !view || drag) return;
    const resize = !!source.dataset.resizePlan;
    const block = blockFor(source.dataset.resizePlan ?? source.dataset.block);
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
      source, block, task, card, resize, day: view.day, pointerId: event.pointerId,
      x: event.clientX, y: event.clientY, initialX: event.clientX, initialY: event.clientY,
      scroll: grid.scrollTop, grab: block ? event.clientY - card.getBoundingClientRect().top : 0,
      before: card.getAttribute('style'), seconds: block?.plannedSeconds ?? DEFAULT_PLAN_SECONDS,
    };
    source.setPointerCapture(event.pointerId);
  });

  function preview() {
    const { x, y, card, block, resize, grab } = drag;
    if (resize) {
      const distance = y - drag.initialY + grid.scrollTop - drag.scroll;
      drag.seconds = duration(block, snap(toSeconds(distance)));
      const visibleSeconds = block.startsAt + drag.seconds - Math.max(start, block.startsAt);
      card.style.height = `${toPixels(visibleSeconds)}px`;
      caption.textContent = `${Math.round(drag.seconds / 60)} 分钟`;
      return;
    }
    const rect = grid.getBoundingClientRect();
    const layer = grid.querySelector('.planner-layer').getBoundingClientRect();
    const inside = x >= rect.left && x < rect.right && y >= Math.max(rect.top, layer.top)
      && y < Math.min(rect.bottom, layer.bottom);
    const required = block ? block.plannedSeconds : QUARTER;
    drag.startsAt = inside && required <= end - start
      ? Math.max(start, Math.min(end - required, start + snap(toSeconds(y - layer.top - grab))))
      : undefined;
    if (!block) card.hidden = drag.startsAt === undefined;
    if (drag.startsAt === undefined) {
      if (block) resetCard(drag);
      showDate();
      return;
    }
    if (!block) drag.seconds = Math.min(DEFAULT_PLAN_SECONDS, end - drag.startsAt);
    card.classList.add('planner-dragging');
    card.style.top = `${toPixels(drag.startsAt - start)}px`;
    card.style.height = `${toPixels(drag.seconds)}px`;
    caption.textContent = timeLabel({ startsAt: drag.startsAt, plannedSeconds: drag.seconds }, view.timeZone);
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
    drag.moved ||= Math.hypot(drag.x - drag.initialX, drag.y - drag.initialY) >= 4;
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
    if (keep) stopped.card.classList.remove('planner-dragging');
    else if (stopped.block) resetCard(stopped);
    else stopped.card.remove();
    if (stopped.source.hasPointerCapture(stopped.pointerId)) {
      stopped.source.releasePointerCapture(stopped.pointerId);
    }
    showDate();
    suppressClick = stopped.moved;
    return stopped;
  }
  const stop = (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    if (event.type === 'pointerup' && drag.moved) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      preview();
    }
    const { block, resize, task, seconds, startsAt, moved } = drag;
    let save = null;
    if (event.type === 'pointerup' && moved) {
      if (resize) {
        if (seconds !== block.plannedSeconds) save = () => onChange(block, block.startsAt, seconds);
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
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') finishDrag();
  });
  grid.addEventListener('keydown', async (event) => {
    const handle = event.target.closest('[data-resize-plan]');
    if (!handle || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const block = blockFor(handle.dataset.resizePlan);
    if (!block) return;
    event.preventDefault();
    const next = duration(block, event.key === 'ArrowDown' ? STEP : -STEP);
    if (next === block.plannedSeconds) return;
    await onChange(block, block.startsAt, next);
    if (!handle.isConnected && document.activeElement === document.body) {
      const handles = grid.querySelectorAll('[data-resize-plan]');
      [...handles].find((item) => item.dataset.resizePlan === block.id)?.focus({ preventScroll: true });
    }
  });
  return { render, show, position, reveal, appendStart, appendSlot, inPlanMode: () => mode === 'plan' };
}

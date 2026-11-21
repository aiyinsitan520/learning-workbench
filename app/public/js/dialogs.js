// 任务弹窗：任务详情（改名 / 排期 / 完成）、日计划添加时间块（可新建任务）、选任务。
import { newId } from './api.js';
import { $, closeDialog, modal, notify } from './dom.js';
import { esc } from './icons.js';
import { DEFAULT_PLAN_SECONDS } from './planner.js';
import { clockOf, minutesOf, todoTasks } from './views.js';

/**
 * @param {object} ctx
 * @param {object} ctx.state
 * @param {(id: string) => object|undefined} ctx.findTask
 * @param {(id: string, title: string) => Promise<boolean>} ctx.renameTask
 * @param {(block: object, success: string) => Promise<boolean|undefined>} ctx.saveBlock
 * @param {(title: string, block: object) => Promise<boolean|undefined>} ctx.createTaskBlock
 * @param {object} ctx.planner
 */
export function createDialogs({ state, findTask, renameTask, saveBlock, createTaskBlock, planner }) {
  function taskDialog(taskId, blockId) {
    const view = state.view;
    const task = findTask(taskId);
    if (!task) return;
    const blocks = view.scheduled.filter((b) => b.taskId === taskId);
    const selectedBlock = blocks.find((block) => block.id === blockId) ?? blocks[0];
    const selectedSeconds = selectedBlock?.plannedSeconds ?? 1500;
    const durations = [...new Set([900, 1500, 1800, 2700, 3600, selectedSeconds])].sort((a, b) => a - b);
    const initialTime = selectedBlock ? clockOf(selectedBlock.startsAt, view.timeZone) : '15:00';
    const done = Boolean(task.completedAt);

    modal(`
      <div class="cardlabel">${esc(task.course || '自选学习')}</div>
      <h2>${esc(task.title)}</h2>
      <p class="soft">${task.estimatedSeconds ? `预计 ${Math.round(task.estimatedSeconds / 60)} 分钟` : '未设置预计时长'}${done ? ' · 已完成' : ''}</p>
      <div class="dialogrow">
        <label class="grow">标题 <input type="text" id="editTitle" maxlength="120" value="${esc(task.title)}"></label>
        <button class="light" id="saveTitle">改名</button>
      </div>
      <div class="dialogrow">
        <label>开始时间 <input type="time" id="at" value="${initialTime}"></label>
        <label>时长 <select id="mins">${durations.map((seconds) => `<option value="${seconds}" ${seconds === selectedSeconds ? 'selected' : ''}>${minutesOf(seconds)} 分钟</option>`).join('')}</select></label>
        <button class="light" id="saveTime">${blocks.length ? '改期' : '排入时间线'}</button>
      </div>
      ${blocks.length ? `<p class="soft small">已有 ${blocks.length} 个时间块：${blocks.map((b) => clockOf(b.startsAt, view.timeZone)).join('、')}</p>` : ''}
      <div class="dialogrow">
        ${done
          ? `<button class="light" data-undo="${esc(task.id)}">撤销完成</button>`
          : `<button class="primary" data-select="${esc(task.id)}">让贾维斯喵陪我学这项</button>
             <button class="light" data-complete="${esc(task.id)}">标记完成</button>`}
        ${selectedBlock ? `<button class="light danger" data-removeblock="${esc(selectedBlock.id)}">取消排期</button>` : ''}
      </div>`);

    $('#saveTitle').onclick = () => {
      const next = $('#editTitle').value.trim();
      if (!next) { notify('标题不能为空', 'bad'); return; }
      if (next === task.title) { notify('标题没有变化'); return; }
      closeDialog();
      void renameTask(task.id, next);
    };

    $('#saveTime').onclick = () => {
      const value = $('#at').value;
      if (!value) return;
      const [hh, mm] = value.split(':').map(Number);
      if (hh > 23 || mm > 59) { notify('时间不合法', 'bad'); return; }
      const startsAt = selectedBlock && value === initialTime
        ? selectedBlock.startsAt
        : view.range.start + hh * 3600 + mm * 60;
      if (startsAt < 0) { notify('时间不合法', 'bad'); return; }
      const block = {
        id: selectedBlock?.id ?? newId('block'), taskId: task.id, startsAt,
        plannedSeconds: Number($('#mins').value),
      };
      closeDialog();
      void saveBlock(block, selectedBlock ? '已改期，任务数不变' : '已排入时间线');
    };
  }

  /**
   * 点日计划空档：写一个名字（可以是新任务），或点下面列出的未完成待办；再选时长。
   * 名字与某个待办完全相同就排那个待办，否则新建任务并排进去。
   */
  function plannerBlockDialog(startsAt) {
    const { day, scheduled, range, timeZone } = state.view;
    const pending = todoTasks(state.view); // 只列待办清单里的任务；新写的名字只进日计划
    const max = Math.floor((range.end - startsAt) / 60);
    if (max < 1) return;
    // 到下一个已有安排还有多少分钟，用来给默认时长和提示
    const nextStart = scheduled.map((b) => b.startsAt).filter((at) => at > startsAt).sort((a, b) => a - b)[0];
    const room = Math.floor(((nextStart ?? range.end) - startsAt) / 60);
    const fit = Math.max(1, Math.min(max, room));
    const defaultMinutes = Math.min(DEFAULT_PLAN_SECONDS / 60, fit >= 15 ? Math.floor(fit / 5) * 5 : fit);
    const presets = [15, 25, 30, 45, 60, 90].filter((m) => m <= max);
    const firstStart = new Map();
    for (const b of scheduled) if (!firstStart.has(b.taskId)) firstStart.set(b.taskId, b.startsAt);
    const ids = { task: newId('task'), block: newId('block') }; // 同一次弹窗重试复用，服务端按 ID 幂等

    modal(`<div class="dialoghead">
        <h2>${clockOf(startsAt, timeZone)} 添加时间块</h2>
        <p class="soft">${nextStart ? `到下一个安排 ${clockOf(nextStart, timeZone)} 还有 ${room} 分钟` : `到午夜还有 ${max} 分钟`}</p>
      </div>
      <form id="planForm" class="planform" autocomplete="off">
        <label class="field" for="planTitle"><span>做什么</span></label>
        <input id="planTitle" maxlength="48" placeholder="写下要做的事，或从下面选一个待办" required>
        ${pending.length ? `<div class="field-head"><span>未完成的待办</span><small>${pending.length} 项</small></div>
          <div class="chipgroup" id="planPicks" role="group" aria-label="未完成的待办">
            ${pending.map((task) => {
              const at = firstStart.get(task.id);
              return `<button type="button" class="chip task-chip" data-plan-pick="${esc(task.id)}" aria-pressed="false"
                title="${esc(task.title)}"><span>${esc(task.title)}</span>${at === undefined ? '' : `<time>${clockOf(at, timeZone)}</time>`}</button>`;
            }).join('')}
            <p class="empty chip-empty" hidden>没有匹配的待办，将把「<b></b>」只加进日计划</p>
          </div>` : '<p class="soft plan-hint">还没有待办，写下名字就会直接加进日计划。</p>'}
        <div class="field-head"><span>时长</span></div>
        <div class="chipgroup duration">
          ${presets.map((m) => `<button type="button" class="chip" data-plan-minutes="${m}"
            aria-pressed="${m === defaultMinutes}">${m} 分钟</button>`).join('')}
          <label class="chip chip-input">自定 <input id="planMinutes" type="number" min="1" max="${max}" step="1"
            value="${defaultMinutes}" required aria-label="时长（分钟）"></label>
        </div>
        <div class="dialogactions">
          <span class="soft" id="planSummary"></span>
          <button type="button" class="light" id="planCancel">取消</button>
          <button type="submit" class="primary">安排</button>
        </div>
      </form>`);

    const title = $('#planTitle');
    const minutes = $('#planMinutes');
    const picks = [...document.querySelectorAll('#planPicks [data-plan-pick]')];
    const presetButtons = [...document.querySelectorAll('[data-plan-minutes]')];
    let picked = null;

    const matchTask = () => pending.find((t) => t.title === title.value.trim()) ?? null;
    function sync() {
      const text = title.value.trim();
      const match = matchTask();
      picked = match?.id ?? null;
      let visible = 0;
      for (const chip of picks) {
        const task = pending.find((t) => t.id === chip.dataset.planPick);
        const on = chip.dataset.planPick === picked;
        chip.setAttribute('aria-pressed', String(on));
        // 输入时按名字筛选；选中某项后仍显示全部，方便改选
        const show = !text || picked || task.title.includes(text);
        chip.hidden = !show;
        if (show) visible += 1;
      }
      const empty = document.querySelector('#planPicks .chip-empty');
      if (empty) {
        empty.hidden = visible > 0 || !text;
        empty.querySelector('b').textContent = text;
      }
      const m = Number(minutes.value);
      for (const button of presetButtons) button.setAttribute('aria-pressed', String(Number(button.dataset.planMinutes) === m));
      const end = startsAt + Math.max(0, m) * 60;
      $('#planSummary').textContent = text && m > 0
        ? `${picked ? '排入这个待办' : '只加进日计划'} · ${clockOf(startsAt, timeZone)}–${clockOf(Math.min(end, range.end), timeZone)}`
        : '';
    }

    for (const chip of picks) {
      chip.onclick = () => {
        title.value = pending.find((t) => t.id === chip.dataset.planPick).title;
        sync();
      };
    }
    for (const button of presetButtons) {
      button.onclick = () => { minutes.value = button.dataset.planMinutes; sync(); };
    }
    title.oninput = sync;
    minutes.oninput = sync;
    $('#planCancel').onclick = closeDialog;
    // 默认选中当前推荐 / 正在编辑的待办，方便直接确认
    const preferred = pending.find((t) => t.id === state.selectedTaskId);
    if (preferred) title.value = preferred.title;
    sync();
    title.focus();
    title.select();

    $('#planForm').onsubmit = async (event) => {
      event.preventDefault();
      const name = title.value.trim();
      const m = Number(minutes.value);
      if (!name) { title.focus(); return; }
      if (!(m >= 1 && m <= max)) { notify(`时长需在 1–${max} 分钟之间`, 'bad'); minutes.focus(); return; }
      const existing = matchTask();
      const block = { id: ids.block, taskId: existing?.id ?? ids.task, startsAt, plannedSeconds: m * 60 };
      closeDialog();
      const saved = existing
        ? await saveBlock(block, '已添加时间块')
        : await createTaskBlock(name, block);
      if (saved && state.view.day === day) planner.reveal(startsAt, block.plannedSeconds);
    };
  }

  /** 选一个任务开始专注（灵动岛 / 专注页的「换任务」）。 */
  function chooseTaskDialog() {
    if (state.view.openFocus) { notify('结束本轮专注后即可更换任务'); return; }
    const pending = state.view.pending;
    if (!pending.length) { notify('还没有待办任务'); return; }
    modal(`<h2>想先学哪一项？</h2>${pending.map((t) => `
      <div class="listrow"><button data-choose="${esc(t.id)}">${esc(t.title)}</button></div>`).join('')}`);
  }

  return { taskDialog, plannerBlockDialog, chooseTaskDialog };
}

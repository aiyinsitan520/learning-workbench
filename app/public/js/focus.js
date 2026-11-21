// 专注相关的外壳部件：顶栏灵动岛、首页专注卡、右下角贾维喵浮层，以及共用的倒计时。
// 只负责画和开关；开始 / 暂停 / 结束等写操作由 app.js 的 commands 执行。
import { $ } from './dom.js';
import { catPanel, mmss } from './views.js';

/** 开放专注还剩多少秒（运行中按墙钟推算，暂停时按已累计）。 */
export function remainingSeconds(open, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!open) return null;
  return open.state === 'running'
    ? open.startedAt + open.plannedSeconds - open.elapsedSeconds - nowSeconds
    : open.plannedSeconds - open.elapsedSeconds;
}

/**
 * @param {object} ctx
 * @param {object} ctx.state      应用状态（只读）
 * @param {object} ctx.commands   start / pause / resume
 * @param {(id: string) => string} ctx.taskName
 */
export function bindFocusChrome({ state, commands, taskName }) {
  const islandMain = $('#islandMain');
  const islandBox = $('#islandBox');
  const cat = $('#cat');
  const catPanelEl = $('#catPanel');

  function drawIsland() {
    const open = state.view?.openFocus;
    const rec = state.recommended;
    islandMain.dataset.busy = open ? '1' : '0';
    $('#islandTime').textContent = open ? (open.state === 'running' ? '专注中' : '已暂停') : '待专注';
    $('#islandTask').textContent = open
      ? (open.taskId ? taskName(open.taskId) : '自由专注')
      : (rec?.title ?? '自由专注');
    const act = $('#islandAct');
    if (open) {
      act.textContent = open.state === 'running' ? '暂停计时' : '继续计时';
      act.disabled = false;
    } else {
      act.textContent = `开始 ${Math.round((rec?.estimatedSeconds ?? state.focusPlanned) / 60)} 分钟`;
      act.disabled = !rec;
    }
  }

  function drawHomeFocus() {
    const open = state.view.openFocus;
    const card = $('#homeFocus');
    card.hidden = state.page !== 'home' || !open;
    if (card.hidden) return;
    const paused = open.state === 'paused';
    const title = open.taskId ? taskName(open.taskId) : '自由专注';
    $('#homeFocusTitle').textContent = `${paused ? '本轮专注已暂停' : '本轮专注中'}：${title}。`;
    $('#homeFocusStatus').textContent = paused ? '回到专注页就能继续计时。' : '计时还在走，随时可以回到专注页。';
  }

  function drawCat() {
    const open = state.view?.openFocus;
    cat.dataset.busy = open ? '1' : '0';
    cat.title = open ? `贾维斯喵 · ${open.state === 'running' ? '专注中' : '已暂停'}` : '贾维斯喵 · 待命';
    if (catPanelEl.hidden) return;
    $('#catBody').innerHTML = catPanel(state);
    $('#catState').textContent = open ? (open.state === 'running' ? '专注计时中' : '已暂停') : '待命中';
    tickCat();
  }

  function tickCat() {
    const el = $('#catClock');
    const left = remainingSeconds(state.view?.openFocus);
    if (el && left != null) el.textContent = mmss(Math.max(0, left));
  }

  function showIsland(on) {
    islandBox.hidden = !on;
    islandMain.setAttribute('aria-expanded', String(on));
    if (on) drawIsland();
  }

  function toggleCat(force) {
    const show = force ?? catPanelEl.hidden;
    catPanelEl.hidden = !show;
    cat.setAttribute('aria-expanded', String(show));
    if (show) drawCat();
  }

  islandMain.addEventListener('click', () => showIsland(islandBox.hidden));
  $('#islandAct').addEventListener('click', () => {
    const open = state.view?.openFocus;
    if (!open) commands.start();
    else if (open.state === 'running') commands.pause();
    else commands.resume();
    showIsland(false);
  });
  document.addEventListener('click', (event) => {
    if (!islandBox.hidden && !event.target.closest?.('.island')) showIsland(false);
  });
  cat.addEventListener('click', () => toggleCat());
  $('#catClose').addEventListener('click', () => toggleCat(false));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || $('#dialog').open) return;
    if (!islandBox.hidden) { showIsland(false); islandMain.focus(); return; }
    if (!catPanelEl.hidden) { toggleCat(false); cat.focus(); }
  });

  return {
    draw() { drawHomeFocus(); drawCat(); drawIsland(); },
    tickCat,
    showIsland,
    toggleCat,
  };
}

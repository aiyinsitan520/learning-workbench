// 新手引导与帮助面板（T-W9）。
// - 首次打开（localStorage 没有 workbench.tour.v1）在主区顶部出现欢迎卡：「开始 1 分钟引导」/「以后再说」。
//   欢迎卡是普通的页内卡片，不遮挡、不抢焦点；两个按钮都会记下，之后不再自动出现。
// - 引导：聚光圈 + 气泡说明，「上一步 / 下一步 / 跳过」+ 进度点；←/→ 翻页，Esc 退出。
//   锚点不存在或不可见（例如窄屏隐藏）时自动跳过该步。引导期间外壳不做实时刷新（app.js 的 refreshBlocked）。
// - 顶栏「?」（或在页面上按 ?）打开帮助：功能速查（每项一句话 +「带我去」）、快捷键表、「重新开始引导」。
import { esc } from './icons.js';

export const TOUR_KEY = 'workbench.tour.v1';

/** 步骤锚点都用 data-tour 属性（index.html / views.js / planner.js 里加的），不依赖样式类名。 */
export const STEPS = [
  { id: 'nav', title: '顶栏：切换页面',
    text: '今日、日历、专注、统计、维护、收获六个页面在这里切换，也可以直接按数字键 1–6。' },
  { id: 'planner', page: 'home', title: '左栏：今天的日计划',
    text: '点时间轴空白处加一个时间块；按住块拖动改期；拖块的上沿改开始时间、拖下沿改时长。' },
  { id: 'todo', title: '待办拖进计划',
    text: '切到「待办」，按住一项拖到时间轴上就排好了。右键选「排进下一个空档」更省事。' },
  { id: 'focus', title: '专注与灵动岛',
    text: '点「贾维喵」开始一轮专注；「桌面灵动岛」把倒计时钉在屏幕顶部，切到别的软件也看得见。' },
  { id: 'notes', page: 'home', title: '任务正文',
    text: '点任何任务都会在这里打开它的正文，随手记笔记；截图可以直接粘贴进来，Ctrl+S 立即保存。' },
  { id: 'projects', title: '右栏：长期项目',
    text: '要连续做好几天的事建成项目；按住项目卡左上角的拖动柄拖进左栏计划，或点「排进今天」。' },
  { id: 'harvest', title: '收获：存下对话精华',
    text: '在任何页面按 Ctrl+Shift+V，粘贴 AI 对话里的精华存成卡片；有该复习的卡片时这里亮小红点。' },
  { id: 'menu', title: '右键菜单',
    text: '时间块、待办、项目卡、收获卡上点右键，常用操作都在里面；键盘上用 Shift+F10。' },
  { id: 'data', title: '数据位置与 Obsidian',
    text: '齿轮里的「数据与备份」可以查看、更换数据文件夹和做备份，也能把正文和收获导出到 Obsidian 仓库。' },
];

const SHORTCUTS = [
  ['1 – 6', '切换顶栏页面'],
  ['N', '新建任务'],
  ['空格', '专注页：开始 / 暂停 / 继续'],
  ['Ctrl+S', '立即保存任务正文'],
  ['Ctrl+Shift+V', '收获速记：粘贴对话精华'],
  ['Ctrl+C / Ctrl+V', '复制 / 粘贴时间块（焦点在时间轴上）'],
  ['↑ / ↓', '时间块上下沿：改开始时间或时长 5 分钟（Shift 15 分钟）'],
  ['Ctrl+滚轮', '时间轴切换紧凑 / 舒适 / 宽松'],
  ['Shift+F10', '打开右键菜单'],
  ['Esc', '关闭菜单、取消拖动、退出引导'],
  ['?', '打开这份帮助'],
];

let ctx = null;
let tour = null;      // { index, layer, spot, bubble, back }
let welcome = null;

export const isTourActive = () => Boolean(tour);

const anchorOf = (step) => document.querySelector(`[data-tour="${step.id}"]`);
function visible(el) {
  if (!el?.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/**
 * @param {object} moduleCtx  外壳的 ModuleContext（用到 gotoPage / state / modal / closeDialog / prefs / notify）
 */
export function bindTour(moduleCtx) {
  ctx = moduleCtx;
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  if (!ctx.prefs.get(TOUR_KEY)) showWelcome();
  return { start, openHelp, active: isTourActive };
}

// ---------------------------------------------------------------- 欢迎卡

function showWelcome() {
  const main = document.querySelector('#main');
  if (!main || welcome) return;
  welcome = document.createElement('section');
  welcome.className = 'tour-welcome';
  welcome.setAttribute('aria-label', '新手引导');
  welcome.innerHTML = `<img src="/kitten.png" alt="">
    <div class="tour-welcome-copy"><b>第一次来？花 1 分钟认识工作台</b>
      <small>之后随时可以点顶栏的「?」再看。</small></div>
    <div class="tour-welcome-actions">
      <button type="button" class="light" data-tour-later>以后再说</button>
      <button type="button" class="primary" data-tour-start>开始 1 分钟引导</button>
    </div>`;
  main.insertBefore(welcome, main.firstChild);
}

function hideWelcome(remember) {
  if (remember && !ctx.prefs.get(TOUR_KEY)) ctx.prefs.set(TOUR_KEY, remember);
  welcome?.remove();
  welcome = null;
}

// ---------------------------------------------------------------- 引导

function start(index = 0) {
  hideWelcome('started');
  if (document.querySelector('#dialog')?.open) ctx.closeDialog();
  if (!tour) {
    const layer = document.createElement('div');
    layer.className = 'tour-layer';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-labelledby', 'tourTitle');
    layer.innerHTML = `<div class="tour-spot" aria-hidden="true"></div>
      <div class="tour-bubble">
        <small class="tour-count" data-tour-count></small>
        <h2 id="tourTitle" data-tour-title></h2>
        <p data-tour-text></p>
        <div class="tour-dots" aria-hidden="true">${STEPS.map(() => '<i></i>').join('')}</div>
        <div class="tour-actions">
          <button type="button" class="light tour-skip" data-tour-skip>跳过</button>
          <button type="button" class="light" data-tour-prev>上一步</button>
          <button type="button" class="primary" data-tour-next>下一步</button>
        </div>
      </div>`;
    document.body.append(layer);
    tour = {
      index: -1, layer, spot: layer.querySelector('.tour-spot'), bubble: layer.querySelector('.tour-bubble'),
      back: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
  }
  go(index, 1);
}

/** 从 index 起按方向找第一个锚点可见的步骤；需要的话先切到它所在的页面。找不到就结束引导。 */
function go(index, direction) {
  for (let i = index; i >= 0 && i < STEPS.length; i += direction) {
    const step = STEPS[i];
    if (step.page && ctx.state.page !== step.page) ctx.gotoPage(step.page, { animate: false });
    const el = anchorOf(step);
    if (!visible(el)) continue;
    tour.index = i;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    render();
    return;
  }
  if (direction < 0) return; // 已经是第一步，留在原地
  finish(true);
}

function render() {
  const step = STEPS[tour.index];
  const { layer } = tour;
  layer.dataset.step = step.id;
  layer.querySelector('[data-tour-count]').textContent = `第 ${tour.index + 1} / ${STEPS.length} 步`;
  layer.querySelector('[data-tour-title]').textContent = step.title;
  layer.querySelector('[data-tour-text]').textContent = step.text;
  layer.querySelectorAll('.tour-dots i').forEach((dot, i) => dot.classList.toggle('on', i === tour.index));
  const first = !STEPS.slice(0, tour.index).some((s) => visible(anchorOf(s)));
  // 后面的步骤要切页面的，切过去才知道锚点在不在，先当作还有下一步
  const last = !STEPS.slice(tour.index + 1).some((s) => (s.page && s.page !== ctx.state.page) || visible(anchorOf(s)));
  layer.querySelector('[data-tour-prev]').disabled = first;
  layer.querySelector('[data-tour-next]').textContent = last ? '完成' : '下一步';
  place();
  layer.querySelector('[data-tour-next]').focus({ preventScroll: true });
}

const PAD = 6;
const GAP = 12;
function place() {
  if (!tour || tour.index < 0) return;
  const el = anchorOf(STEPS[tour.index]);
  if (!visible(el)) return;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const r = el.getBoundingClientRect();
  const left = Math.max(4, r.left - PAD);
  const top = Math.max(4, r.top - PAD);
  const right = Math.min(vw - 4, r.right + PAD);
  const bottom = Math.min(vh - 4, r.bottom + PAD);
  Object.assign(tour.spot.style, {
    left: `${left}px`, top: `${top}px`, width: `${Math.max(0, right - left)}px`, height: `${Math.max(0, bottom - top)}px`,
  });
  const { bubble } = tour;
  const { width, height } = bubble.getBoundingClientRect();
  // 优先放在高亮区下方，其次上方，再其次右侧 / 左侧；都放不下就叠在视口底部
  let x = left;
  let y;
  if (bottom + GAP + height <= vh) y = bottom + GAP;
  else if (top - GAP - height >= 0) y = top - GAP - height;
  else if (right + GAP + width <= vw) { x = right + GAP; y = top; }
  else if (left - GAP - width >= 0) { x = left - GAP - width; y = top; }
  else y = vh - height - 8;
  x = Math.max(8, Math.min(x, vw - width - 8));
  y = Math.max(8, Math.min(y, vh - height - 8));
  bubble.style.left = `${Math.round(x)}px`;
  bubble.style.top = `${Math.round(y)}px`;
}

function finish(completed) {
  if (!tour) return;
  const { layer, back } = tour;
  tour = null;
  layer.remove();
  ctx.prefs.set(TOUR_KEY, completed ? 'done' : 'skipped');
  if (back?.isConnected) back.focus({ preventScroll: true });
  ctx.notify(completed ? '引导完成，随时点顶栏的「?」再看' : '已退出引导，随时点顶栏的「?」再看');
}

// ---------------------------------------------------------------- 帮助面板

function openHelp() {
  if (tour) finish(false);
  ctx.modal(`<section class="tour-help" data-tour-help>
    <h2>使用帮助</h2>
    <h3>功能速查</h3>
    <ul class="tour-features">${STEPS.map((step, i) => `<li>
      <div><b>${esc(step.title)}</b><p>${esc(step.text)}</p></div>
      <button type="button" class="light" data-tour-goto="${i}">带我去</button></li>`).join('')}</ul>
    <h3>快捷键</h3>
    <table class="tour-keys"><tbody>${SHORTCUTS.map(([keys, what]) => `<tr>
      <th scope="row">${keys.split(' / ').map((k) => `<kbd>${esc(k)}</kbd>`).join(' / ')}</th><td>${esc(what)}</td></tr>`).join('')}
    </tbody></table>
    <div class="dialogactions"><button type="button" class="primary" data-tour-restart>重新开始引导</button></div>
  </section>`);
}

// ---------------------------------------------------------------- 事件

function onClick(event) {
  const btn = event.target instanceof Element ? event.target.closest('button') : null;
  if (!btn) return;
  const d = btn.dataset;
  if (d.tourStart != null) start(0);
  else if (d.tourLater != null) { hideWelcome('later'); ctx.notify('好的，需要时点顶栏的「?」'); }
  else if (d.tourNext != null) go(tour.index + 1, 1);
  else if (d.tourPrev != null) go(tour.index - 1, -1);
  else if (d.tourSkip != null) finish(false);
  else if (d.tourGoto != null) start(Number(d.tourGoto));
  else if (d.tourRestart != null) start(0);
  else if (d.tourHelp != null) openHelp();
}

function onKey(event) {
  if (tour) {
    const keys = {
      Escape: () => finish(false),
      ArrowRight: () => go(tour.index + 1, 1),
      ArrowLeft: () => go(tour.index - 1, -1),
    };
    if (keys[event.key]) {
      event.preventDefault();
      event.stopPropagation();
      keys[event.key]();
    } else if (event.key === 'Tab') {
      // 焦点只在气泡的按钮之间转
      const buttons = [...tour.bubble.querySelectorAll('button:not(:disabled)')];
      const i = buttons.indexOf(document.activeElement);
      event.preventDefault();
      buttons[(i + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }
    return;
  }
  const el = event.target instanceof Element ? event.target : null;
  if (event.key === '?' && !el?.closest('input, textarea, select, [contenteditable]')
    && !event.ctrlKey && !event.metaKey && !event.altKey && !document.querySelector('#dialog')?.open) {
    event.preventDefault();
    openHelp();
  }
}

// 每日维护看板（顶栏「维护」，快捷键 5，页面 key 'review'）。
// 数据只从 ctx.api.get('/api/review?day=…') 取（DayDigest + 已存的 AI 回顾），
// 写操作走 ctx.api.command / ctx.api.post；按钮统一用 data-board-* 属性并在本模块内监听，
// 不使用外壳已占用的 data-page / data-task / data-day 等属性。
import { newId } from './api.js';
import { esc } from './icons.js';
import { zoneWall } from './dom.js';
import { paint, localText } from './review.js';

/** 看板自己的状态：外壳重绘时保留，切页回来重新读取。 */
const state = {
  day: null, // 正在看的那一天；null = 用服务默认（昨天）
  data: null, // { digest, factsHash, review, today }
  marks: new Map(), // 时间块 id → { block, mark: 'moved' | 'done' }：刚顺延/完成的那些行
  loading: false,
  error: '',
  aiBusy: false,
  aiError: '',
};

let panel = null;
let ctx = null;
let loadSeq = 0;

/** @param {HTMLElement} host #mainContent */
export function showBoard(host, moduleCtx) {
  ctx = moduleCtx;
  // 外壳每次重绘都会调用本函数；看板还在页面上就保持原样，不打断正在输入的内容。
  if (panel && panel.isConnected && host.contains(panel)) return;
  panel = document.createElement('section');
  panel.className = 'board-page';
  panel.addEventListener('click', onClick);
  panel.addEventListener('input', onInput);
  host.replaceChildren(panel);
  panel.innerHTML = '<div class="topline"><h1>每日维护</h1></div><p class="empty">正在读取记录…</p>';
  // 每次重新进入页面都从默认日期（昨天）看起，避免上次翻到的旧日期让人困惑。
  state.day = null;
  state.data = null;
  state.marks.clear();
  state.aiError = '';
  void load({ keepMarks: false });
}

/**
 * T-W1 遗留的实时刷新：另一端改了数据（live change）时重读当前日期的看板。
 * 有弹窗、正在生成、或看板里还有未保存的标记时跳过，交给下一次变化。
 */
export function refreshBoard() {
  if (!panel?.isConnected || state.loading) return false;
  void load({ keepMarks: true });
  return true;
}

// ---------------------------------------------------------------- 数据

function shift(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

async function load({ day = state.day, keepMarks = false } = {}) {
  const seq = ++loadSeq;
  state.loading = true;
  state.error = '';
  render();
  try {
    const data = await ctx.api.get('/api/review' + (day ? `?day=${encodeURIComponent(day)}` : ''));
    if (seq !== loadSeq) return;
    state.day = data.digest.day;
    state.data = data;
    if (!keepMarks) { state.marks.clear(); state.aiError = ''; }
  } catch (err) {
    if (seq !== loadSeq) return;
    state.error = err?.message ?? String(err);
  } finally {
    if (seq === loadSeq) {
      state.loading = false;
      render();
    }
  }
}

/** 写操作后：先刷新看板自己的数据，再让外壳刷新当天视图（左栏日计划跟着变）。 */
async function refreshAfterWrite() {
  await load({ keepMarks: true });
  await ctx.reload();
}

// ---------------------------------------------------------------- 渲染

const dayLabel = (day) => {
  const [, m, d] = day.split('-').map(Number);
  return `${m} 月 ${d} 日`;
};

function relativeWord(day, today) {
  if (day === today) return '今天';
  if (day === shift(today, -1)) return '昨天';
  return '';
}

const whenWord = (day, today) => relativeWord(day, today) || '这一天';

function focusText(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (!hours) return { value: String(minutes), unit: '分钟' };
  return { value: `${hours} 小时 ${minutes} 分`, unit: '' };
}

/** 给 review.js 的画布导出用的「事实」，口径与 /api/review 一致。 */
function factsOf(digest, extra = {}) {
  return {
    day: digest.day,
    created: (digest.created ?? []).length,
    followRate: digest.plan.followRate,
    planned: digest.plan.blocks.length,
    noteTasks: (extra.notes ?? []).filter((n) => n.edited).length,
    harvests: (extra.harvests ?? []).length,
    projectLogs: (digest.projects ?? []).filter((p) => p.log).length,
    completed: digest.completed.map((t) => t.title),
    focus: digest.focus.byTask.map((t) => ({ title: t.title, seconds: t.seconds })),
    sessions: digest.focus.sessions,
    seconds: digest.focus.seconds,
    scheduled: digest.plan.blocks.length,
    noteTitle: '',
    noteBlocks: 0,
  };
}

/** 没做完的计划：服务给的未完成块 + 刚处理过、已经不在列表里的那些行。 */
function unfinishedRows() {
  const { digest } = state.data;
  const rows = digest.unfinishedBlocks.map((block) => ({ block, mark: state.marks.get(block.id)?.mark ?? '' }));
  for (const [id, entry] of state.marks) {
    if (!rows.some((r) => r.block.id === id)) rows.push({ block: entry.block, mark: entry.mark });
  }
  return rows;
}

/** 数字卡：unit 紧跟数字（百分比），hint 是下面一行口径说明。 */
function metric(label, value, unit, hint, { tight = false } = {}) {
  return `<div class="board-card board-metric">
    <small>${esc(label)}</small>
    <strong>${esc(value)}${unit ? `<em${tight ? ' class="tight"' : ''}>${tight ? '' : ' '}${esc(unit)}</em>` : ''}</strong>
    <span>${esc(hint)}</span>
  </div>`;
}

function headMarkup() {
  const { digest, today } = state.data;
  const word = relativeWord(digest.day, today);
  const atToday = digest.day >= today;
  return `<div class="topline board-head">
    <div class="board-headline">
      <h1>每日维护</h1>
      <span class="board-date">${esc(dayLabel(digest.day))} ${esc(digest.weekday)}${word ? ` · ${esc(word)}` : ''}</span>
    </div>
    <div class="board-headtools">
      <button type="button" class="iconbtn" data-board-prev title="前一天" aria-label="前一天">‹</button>
      <button type="button" class="iconbtn" data-board-next title="后一天" aria-label="后一天"${atToday ? ' disabled' : ''}>›</button>
      <button type="button" class="light" data-board-export>保存图片</button>
    </div>
  </div>`;
}

function metricsMarkup() {
  const { digest } = state.data;
  const focus = focusText(digest.focus.seconds);
  const follow = digest.plan.followRate;
  const planned = Math.round(digest.plan.plannedSeconds / 60);
  const focusedOnPlanned = Math.round(digest.plan.focusedOnPlannedSeconds / 60);
  return `<div class="board-metrics">
    ${metric('完成任务', String(digest.completed.length), '项', digest.completed.length ? '这一天完成的都记在这里' : '还没有完成的任务')}
    ${metric('专注', focus.value, focus.unit, `${digest.focus.sessions} 轮已结束的专注`)}
    ${metric('计划执行率', follow == null ? '无计划' : String(Math.round(follow * 100)), follow == null ? '' : '%',
    follow == null ? '这一天没有排时间块' : '计划里的任务被专注或完成的比例', { tight: true })}
    ${metric('计划 vs 实际', String(planned), '分钟', `计划内专注 ${focusedOnPlanned} 分钟`)}
  </div>`;
}

function aiMarkup() {
  const { digest, review, today } = state.data;
  const facts = factsOf(digest, state.data);
  const summary = review ? review.text : localText(facts, { when: whenWord(digest.day, today) });
  const when = review ? reviewTime(review.createdAt) : '';
  const needModel = state.aiError.includes('还没有设置模型');
  const regenerate = review && review.stale;
  const button = review
    ? (regenerate ? '<button type="button" class="light" data-board-ai>重新生成</button>' : '')
    : '<button type="button" class="primary" data-board-ai>生成 AI 回顾</button>';
  return `<section class="board-card board-ai">
    <div class="board-cardhead">
      <h2>AI 回顾</h2>
      ${review ? `<span class="board-meta">${esc(review.provider || '模型')} · ${esc(review.model || '')} · ${esc(when)}</span>` : ''}
    </div>
    <p class="board-text">${reviewHtml(summary)}</p>
    ${regenerate ? '<span class="board-tag">记录有更新</span>' : ''}
    <div class="board-actions">
      ${state.aiBusy ? '<button type="button" class="light" disabled>正在生成…</button>' : button}
      ${needModel ? '<button type="button" class="light" data-board-goto-ai>去设置模型</button>' : ''}
    </div>
    ${state.aiError ? `<p class="board-error" role="alert">${esc(state.aiError)}</p>` : ''}
  </section>`;
}

/** 回顾正文：保留换行，把【今日概览】这类小标题加粗。 */
function reviewHtml(text) {
  return esc(text).split('\n')
    .map((line) => line.replace(/^\s*(【[^】]{1,8}】)/, '<b class="board-h">$1</b>'))
    .join('\n');
}

/** 生成时间按工作台时区的钟面显示；时区未知时退回浏览器的本地时间。 */
function reviewTime(createdAt) {
  const zone = ctx?.state?.view?.timeZone;
  const wall = zone ? zoneWall(createdAt, zone) : null;
  if (wall) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${wall.getUTCMonth() + 1} 月 ${wall.getUTCDate()} 日 ${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`;
  }
  return new Date(createdAt * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function unfinishedMarkup() {
  const rows = unfinishedRows();
  if (!rows.length) return '';
  const pending = rows.filter((r) => !r.mark);
  return `<section class="board-card board-unfinished">
    <div class="board-cardhead">
      <h2>没做完的计划</h2>
      ${pending.length > 1 ? '<button type="button" class="light" data-board-move-all>全部顺延到今天</button>' : ''}
    </div>
    <div class="board-rows">
      ${rows.map(({ block, mark }) => `<div class="board-row${mark ? ' handled' : ''}">
        <time>${esc(block.start)}</time>
        <span class="board-rowtitle" title="${esc(block.title)}">${esc(block.title)}</span>
        <small>${block.minutes} 分钟</small>
        ${mark
          ? `<b class="board-mark">${mark === 'moved' ? '已顺延' : '已完成'}</b>`
          : `<button type="button" class="light" data-board-move="${esc(block.id)}">顺延到今天</button>
             <button type="button" class="light" data-board-done="${esc(block.id)}">标记完成</button>`}
      </div>`).join('')}
    </div>
  </section>`;
}

function projectsMarkup() {
  const projects = state.data.digest.projects ?? [];
  if (!projects.length) return '';
  return `<section class="board-card board-projects">
    <div class="board-cardhead"><h2>长期项目</h2><span class="count">${projects.length}</span></div>
    ${projects.map((p) => {
      const days = p.totalDays ? `第 ${p.dayIndex}/${p.totalDays} 天` : `第 ${p.dayIndex} 天`;
      const left = p.daysLeft == null ? '' : p.daysLeft < 0 ? `逾期 ${-p.daysLeft} 天` : `剩 ${p.daysLeft} 天`;
      const goal = p.dailyMinutes ? p.dailyMinutes * 60 : 0;
      const pct = goal ? Math.min(100, Math.round((p.focusSecondsOnDay / goal) * 100)) : 0;
      const focused = Math.round(p.focusSecondsOnDay / 60);
      const progress = p.log?.progress ?? 0;
      return `<div class="board-project" data-board-project="${esc(p.id)}">
        <div class="board-projecthead">
          <b title="${esc(p.title)}">${esc(p.title)}</b>
          <small>${esc(days)}${left ? ` · <span class="${p.daysLeft < 0 ? 'board-late' : ''}">${esc(left)}</span>` : ''}</small>
        </div>
        <div class="track"><i style="width:${pct}%"></i></div>
        <small class="board-projectfoot">当天专注 ${focused} / ${p.dailyMinutes ? `${p.dailyMinutes}` : '—'} 分钟</small>
        <label class="board-field">进展
          <input type="text" maxlength="500" data-board-log-note="${esc(p.id)}"
            value="${esc(p.log?.note ?? '')}" placeholder="今天推进了什么…" autocomplete="off">
        </label>
        <div class="board-logrow">
          <label class="board-range">进度
            <input type="range" min="0" max="100" step="5" value="${progress}" data-board-log-progress="${esc(p.id)}">
          </label>
          <output data-board-log-out="${esc(p.id)}">${progress}%</output>
          <button type="button" class="light" data-board-save-log="${esc(p.id)}">保存</button>
        </div>
      </div>`;
    }).join('')}
  </section>`;
}

function detailsMarkup() {
  const { digest } = state.data;
  const completed = digest.completed.length
    ? `<ul class="board-list">${digest.completed.map((t) => `<li>${esc(t.title)}</li>`).join('')}</ul>`
    : '<p class="empty">没有完成的任务。</p>';
  const byTask = digest.focus.byTask.length
    ? `<ul class="board-list">${digest.focus.byTask.map((t) => `<li>${esc(t.title)}<b>${Math.round(t.seconds / 60)} 分钟</b></li>`).join('')}</ul>`
    : '<p class="empty">没有已结束的专注。</p>';
  const blocks = digest.plan.blocks.length
    ? `<ul class="board-list">${digest.plan.blocks.map((b) => `<li><time>${esc(b.start)}</time>${esc(b.title)}
        <b>${b.end ? `至 ${esc(b.end)} · ` : ''}${b.minutes} 分钟${b.taskDone ? ' · 已完成' : ''}${b.focusSeconds ? ` · 专注 ${Math.round(b.focusSeconds / 60)} 分钟` : ''}</b></li>`).join('')}</ul>`
    : '<p class="empty">这一天没有排时间块。</p>';
  const timeline = digest.focus.timeline?.length
    ? `<ul class="board-list" data-board-timeline>${digest.focus.timeline.map((f) => `<li><time>${esc(f.start)}–${esc(f.end)}</time>${esc(f.title)}
        <b>${f.minutes} 分钟</b></li>`).join('')}</ul>`
    : '<p class="empty">没有已结束的专注。</p>';
  const notes = state.data.notes ?? [];
  const noteList = notes.length
    ? `<ul class="board-list" data-board-notes>${notes.map((n) => `<li>${esc(n.title)}<b>${n.edited ? (n.firstTime ? '首次记录' : '新写了内容') : '查看过'}</b></li>`).join('')}</ul>`
    : '<p class="empty">这一天没有写任务正文。</p>';
  const harvests = state.data.harvests ?? [];
  const harvestList = harvests.length
    ? `<ul class="board-list" data-board-harvests>${harvests.map((h) => `<li>${esc(h.title)}${h.conclusion ? `：${esc(h.conclusion)}` : ''}</li>`).join('')}</ul>`
    : '<p class="empty">这一天没有存收获。</p>';
  const created = digest.created ?? [];
  const createdList = created.length
    ? `<ul class="board-list" data-board-created>${created.map((t) => `<li>${esc(t.title)}</li>`).join('')}</ul>`
    : '<p class="empty">这一天没有新建任务。</p>';
  return `<details class="board-details">
    <summary>当天明细</summary>
    <div class="board-detailgrid">
      <div><h3>完成清单</h3>${completed}</div>
      <div><h3>按任务的专注</h3>${byTask}</div>
    </div>
    <div class="board-detailgrid">
      <div><h3>计划时间表</h3>${blocks}</div>
      <div><h3>专注时间线</h3>${timeline}</div>
    </div>
    <div class="board-detailgrid">
      <div><h3>当天记录</h3>${noteList}</div>
      <div><h3>当天收获</h3>${harvestList}</div>
    </div>
    <div><h3>新建任务</h3>${createdList}</div>
  </details>`;
}

function emptyMarkup() {
  return `<section class="board-card board-empty">
    <span class="board-mascot" aria-hidden="true"></span>
    <p>这一天没有记录</p>
    <small>完成的、专注的、排进计划的，都会出现在这里。可以翻到别的日期看看。</small>
  </section>`;
}

function render() {
  if (!panel?.isConnected) return;
  if (state.loading && !state.data) return;
  if (state.error) {
    panel.innerHTML = `${headMarkupFallback()}<div class="board-card"><p class="board-error" role="alert">${esc(state.error)}</p>
      <div class="board-actions"><button type="button" class="light" data-board-retry>重新读取</button></div></div>`;
    return;
  }
  if (!state.data) return;
  const { digest } = state.data;
  // 空白天：只有吉祥物提示，日期切换与「保存图片」仍在标题行。
  if (digest.isEmpty) {
    panel.innerHTML = `${headMarkup()}${emptyMarkup()}`;
    return;
  }
  panel.innerHTML = `${headMarkup()}
    ${metricsMarkup()}
    ${aiMarkup()}
    ${unfinishedMarkup()}
    ${projectsMarkup()}
    ${detailsMarkup()}`;
}

/** 读取失败时没有 digest，仍要给一个能翻页/重试的标题行。 */
function headMarkupFallback() {
  const today = state.data?.today ?? '';
  return `<div class="topline board-head">
    <div class="board-headline"><h1>每日维护</h1>${state.day ? `<span class="board-date">${esc(dayLabel(state.day))}</span>` : ''}</div>
    <div class="board-headtools">
      <button type="button" class="iconbtn" data-board-prev title="前一天" aria-label="前一天">‹</button>
      <button type="button" class="iconbtn" data-board-next title="后一天" aria-label="后一天"${today && state.day && state.day >= today ? ' disabled' : ''}>›</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- 事件

function onClick(event) {
  const btn = event.target instanceof Element ? event.target.closest('button') : null;
  if (!btn || !panel?.contains(btn) || btn.disabled) return;
  const d = btn.dataset;
  if ('boardPrev' in d) { void load({ day: shift(state.data?.digest.day ?? state.day, -1) }); return; }
  if ('boardNext' in d) {
    const { digest, today } = state.data;
    if (digest.day >= today) return;
    void load({ day: shift(digest.day, 1) });
    return;
  }
  if ('boardRetry' in d) { void load(); return; }
  if ('boardExport' in d) { exportImage(); return; }
  if ('boardAi' in d) { void generateAi(); return; }
  if ('boardGotoAi' in d) { ctx.gotoPage('ai'); return; }
  if ('boardMoveAll' in d) { void moveBlocks({ all: true }); return; }
  if (d.boardMove) { void moveBlocks({ blockId: d.boardMove }); return; }
  if (d.boardDone) { void completeBlock(d.boardDone); return; }
  if (d.boardSaveLog) { void saveLog(d.boardSaveLog); return; }
}

function onInput(event) {
  const el = event.target;
  if (!(el instanceof Element) || !panel?.contains(el)) return;
  const id = el.dataset.boardLogProgress;
  if (!id) return;
  const out = [...panel.querySelectorAll('[data-board-log-out]')].find((node) => node.dataset.boardLogOut === id);
  if (out) out.textContent = `${el.value}%`;
}

/** 保存图片：沿用 review.js 的画布排版，换成每日维护的标题与统计。 */
function exportImage() {
  const { digest, review } = state.data;
  const facts = factsOf(digest, state.data);
  const summary = review ? review.text : localText(facts, { when: whenWord(digest.day, state.data.today) });
  const output = document.createElement('canvas');
  paint(output, 760, facts, summary, Boolean(review), {
    title: '每日维护',
    aiLabel: review ? '贾维斯喵 · AI 回顾' : '贾维斯喵 · 本地摘要',
  });
  output.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${digest.day}-每日维护.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

async function generateAi() {
  if (state.aiBusy || !state.data) return;
  const { digest, review } = state.data;
  state.aiBusy = true;
  state.aiError = '';
  render();
  try {
    const payload = await ctx.api.post('/api/ai/review', { day: digest.day, force: Boolean(review) });
    if (!state.data || state.data.digest.day !== digest.day) return;
    state.data.review = payload.review ?? null;
    ctx.notify('AI 回顾已生成');
  } catch (err) {
    state.aiError = err?.message ?? String(err);
  } finally {
    state.aiBusy = false;
    render();
  }
}

/** 顺延到今天：startsAt 加上「今天零点 − 那天零点」的差。 */
async function moveBlocks({ blockId = '', all = false } = {}) {
  if (!state.data) return;
  const rows = unfinishedRows().filter((r) => !r.mark && (all || r.block.id === blockId));
  if (!rows.length) return;
  const { digest, today } = state.data;
  const busy = panel.querySelector('[data-board-move-all]');
  if (busy) busy.disabled = true;
  try {
    const [todayView, dayView] = await Promise.all([
      ctx.api.get(`/api/view?day=${encodeURIComponent(today)}`),
      ctx.api.get(`/api/view?day=${encodeURIComponent(digest.day)}`),
    ]);
    const delta = todayView.view.range.start - dayView.view.range.start;
    for (const { block } of rows) {
      await ctx.api.command({
        type: 'saveSchedule',
        block: {
          id: newId('block'),
          taskId: block.taskId,
          startsAt: block.startsAt + delta,
          plannedSeconds: block.minutes * 60,
        },
      });
      state.marks.set(block.id, { block, mark: 'moved' });
    }
    ctx.notify(rows.length > 1 ? `已把 ${rows.length} 个时间块顺延到今天` : '已顺延到今天');
    await refreshAfterWrite();
  } catch (err) {
    ctx.notify(err?.message ?? String(err), 'bad');
    render();
  }
}

async function completeBlock(blockId) {
  if (!state.data) return;
  const rows = unfinishedRows();
  const row = rows.find((r) => r.block.id === blockId);
  if (!row) return;
  try {
    await ctx.api.command({ type: 'setTaskCompleted', taskId: row.block.taskId, completed: true });
    // 同一个任务的其它时间块也会一起变成已完成，行标记一并打上。
    for (const other of rows) {
      if (other.block.taskId === row.block.taskId && !other.mark) {
        state.marks.set(other.block.id, { block: other.block, mark: 'done' });
      }
    }
    ctx.notify('已标记完成');
    await refreshAfterWrite();
  } catch (err) {
    ctx.notify(err?.message ?? String(err), 'bad');
    render();
  }
}

async function saveLog(projectId) {
  if (!state.data) return;
  const noteEl = [...panel.querySelectorAll('[data-board-log-note]')]
    .find((node) => node.dataset.boardLogNote === projectId);
  const progressEl = [...panel.querySelectorAll('[data-board-log-progress]')]
    .find((node) => node.dataset.boardLogProgress === projectId);
  if (!noteEl) return;
  const note = noteEl.value.trim();
  const progress = progressEl ? Number(progressEl.value) : null;
  try {
    await ctx.api.command({
      type: 'saveProjectLog',
      projectId,
      day: state.data.digest.day,
      note,
      progress: Number.isFinite(progress) ? progress : null,
    });
    ctx.notify('进展已保存');
    await refreshAfterWrite();
  } catch (err) {
    ctx.notify(err?.message ?? String(err), 'bad');
    render();
  }
}

// 供测试与调试读取（不参与渲染）。
export const boardState = state;

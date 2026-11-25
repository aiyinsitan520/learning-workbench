// 收获页与全局粘贴入口。原文只用于本地解析或请求提炼，保存时仅提交卡片字段。
import { newId } from './api.js';
import { localToday } from './dom.js';
import { esc } from './icons.js';
import { parseHarvest, formatHarvest, splitTags, CHATGPT_PROMPT, HARVEST_LIMITS as limits } from './harvest-format.js';

const PAGE_SIZE = 20;
const BLOCK_SECONDS = 30 * 60;
const PASTE_LIMIT = 60000;
/** 卡片默认只露前几条要点，其余点「展开」看。 */
const POINTS_PREVIEW = 3;
/** 一张收获最多 6 张图（工单 T-W8b）。 */
const MAX_IMAGES = 6;
const IMAGE_PATH = /^\/api\/attachments\/[0-9a-f]{64}\.(?:png|jpg|webp|gif)$/;
const IMAGE_ID = /^[0-9a-f]{64}\.(?:png|jpg|webp|gif)$/;
const message = (err) => err?.message ?? String(err);
const lines = (value) => value.split('\n').map((line) => line.trim()).filter(Boolean);
const todoText = (todo) => typeof todo === 'string' ? todo : todo.text;

let currentPage;
let promoting = false;
// promote 与 saveSchedule 是两个命令。第二步失败时，保留时间块 ID 供本会话补排。
const pendingBlocks = new Map();
/**
 * 别的模块要求按某个项目筛选收获（项目卡的「收获 N」）时用自定义事件，避免新增模块导入关系：
 * projects.js 先 ctx.gotoPage('harvest') 让本页挂上，再 dispatch 这个事件。
 */
const FILTER_EVENT = 'workbench:harvest-filter';
document.addEventListener(FILTER_EVENT, (event) => {
  const page = currentPage;
  if (!page?.root.isConnected) return;
  page.project = event.detail?.project ?? '';
  page.tag = '';
  page.q = '';
  page.starred = false;
  page.due = false;
  const search = page.root.querySelector('[data-harvest-search]');
  if (search) search.value = '';
  void load(page);
});

/**
 * 标签颜色：按标签名哈希到固定的几个令牌色变体里选，不写颜色值。
 * 换皮肤时这几个类跟着令牌变，深色「摩卡夜」也仍然可读。
 */
const TAG_TONES = 6;
function tagTone(tag) {
  let hash = 0;
  for (const ch of String(tag)) hash = (hash * 31 + ch.codePointAt(0)) % 100000;
  return 'tone-' + (hash % TAG_TONES);
}

/** 来源只显示域名，点开才是原链接。 */
function sourceHost(url) {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function connectedPage(ctx) {
  return ctx.state.page === 'harvest' && currentPage?.root.isConnected ? currentPage : null;
}

/**
 * 实时刷新（T-W8b，含 T-W1 遗留）：另一端改了收获库时重读当前列表。
 * 有弹窗（编辑/复习/关联）、正在原地改某一行、或列表还没挂上时跳过，等下一次变化。
 */
export function refreshHarvest() {
  const page = currentPage;
  if (!page?.root.isConnected) return false;
  if (document.querySelector('#dialog[open]')) return false;
  // 正在原地编辑要点/待办时不能重绘，否则那一行会被换成新节点、编辑中断
  if (page.editing || page.root.querySelector('[contenteditable="true"]')) return false;
  void load(page);
  return true;
}

export function showHarvest(host, ctx) {
  if (currentPage?.root.isConnected && host.contains(currentPage.root)) {
    const page = currentPage;
    if (page.view !== ctx.state.view) {
      page.view = ctx.state.view;
      // 正在原地编辑或输入时不要重读列表：外壳每次重绘都会调到这里，重读会把那一行换掉
      if (page.editing || page.root.querySelector('[contenteditable="true"]')) return;
      if (!promoting && page.cards.length) void load(page);
      else updateScheduleButtons(page);
    }
    return;
  }

  const root = document.createElement('section');
  root.className = 'harvest-page';
  root.innerHTML = [
    '<header class="topline harvest-header"><h1>收获</h1>',
    '<div class="harvest-actions"><button type="button" class="light" data-harvest-review-start hidden></button>',
    '<button type="button" class="light" data-harvest-random>随便看一张</button>',
    '<button type="button" class="light" data-harvest-prompt>复制 ChatGPT 口令</button>',
    '<button type="button" class="primary" data-harvest-open>粘贴收获</button></div></header>',
    '<div class="harvest-tools">',
    '<label class="harvest-field">搜索收获<input type="search" data-harvest-search placeholder="标题、要点、标签…"></label>',
    '<span class="harvest-shortcut"><kbd>Ctrl+Shift+V</kbd> / <kbd>⌘+Shift+V</kbd></span></div>',
    '<div class="harvest-filters" role="group" aria-label="筛选收获">',
    '<button type="button" class="harvest-chip" data-harvest-filter="starred" aria-pressed="false">★ 星标</button>',
    '<button type="button" class="harvest-chip" data-harvest-filter="due" aria-pressed="false">待复习</button>',
    '<label class="harvest-field harvest-projectfilter">按项目<select data-harvest-project-filter><option value="">全部项目</option></select></label>',
    '</div>',
    '<div class="harvest-tags" role="group" aria-label="按标签筛选" data-harvest-tags></div>',
    '<p class="soft" role="status" data-harvest-status></p>',
    '<div class="harvest-list" data-harvest-list></div>',
    '<button type="button" class="light harvest-more" data-harvest-more hidden>加载更多</button>',
  ].join('');
  const page = {
    root, ctx, view: ctx.state.view, q: '', tag: '', project: '', starred: false, due: false,
    cards: [], total: 0, tags: [], tasks: new Map(), expanded: new Set(),
    seq: 0, timer: 0, reviewing: null,
  };
  currentPage = page;
  host.replaceChildren(root);

  root.querySelector('[data-harvest-search]').addEventListener('input', (event) => {
    page.q = event.target.value.trim();
    clearTimeout(page.timer);
    page.seq += 1;
    page.root.querySelector('[data-harvest-more]').disabled = true;
    page.timer = setTimeout(() => void load(page), 250);
  });
  root.querySelector('[data-harvest-project-filter]').addEventListener('change', (event) => {
    page.project = event.target.value;
    void load(page);
  });
  root.addEventListener('click', (event) => void onPageClick(page, event));
  // 行内文字点击进入原地编辑。必须拦 pointerdown：真鼠标点击时浏览器会先把焦点交给那个
  // tabindex=0 的 span，等我们换成输入框后焦点又被收回 body，一 blur 就把编辑判成提交。
  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const span = event.target.closest?.('[data-harvest-editrow]');
    if (!span) return;
    event.preventDefault();
    // 同步就占位：实时刷新在下一拍可能重绘，先把它挡住
    page.editing = true;
    // 等这一帧的鼠标事件和浏览器的焦点修正都走完再进入编辑，
    // 否则 mouseup 之后焦点被收回 body，紧接着的 blur 会把编辑判成「改完了」。
    requestAnimationFrame(() => {
      const row = span.closest('[data-harvest-point], [data-harvest-todo]');
      const cardEl = span.closest('[data-harvest-card]');
      const card = page.cards.find((item) => item.id === cardEl?.dataset.harvestCard);
      if (!row || !card || span.isContentEditable) { page.editing = false; return; }
      const isPoint = row.hasAttribute('data-harvest-point');
      const index = Number(isPoint ? row.dataset.harvestPoint : row.dataset.harvestTodo);
      beginRowEdit(page, card, row, isPoint, index, span);
    });
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') onRowKey(page, event);
  });
  void load(page);
}

async function load(page, append = false) {
  if (!page.root.isConnected) return;
  clearTimeout(page.timer);
  page.timer = 0;
  const seq = ++page.seq;
  const offset = append ? page.cards.length : 0;
  const query = new URLSearchParams({ q: page.q, tag: page.tag, limit: PAGE_SIZE, offset });
  if (page.project) query.set('project', page.project);
  if (page.starred) query.set('starred', '1');
  if (page.due) query.set('due', '1');
  const status = page.root.querySelector('[data-harvest-status]');
  const more = page.root.querySelector('[data-harvest-more]');
  more.disabled = true;
  status.textContent = '正在读取收获…';
  const isCurrent = () => seq === page.seq && page.root.isConnected;
  try {
    const { harvests, total, tags } = await page.ctx.api.get('/api/harvests?' + query);
    if (!isCurrent()) return;
    page.cards = append ? [...page.cards, ...harvests] : harvests;
    page.total = total;
    page.tags = tags;
    refreshTasks(page);
    renderResults(page);
    status.textContent = page.total ? '共 ' + page.total + ' 条收获' : '';
  } catch (err) {
    if (!isCurrent()) return;
    status.textContent = message(err);
    if (!append) {
      page.cards = [];
      page.root.querySelector('[data-harvest-list]').replaceChildren();
    }
    more.hidden = false;
    more.textContent = '重新读取';
  } finally {
    if (isCurrent()) more.disabled = false;
  }
}

/**
 * 卡片底部要显示关联任务的名字，但 /api/harvests 只给 taskId，也没有「列出全部任务」的接口。
 * 所以只用当前视图里拿得到的：待办 / 当天已完成 / 当天已排期的任务，加上各长期项目的主任务。
 * 找不到的就只显示项目标签或不显示，不猜。
 */
function knownTasks(view) {
  const tasks = new Map();
  for (const task of [...(view?.pending ?? []), ...(view?.completedOnDay ?? []),
    ...(view?.scheduled ?? []).map((block) => block.task)]) {
    if (task?.id) tasks.set(task.id, { id: task.id, title: task.title });
  }
  for (const project of view?.projects ?? []) {
    if (project.mainTaskId && !tasks.has(project.mainTaskId)) {
      tasks.set(project.mainTaskId, { id: project.mainTaskId, title: project.title });
    }
  }
  return tasks;
}

function refreshTasks(page) {
  page.tasks = knownTasks(page.ctx.state.view);
}

function renderResults(page) {
  const tagBar = page.root.querySelector('[data-harvest-tags]');
  const focusedTag = tagBar.contains(document.activeElement) ? document.activeElement.dataset.harvestTag : null;
  // 保留刚被删除或改名的筛选标签，用户仍能点一下取消筛选。
  const tags = page.tag && !page.tags.some((item) => item.tag === page.tag)
    ? [...page.tags, { tag: page.tag, count: 0 }] : page.tags;
  tagBar.innerHTML = tags.map(({ tag, count }) =>
    '<button type="button" class="harvest-chip ' + tagTone(tag) + '" data-harvest-tag="' + esc(tag) + '" aria-pressed="' +
      (tag === page.tag) + '">#' + esc(tag) + ' <small>' + count + '</small></button>').join('');
  if (focusedTag != null) {
    [...tagBar.children].find((button) => button.dataset.harvestTag === focusedTag)?.focus({ preventScroll: true });
  }
  // 筛选按钮与项目下拉跟着当前状态走（重绘后不会丢）
  for (const button of page.root.querySelectorAll('[data-harvest-filter]')) {
    const on = button.dataset.harvestFilter === 'starred' ? page.starred : page.due;
    button.setAttribute('aria-pressed', String(on));
  }
  const projectSelect = page.root.querySelector('[data-harvest-project-filter]');
  const projects = page.ctx.state.view?.projects ?? [];
  const kept = projectSelect.value;
  projectSelect.innerHTML = '<option value="">全部项目</option>' +
    projects.map((item) => '<option value="' + esc(item.id) + '">' + esc(item.title) + '</option>').join('') +
    (page.project && !projects.some((item) => item.id === page.project)
      ? '<option value="' + esc(page.project) + '">已归档的项目</option>' : '');
  projectSelect.value = page.project || kept || '';
  page.root.querySelector('[data-harvest-list]').innerHTML = page.cards.length
    ? page.cards.map((card) => cardMarkup(card, page)).join('')
    : (page.q || page.tag || page.project || page.starred || page.due
      ? '<p class="empty">没有匹配的收获。</p>'
      : '<section class="harvest-card harvest-empty"><h2>把对话里的精华存下来</h2><ol>' +
        '<li>复制 ChatGPT 口令，放进 ChatGPT 的自定义指令。</li>' +
        '<li>问完后发送「收」，复制它给出的精华。</li>' +
        '<li>回到工作台按 <kbd>Ctrl+Shift+V</kbd>，预览后保存。</li></ol></section>');
  const more = page.root.querySelector('[data-harvest-more]');
  more.hidden = page.cards.length >= page.total;
  more.textContent = '加载更多';
  updateReviewEntry(page);
  updateScheduleButtons(page);
}

/** 顶部「今天待复习 N 张 · 开始复习」；没有到期的就藏起来。 */
function updateReviewEntry(page) {
  const due = Number(page.ctx.state.view?.harvestDue ?? 0);
  const button = page.root.querySelector('[data-harvest-review-start]');
  if (!button) return;
  button.hidden = due <= 0;
  button.textContent = '今天待复习 ' + due + ' 张 · 开始复习';
}

/** 卡片上的一行要点/待办：可原地编辑，带上下移动与删除。 */
function editableRow(kind, index, text, { done = false, extra = '' } = {}) {
  const label = kind === 'point' ? '要点' : '待办';
  return [
    '<li class="harvest-row' + (done ? ' done' : '') + '" data-harvest-' + kind + '="' + index + '">',
    '<span class="harvest-rowtext" data-harvest-editrow role="button" tabindex="0"',
    ' title="点击直接改；Enter 新增一条，清空后按 Enter 删除">' + (done ? '<s>' + esc(text) + '</s>' : esc(text)) + '</span>',
    extra,
    '<span class="harvest-rowtools">',
    '<button type="button" class="harvest-mini" data-harvest-moveup aria-label="上移这条' + label + '" title="上移">↑</button>',
    '<button type="button" class="harvest-mini" data-harvest-movedown aria-label="下移这条' + label + '" title="下移">↓</button>',
    '<button type="button" class="harvest-mini danger" data-harvest-removerow aria-label="删除这条' + label + '" title="删除">×</button>',
    '</span></li>',
  ].join('');
}

function cardMarkup(card, page) {
  const host = sourceHost(card.sourceUrl);
  const link = host
    ? '<a class="harvest-source" href="' + esc(card.sourceUrl) + '" target="_blank" rel="noopener" title="' +
      esc(card.sourceUrl) + '">' + esc(host) + '</a>' : '';
  const expanded = page.expanded.has(card.id);
  const points = card.points ?? [];
  const shown = expanded ? points : points.slice(0, POINTS_PREVIEW);
  const hidden = points.length - shown.length;
  const project = (page.ctx.state.view?.projects ?? []).find((item) => item.id === card.projectId);
  const task = card.taskId ? page.tasks.get(card.taskId) : null;
  const reviewOn = Boolean(card.review?.nextDay);
  const images = (card.images ?? []).filter((id) => IMAGE_ID.test(id));
  return [
    '<article class="harvest-card' + (card.starred ? ' starred' : '') + '" data-harvest-card="' + esc(card.id) + '">',
    '<header class="harvest-cardhead">',
    '<h2>' + esc(card.title) + '</h2>',
    '<div class="harvest-cardbadges">',
    '<button type="button" class="harvest-star" data-harvest-star aria-pressed="' + Boolean(card.starred) +
      '" aria-label="' + (card.starred ? '取消星标' : '标为星标') + '" title="' +
      (card.starred ? '取消星标' : '标为星标') + '">' + (card.starred ? '★' : '☆') + '</button>',
    '<time datetime="' + esc(card.day) + '">' + esc(card.day) + '</time></div></header>',
    card.conclusion ? '<p class="harvest-conclusion">' + esc(card.conclusion) + '</p>' : '',
    shown.length ? '<ul class="harvest-points">' +
      shown.map((point, index) => editableRow('point', index, point)).join('') + '</ul>' : '',
    hidden > 0
      ? '<button type="button" class="light harvest-expand" data-harvest-expand>展开其余 ' + hidden + ' 条要点</button>'
      : (expanded && points.length > POINTS_PREVIEW
        ? '<button type="button" class="light harvest-expand" data-harvest-expand>收起要点</button>' : ''),
    images.length ? '<div class="harvest-images">' + images.map((id) =>
      '<a class="harvest-thumb" href="/api/attachments/' + esc(id) + '" target="_blank" rel="noopener" data-harvest-image="' +
        esc(id) + '"><img src="/api/attachments/' + esc(id) + '" alt="收获图片" loading="lazy"></a>').join('') + '</div>' : '',
    card.todos.length ? '<div class="harvest-todos"><h3>待办</h3><ul>' +
      card.todos.map((todo, index) => todoMarkup(todo, index)).join('') + '</ul></div>' : '',
    '<div class="harvest-links">',
    project ? '<button type="button" class="harvest-chip joined" data-harvest-goto-project="' + esc(project.id) +
      '" title="按这个项目筛选收获">项目 · ' + esc(project.title) + '</button>' : '',
    task ? '<button type="button" class="harvest-chip joined" data-harvest-goto-task="' + esc(task.id) +
      '" title="按这个任务筛选收获">任务 · ' + esc(task.title) + '</button>' : '',
    '<button type="button" class="harvest-chip" data-harvest-link>关联…</button>',
    '<button type="button" class="harvest-chip" data-harvest-review aria-pressed="' + reviewOn + '">' +
      (reviewOn ? '在复习中' : '加入复习') + '</button>',
    '</div>',
    '<footer class="harvest-cardfoot"><div class="harvest-tags">' +
      card.tags.map((tag) => '<span class="harvest-chip ' + tagTone(tag) + '">#' + esc(tag) + '</span>').join('') + '</div>',
    '<div class="harvest-actions">' + link,
    '<button type="button" class="light" data-harvest-image-add>加图片</button>',
    '<button type="button" class="light" data-harvest-edit>编辑</button>',
    '<button type="button" class="light" data-harvest-copy>复制为文本</button>',
    '<button type="button" class="light danger" data-harvest-delete>删除</button></div></footer></article>',
  ].join('');
}

function todoMarkup(todo, index) {
  const queued = Boolean(todo.taskId && pendingBlocks.has(todo.taskId) && !todo.taskDone);
  const actions = [
    todo.taskId ? '<span class="harvest-joined">已加入</span>' :
      '<button type="button" class="light" data-harvest-join>加入待办</button>',
    !todo.taskId || queued
      ? '<button type="button" class="light" data-harvest-schedule>' + (queued ? '重试排进今天' : '排进今天') + '</button>' : '',
  ].join('');
  return editableRow('todo', index, todo.text, { done: todo.taskDone, extra: '<span class="harvest-rowactions">' + actions + '</span>' });
}

function todayView(ctx, now = Date.now() / 1000) {
  const view = ctx.state.view;
  return view?.range && now >= view.range.start && now < view.range.end ? view : null;
}

function updateScheduleButtons(page) {
  const today = Boolean(todayView(page.ctx));
  for (const button of page.root.querySelectorAll('[data-harvest-schedule]')) {
    button.disabled = promoting || !today;
    button.title = today ? '' : '回到今天再排';
  }
  for (const button of page.root.querySelectorAll('[data-harvest-join]')) button.disabled = promoting;
}

function scheduleStart(view, now, blockId) {
  // 日计划只显示 06:00–24:00（range.start 是工作台时区的零点），凌晨点「排进今天」从 06:00 起排
  let start = Math.max(Math.ceil(now / 300) * 300, view.range.start + 6 * 3600);
  const blocks = [...view.scheduled].sort((a, b) => a.startsAt - b.startsAt);
  for (const block of blocks) {
    if (block.id === blockId) continue;
    if (start + BLOCK_SECONDS <= block.startsAt) break;
    start = Math.max(start, block.startsAt + block.plannedSeconds);
  }
  return start + BLOCK_SECONDS <= view.range.end ? start : null;
}

async function promote(page, card, index, schedule) {
  if (promoting) return;
  const ctx = page.ctx;
  const todo = card.todos[index];
  const existingBlockId = pendingBlocks.get(todo.taskId);
  if (todo.taskId && (!schedule || !existingBlockId || todo.taskDone)) return;

  const now = Date.now() / 1000;
  const view = todayView(ctx, now);
  if (schedule && !view) {
    updateScheduleButtons(page);
    ctx.notify('回到今天再排', 'bad');
    return;
  }
  const startsAt = schedule ? scheduleStart(view, now, existingBlockId) : null;
  if (schedule && startsAt == null) {
    ctx.notify('今天已经排不下', 'bad');
    return;
  }

  promoting = true;
  updateScheduleButtons(page);
  const taskId = todo.taskId ?? newId('task');
  const blockId = schedule ? existingBlockId ?? newId('block') : null;
  if (schedule) pendingBlocks.set(taskId, blockId);
  try {
    if (!todo.taskId) {
      await ctx.api.command({
        type: 'promoteHarvestTodo', harvestId: card.id, index, taskId, course: schedule ? '日计划' : '',
      });
    }
    if (schedule) {
      await ctx.api.command({ type: 'saveSchedule', block: { id: blockId, taskId, startsAt, plannedSeconds: BLOCK_SECONDS } });
      pendingBlocks.delete(taskId);
    }
    await ctx.reload();
    ctx.notify(schedule ? '已排进今天' : '已加入待办');
  } catch (err) {
    ctx.notify(message(err), 'bad');
    if (schedule) {
      await ctx.reload();
      if (ctx.state.view?.scheduled.some((block) => block.id === blockId)) {
        pendingBlocks.delete(taskId);
        ctx.notify('已排进今天');
      }
    }
  } finally {
    const visible = connectedPage(ctx);
    if (visible) await load(visible);
    promoting = false;
    const active = connectedPage(ctx);
    if (active) updateScheduleButtons(active);
  }
}

async function copyText(ctx, value, success) {
  try {
    await navigator.clipboard.writeText(value);
    ctx.notify(success);
  } catch {
    ctx.notify('无法写入剪贴板，请检查浏览器的剪贴板权限', 'bad');
  }
}

async function onPageClick(page, event) {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  const ctx = page.ctx;
  const data = button.dataset;
  if ('harvestOpen' in data) return openHarvestCapture(ctx);
  if ('harvestPrompt' in data) return copyText(ctx, CHATGPT_PROMPT, '已复制 ChatGPT 口令');
  if ('harvestReviewStart' in data) return startReview(page, { due: true });
  if ('harvestRandom' in data) return startReview(page, { due: false });
  if ('harvestTag' in data) {
    page.tag = page.tag === data.harvestTag ? '' : data.harvestTag;
    return load(page);
  }
  if ('harvestFilter' in data) {
    if (data.harvestFilter === 'starred') page.starred = !page.starred;
    else page.due = !page.due;
    return load(page);
  }
  if ('harvestMore' in data) return load(page, button.textContent === '加载更多');
  const id = button.closest('[data-harvest-card]')?.dataset.harvestCard;
  const card = page.cards.find((item) => item.id === id);
  if (!card) return;
  if ('harvestStar' in data) return setStar(page, card, !card.starred);
  if ('harvestReview' in data) return setReview(page, card, !card.review?.nextDay);
  if ('harvestExpand' in data) {
    if (page.expanded.has(card.id)) page.expanded.delete(card.id);
    else page.expanded.add(card.id);
    return renderResults(page);
  }
  if ('harvestLink' in data) return openLink(page, card);
  if ('harvestGotoProject' in data) {
    page.project = data.harvestGotoProject;
    page.tag = '';
    page.q = '';
    page.root.querySelector('[data-harvest-search]').value = '';
    return load(page);
  }
  if ('harvestGotoTask' in data) {
    page.q = page.tasks.get(data.harvestGotoTask)?.title ?? '';
    page.root.querySelector('[data-harvest-search]').value = page.q;
    return load(page);
  }
  if ('harvestImageAdd' in data) return addImages(page, card);
  if ('harvestCopy' in data) return copyText(ctx, formatHarvest(card), '已复制收获文本');
  if ('harvestEdit' in data) return openEdit(ctx, card);
  if ('harvestDelete' in data) return confirmDelete(ctx, card);
  // 要点 / 待办行的上移、下移、删除
  const row = button.closest('[data-harvest-point], [data-harvest-todo]');
  if (row) {
    const isPoint = row.hasAttribute('data-harvest-point');
    const index = Number(isPoint ? row.dataset.harvestPoint : row.dataset.harvestTodo);
    if ('harvestMoveup' in data) return moveRow(page, card, isPoint, index, -1);
    if ('harvestMovedown' in data) return moveRow(page, card, isPoint, index, 1);
    if ('harvestRemoverow' in data) return saveRows(page, card, isPoint, withoutRow(card, isPoint, index));
    if ('harvestJoin' in data || 'harvestSchedule' in data) {
      return promote(page, card, index, 'harvestSchedule' in data);
    }
  }
  if (row) return promote(page, card, Number(row.dataset.harvestTodo), 'harvestSchedule' in data);
}

/** 卡片上按钮触发的写操作：统一走 ctx.run，失败给提示，成功后重载列表。 */
async function applyCard(page, card, command, success) {
  try {
    await page.ctx.api.command(command);
    page.ctx.notify(success);
    await page.ctx.reload();
    const visible = connectedPage(page.ctx);
    if (visible) await load(visible);
  } catch (err) {
    page.ctx.notify(message(err), 'bad');
  }
}

function setStar(page, card, starred) {
  return applyCard(page, card, { type: 'setHarvestStar', id: card.id, starred },
    starred ? '已加星标' : '已取消星标');
}

function setReview(page, card, enabled) {
  return applyCard(page, card, { type: 'setHarvestReview', id: card.id, enabled },
    enabled ? '已加入复习' : '已移出复习');
}

/** 要点/待办的行编辑：改完直接 updateHarvest。 */
function withoutRow(card, isPoint, index) {
  const list = isPoint ? [...card.points] : card.todos.map((todo) => ({ text: todo.text, taskId: todo.taskId }));
  list.splice(index, 1);
  return list;
}

function saveRows(page, card, isPoint, list) {
  const command = isPoint
    ? { type: 'updateHarvest', harvestId: card.id, points: list }
    : { type: 'updateHarvest', harvestId: card.id, todos: list };
  return applyCard(page, card, command, '已保存');
}

function moveRow(page, card, isPoint, index, delta) {
  const list = isPoint ? [...card.points] : card.todos.map((todo) => ({ text: todo.text, taskId: todo.taskId }));
  const to = index + delta;
  if (to < 0 || to >= list.length) return undefined;
  [list[index], list[to]] = [list[to], list[index]];
  return saveRows(page, card, isPoint, list);
}

/**
 * 原地编辑要点/待办：点一行直接在原地变成可编辑（contenteditable，不换节点，避免焦点被抢），
 * Enter 提交并在其后新增一条空行，清空内容再提交等于删除这一条；Esc 放弃。保存都走 updateHarvest。
 */
function onRowKey(page, event) {
  const span = event.target.closest?.('[data-harvest-editrow]');
  if (!span || span.isContentEditable) return;
  const row = span.closest('[data-harvest-point], [data-harvest-todo]');
  const cardEl = span.closest('[data-harvest-card]');
  const card = page.cards.find((item) => item.id === cardEl?.dataset.harvestCard);
  if (!row || !card) return;
  const isPoint = row.hasAttribute('data-harvest-point');
  const index = Number(isPoint ? row.dataset.harvestPoint : row.dataset.harvestTodo);
  event.preventDefault();
  beginRowEdit(page, card, row, isPoint, index, span);
}

function beginRowEdit(page, card, row, isPoint, index, span) {
  const original = isPoint ? card.points[index] : card.todos[index]?.text ?? '';
  // 不换节点：直接让这一行文字可编辑。换节点会让浏览器把焦点收回去，编辑框一闪就没了。
  page.editing = true;
  span.setAttribute('contenteditable', 'true');
  span.dataset.harvestEditing = '1';
  span.textContent = original;
  span.focus();
  const range = document.createRange();
  range.selectNodeContents(span);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  let settled = false;
  const finish = async (commit, addAfter) => {
    if (settled) return;
    settled = true;
    page.editing = false;
    const text = span.textContent.trim();
    span.removeAttribute('contenteditable');
    delete span.dataset.harvestEditing;
    if (!commit || text === original) {
      span.textContent = original;
      return;
    }
    const list = isPoint ? [...card.points] : card.todos.map((todo) => ({ text: todo.text, taskId: todo.taskId }));
    if (text) {
      list[index] = isPoint ? text : { ...list[index], text };
      if (addAfter) list.splice(index + 1, 0, isPoint ? '' : { text: '', taskId: null });
      const payload = isPoint ? list.filter((item) => item.trim()) : list.filter((item) => item.text.trim());
      await saveRows(page, card, isPoint, payload);
    } else {
      await saveRows(page, card, isPoint, withoutRow(card, isPoint, index));
    }
  };
  span.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void finish(true, true); }
    else if (event.key === 'Escape') { event.preventDefault(); void finish(false, false); }
    else if (event.key === 'Tab') { void finish(true, false); }
  }, { once: false });
  // 进入编辑后浏览器还会补发一次 blur（焦点从被点的位置回到文档），那一拍不算改完。
  // 所以延后一拍才开始监听 blur。
  setTimeout(() => {
    if (!settled) span.addEventListener('blur', () => void finish(true, false), { once: true });
  }, 0);
}

/** 没改动时把这一行还原成可点的文字，不重读列表。 */
function restoreRow(span, text) {
  span.removeAttribute('contenteditable');
  delete span.dataset.harvestEditing;
  span.textContent = text;
}

function field(label, key, control) {
  return '<label class="harvest-field">' + label + control.replace(' data-field', ' data-harvest-' + key) + '</label>';
}

function previewMarkup() {
  return [
    '<form class="harvest-preview" data-harvest-form><fieldset>',
    '<legend>收获卡片</legend>',
    field('标题', 'title', '<input data-field maxlength="' + limits.title + '" required>'),
    field('结论', 'conclusion', '<textarea data-field rows="2" maxlength="' + limits.conclusion + '"></textarea>'),
    '<div class="harvest-fields">',
    field('要点 · 一行一条', 'points', '<textarea data-field rows="3"></textarea>'),
    field('待办 · 一行一条', 'todos', '<textarea data-field rows="3"></textarea>'),
    '</div><div class="harvest-fields">',
    field('标签', 'labels', '<input data-field placeholder="用空格或逗号分隔">'),
    field('关联长期项目', 'project', '<select data-field><option value="">不关联</option></select>'),
    '</div>',
    field('对话链接', 'link', '<input data-field type="url" maxlength="' + limits.url + '" placeholder="https://chatgpt.com/c/…">'),
    '<p class="harvest-error" role="alert" data-harvest-save-error hidden></p>',
    '<div class="harvest-actions harvest-dialog-actions">',
    '<button type="button" class="light" data-harvest-cancel>取消</button>',
    '<button type="submit" class="primary" data-harvest-save>保存收获</button></div></fieldset></form>',
  ].join('');
}

function showPreview(root, ctx, draft, save, originalTodos) {
  const container = root.querySelector('[data-harvest-preview]');
  container.innerHTML = previewMarkup();
  const form = container.querySelector('form');
  const get = (key) => form.querySelector('[data-harvest-' + key + ']');
  get('title').value = draft.title ?? '';
  get('conclusion').value = draft.conclusion ?? '';
  get('points').value = (draft.points ?? []).join('\n');
  get('todos').value = (draft.todos ?? []).map(todoText).join('\n');
  get('labels').value = (draft.tags ?? []).join(' ');
  get('link').value = draft.sourceUrl ?? '';
  const project = get('project');
  for (const item of ctx.state.view?.projects ?? []) project.add(new Option(item.title, item.id));
  if (draft.projectId && ![...project.options].some((option) => option.value === draft.projectId)) {
    project.add(new Option('保留原关联项目', draft.projectId));
  }
  project.value = draft.projectId ?? '';
  get('cancel').addEventListener('click', ctx.closeDialog);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = form.querySelector('fieldset');
    if (fields.disabled) return;
    const error = get('save-error');
    error.hidden = true;
    const points = lines(get('points').value);
    const todos = lines(get('todos').value);
    const card = {
      title: get('title').value.trim(), conclusion: get('conclusion').value.trim(), points, todos,
      tags: splitTags(get('labels').value), sourceUrl: get('link').value.trim(), projectId: project.value || null,
    };
    if (originalTodos) {
      // 文字未改时由服务保留最新任务关联。修改时按同文字的出现顺序保留旧关联。
      if (todos.join('\n') === originalTodos.map(todoText).join('\n')) delete card.todos;
      else {
        const links = new Map();
        for (const todo of originalTodos) {
          if (!links.has(todo.text)) links.set(todo.text, []);
          links.get(todo.text).push(todo.taskId);
        }
        card.todos = todos.map((text) => ({ text, taskId: links.get(text)?.shift() ?? null }));
      }
    }
    fields.disabled = true;
    const sourceBox = root.querySelector('[data-harvest-text]');
    if (sourceBox) sourceBox.disabled = true;
    try {
      await save(card);
      if (dialogActive(root)) ctx.closeDialog();
      ctx.notify(originalTodos ? '已保存修改' : '已存入收获');
      const page = connectedPage(ctx);
      if (page) await load(page);
    } catch (err) {
      error.textContent = message(err);
      error.hidden = false;
    } finally {
      fields.disabled = false;
      if (sourceBox) sourceBox.disabled = false;
    }
  });
  return get('title');
}

function dialogActive(root) {
  return root.isConnected && Boolean(root.closest('dialog')?.open);
}

export function openHarvestCapture(ctx, text) {
  const active = document.querySelector('#dialog[open] [data-harvest-capture]');
  if (active && text === undefined) {
    active.querySelector('[data-harvest-text]').focus();
    return;
  }
  ctx.modal([
    '<section class="harvest-dialog" data-harvest-capture><h2>粘贴收获</h2>',
    '<label class="harvest-field">对话内容<textarea data-harvest-text rows="6" maxlength="' + PASTE_LIMIT +
      '" placeholder="粘贴 ChatGPT 的收获卡片，或粘贴需要提炼的对话"></textarea></label>',
    '<p class="soft" role="status" data-harvest-hint>粘贴后可以先修改，再保存。</p>',
    '<p class="harvest-error" role="alert" data-harvest-error hidden></p>',
    '<div class="harvest-actions" data-harvest-capture-actions>',
    '<button type="button" class="primary" data-harvest-distill hidden>用 AI 提炼</button>',
    '<button type="button" class="light" data-harvest-manual>手动填写</button>',
    '<button type="button" class="light" data-harvest-model hidden>去设置模型</button></div>',
    '<div data-harvest-preview></div></section>',
  ].join(''));
  const root = document.querySelector('[data-harvest-capture]');
  const box = root.querySelector('[data-harvest-text]');
  const hint = root.querySelector('[data-harvest-hint]');
  const actions = root.querySelector('[data-harvest-capture-actions]');
  const distill = root.querySelector('[data-harvest-distill]');
  const model = root.querySelector('[data-harvest-model]');
  const error = root.querySelector('[data-harvest-error]');
  const preview = root.querySelector('[data-harvest-preview]');
  const id = newId('harvest');
  let day;
  let revision = 0;

  function fill(draft, source, note) {
    actions.hidden = true;
    error.hidden = true;
    hint.textContent = note;
    return showPreview(root, ctx, draft, (card) => {
      day ??= ctx.state.view?.timeZone ? localToday(ctx.state.view.timeZone) : undefined;
      return ctx.api.command({ type: 'createHarvest', id, day, ...card, source });
    });
  }

  function readInput() {
    revision += 1;
    const parsed = parseHarvest(box.value);
    if (parsed.ok) {
      fill(parsed.draft, 'chatgpt', '已识别 ChatGPT 收获卡片。');
      return;
    }
    preview.replaceChildren();
    error.hidden = true;
    model.hidden = true;
    actions.hidden = false;
    distill.disabled = false;
    distill.hidden = !box.value.trim();
    hint.textContent = distill.hidden ? '粘贴后可以先修改，再保存。' : '可以用 AI 提炼，或手动填写收获卡片。';
  }

  box.addEventListener('input', readInput);
  root.querySelector('[data-harvest-manual]').addEventListener('click', () => {
    revision += 1;
    fill({}, 'manual', '填写想留下的精华。').focus();
  });
  model.addEventListener('click', () => {
    ctx.closeDialog();
    ctx.gotoPage('ai');
  });
  distill.addEventListener('click', async () => {
    const seq = ++revision;
    const stillCurrent = () => seq === revision && dialogActive(root);
    distill.disabled = true;
    error.hidden = true;
    model.hidden = true;
    hint.textContent = '正在提炼…';
    try {
      const { draft, via, provider, model: name } = await ctx.api.post('/api/ai/distill', { text: box.value });
      if (!stillCurrent()) return;
      const source = via === 'ai' ? 'ai' : 'chatgpt';
      const used = [provider, name].filter(Boolean).join(' · ');
      fill(draft, source, source === 'ai' ? '已用 ' + (used || '当前模型') + ' 提炼。' : '已识别 ChatGPT 收获卡片。');
    } catch (err) {
      if (!stillCurrent()) return;
      error.textContent = message(err);
      error.hidden = false;
      hint.textContent = '可以重试、手动填写或前往模型接入。';
      model.hidden = false;
    } finally {
      if (stillCurrent()) distill.disabled = false;
    }
  });

  box.focus();
  if (text !== undefined) {
    box.value = String(text).slice(0, PASTE_LIMIT);
    readInput();
  } else {
    void (async () => {
      try {
        const clip = await navigator.clipboard.readText();
        if (!clip || revision || box.value || !dialogActive(root)) return;
        box.value = clip.slice(0, PASTE_LIMIT);
        readInput();
      } catch { /* 剪贴板不可读时，保留当前焦点供用户粘贴。 */ }
    })();
  }
}

function openEdit(ctx, card) {
  ctx.modal('<section class="harvest-dialog" data-harvest-editor><h2>编辑收获</h2><div data-harvest-preview></div></section>');
  const root = document.querySelector('[data-harvest-editor]');
  showPreview(root, ctx, card, (draft) =>
    ctx.api.command({ type: 'updateHarvest', harvestId: card.id, ...draft }), card.todos).focus();
}

/**
 * 「关联…」：下拉搜索项目或任务，可以清除。
 * 项目列 view.projects，任务列当前视图里拿得到的（待办 / 已完成 / 已排期 / 项目主任务）——
 * 没有「列出全部任务」的接口，所以只给能确定标题的那些，不猜。
 */
async function openLink(page, card) {
  const ctx = page.ctx;
  const projects = ctx.state.view?.projects ?? [];
  const tasks = [...knownTasks(ctx.state.view).values()];
  const options = [
    ...projects.map((item) => ({ value: 'project:' + item.id, label: '项目 · ' + item.title })),
    ...tasks.map((item) => ({ value: 'task:' + item.id, label: '任务 · ' + item.title })),
  ];
  ctx.modal([
    '<section class="harvest-dialog" data-harvest-linker><h2>关联到项目或任务</h2>',
    '<label class="harvest-field">搜索<input type="search" data-harvest-link-search placeholder="输入项目或任务名…"></label>',
    '<label class="harvest-field">选择<select data-harvest-link-select size="8">',
    '<option value="">不关联</option>',
    options.map((item) => '<option value="' + esc(item.value) + '">' + esc(item.label) + '</option>').join(''),
    '</select></label>',
    '<p class="harvest-error" role="alert" data-harvest-error hidden></p>',
    '<div class="harvest-actions harvest-dialog-actions">',
    '<button type="button" class="light" data-harvest-cancel>取消</button>',
    '<button type="button" class="primary" data-harvest-link-save>保存关联</button></div></section>',
  ].join(''));
  const root = document.querySelector('[data-harvest-linker]');
  const search = root.querySelector('[data-harvest-link-search]');
  const select = root.querySelector('[data-harvest-link-select]');
  const current = card.projectId ? 'project:' + card.projectId
    : card.taskId ? 'task:' + card.taskId : '';
  select.value = current;
  search.addEventListener('input', () => {
    const keyword = search.value.trim().toLowerCase();
    for (const option of select.options) {
      option.hidden = Boolean(keyword) && option.value !== '' && !option.textContent.toLowerCase().includes(keyword);
    }
  });
  root.querySelector('[data-harvest-cancel]').addEventListener('click', ctx.closeDialog);
  root.querySelector('[data-harvest-link-save]').addEventListener('click', async () => {
    const value = select.value;
    const projectId = value.startsWith('project:') ? value.slice(8) : null;
    const taskId = value.startsWith('task:') ? value.slice(5) : null;
    try {
      await ctx.api.command({ type: 'updateHarvest', harvestId: card.id, projectId, taskId });
      ctx.closeDialog();
      ctx.notify(value ? '已建立关联' : '已清除关联');
      await ctx.reload();
      const visible = connectedPage(ctx);
      if (visible) await load(visible);
    } catch (err) {
      const error = root.querySelector('[data-harvest-error]');
      error.textContent = message(err);
      error.hidden = false;
    }
  });
  search.focus();
}

/**
 * 卡片加图片：复用任务正文那套 /api/attachments（按 SHA-256 去重）。
 * 一张收获最多 MAX_IMAGES 张，库里存附件 id 数组。
 */
function addImages(page, card) {
  const ctx = page.ctx;
  const current = (card.images ?? []).length;
  // 先查上限：满了就别弹选文件框，直接提示
  if (current >= MAX_IMAGES) {
    ctx.notify('一张收获最多 ' + MAX_IMAGES + ' 张图片', 'bad');
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif';
  input.multiple = true;
  input.hidden = true;
  document.body.append(input);
  input.addEventListener('change', async () => {
    const files = [...(input.files ?? [])];
    input.remove();
    if (!files.length) return;
    const room = MAX_IMAGES - current;
    const ids = [...(card.images ?? [])];
    let failed = 0;
    for (const file of files.slice(0, room)) {
      try {
        const response = await fetch('/api/attachments', {
          method: 'POST', headers: { 'Content-Type': file.type }, body: file,
        });
        if (!response.ok) throw new Error();
        const { url } = await response.json();
        const id = String(url).replace('/api/attachments/', '');
        if (!IMAGE_ID.test(id)) throw new Error();
        ids.push(id);
      } catch {
        failed += 1;
      }
    }
    if (ids.length === (card.images ?? []).length) {
      ctx.notify(failed ? '图片上传失败，支持 PNG、JPEG、WebP、GIF，单张最多 10 MiB' : '没有可添加的图片', 'bad');
      return;
    }
    await applyCard(page, card, { type: 'updateHarvest', harvestId: card.id, images: ids },
      failed ? '已加图片，' + failed + ' 张失败' : '已加图片');
  }, { once: true });
  input.click();
}

/**
 * 复习模式：翻卡。先只看标题 → 「显示答案」看结论与要点 → 「记住了」/「没记住」。
 * 记住了按 T-W8a 的间隔递增下次复习日，没记住回到明天。
 */
async function startReview(page, { due }) {
  const ctx = page.ctx;
  let queue;
  try {
    if (due) {
      const { harvests } = await ctx.api.get('/api/harvests?due=1&limit=50');
      queue = harvests;
    } else {
      // /api/harvests/random 直接返回一张卡或 null（没有 ok 包装），所以用 fetch 读
      const response = await fetch('/api/harvests/random');
      const single = response.ok ? await response.json() : null;
      queue = single ? [single] : [];
    }
  } catch (err) {
    ctx.notify(message(err), 'bad');
    return;
  }
  if (!queue.length) { ctx.notify('现在没有要复习的收获'); return; }
  let index = 0;
  let revealed = false;
  ctx.modal('<section class="harvest-dialog harvest-review" data-harvest-reviewbox></section>');
  const root = document.querySelector('[data-harvest-reviewbox]');

  function draw() {
    const card = queue[index];
    root.innerHTML = [
      '<div class="harvest-reviewtop"><span class="soft">第 ' + (index + 1) + ' / ' + queue.length + ' 张</span>',
      '<button type="button" class="iconbtn ghost" data-harvest-review-close aria-label="结束复习">×</button></div>',
      '<article class="harvest-card review-card">',
      '<header class="harvest-cardhead"><h2>' + esc(card.title) + '</h2>',
      '<time datetime="' + esc(card.day) + '">' + esc(card.day) + '</time></header>',
      revealed
        ? (card.conclusion ? '<p class="harvest-conclusion">' + esc(card.conclusion) + '</p>' : '') +
          (card.points.length ? '<ul class="harvest-points">' +
            card.points.map((point) => '<li>' + esc(point) + '</li>').join('') + '</ul>' : '')
        : '<p class="soft harvest-hidden">先自己回想一下，再看答案。</p>',
      '</article>',
      '<div class="harvest-actions harvest-dialog-actions">',
      revealed
        ? '<button type="button" class="light" data-harvest-review-forgot>没记住</button>' +
          '<button type="button" class="primary" data-harvest-review-remember>记住了</button>'
        : '<button type="button" class="primary" data-harvest-review-show>显示答案</button>',
      '</div>',
    ].join('');
    root.querySelector('[data-harvest-review-close]').addEventListener('click', ctx.closeDialog);
    root.querySelector('[data-harvest-review-show]')?.addEventListener('click', () => {
      revealed = true;
      draw();
    });
    const answer = async (result) => {
      const card = queue[index];
      try {
        await ctx.api.command({ type: 'reviewHarvest', id: card.id, result });
        await ctx.reload();
      } catch (err) {
        ctx.notify(message(err), 'bad');
      }
      index += 1;
      revealed = false;
      if (index >= queue.length) {
        ctx.closeDialog();
        ctx.notify('这一轮复习完成');
        const visible = connectedPage(ctx);
        if (visible) await load(visible);
        return;
      }
      draw();
    };
    root.querySelector('[data-harvest-review-remember]')?.addEventListener('click', () => void answer('remember'));
    root.querySelector('[data-harvest-review-forgot]')?.addEventListener('click', () => void answer('forgot'));
  }
  draw();
}

function confirmDelete(ctx, card) {
  ctx.modal([
    '<section class="harvest-dialog" data-harvest-confirm><h2>删除收获</h2>',
    '<p>确定删除「' + esc(card.title) + '」？</p>',
    '<p class="harvest-error" role="alert" data-harvest-error hidden></p>',
    '<div class="harvest-actions harvest-dialog-actions">',
    '<button type="button" class="light" data-harvest-cancel>取消</button>',
    '<button type="button" class="light danger" data-harvest-delete-confirm>确认删除</button></div></section>',
  ].join(''));
  const root = document.querySelector('[data-harvest-confirm]');
  const cancel = root.querySelector('[data-harvest-cancel]');
  const confirm = root.querySelector('[data-harvest-delete-confirm]');
  cancel.focus();
  cancel.addEventListener('click', ctx.closeDialog);
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    try {
      await ctx.api.command({ type: 'deleteHarvest', harvestId: card.id });
      if (dialogActive(root)) ctx.closeDialog();
      ctx.notify('已删除收获');
      const page = connectedPage(ctx);
      if (page) await load(page);
    } catch (err) {
      const error = root.querySelector('[data-harvest-error]');
      error.textContent = message(err);
      error.hidden = false;
      confirm.disabled = false;
    }
  });
}

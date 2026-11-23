// 收获页与全局粘贴入口。原文只用于本地解析或请求提炼，保存时仅提交卡片字段。
import { newId } from './api.js';
import { localToday } from './dom.js';
import { esc } from './icons.js';
import { parseHarvest, formatHarvest, splitTags, CHATGPT_PROMPT, HARVEST_LIMITS as limits } from './harvest-format.js';

const PAGE_SIZE = 20;
const BLOCK_SECONDS = 30 * 60;
const PASTE_LIMIT = 60000;
const message = (err) => err?.message ?? String(err);
const lines = (value) => value.split('\n').map((line) => line.trim()).filter(Boolean);
const todoText = (todo) => typeof todo === 'string' ? todo : todo.text;

let currentPage;
let promoting = false;
// promote 与 saveSchedule 是两个命令。第二步失败时，保留时间块 ID 供本会话补排。
const pendingBlocks = new Map();

function connectedPage(ctx) {
  return ctx.state.page === 'harvest' && currentPage?.root.isConnected ? currentPage : null;
}

export function showHarvest(host, ctx) {
  if (currentPage?.root.isConnected && host.contains(currentPage.root)) {
    const page = currentPage;
    if (page.view !== ctx.state.view) {
      page.view = ctx.state.view;
      if (!promoting && page.cards.length) void load(page);
      else updateScheduleButtons(page);
    }
    return;
  }

  const root = document.createElement('section');
  root.className = 'harvest-page';
  root.innerHTML = [
    '<header class="topline harvest-header"><h1>收获</h1>',
    '<div class="harvest-actions"><button type="button" class="light" data-harvest-prompt>复制 ChatGPT 口令</button>',
    '<button type="button" class="primary" data-harvest-open>粘贴收获</button></div></header>',
    '<div class="harvest-tools">',
    '<label class="harvest-field">搜索收获<input type="search" data-harvest-search placeholder="标题、要点、标签…"></label>',
    '<span class="harvest-shortcut"><kbd>Ctrl+Shift+V</kbd> / <kbd>⌘+Shift+V</kbd></span></div>',
    '<div class="harvest-tags" role="group" aria-label="按标签筛选" data-harvest-tags></div>',
    '<p class="soft" role="status" data-harvest-status></p>',
    '<div class="harvest-list" data-harvest-list></div>',
    '<button type="button" class="light harvest-more" data-harvest-more hidden>加载更多</button>',
  ].join('');
  const page = {
    root, ctx, view: ctx.state.view, q: '', tag: '', cards: [], total: 0, tags: [],
    seq: 0, timer: 0,
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
  root.addEventListener('click', (event) => void onPageClick(page, event));
  void load(page);
}

async function load(page, append = false) {
  if (!page.root.isConnected) return;
  clearTimeout(page.timer);
  page.timer = 0;
  const seq = ++page.seq;
  const offset = append ? page.cards.length : 0;
  const query = new URLSearchParams({ q: page.q, tag: page.tag, limit: PAGE_SIZE, offset });
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

function renderResults(page) {
  const tagBar = page.root.querySelector('[data-harvest-tags]');
  const focusedTag = tagBar.contains(document.activeElement) ? document.activeElement.dataset.harvestTag : null;
  // 保留刚被删除或改名的筛选标签，用户仍能点一下取消筛选。
  const tags = page.tag && !page.tags.some((item) => item.tag === page.tag)
    ? [...page.tags, { tag: page.tag, count: 0 }] : page.tags;
  tagBar.innerHTML = tags.map(({ tag, count }) =>
    '<button type="button" class="harvest-chip" data-harvest-tag="' + esc(tag) + '" aria-pressed="' +
      (tag === page.tag) + '">#' + esc(tag) + ' <small>' + count + '</small></button>').join('');
  if (focusedTag != null) {
    [...tagBar.children].find((button) => button.dataset.harvestTag === focusedTag)?.focus({ preventScroll: true });
  }
  page.root.querySelector('[data-harvest-list]').innerHTML = page.cards.length
    ? page.cards.map((card) => cardMarkup(card)).join('')
    : (page.q || page.tag
      ? '<p class="empty">没有匹配的收获。</p>'
      : '<section class="harvest-card harvest-empty"><h2>把对话里的精华存下来</h2><ol>' +
        '<li>复制 ChatGPT 口令，放进 ChatGPT 的自定义指令。</li>' +
        '<li>问完后发送「收」，复制它给出的精华。</li>' +
        '<li>回到工作台按 <kbd>Ctrl+Shift+V</kbd>，预览后保存。</li></ol></section>');
  const more = page.root.querySelector('[data-harvest-more]');
  more.hidden = page.cards.length >= page.total;
  more.textContent = '加载更多';
  updateScheduleButtons(page);
}

function cardMarkup(card) {
  const link = /^https?:\/\//i.test(card.sourceUrl)
    ? '<a class="link" href="' + esc(card.sourceUrl) + '" target="_blank" rel="noopener">打开对话</a>' : '';
  return [
    '<article class="harvest-card" data-harvest-card="' + esc(card.id) + '">',
    '<header class="harvest-cardhead"><h2>' + esc(card.title) + '</h2>',
    '<time datetime="' + esc(card.day) + '">' + esc(card.day) + '</time></header>',
    card.conclusion ? '<p class="harvest-conclusion">' + esc(card.conclusion) + '</p>' : '',
    card.points.length ? '<ul class="harvest-points">' +
      card.points.map((point) => '<li>' + esc(point) + '</li>').join('') + '</ul>' : '',
    card.todos.length ? '<div class="harvest-todos"><h3>待办</h3><ul>' +
      card.todos.map(todoMarkup).join('') + '</ul></div>' : '',
    '<footer class="harvest-cardfoot"><div class="harvest-tags">' +
      card.tags.map((tag) => '<span class="harvest-chip">#' + esc(tag) + '</span>').join('') + '</div>',
    '<div class="harvest-actions">' + link,
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
  const text = todo.taskDone ? '<s>' + esc(todo.text) + '</s>' : esc(todo.text);
  return '<li data-harvest-todo="' + index + '"><span>' + text + '</span><div class="harvest-actions">' + actions + '</div></li>';
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

function onPageClick(page, event) {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  const ctx = page.ctx;
  const data = button.dataset;
  if ('harvestOpen' in data) return openHarvestCapture(ctx);
  if ('harvestPrompt' in data) return copyText(ctx, CHATGPT_PROMPT, '已复制 ChatGPT 口令');
  if ('harvestTag' in data) {
    page.tag = page.tag === data.harvestTag ? '' : data.harvestTag;
    return load(page);
  }
  if ('harvestMore' in data) return load(page, button.textContent === '加载更多');
  const id = button.closest('[data-harvest-card]')?.dataset.harvestCard;
  const card = page.cards.find((item) => item.id === id);
  if (!card) return;
  if ('harvestCopy' in data) return copyText(ctx, formatHarvest(card), '已复制收获文本');
  if ('harvestEdit' in data) return openEdit(ctx, card);
  if ('harvestDelete' in data) return confirmDelete(ctx, card);
  const row = button.closest('[data-harvest-todo]');
  if (row) return promote(page, card, Number(row.dataset.harvestTodo), 'harvestSchedule' in data);
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

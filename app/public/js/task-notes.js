import { api } from './api.js';
import { icon } from './icons.js';

const SAVE_DELAY = 350;
const DRAFT_PREFIX = 'workbench.taskNoteDraft.';
const STATUS = {
  loading: '正在读取',
  saved: '已自动保存',
  dirty: '待保存',
  saving: '正在保存',
  error: '保存失败 · 草稿已保留',
  'load-error': '读取失败',
  conflict: '正文已在另一窗口更新 · 当前草稿已保留',
};

export function bindTaskNotes(main, renameTask) {
  const drafts = new Map();
  let current;
  let focusWhenReady;

  function syncStatus(entry) {
    if (current !== entry) return;
    main.querySelector('#taskNoteStatus').textContent = STATUS[entry.status];
    main.querySelector('#retryTaskNote').hidden = !['error', 'load-error'].includes(entry.status);
  }

  function stash(entry) {
    const key = DRAFT_PREFIX + entry.id;
    try {
      if (entry.body === entry.savedBody && !entry.request) {
        sessionStorage.removeItem(key);
      } else {
        sessionStorage.setItem(key, JSON.stringify({
          body: entry.body,
          revision: entry.revision,
          sending: entry.request?.body,
        }));
      }
      entry.recoverable = true;
    } catch {
      entry.recoverable = false;
    }
  }

  async function load(entry) {
    entry.status = 'loading';
    syncStatus(entry);
    try {
      const { note } = await api.taskNote(entry.id);
      entry.loaded = true;
      entry.savedBody = note.body;
      const draft = entry.recovered;
      entry.body = draft?.body ?? note.body;
      entry.revision = note.revision;
      if (draft && draft.body !== note.body && draft.revision !== note.revision && draft.sending !== note.body) {
        entry.revision = draft.revision;
        entry.status = 'conflict';
      } else {
        entry.status = entry.body === note.body ? 'saved' : 'dirty';
      }
      stash(entry);
      if (current === entry) {
        const area = main.querySelector('#taskNoteBody');
        area.value = entry.body;
        area.disabled = false;
        if (focusWhenReady === entry.id) {
          focusWhenReady = null;
          area.focus({ preventScroll: true });
        }
      }
      if (entry.status === 'dirty') void flush(entry);
    } catch {
      entry.status = 'load-error';
    }
    syncStatus(entry);
  }

  async function flush(entry) {
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.request || !entry.loaded || entry.body === entry.savedBody || entry.status === 'conflict') return;
    const body = entry.body;
    entry.request = { body };
    entry.status = 'saving';
    stash(entry);
    syncStatus(entry);
    try {
      const command = {
        type: 'saveTaskNote', taskId: entry.id, body, expectedRevision: entry.revision,
      };
      const keepalive = new TextEncoder().encode(JSON.stringify({ command })).byteLength < 60000;
      const { result } = await api.command(command, { keepalive });
      entry.savedBody = body;
      entry.revision = result.revision;
      entry.status = entry.body === body ? 'saved' : 'dirty';
    } catch (error) {
      entry.status = error.reason === 'conflict' ? 'conflict' : 'error';
    } finally {
      entry.request = null;
      stash(entry);
      syncStatus(entry);
    }
    if (entry.status === 'dirty') void flush(entry);
  }

  function getDraft(id) {
    if (drafts.has(id)) return drafts.get(id);
    let recovered;
    try {
      const data = JSON.parse(sessionStorage.getItem(DRAFT_PREFIX + id));
      if (typeof data?.body === 'string' && Number.isInteger(data.revision)) recovered = data;
    } catch { /* No recoverable draft. */ }
    const entry = { id, recovered, body: recovered?.body ?? '', savedBody: '',
      status: 'loading', recoverable: true };
    drafts.set(id, entry);
    void load(entry);
    return entry;
  }

  function leave() {
    const previous = current;
    current = null;
    focusWhenReady = null;
    void flush(previous);
  }

  function bindTitle(taskId) {
    const heading = main.querySelector('#taskEditorTitle');
    const button = main.querySelector('#editTaskName');
    const label = main.querySelector('#taskNameText');
    const form = main.querySelector('#taskNameForm');
    const input = main.querySelector('#taskNameInput');

    function finish() {
      const restoreFocus = document.activeElement === input;
      form.hidden = true;
      heading.hidden = false;
      if (restoreFocus) button.focus({ preventScroll: true });
    }

    async function save() {
      if (form.hidden || input.readOnly) return;
      const title = input.value.trim();
      if (!title || title === label.textContent) {
        finish();
        return;
      }
      input.readOnly = true;
      const saved = await renameTask(taskId, title);
      input.readOnly = false;
      if (saved) finish();
    }

    button.onclick = () => {
      input.value = label.textContent;
      heading.hidden = true;
      form.hidden = false;
      input.focus({ preventScroll: true });
      input.select();
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      void save();
    };
    input.onblur = () => void save();
    input.onkeydown = (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        void save();
      }
      if (event.key === 'Escape' && !input.readOnly) {
        event.preventDefault();
        finish();
      }
    };
  }

  function render(task, blockId, openFocus) {
    const alreadyShown = main.querySelector('#taskEditor');
    if (!alreadyShown || (task?.id ?? null) !== (current?.id ?? null)) {
      leave();
      if (!task) {
        main.innerHTML = '<section id="taskEditor" class="task-editor empty">选一个任务，开始记录。</section>';
        return;
      }
      current = getDraft(task.id);
      main.innerHTML = `<section id="taskEditor" class="task-editor" aria-labelledby="taskEditorTitle">
        <div class="task-editor-head">
          <h1 id="taskEditorTitle"><button type="button" id="editTaskName" class="task-name-button"
            title="编辑任务名称"><span id="taskNameText"></span>${icon('edit')}</button></h1>
          <form id="taskNameForm" hidden>
            <input type="text" id="taskNameInput" aria-label="任务名称" maxlength="120">
          </form>
          <div class="task-editor-tools">
            <button type="button" class="light" id="taskEditorDetails">任务详情</button>
            <button type="button" class="light" id="taskEditorFocus" data-action="start">开始专注</button>
            <button type="button" class="primary" id="taskEditorDone" data-keep-editor>完成任务</button>
          </div>
        </div>
        <textarea id="taskNoteBody" aria-label="任务正文" maxlength="32000" placeholder="写点什么…"></textarea>
        <div class="task-editor-footer">
          <span id="taskNoteStatus" role="status"></span>
          <button type="button" class="link" id="retryTaskNote" hidden>重试</button>
        </div>
      </section>`;
      bindTitle(task.id);
      const area = main.querySelector('#taskNoteBody');
      area.value = current.body;
      area.disabled = !current.loaded;
      syncStatus(current);
    }
    if (!task) return;
    main.querySelector('#taskNameText').textContent = task.title;
    const details = main.querySelector('#taskEditorDetails');
    details.dataset.task = task.id;
    details.dataset.block = blockId ?? '';
    const focusButton = main.querySelector('#taskEditorFocus');
    focusButton.dataset.focusTask = task.id;
    focusButton.hidden = Boolean(task.completedAt || openFocus);
    // 完成 / 撤销：走外壳的 data-complete / data-undo 分派（commands.complete / undo）
    const done = main.querySelector('#taskEditorDone');
    delete done.dataset.complete;
    delete done.dataset.undo;
    if (task.completedAt) {
      done.dataset.undo = task.id;
      done.className = 'light done-toggle';
      done.textContent = '已完成 · 撤销';
    } else {
      done.dataset.complete = task.id;
      done.className = 'primary done-toggle';
      done.textContent = '完成任务';
    }
  }

  main.addEventListener('input', (event) => {
    if (event.target.id !== 'taskNoteBody' || !current?.loaded) return;
    const entry = current;
    entry.body = event.target.value;
    stash(entry);
    if (entry.status === 'conflict') return;
    entry.status = entry.body === entry.savedBody && !entry.request ? 'saved' : 'dirty';
    syncStatus(entry);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flush(entry), SAVE_DELAY);
  });
  main.addEventListener('click', (event) => {
    if (event.target.id !== 'retryTaskNote' || !current) return;
    if (current.loaded) void flush(current);
    else void load(current);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush(current);
  });
  window.addEventListener('pagehide', () => {
    for (const entry of drafts.values()) void flush(entry);
  });

  return {
    render,
    leave,
    focus() {
      if (current?.loaded) main.querySelector('#taskNoteBody').focus({ preventScroll: true });
      else focusWhenReady = current?.id;
    },
    /** 跳过 350 ms 防抖，立即保存当前正文（Ctrl/⌘+S）。 */
    saveNow() {
      return flush(current);
    },
    hasUnsavedWork() {
      return [...drafts.values()].some((entry) => !entry.recoverable
        && (entry.request || entry.body !== entry.savedBody));
    },
  };
}

const HEALTH_MS = 5000;
const VIEW_KEY = 'workbenchLiveView';
const DRAFT_PREFIX = 'workbench.taskNoteDraft.';

export function startLive({ onChange }) {
  let revision;
  let failures = 0;
  let polling;
  let closed = false;
  let source;

  function receive(rev, origin) {
    if (!Number.isSafeInteger(rev) || rev < 0 || revision === rev) return;
    revision = rev;
    onChange({ rev, origin });
  }

  async function poll() {
    try {
      const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(HEALTH_MS) });
      if (!response.ok) return;
      const { dataRev } = await response.json();
      if (!closed) receive(dataRev, 'external');
    } catch { /* 服务恢复后由下一次轮询补上 */ }
  }

  function startPolling() {
    source?.close();
    void poll();
    polling = setInterval(poll, HEALTH_MS);
  }

  if (typeof EventSource === 'function') {
    source = new EventSource('/api/events');
    source.addEventListener('hello', (event) => {
      const { rev } = JSON.parse(event.data);
      if (failures) {
        revision = undefined; // 重新连接到重启的进程时，数字可能恰好相同。
        receive(rev, 'external');
      } else if (revision === undefined) {
        revision = rev;
        if (rev > 0) onChange({ rev, origin: 'external' });
      }
      failures = 0;
    });
    source.addEventListener('change', (event) => {
      const { rev, origin } = JSON.parse(event.data);
      receive(rev, origin);
    });
    source.addEventListener('error', () => {
      if (++failures === 3) startPolling();
    });
  } else {
    startPolling();
  }

  return () => {
    closed = true;
    source?.close();
    clearInterval(polling);
  };
}

export function openNoteHasDraft() {
  const note = document.querySelector('#taskNoteBody');
  if (!note) return false;
  const task = document.querySelector('#taskEditorDetails')?.dataset.task;
  try { return note.disabled || Boolean(task && sessionStorage.getItem(DRAFT_PREFIX + task)); }
  catch { return note.disabled; }
}

// 正文编辑器在挂载时读取正文和修订号。保留当前日期、任务和位置，
// 只在干净的正文确实变化时重挂页面，让原有编辑器用同一次读取更新这两个值。
export async function refreshOpenNote(api, state, blocked) {
  const editor = document.querySelector('#taskNoteBody');
  const task = document.querySelector('#taskEditorDetails')?.dataset.task;
  if (!editor || !task) return 'continue';
  const { note } = await api.taskNote(task);
  if (editor !== document.querySelector('#taskNoteBody')) return 'defer';
  if (note.body === editor.value) return 'continue';
  if (blocked()) return 'defer';
  const { day, month, timeZone, todayDay, userPinnedDate, selectedTaskId, editorTaskId, editorBlockId, scrolls } = state;
  history.replaceState({ ...history.state, [VIEW_KEY]: {
    day, month, timeZone, todayDay, userPinnedDate, selectedTaskId, editorTaskId, editorBlockId, scrolls,
  } }, '');
  location.reload();
  return 'reloading';
}

export function restoreLiveView(state) {
  const { [VIEW_KEY]: saved, ...other } = history.state ?? {};
  if (!saved) return;
  history.replaceState(other, '');
  Object.assign(state, saved);
}

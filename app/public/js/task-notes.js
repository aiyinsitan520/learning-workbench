import { api } from './api.js';
import { icon } from './icons.js';

const SAVE_DELAY = 350;
const BODY_LIMIT = 32000;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const UPLOADING = '![上传中…]()';
const IMAGE_PATH = /^\/api\/attachments\/[0-9a-f]{64}\.(?:png|jpg|webp|gif)$/;
const IMAGE_TYPE = /^image\/(?:png|jpeg|webp|gif)$/;
const INLINE_IMAGE = /^data:(image\/(?:png|jpeg|webp|gif));base64,/i;
const HTML_IMAGE_LIMIT = 20;

function clipboardImages(data) {
  if (!data) return [];
  const files = Array.from(data.files).filter(file => file.type.startsWith('image/'));
  if (files.length) return files;
  return Array.from(data.items)
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile()).filter(Boolean);
}

function htmlHasText(html) {
  if (!html) return false;
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script,style').forEach(node => node.remove());
  return Boolean(template.content.textContent.trim());
}

function clipboardArticle(html) {
  if (!html) return null;
  const template = document.createElement('template');
  template.innerHTML = html;
  if (!template.content.querySelector('img')) return null;
  const lines = [];
  let line = '', listPrefix = '', readable = 0, unreadable = 0;
  function endLine(force = false) {
    const text = line.replace(/\s+/g, ' ').trim();
    if (text) {
      lines.push(listPrefix + text);
      listPrefix = '';
    } else if (force && lines.length && lines.at(-1) !== '') {
      lines.push('');
    }
    line = '';
  }
  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      line += node.data;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.localName;
    if (tag === 'script' || tag === 'style') return;
    if (tag === 'br') return endLine(true);
    if (tag === 'img') {
      const src = (node.getAttribute('src') || '').trim();
      if (!INLINE_IMAGE.test(src) && !/^https?:\/\//i.test(src)) {
        unreadable++;
      } else if (++readable <= HTML_IMAGE_LIMIT) {
        endLine();
        lines.push({ src, alt: node.getAttribute('alt') || '图片' });
      }
      return;
    }
    const block = /^(p|div|li|h[1-6]|tr|blockquote|pre|section|article)$/.test(tag);
    if (block) endLine();
    if (tag === 'li') listPrefix = '- ';
    for (const child of node.childNodes) visit(child);
    if (block) endLine();
    if (tag === 'li') listPrefix = '';
  }
  for (const child of template.content.childNodes) visit(child);
  endLine();
  if (lines.at(-1) === '') lines.pop();
  return { lines, readable, unreadable };
}

async function uploadImage(image) {
  let file = image;
  let endpoint = '/api/attachments';
  let body, type;
  if (image.src && !INLINE_IMAGE.test(image.src)) {
    endpoint += '/fetch';
    type = 'application/json';
    body = JSON.stringify({ url: image.src });
  } else {
    if (image.src) {
      const [header, mime] = INLINE_IMAGE.exec(image.src);
      if (image.src.length - header.length > 4 * Math.ceil(IMAGE_LIMIT / 3)) throw new Error();
      const bytes = Uint8Array.from(atob(image.src.slice(header.length)), char => char.charCodeAt(0));
      file = new Blob([bytes], { type: mime.toLowerCase() });
    }
    if (!IMAGE_TYPE.test(file.type) || file.size > IMAGE_LIMIT) throw new Error();
    type = file.type;
    body = file;
  }
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': type }, body });
  if (!response.ok) throw new Error();
  const { url } = await response.json();
  if (!IMAGE_PATH.test(url)) throw new Error();
  const alt = (image.alt || image.name || '图片').replace(/[\[\]\r\n]/g, '').slice(0, 120) || '图片';
  return '![' + alt + '](' + url + ')';
}

function imageToken(alt, url) {
  return { alt, url: IMAGE_PATH.test(url) ? url : null };
}

function appendInline(parent, line) {
  const tokens = /(!?)\[([^\]\n]*)\]\(([^)\s]*)\)|\*\*([^*\n]+)\*\*/g;
  let start = 0;
  for (const match of line.matchAll(tokens)) {
    parent.append(line.slice(start, match.index));
    start = match.index + match[0].length;
    const [, image, label, url, bold] = match;
    if (image && IMAGE_PATH.test(url)) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = label;
      img.loading = 'lazy';
      parent.append(img);
    } else if (bold !== undefined) {
      const strong = document.createElement('strong');
      strong.textContent = bold;
      parent.append(strong);
    } else if (!image && /^https?:\/\//i.test(url)) {
      const link = document.createElement('a');
      link.href = url;
      link.textContent = label;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      parent.append(link);
    } else {
      parent.append(match[0]);
    }
  }
  parent.append(line.slice(start));
}

function renderMarkdown(container, body) {
  container.replaceChildren();
  let list;
  for (const line of body.split(/\r?\n/)) {
    const item = /^(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(line);
    if (item) {
      const tag = item[2] ? 'OL' : 'UL';
      if (list?.tagName !== tag) {
        list = document.createElement(tag);
        if (item[2]) list.start = Number(item[2]);
        container.append(list);
      }
      const li = document.createElement('li');
      appendInline(li, item[3]);
      list.append(li);
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const block = document.createElement(heading ? 'h' + heading[1].length : 'p');
    appendInline(block, heading ? heading[2] : line);
    container.append(block);
  }
}
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

  function syncImages(entry) {
    if (current !== entry) return;
    const strip = main.querySelector('#taskNoteImages');
    const preview = main.querySelector('#taskNotePreview');
    const area = main.querySelector('#taskNoteBody');
    main.querySelector('#insertTaskNoteImage').disabled = !entry.loaded || Boolean(entry.upload || entry.preview);
    main.querySelector('#toggleTaskNotePreview').disabled = !entry.loaded;
    main.querySelector('#taskNoteImageStatus').textContent = entry.imageStatus ?? '';
    const images = [...entry.body.matchAll(/!\[([^\]\n]*)\]\(([^)\s]*)\)/g)]
      .map(([, alt, url]) => imageToken(alt, url)).filter(image => image.url);
    strip.replaceChildren();
    strip.hidden = !images.length;
    for (const { alt, url } of images) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', '查看大图：' + (alt || '正文图片'));
      const thumb = document.createElement('img');
      thumb.src = url;
      thumb.alt = alt;
      thumb.loading = 'lazy';
      button.append(thumb);
      button.onclick = () => {
        const dialog = main.querySelector('#taskNoteImageDialog');
        const image = dialog.querySelector('img');
        image.src = url;
        image.alt = alt;
        dialog.showModal();
      };
      strip.append(button);
    }
    area.hidden = entry.preview === true;
    preview.hidden = !area.hidden;
    const toggle = main.querySelector('#toggleTaskNotePreview');
    toggle.textContent = area.hidden ? '编辑正文' : '预览';
    toggle.setAttribute('aria-pressed', String(area.hidden));
    if (!preview.hidden) renderMarkdown(preview, entry.body);
  }

  function updateBody(entry, body) {
    entry.body = body;
    stash(entry);
    syncImages(entry);
    if (entry.status === 'conflict') return;
    entry.status = body === entry.savedBody && !entry.request ? 'saved' : 'dirty';
    syncStatus(entry);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flush(entry), SAVE_DELAY);
  }

  async function insertImages(entry, area, parts, article = null) {
    if (!entry.loaded || area.hidden || !parts.length) return;
    if (entry.upload) {
      if (article) {
        entry.imageStatus = '上一批图片还在上传，稍候再按一次 Ctrl+V';
        syncImages(entry);
      } else {
        entry.upload.parts.push(...parts);
      }
      return;
    }
    const offset = area.selectionStart;
    const end = article ? area.selectionEnd : offset;
    const marker = UPLOADING;
    if (entry.body.length - (end - offset) + marker.length > BODY_LIMIT) {
      entry.imageStatus = '正文已接近 32000 字上限，无法插入图片。';
      syncImages(entry);
      return;
    }
    const upload = { offset, marker, parts, selectedText: entry.body.slice(offset, end) };
    entry.upload = upload;
    entry.imageStatus = '正在上传图片…';
    area.setRangeText(marker, offset, end, 'end');
    updateBody(entry, area.value);
    const lines = [];
    let rejected = article?.unreadable || 0;
    for (const part of parts) {
      if (typeof part === 'string') {
        lines.push({ text: part });
        continue;
      }
      try {
        lines.push({ text: await uploadImage(part), image: true });
      } catch {
        rejected++;
      }
    }
    entry.upload = null;
    const notices = [];
    if (rejected) notices.push(article ? '有 ' + rejected + ' 张图片没取到（网址打不开或不是 PNG/JPEG/WebP/GIF）'
      : '有 ' + rejected + ' 张图片上传失败。支持 PNG、JPEG、WebP、GIF，单张最多 10 MiB。');
    if (article?.readable > HTML_IMAGE_LIMIT) notices.push('一次最多插入 20 张图片，超出的图片请分批粘贴。');
    entry.imageStatus = notices.join(' ');
    if (upload.offset === null) {
      updateBody(entry, entry.body);
      return;
    }
    const from = upload.offset;
    const to = from + marker.length;
    const available = BODY_LIMIT - (entry.body.length - marker.length);
    const before = entry.body.slice(0, from);
    const after = entry.body.slice(to);
    let replacement = '';
    let lastImage = false;
    for (const { text, image } of lines) {
      if (!text && (!replacement || replacement.endsWith('\n'))) continue;
      const newline = replacement || (image && before && !before.endsWith('\n')) ? '\n' : '';
      const boundary = image && after && !after.startsWith('\n') ? 1 : 0;
      const room = available - replacement.length - newline.length;
      if (text.length + boundary > room) {
        if (!image && room > 0) {
          replacement += newline + text.slice(0, room);
          lastImage = false;
        }
        notices.push('正文已接近 32000 字上限，部分内容无法插入。');
        entry.imageStatus = notices.join(' ');
        break;
      }
      replacement += newline + text;
      lastImage = image;
    }
    if (lastImage && after && !after.startsWith('\n')) replacement += '\n';
    if (current === entry) {
      main.querySelector('#taskNoteBody').setRangeText(replacement, from, to, 'preserve');
    }
    updateBody(entry, before + replacement + after);
  }

  function syncStatus(entry) {
    if (current !== entry) return;
    main.querySelector('#taskNoteStatus').textContent = STATUS[entry.status];
    main.querySelector('#retryTaskNote').hidden = !['error', 'load-error'].includes(entry.status);
  }

  function stash(entry) {
    const key = DRAFT_PREFIX + entry.id;
    const upload = entry.upload;
    const body = upload && upload.offset !== null
      ? entry.body.slice(0, upload.offset) + upload.selectedText + entry.body.slice(upload.offset + upload.marker.length)
      : entry.body;
    try {
      if (body === entry.savedBody && !entry.request) {
        sessionStorage.removeItem(key);
      } else {
        sessionStorage.setItem(key, JSON.stringify({
          body,
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
        syncImages(entry);
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
    if (entry.upload || entry.request || !entry.loaded || entry.body === entry.savedBody || entry.status === 'conflict') return;
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
        <div class="task-note-tools">
          <button type="button" class="light" id="insertTaskNoteImage">从文件插图</button>
          <input type="file" id="taskNoteImageFile" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
          <button type="button" class="light" id="toggleTaskNotePreview" aria-pressed="false">预览</button>
          <span id="taskNoteImageStatus" role="status"></span>
        </div>
        <textarea id="taskNoteBody" aria-label="任务正文" maxlength="32000" placeholder="写点什么… 复制图片后，在这里按 Ctrl+V（Mac 用 ⌘V）即可插图。"></textarea>
        <div id="taskNotePreview" class="task-note-preview" aria-label="正文预览" hidden></div>
        <div id="taskNoteImages" class="task-note-images" aria-label="正文图片" hidden></div>
        <dialog id="taskNoteImageDialog" class="task-note-image-dialog" aria-label="正文大图">
          <form method="dialog"><button type="submit" class="light">关闭</button></form>
          <img alt="">
        </dialog>
        <div class="task-editor-footer">
          <span id="taskNoteStatus" role="status"></span>
          <button type="button" class="link" id="retryTaskNote" hidden>重试</button>
        </div>
      </section>`;
      bindTitle(task.id);
      const area = main.querySelector('#taskNoteBody');
      area.value = current.body;
      area.disabled = !current.loaded;
      const entry = current;
      const input = main.querySelector('#taskNoteImageFile');
      main.querySelector('#insertTaskNoteImage').onclick = () => input.click();
      input.onchange = () => {
        void insertImages(entry, area, [...input.files]);
        input.value = '';
      };
      main.querySelector('#toggleTaskNotePreview').onclick = () => {
        entry.preview = !entry.preview;
        syncImages(entry);
        if (!entry.preview) area.focus({ preventScroll: true });
      };
      area.onpaste = event => {
        const files = clipboardImages(event.clipboardData);
        // Excel、Word 复制文字时会附带整段内容的位图；HTML 里有文字就按文字处理，不上传这张位图。
        if (files.length && !htmlHasText(event.clipboardData.getData('text/html'))) {
          event.preventDefault();
          void insertImages(entry, area, files);
          return;
        }
        const article = clipboardArticle(event.clipboardData?.getData('text/html'));
        if (article?.readable) {
          event.preventDefault();
          void insertImages(entry, area, article.lines, article);
        } else if (article?.unreadable) {
          entry.imageStatus = '有 ' + article.unreadable + ' 张图片来自本机文件，网页读不到，请用「从文件插图」或拖入';
          syncImages(entry);
        }
      };
      area.ondragover = event => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      };
      area.ondrop = event => {
        const files = [...event.dataTransfer.files];
        if (!files.length) return;
        event.preventDefault();
        void insertImages(entry, area, files);
      };
      syncImages(entry);
      syncStatus(entry);
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
    const body = event.target.value;
    if (entry.upload?.offset != null) {
      const { offset, marker } = entry.upload;
      // 修改发生在占位符前后时跟随它；改写了占位符就保留用户输入。
      if (body.startsWith(entry.body.slice(0, offset + marker.length))) {
        entry.upload.offset = offset;
      } else if (body.endsWith(entry.body.slice(offset))) {
        entry.upload.offset = offset + body.length - entry.body.length;
      } else {
        entry.upload.offset = null;
      }
    }
    updateBody(entry, body);
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
      if (window.matchMedia('(max-width: 830px)').matches) {
        const editor = main.querySelector('#taskEditor');
        const taskId = current?.id;
        // 等路由完成滚动位置还原，再定位显式打开的正文。
        requestAnimationFrame(() => {
          if (!editor?.isConnected || current?.id !== taskId) return;
          const top = editor.getBoundingClientRect().top;
          const header = document.querySelector('header.macbar').getBoundingClientRect().bottom;
          const bodyTop = main.querySelector('#taskNoteBody')?.getBoundingClientRect().top;
          if (top < header || bodyTop >= innerHeight) {
            window.scrollTo({ top: scrollY + top - header - 8,
              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
          }
        });
      }
      if (current?.loaded) main.querySelector('#taskNoteBody').focus({ preventScroll: true });
      else focusWhenReady = current?.id;
    },
    /** 跳过 350 ms 防抖，立即保存当前正文（Ctrl/⌘+S）。 */
    saveNow() {
      return flush(current);
    },
    hasUnsavedWork() {
      return [...drafts.values()].some((entry) => entry.upload || (!entry.recoverable
        && (entry.request || entry.body !== entry.savedBody)));
    },
  };
}

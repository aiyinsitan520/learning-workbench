// 「数据」设置页（页面 key 'storage'，从齿轮页「数据与备份」和桌面菜单「数据位置…」进入）。
// 数据全部来自 GET /api/storage（StorageInfo，见 architecture/workbench.d.ts），
// 写操作只走 /api/storage/backup、reveal、pick-folder、relocate 与 /api/restart。
// 按钮统一用 data-storage-* 属性并在本模块内监听，不使用外壳已占用的
// data-page / data-task / data-day / data-action 等属性。
//
// 风险最高的操作是「更换数据位置」：确认对话框必须写明旧文件夹不删除、需要重启、
// 重启前先自动备份，任何错误都翻译成人话，不把堆栈丢给用户。
import { ApiError } from './api.js';
import { esc, icon } from './icons.js';
// Obsidian 联动小节（T-W5）。它自己挂载内容并注入 obsidian.css，这里只给一个空 section。
import { mountObsidianSection } from './obsidian-section.js';

const BYTES = ['B', 'KB', 'MB', 'GB'];

/** 字节数 → 「1.2 MB」；只用于展示。 */
function size(bytes) {
  let value = Math.abs(Number(bytes) || 0);
  let unit = 0;
  while (value >= 1024 && unit < BYTES.length - 1) { value /= 1024; unit += 1; }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1);
  return `${text} ${BYTES[unit]}`;
}

/** Unix 秒 → 「2026/11/24 14:05」；按工作台时区，取不到时退回本机时区。 */
function clockText(seconds, timeZone) {
  if (!seconds) return '—';
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  const options = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  try {
    return new Intl.DateTimeFormat('zh-CN', timeZone ? { ...options, timeZone } : options).format(date);
  } catch {
    return date.toLocaleString('zh-CN', options);
  }
}

const SOURCE_LABELS = { default: '默认位置', config: '自定义', env: '开发环境变量' };

/**
 * /api/storage 系列返回的是裸对象（没有 ok:true），api.get/api.post 会判成失败，
 * 所以这里自带一层只认 HTTP 状态的请求包装。错误码留给 humanError 翻译。
 */
async function call(path, body) {
  const init = body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('storage', '连不上本机服务，请确认工作台还在运行', 0);
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(payload?.reason ?? payload?.code ?? 'storage',
      payload?.message ?? `请求失败（${res.status}）`, res.status);
  }
  return payload;
}

/** POST 包装：body 省略时也要发 POST，不能退化成 GET。 */
const post = (path, body = {}) => call(path, body);

/** 服务端说的人话（例如「目标已存在 workbench.db」）可以照原样显示。 */
function isHuman(text) {
  if (!text || text.includes('\n')) return false;
  // Node 的错误码（EACCES: …）与异常类名（TypeError: …）属于技术细节，不给用户看
  return !/^[A-Z][A-Z0-9_]*:/.test(text) && !/^[A-Za-z]*Error:/.test(text);
}

/** 任何失败都变成一句人话；不显示原始堆栈。 */
function humanError(err) {
  const status = err?.status;
  const message = String(err?.message ?? '').replace(/\s+at\s+\S+.*$/gm, '').trim();
  if (status === 0) return '连不上本机服务，请确认工作台还在运行。';
  if (status === 501) return '这个版本不支持选择文件夹，请直接输入路径。';
  if (status === 403) return '被拒绝了：只有在本机打开的工作台才能改数据位置。';
  if (status === 415) return '请求格式不对，请刷新页面后重试。';
  if (isHuman(message)) return message;
  if (status === 409) return '这个文件夹现在不能用：里面可能已经有一个资料库，或者正在使用。';
  if (status === 400) return '路径不对：请填完整的绝对路径，且不能放在程序目录里。';
  return '操作没有完成，请稍后重试。';
}

const ui = {
  info: null, // StorageInfo；null = 还在读
  error: '', // 整页读取失败的原因
  busy: false, // 正在备份 / 更换位置，按钮暂时锁住
  target: '', // 用户输入的新路径（重绘时保留）
  mode: 'copy', // 'copy' 复制过去（推荐）/ 'use' 使用那里已有的数据
  noPick: false, // 这个版本没有原生选文件夹（pick-folder 回 501）
  restart: null, // 更换成功后的重启提示 { dataDir, backup }
  note: '', // 重启按钮的说明文字
};

let panel = null;
let ctx = null;

// ---------------------------------------------------------------- 渲染

function badge(info) {
  const key = info.source;
  return `<span class="storage-badge" data-storage-badge="${esc(key)}">${SOURCE_LABELS[key] ?? key}</span>`;
}

function sourceNote(info) {
  if (info.remote) return '';
  if (info.source === 'env') {
    return '<p class="storage-note" data-storage-env-note>当前位置由环境变量 <code>WORKBENCH_DB</code> 指定（开发或测试用），'
      + '这个页面上不能更改。</p>';
  }
  if (info.source === 'config') {
    return `<p class="storage-note">位置记在 <code>${esc(info.configPath)}</code>。`
      + '网页版和桌面版读同一份配置就会用同一个文件夹，数据实时互通。</p>';
  }
  return '<p class="storage-note">这是程序的默认位置。想换地方，或让网页版和桌面版共用一个文件夹，用下面的「更换数据文件夹」。</p>';
}

function readonlyNote(info) {
  if (!info.remote) return '';
  return '<div class="storage-readonly" data-storage-readonly role="status">'
    + '<b>当前用的是服务器数据库</b>'
    + '<p>数据放在另一台电脑上，这个页面只能看，不能改位置、备份或打开文件夹。'
    + '要改本机的数据位置，请先在桌面菜单「数据源」里切回「本机数据库」。</p></div>';
}

function sharedTip(info) {
  if (info.shared) {
    return '<div class="storage-tip ok" data-storage-shared="1">'
      + '<b>网页版和桌面版用的是同一个文件夹，数据实时同步。</b>'
      + '<p>一端改动，另一端几秒内自动刷新。</p></div>';
  }
  const web = info.defaults?.web ?? '—';
  const desktop = info.defaults?.desktop;
  return '<div class="storage-tip" data-storage-shared="0">'
    + '<b>网页版和桌面版现在各用各的文件夹，数据不会互通。</b>'
    + '<p>两处默认位置：</p>'
    + `<ul><li>网页版：<code>${esc(web)}</code></li>`
    + (desktop ? `<li>桌面版：<code>${esc(desktop)}</code></li>` : '<li>桌面版：桌面应用自己的数据目录</li>')
    + '</ul>'
    + '<p>把两边设为同一个文件夹即可实时同步：在下面填上同一个路径，两端各换一次，然后各重启一次。</p></div>';
}

function usage(info) {
  return `<div class="storage-metrics" data-storage-usage>
    <div><small>数据库</small><strong>${size(info.dbBytes)}</strong><span>workbench.db</span></div>
    <div><small>图片附件</small><strong>${info.attachmentCount} 个</strong><span>${size(info.attachmentsBytes)}</span></div>
    <div><small>备份</small><strong>${info.backups?.length ?? 0} 份</strong><span>最近 20 份</span></div>
  </div>`;
}

function backupList(info) {
  const items = info.backups ?? [];
  if (!items.length) return '<p class="empty" data-storage-backups-empty>还没有备份。点「立即备份」会在数据文件夹的 backups 里存一份。</p>';
  return `<ul class="storage-backups" data-storage-backups>${items.map((item) => `
    <li><span class="storage-backup-time">${esc(clockText(item.createdAt, ctx?.state?.view?.timeZone))}</span>
      <code>${esc(item.name)}</code><strong>${size(item.bytes)}</strong></li>`).join('')}</ul>`;
}

function restartCard() {
  const { dataDir, backup } = ui.restart;
  return `<section class="storage-card storage-restart" data-storage-restart>
    <h2>${icon('check')} 已换到新文件夹，重启后生效</h2>
    <p class="storage-note">新位置：<code class="storage-path-inline">${esc(dataDir)}</code></p>
    <p class="storage-note">重启前已自动备份：<code>${esc(backup ?? '—')}</code></p>
    <div class="storage-actions">
      <button type="button" class="storage-btn primary" data-storage="restart">立即重启</button>
    </div>
    <p class="storage-note">重启之前，工作台仍在用原来的文件夹读写；旧文件夹里的文件一个都没删。</p>
    <p class="storage-error" data-storage-restart-note role="status">${esc(ui.note)}</p>
  </section>`;
}

function markup() {
  const info = ui.info;
  const head = '<div class="topline"><h1>数据</h1><span class="storage-caption">位置、用量与备份</span></div>';
  if (!info) {
    return `<section class="storage-page">${head}
      <p class="empty" data-storage-loading>正在读取数据位置…</p>
      ${ui.error ? `<div class="storage-error" data-storage-loaderror role="status">${esc(ui.error)}
        <button type="button" class="storage-btn" data-storage="retry">重试</button></div>` : ''}
    </section>`;
  }
  const disabled = info.remote || ui.busy ? 'disabled' : '';
  const env = info.source === 'env';
  const moveDisabled = disabled || env;
  // 桌面版才有原生选文件夹；网页端 /api/storage/pick-folder 回 501，试过一次就隐藏按钮
  const desktop = info.edition === 'desktop' && !info.remote && !ui.noPick;
  const mode = (value) => (ui.mode === value ? 'checked' : '');

  return `<section class="storage-page${info.remote ? ' readonly' : ''}">
    ${head}
    ${readonlyNote(info)}
    ${ui.restart ? restartCard() : ''}
    <section class="storage-card storage-where">
      <div class="storage-where-head">
        <h2>数据文件夹</h2>${badge(info)}
      </div>
      <p class="storage-path" data-storage-path>${esc(info.dataDir || '（内存数据库，没有文件夹）')}</p>
      <div class="storage-actions">
        <button type="button" class="storage-btn" data-storage="copy" ${info.dataDir ? '' : 'disabled'}>复制路径</button>
        <button type="button" class="storage-btn" data-storage="reveal" ${disabled || !info.dataDir ? 'disabled' : ''}>打开文件夹</button>
        ${info.dbPath ? `<span class="storage-faint">数据库：<code>${esc(info.dbPath)}</code></span>` : ''}
      </div>
      ${sourceNote(info)}
    </section>
    <section class="storage-card">
      <h2>占用</h2>
      ${usage(info)}
    </section>
    ${sharedTip(info)}
    <section class="storage-card">
      <div class="storage-where-head"><h2>备份</h2>
        <span class="storage-faint">每次更换位置前也会自动备份一次</span></div>
      ${backupList(info)}
      <div class="storage-actions">
        <button type="button" class="storage-btn primary" data-storage="backup" ${disabled || !info.dataDir ? 'disabled' : ''}>立即备份</button>
        <button type="button" class="storage-btn" data-storage="reveal-backups" ${disabled || !info.dataDir ? 'disabled' : ''}>打开备份文件夹</button>
      </div>
    </section>
    <section class="storage-card storage-move">
      <h2>更换数据文件夹</h2>
      ${env ? '<p class="storage-note">当前位置由环境变量指定，更换按钮不可用。</p>' : ''}
      <div class="storage-field">
        <label for="storagePathInput">新文件夹的完整路径</label>
        <div class="storage-field-row">
          <input id="storagePathInput" type="text" data-storage-path-input spellcheck="false" autocomplete="off"
            placeholder="例如 D:\\学习资料\\工作台数据" value="${esc(ui.target)}" ${moveDisabled ? 'disabled' : ''}>
          ${desktop ? `<button type="button" class="storage-btn" data-storage="pick" ${moveDisabled ? 'disabled' : ''}>选择文件夹…</button>` : ''}
        </div>
      </div>
      <fieldset class="storage-modes" ${moveDisabled ? 'disabled' : ''}>
        <legend>新文件夹里怎么处理</legend>
        <label><input type="radio" name="storageMode" value="copy" ${mode('copy')}>
          <span>把当前数据复制过去（推荐）<small>数据库和附件都复制一份，新位置可以独立使用。</small></span></label>
        <label><input type="radio" name="storageMode" value="use" ${mode('use')}>
          <span>使用那里已有的数据<small>直接打开那个文件夹里已有的 workbench.db，不复制当前数据。</small></span></label>
      </fieldset>
      <div class="storage-actions">
        <button type="button" class="storage-btn primary" data-storage="relocate" ${moveDisabled ? 'disabled' : ''}>更换数据位置</button>
        <span class="storage-faint">旧文件夹不会被删除</span>
      </div>
      <p class="storage-error" data-storage-error role="status"></p>
    </section>
    <!-- Obsidian 联动（T-W5）：内容由 mountObsidianSection 挂进来 -->
    <section class="storage-card" id="obsidianSection"></section>
  </section>`;
}

function render() {
  if (!panel) return;
  const input = panel.querySelector('[data-storage-path-input]');
  const picked = panel.querySelector('input[name="storageMode"]:checked');
  if (picked) ui.mode = picked.value;
  const hadFocus = Boolean(input && document.activeElement === input);
  panel.innerHTML = markup();
  const next = panel.querySelector('[data-storage-path-input]');
  if (next && next.value !== ui.target) next.value = ui.target;
  // 每次重绘后重新挂载：Obsidian 小节的内容不是本模块渲染的，innerHTML 会把它清掉。
  // 读取中/读取失败时没有这个小节（section 为 null），先不挂。
  const obsidian = panel.querySelector('#obsidianSection');
  if (obsidian) mountObsidianSection(obsidian);
  // 重绘前光标就在路径输入框里：把焦点还回去，别打断正在输入的人。
  if (hadFocus) panel.querySelector('[data-storage-path-input]')?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- 读取

let loadSeq = 0;

async function load() {
  const seq = ++loadSeq;
  ui.error = '';
  try {
    const info = await call('/api/storage');
    if (seq !== loadSeq) return;
    ui.info = info;
  } catch (err) {
    if (seq !== loadSeq) return;
    ui.info = null;
    ui.error = humanError(err);
  }
  render();
}

// ---------------------------------------------------------------- 动作

function setBusy(on) {
  ui.busy = on;
  render();
}

function dialogError(text) {
  const el = document.querySelector('[data-storage-dialog-error]');
  if (el) el.textContent = text;
}

/** 打开确认对话框；只监听带 data-storage-dialog 的按钮，关闭时自动解绑。 */
function openDialog(html, onAction) {
  ctx.modal(html);
  const dialog = document.querySelector('#dialog');
  const body = document.querySelector('#dialogBody');
  const onClick = (event) => {
    const btn = event.target.closest('button[data-storage-dialog]');
    // 提交按钮交给下面的 submit 处理，否则确认会被执行两次
    if (!btn || btn.type === 'submit') return;
    event.preventDefault();
    onAction(btn.dataset.storageDialog, body, btn);
  };
  const onSubmit = (event) => {
    if (!event.target.matches('[data-storage-confirm]')) return;
    event.preventDefault();
    onAction('confirm', body, body.querySelector('[data-storage-dialog="confirm"]'));
  };
  const cleanup = () => {
    dialog.removeEventListener('click', onClick);
    dialog.removeEventListener('submit', onSubmit);
    dialog.removeEventListener('close', cleanup);
  };
  dialog.addEventListener('click', onClick);
  dialog.addEventListener('submit', onSubmit);
  dialog.addEventListener('close', cleanup);
  return { close: () => ctx.closeDialog(), cleanup };
}

async function copyPath() {
  const path = ui.info?.dataDir;
  if (!path) return;
  try {
    await navigator.clipboard.writeText(path);
    ctx.notify('已复制路径');
    return;
  } catch { /* 无剪贴板权限时退回选中文本 */ }
  const el = panel?.querySelector('[data-storage-path]');
  if (el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  ctx.notify('已选中路径，按 Ctrl+C 复制');
}

async function reveal(target) {
  try {
    await call('/api/storage/reveal', { target });
    ctx.notify(target === 'backups' ? '已在资源管理器打开备份文件夹' : '已在资源管理器打开数据文件夹');
  } catch (err) {
    ctx.notify(humanError(err), 'bad');
  }
}

async function backup() {
  if (ui.busy) return;
  setBusy(true);
  try {
    const { name } = await post('/api/storage/backup');
    ctx.notify(`已备份 ${name}`);
    await load();
  } catch (err) {
    ctx.notify(humanError(err), 'bad');
  } finally {
    if (ui.busy) setBusy(false);
  }
}

async function pickFolder() {
  try {
    const result = await post('/api/storage/pick-folder');
    if (result?.cancelled) return;
    if (result?.dataDir) {
      ui.target = result.dataDir;
      render();
      ctx.notify('已选中文件夹，确认后再点「更换数据位置」');
    }
  } catch (err) {
    // 这个版本没有原生选文件夹：隐藏按钮，改用输入框
    if (err?.status === 501) {
      ui.noPick = true;
      render();
      ctx.notify('这个版本不支持选择文件夹，请直接输入路径', 'bad');
      return;
    }
    ctx.notify(humanError(err), 'bad');
  }
}

function askRelocate(target, mode) {
  const info = ui.info;
  const copy = mode === 'copy';
  const html = `<form class="storage-dialog" data-storage-confirm autocomplete="off">
    <h2>更换数据文件夹？</h2>
    <p class="storage-dialog-lead">从</p>
    <p class="storage-dialog-path">${esc(info.dataDir)}</p>
    <p class="storage-dialog-lead">改为</p>
    <p class="storage-dialog-path">${esc(target)}</p>
    <ul class="storage-dialog-list">
      <li><b>旧文件夹不会删除。</b>里面的文件原样留在原处，确认新位置能用之后再自己处理。</li>
      <li><b>需要重启工作台</b>才会改用新文件夹。</li>
      <li><b>重启前先自动备份一次</b>当前资料库，备份放在现在这个数据文件夹的 backups 里。</li>
      <li>${copy
        ? '当前资料库和附件会复制到新文件夹，两端各留一份。'
        : '不会复制当前数据，工作台会直接使用新文件夹里已有的 workbench.db。'}</li>
    </ul>
    <p class="storage-error" data-storage-dialog-error role="status"></p>
    <div class="storage-actions">
      <button type="button" class="storage-btn" data-storage-dialog="cancel">取消</button>
      <button type="submit" class="storage-btn primary" data-storage-dialog="confirm">确认更换</button>
    </div>
  </form>`;
  const opened = openDialog(html, (action, _body, btn) => {
    if (action === 'cancel') { opened.close(); return; }
    if (action === 'confirm') void relocate(target, mode, btn);
  });
}

async function relocate(target, mode, submit) {
  if (ui.busy) return;
  ui.busy = true;
  if (submit) { submit.disabled = true; submit.textContent = '正在备份并更换…'; }
  try {
    // 先备份再迁移：备份失败就停在这里，不写 location.json
    let backupName = '';
    try {
      backupName = (await post('/api/storage/backup'))?.name ?? '';
    } catch (err) {
      if (err?.status === 409) {
        // 这一秒刚备份过：复用最新那份，不拦着用户
        backupName = (await call('/api/storage').catch(() => null))?.backups?.[0]?.name ?? '刚刚生成的备份';
      } else {
        dialogError(`自动备份失败，已取消更换：${humanError(err)}`);
        return;
      }
    }
    const result = await post('/api/storage/relocate', { dataDir: target, mode });
    ui.restart = { dataDir: result?.dataDir ?? target, backup: backupName };
    ui.note = '';
    ui.target = '';
    const input = panel?.querySelector('[data-storage-path-input]');
    if (input) input.value = '';
    ctx.closeDialog();
    ctx.notify('已换到新文件夹，重启后生效');
  } catch (err) {
    dialogError(humanError(err));
  } finally {
    ui.busy = false;
    // 解锁后再重绘：否则按钮会一直带着 disabled，成功的重启卡片也要靠这次重绘出现
    render();
    if (submit) { submit.disabled = false; submit.textContent = '确认更换'; }
  }
}

async function restart() {
  const note = panel?.querySelector('[data-storage-restart-note]');
  const btn = panel?.querySelector('[data-storage="restart"]');
  if (btn) btn.disabled = true;
  try {
    const result = await post('/api/restart');
    ui.note = result?.restarting
      ? '正在重启，稍等几秒后刷新页面。'
      : '这个版本不能自己重启：请关闭并重新运行启动脚本（启动学习工作台.ps1）。';
  } catch (err) {
    ui.note = err?.status === 404
      ? '这个版本不能自己重启：请关闭并重新运行启动脚本（启动学习工作台.ps1）。'
      : `自动重启没有成功（${humanError(err)}）请关闭并重新运行启动脚本（启动学习工作台.ps1）。`;
  }
  if (note) note.textContent = ui.note;
  if (btn) btn.disabled = false;
}

function act(name, btn) {
  switch (name) {
    case 'copy': void copyPath(); break;
    case 'reveal': void reveal('data'); break;
    case 'reveal-backups': void reveal('backups'); break;
    case 'backup': void backup(); break;
    case 'pick': void pickFolder(); break;
    case 'restart': void restart(); break;
    case 'retry': void load(); break;
    case 'relocate': {
      const input = panel.querySelector('[data-storage-path-input]');
      const target = (input?.value ?? '').trim();
      ui.target = target;
      const mode = panel.querySelector('input[name="storageMode"]:checked')?.value ?? 'copy';
      ui.mode = mode;
      const error = panel.querySelector('[data-storage-error]');
      if (!target) {
        if (error) error.textContent = '请先填新文件夹的完整路径，例如 D:\\学习资料\\工作台数据。';
        input?.focus();
        return;
      }
      if (error) error.textContent = '';
      askRelocate(target, mode);
      break;
    }
    default: break;
  }
}

// ---------------------------------------------------------------- 挂载

/** @param {HTMLElement} host #mainContent */
export function showStorage(host, moduleCtx) {
  ctx = moduleCtx;
  // 外壳每次重绘都会调用本函数：页面还在就保持原样，不打断正在输入的内容。
  if (panel && panel.isConnected && host.contains(panel)) return;
  panel = document.createElement('section');
  panel.className = 'storage-page';
  panel.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-storage]');
    if (!btn || btn.disabled) return;
    event.preventDefault();
    act(btn.dataset.storage, btn);
  });
  // 输入框与单选的值由事件维护，重绘时照着 ui 还原
  panel.addEventListener('input', (event) => {
    if (event.target.matches('[data-storage-path-input]')) ui.target = event.target.value;
  });
  panel.addEventListener('change', (event) => {
    if (event.target.matches('input[name="storageMode"]')) ui.mode = event.target.value;
  });
  host.replaceChildren(panel);
  ui.info = null;
  ui.error = '';
  ui.restart = null;
  ui.note = '';
  ui.target = '';
  ui.mode = 'copy';
  ui.noPick = false;
  ui.busy = false;
  render();
  void load();
}

/** 桌面菜单「数据位置…」通过 window.dispatchEvent(new CustomEvent('workbench:open',{detail:'storage'})) 进入。 */
export const STORAGE_PAGE_KEY = 'storage';

// 软件更新：左下角版本号按钮 + 「软件更新」对话框（参考贾维喵管家的更新页）。
// 状态全部来自 GET/POST /api/update（app/lib/updater.js）；检查由服务端定时做，这里只展示和发起操作。
// 检查只显示版本提示点；用户确认后才保存正文并安装。

const esc = (value = '') => String(value).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mb = (bytes) => `${(bytes / 1048576).toFixed(bytes >= 10 * 1048576 ? 0 : 1)} MB`;
const NOTIFIED_KEY = 'workbench.update-notified';
const REFRESH_MS = 15 * 60 * 1000;
const RECOVERY_MS = 60_000;

function releaseNotes(notes) {
  return notes.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const item = /^[-*+]\s+(.+)$/.exec(line);
    const inline = esc(heading?.[1] ?? item?.[1] ?? line)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    if (heading) return `<h4>${inline}</h4>`;
    return `<p>${item ? '• ' : ''}${inline}</p>`;
  }).join('');
}

function clock(seconds) {
  if (!seconds) return '';
  const d = new Date(seconds * 1000);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function statusText(u) {
  const latest = u.latest?.version ? `v${u.latest.version}` : '';
  switch (u.status) {
    case 'checking': return '正在检查更新…';
    case 'latest': return `已是最新版本${latest ? `（发布页最新为 ${latest}）` : ''}`;
    case 'available': return `发现新版本 ${latest}${u.latest?.package ? ` · ${mb(u.latest.package.size)}` : ''}`;
    case 'downloading': {
      const p = u.progress;
      return p?.total ? `正在下载 ${Math.floor((p.received / p.total) * 100)}% · ${mb(p.received)} / ${mb(p.total)}` : '正在下载…';
    }
    case 'ready': return `${latest} 已下载，签名、大小和 SHA-256 校验都通过了`;
    case 'installing': return u.step || '正在准备安装…';
    case 'error': return u.error?.message ?? '检查更新失败';
    default: return '还没有检查过更新';
  }
}

function panelHtml(u, { confirming, message }) {
  const busy = ['checking', 'downloading', 'installing'].includes(u.status);
  const pct = u.progress?.total ? Math.floor((u.progress.received / u.progress.total) * 100) : 0;
  const offered = ['available', 'ready'].includes(u.status);
  const source = u.edition === 'source';
  const available = u.latest && (offered || ['installing', 'downloading'].includes(u.status));
  const date = Date.parse(u.latest?.publishedAt);
  const published = Number.isFinite(date) ? new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'long',
  }).format(date) : '';
  const canDownload = !source && u.status === 'available' && u.latest?.package && u.install.mode;
  const blocked = ['available', 'ready'].includes(u.status) && !u.install.mode && u.install.reason;
  const updated = u.justUpdated;
  const buttons = [];
  if (!busy && !confirming) buttons.push(`<button type="button" data-update="check">${u.checkedAt ? '重新检查' : '检查更新'}</button>`);
  if (offered && source && !confirming) buttons.push(`<button type="button" class="primary" data-update="install" ${u.install.mode !== 'source-git' ? 'disabled' : ''}>立即更新</button>`);
  if (canDownload && !busy) buttons.push('<button type="button" class="primary" data-update="download">立即更新</button>');
  if (u.status === 'ready' && u.install.mode === 'restart' && !confirming) buttons.push('<button type="button" class="primary" data-update="install">安装并重启</button>');
  if (u.status === 'ready' && u.install.mode === 'open') buttons.push('<button type="button" class="primary" data-update="open">打开安装包</button>');
  if (!confirming && offered) buttons.push('<button type="button" data-update="later">稍后提醒（明天）</button>',
    '<button type="button" data-update="skip">跳过此版本</button>');
  return `
    <header class="update-head">
      <img src="/icon.png" alt="">
      <div><h2>软件更新</h2><p>当前版本 v${esc(u.current)} · ${u.edition === 'desktop' ? '桌面版' : '源码运行'}</p></div>
    </header>
    ${updated ? `<p class="update-note ${updated.ok ? '' : 'bad'}">${updated.ok
      ? `已从 v${esc(updated.from)} 更新到 v${esc(updated.to)}。更新前的资料库另存为 ${esc(String(updated.backup ?? '').split(/[\\/]/).pop())}（资料目录的 backups 文件夹里）。`
      : `上次更新到 v${esc(updated.to)} 没有完成。当前版本 v${esc(u.current)}。 ${esc(updated.log)}`}</p>` : ''}
    <p class="update-status ${u.status === 'error' ? 'bad' : ''}" role="status" data-update-status>${esc(message || statusText(u))}</p>
    ${u.status === 'downloading' ? `<div class="update-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>` : ''}
    ${blocked && u.install.reasons?.length ? `<ul class="update-note update-reasons">${u.install.reasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>`
      : blocked ? `<p class="update-note">${esc(u.install.reason)}</p>` : ''}
    ${available ? `<section class="update-notes">
      <h3>v${esc(u.latest.version)} 更新内容</h3>${published ? `<p>发布于 ${esc(published)}</p>` : ''}
      <div>${releaseNotes(u.latest.notes || '')}</div></section>` : ''}
    ${u.reminder && offered ? `<p class="update-note">${u.reminder.action === 'skip' ? '已跳过此版本的提醒。' : '明天会再次提醒。'}</p>` : ''}
    ${confirming ? `<div class="update-confirm">
      <p>安装前会先保存正文、备份资料库。工作台将短暂离线，随后以新版本重新打开。${source ? '' : '旧版本保留在程序文件夹旁边的「.previous」里。'}</p>
      <div class="update-actions"><button type="button" class="primary" data-update="confirm">确认安装</button>
      <button type="button" data-update="cancel">取消</button></div></div>` : ''}
    <div class="update-actions">${buttons.join('')}
      <a href="${esc(u.releasesUrl)}" target="_blank" rel="noopener noreferrer">发布页</a></div>
    <label class="update-auto"><input type="checkbox" data-update="auto" ${u.autoCheck ? 'checked' : ''}>
      自动检查更新<small>启动 1 分钟后、此后每 6 小时检查一次；只提醒，不会自动下载或安装</small></label>
    <p class="update-foot">${u.signed
      ? `更新清单经过签名校验。${source ? '源码更新只允许快进。' : '安装包会核对大小和 SHA-256。'}${u.checkedAt ? `上次检查：${clock(u.checkedAt)}` : ''}`
      : '这个版本没有配置更新签名，只能到发布页手动下载新版。'}</p>`;
}

/**
 * @param {HTMLButtonElement} button 左下角版本号按钮
 * @param {import('../../../architecture/workbench.d.ts').ModuleContext} ctx
 */
export function bindUpdates(button, ctx) {
  let info = null;
  let confirming = false;
  let message = '';
  let poll = null;
  let overlay = null;
  let pending = false;
  let confirmedVersion = null;
  let refreshGeneration = 0;

  const panel = () => document.querySelector('#dialog[open] [data-update-panel]');

  function paint() {
    if (!info) return;
    const has = ['available', 'ready', 'downloading'].includes(info.status) && !info.reminder;
    button.classList.toggle('has-update', has);
    button.querySelector('b').textContent = `v${info.current}`;
    button.title = has ? `有新版本 v${info.latest.version}，点击查看` : '软件更新';
    const host = panel();
    if (host) host.innerHTML = panelHtml(info, { confirming, message });
    if (overlay && pending && info.step) overlay.querySelector('[role="status"]').textContent = info.step;
    const downloading = ['downloading', 'checking'].includes(info.status) || pending;
    if (downloading && !poll) poll = setInterval(refresh, 700);
    if (!downloading && poll) { clearInterval(poll); poll = null; }
  }

  function announce() {
    const seen = ctx.prefs.get(NOTIFIED_KEY);
    const result = info.justUpdated;
    const key = result && `done-${result.to}-${result.ok}`;
    if (result && seen !== key) {
      ctx.prefs.set(NOTIFIED_KEY, key);
      ctx.notify(info.justUpdated.ok ? `已更新到 v${info.justUpdated.to}` : '上次更新没有完成，点左下角版本号查看', info.justUpdated.ok ? '' : 'bad');
    }
  }

  async function waitForVersion(current) {
    const end = Date.now() + RECOVERY_MS;
    while (Date.now() < end) {
      try {
        const health = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
        const result = health.ok ? await health.json() : null;
        if (result?.ok && result.version && result.version !== current) {
          location.reload();
          return;
        }
      } catch { /* 重启期间暂时无法连接 */ }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    pending = false;
    overlay.querySelector('h2').textContent = '工作台未能自动恢复';
    overlay.querySelector('[role="status"]').innerHTML =
      `运行「启动学习工作台.ps1」后刷新页面。如需回到旧版，可在工作区干净时手动运行 <code>git checkout v${esc(current)}</code>。`;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.onclick = () => { overlay.close(); overlay.remove(); overlay = null; };
    overlay.append(close);
    paint();
  }

  async function refresh() {
    const generation = refreshGeneration;
    let update;
    try { update = (await ctx.api.get('/api/update')).update; } catch { return; }
    if (generation !== refreshGeneration) return;
    info = update;
    paint();
    announce();
  }

  async function act(action, extra = {}) {
    message = '';
    try {
      const r = await ctx.api.post('/api/update', { action, ...extra });
      refreshGeneration += 1;
      info = r.update;
      if (r.result?.message) message = r.result.message;
      return r;
    } catch (err) {
      refreshGeneration += 1;
      message = err.message;
      await refresh();
      return null;
    } finally {
      paint();
    }
  }

  async function onClick(event) {
    const target = event.target.closest('[data-update]');
    if (!target || target.disabled || pending || target.dataset.update === 'auto') return;
    const action = target.dataset.update;
    if (action === 'install') { confirmedVersion = info.latest.version; confirming = true; paint(); return; }
    if (action === 'cancel') { confirming = false; paint(); return; }
    target.disabled = true;
    if (action === 'confirm') {
      if (!(await ctx.flushNotes())) {
        message = '还有正文没保存成功，先处理正文再安装。';
        paint();
        return;
      }
      confirming = false;
      if (info.install.mode === 'source-git') {
        const current = info.current;
        overlay = document.createElement('dialog');
        overlay.className = 'update-overlay';
        overlay.setAttribute('aria-labelledby', 'update-overlay-title');
        overlay.innerHTML = '<h2 id="update-overlay-title">正在更新…</h2><p role="status">正在检查更新条件…</p>';
        overlay.addEventListener('cancel', (event) => event.preventDefault());
        document.body.append(overlay);
        overlay.showModal();
        pending = true;
        paint();
        const result = await act('install', { version: confirmedVersion });
        if (result?.result?.restarting) {
          overlay.querySelector('[role="status"]').textContent = '正在重启工作台…';
          await waitForVersion(current);
        } else {
          pending = false;
          overlay.close();
          overlay.remove();
          overlay = null;
          paint();
        }
      } else {
        await act('install');
      }
    } else if (action === 'open') {
      await act('install');
    } else {
      await act(action, ['later', 'skip'].includes(action) ? { version: info.latest.version } : {});
    }
  }

  button.addEventListener('click', () => {
    confirming = false;
    message = '';
    ctx.modal('<section class="update-panel" data-update-panel></section>');
    const host = panel();
    host.addEventListener('click', (event) => { void onClick(event); });
    host.addEventListener('change', (event) => {
      if (event.target.dataset.update === 'auto') void act('settings', { autoCheck: event.target.checked });
    });
    paint();
    void refresh();
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); });
  if (typeof EventSource === 'function') {
    const events = new EventSource('/api/events');
    events.addEventListener('hello', refresh);
    events.addEventListener('update', refresh);
  }
  setInterval(refresh, REFRESH_MS);
  void refresh();
  return { refresh, state: () => info };
}

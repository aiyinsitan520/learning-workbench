// 软件更新：左下角版本号按钮 + 「软件更新」对话框（参考贾维喵管家的更新页）。
// 状态全部来自 GET/POST /api/update（app/lib/updater.js）；检查由服务端定时做，这里只展示和发起操作。
// 只检查、不自动下载；安装要用户确认，确认后先保存正文，再交给桌面版安装并重启。

const esc = (value = '') => String(value).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mb = (bytes) => `${(bytes / 1048576).toFixed(bytes >= 10 * 1048576 ? 0 : 1)} MB`;
const NOTIFIED_KEY = 'workbench.update-notified';
const REFRESH_MS = 15 * 60 * 1000;

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
    case 'installing': return '正在准备安装…';
    case 'error': return u.error?.message ?? '检查更新失败';
    default: return u.edition === 'desktop' ? '还没有检查过更新' : '源码运行：可以查看发布页有没有新版本，更新请用 git pull。';
  }
}

function panelHtml(u, { confirming, message }) {
  const busy = ['checking', 'downloading', 'installing'].includes(u.status);
  const pct = u.progress?.total ? Math.floor((u.progress.received / u.progress.total) * 100) : 0;
  const canDownload = u.status === 'available' && u.latest?.package && u.install.mode;
  const blocked = ['available', 'ready'].includes(u.status) && !u.install.mode && u.install.reason;
  const updated = u.justUpdated;
  const buttons = [];
  if (!busy && !confirming) buttons.push(`<button type="button" data-update="check">${u.checkedAt ? '重新检查' : '检查更新'}</button>`);
  if (canDownload && !busy) buttons.push(`<button type="button" class="primary" data-update="download">下载更新（${mb(u.latest.package.size)}）</button>`);
  if (u.status === 'ready' && u.install.mode === 'restart' && !confirming) buttons.push('<button type="button" class="primary" data-update="install">安装并重启</button>');
  if (u.status === 'ready' && u.install.mode === 'open') buttons.push('<button type="button" class="primary" data-update="open">打开安装包</button>');
  return `
    <header class="update-head">
      <img src="/icon.png" alt="">
      <div><h2>软件更新</h2><p>当前版本 v${esc(u.current)} · ${u.edition === 'desktop' ? '桌面版' : '源码运行'}</p></div>
    </header>
    ${updated ? `<p class="update-note ${updated.ok ? '' : 'bad'}">${updated.ok
      ? `已从 v${esc(updated.from)} 更新到 v${esc(updated.to)}。更新前的资料库另存为 ${esc(String(updated.backup ?? '').split(/[\\/]/).pop())}（资料目录的 backups 文件夹里）。`
      : `上次更新到 v${esc(updated.to)} 没有完成，当前仍是 v${esc(u.current)}，资料没有改动。详情见 ${esc(updated.log)}。`}</p>` : ''}
    <p class="update-status ${u.status === 'error' ? 'bad' : ''}" role="status" data-update-status>${esc(message || statusText(u))}</p>
    ${u.status === 'downloading' ? `<div class="update-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>` : ''}
    ${blocked ? `<p class="update-note">${esc(u.install.reason)}</p>` : ''}
    ${u.latest?.notes && ['available', 'downloading', 'ready'].includes(u.status) ? `<section class="update-notes">
      <h3>v${esc(u.latest.version)} 更新内容</h3><div>${esc(u.latest.notes)}</div></section>` : ''}
    ${confirming ? `<div class="update-confirm">
      <p>安装时工作台会关闭，几秒后自动以新版本重新打开。安装前会先保存正文、备份资料库；旧版本保留在程序文件夹旁边的「.previous」里。</p>
      <div class="update-actions"><button type="button" class="primary" data-update="confirm">确认安装</button>
      <button type="button" data-update="cancel">取消</button></div></div>` : ''}
    <div class="update-actions">${buttons.join('')}
      <a href="${esc(u.releasesUrl)}" target="_blank" rel="noopener noreferrer">发布页</a></div>
    ${u.edition === 'desktop' ? `<label class="update-auto"><input type="checkbox" data-update="auto" ${u.autoCheck ? 'checked' : ''}>
      自动检查更新<small>启动 1 分钟后、此后每 6 小时检查一次；只提醒，不会自动下载或安装</small></label>` : ''}
    <p class="update-foot">${u.signed
      ? `更新只从 GitHub 发布页下载，先核对签名，再核对大小和 SHA-256；检查时不会上传任何资料。${u.checkedAt ? `上次检查：${clock(u.checkedAt)}` : ''}`
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

  const panel = () => document.querySelector('#dialog[open] [data-update-panel]');

  function paint() {
    if (!info) return;
    const has = ['available', 'ready'].includes(info.status);
    button.classList.toggle('has-update', has);
    button.querySelector('b').textContent = `v${info.current}`;
    button.title = has ? `有新版本 v${info.latest.version}，点击查看` : '软件更新';
    const host = panel();
    if (host) host.innerHTML = panelHtml(info, { confirming, message });
    const downloading = info.status === 'downloading' || info.status === 'checking';
    if (downloading && !poll) poll = setInterval(refresh, 700);
    if (!downloading && poll) { clearInterval(poll); poll = null; }
  }

  function announce() {
    const seen = ctx.prefs.get(NOTIFIED_KEY);
    if (info.justUpdated && seen !== `done-${info.justUpdated.to}`) {
      ctx.prefs.set(NOTIFIED_KEY, `done-${info.justUpdated.to}`);
      ctx.notify(info.justUpdated.ok ? `已更新到 v${info.justUpdated.to}` : '上次更新没有完成，点左下角版本号查看', info.justUpdated.ok ? '' : 'bad');
      return;
    }
    if (info.status === 'available' && seen !== info.latest.version) {
      ctx.prefs.set(NOTIFIED_KEY, info.latest.version);
      ctx.notify(`学习工作台 v${info.latest.version} 可以更新了，点左下角版本号查看`);
    }
  }

  async function refresh() {
    try { info = (await ctx.api.get('/api/update')).update; } catch { return; }
    paint();
    announce();
  }

  async function act(action, extra = {}) {
    message = '';
    try {
      const r = await ctx.api.post('/api/update', { action, ...extra });
      info = r.update;
      if (r.result?.message) message = r.result.message;
    } catch (err) {
      message = err.message;
    }
    paint();
  }

  async function onClick(event) {
    const target = event.target.closest('[data-update]');
    if (!target || target.disabled || target.dataset.update === 'auto') return;
    const action = target.dataset.update;
    if (action === 'install') { confirming = true; paint(); return; }
    if (action === 'cancel') { confirming = false; paint(); return; }
    target.disabled = true;
    if (action === 'confirm') {
      if (!(await ctx.flushNotes())) {
        message = '还有正文没保存成功，先处理正文再安装。';
        paint();
        return;
      }
      confirming = false;
      await act('install');
    } else if (action === 'open') {
      await act('install');
    } else {
      await act(action);
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
  setInterval(refresh, REFRESH_MS);
  void refresh();
  return { refresh, state: () => info };
}

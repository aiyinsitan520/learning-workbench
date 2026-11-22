// 番茄钟悬浮小窗：一直浮在其他软件上面的小计时窗。
// 首选 Chrome 的 Document Picture-in-Picture（116+，可放任意 HTML）；不支持时退回
// 「画布 → 视频 → 画中画」。两种做法参考 lazy-guy/tomodoro（MIT，index.js 的 PIP Mode 一节）：
// 复制样式表进小窗、监听关闭事件、视频的播放/暂停映射成继续/暂停。
// 与 tomodoro 不同：这里不把主页面元素搬进小窗（专注页会整页重绘），而是小窗自绘一份，随 tick 刷新。
import { mmss } from './views.js';

/**
 * @param {object} ctx
 * @param {object} ctx.state            应用状态（只读）
 * @param {object} ctx.commands         start / pause / resume / finish / complete(taskId)
 * @param {(id: string) => string} ctx.taskName
 * @param {(open: object) => number|null} ctx.remainingSeconds
 * @param {(msg: string, kind?: string) => void} ctx.notify
 */
export function bindPipTimer({ state, commands, taskName, remainingSeconds, notify }) {
  const docPip = typeof window.documentPictureInPicture?.requestWindow === 'function';
  const videoPip = !docPip && document.pictureInPictureEnabled && 'captureStream' in HTMLCanvasElement.prototype;
  let win = null;        // Document PiP 小窗
  let video = null;      // 退路：视频画中画
  let canvas = null;
  let last = '';         // 上次画的内容，没变就不重画

  const supported = () => docPip || videoPip;
  const isOpen = () => Boolean(win) || Boolean(video && document.pictureInPictureElement === video);

  // ---------------------------------------------------------------- 当前该显示什么
  function snapshot() {
    const open = state.view?.openFocus ?? null;
    const selected = state.selectedTaskId && !state.freeFocus ? state.selectedTaskId : null;
    const taskId = open ? open.taskId : selected;
    const planned = open?.plannedSeconds ?? state.focusPlanned;
    const left = open ? Math.max(0, remainingSeconds(open)) : planned;
    return {
      open,
      taskId,
      title: taskId ? taskName(taskId) : '自由专注',
      left,
      planned,
      progress: open ? Math.min(1, Math.max(0, 1 - left / planned)) : 0,
      status: open ? (open.state === 'running' ? '专注中' : '已暂停') : '准备开始',
    };
  }

  // ---------------------------------------------------------------- Document PiP
  function copyStyles(target) {
    // Chrome 文档推荐的写法：能读到规则就内联，读不到（跨域）就挂 <link>
    for (const sheet of document.styleSheets) {
      try {
        const style = target.document.createElement('style');
        style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
        target.document.head.append(style);
      } catch {
        if (!sheet.href) continue;
        const link = target.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        target.document.head.append(link);
      }
    }
    // 皮肤挂在 <html data-skin>，圆体开关挂在 body.plain-font：小窗里照抄一份
    syncTheme(target);
  }

  function syncTheme(target) {
    const skin = document.documentElement.dataset.skin;
    if (skin) target.document.documentElement.dataset.skin = skin;
    else delete target.document.documentElement.dataset.skin;
    target.document.body.classList.toggle('plain-font', document.body.classList.contains('plain-font'));
  }

  async function openDocPip() {
    win = await window.documentPictureInPicture.requestWindow({ width: 280, height: 176 });
    win.document.title = '专注小窗';
    copyStyles(win);
    win.document.body.className = (win.document.body.className + ' pip-body').trim();
    win.document.body.innerHTML = `<main class="pip" aria-label="番茄钟悬浮小窗">
      <div class="pip-head"><span class="pip-dot"></span><b class="pip-task"></b><small class="pip-status"></small></div>
      <div class="pip-clock" role="timer" aria-live="off"></div>
      <div class="pip-bar"><i></i></div>
      <div class="pip-actions">
        <button type="button" class="pip-btn pip-main" data-pip="toggle"></button>
        <button type="button" class="pip-btn" data-pip="finish">结束</button>
        <button type="button" class="pip-btn" data-pip="done">完成任务</button>
      </div>
    </main>`;
    win.document.addEventListener('click', onPipClick);
    win.addEventListener('pagehide', () => { win = null; last = ''; }, { once: true });
    last = '';
    update();
  }

  function onPipClick(event) {
    const btn = event.target.closest?.('[data-pip]');
    if (!btn) return;
    const { open, taskId } = snapshot();
    switch (btn.dataset.pip) {
      case 'toggle':
        if (!open) void commands.start();
        else if (open.state === 'running') void commands.pause();
        else void commands.resume();
        break;
      case 'finish':
        if (open) void commands.finish();
        break;
      case 'done':
        void completeTask(open, taskId);
        break;
      default:
    }
  }

  /** 「完成任务」：有专注在走就先记下这一轮，再把任务勾掉。 */
  async function completeTask(open, taskId) {
    if (!taskId) { notify('自由专注没有绑定任务，无需勾选完成'); return; }
    if (open) await commands.finish();
    await commands.complete(taskId);
  }

  function drawDocPip(s) {
    const d = win.document;
    syncTheme(win);
    d.querySelector('.pip').dataset.state = s.open ? s.open.state : 'idle';
    d.querySelector('.pip-task').textContent = s.title;
    d.querySelector('.pip-status').textContent = s.status;
    d.querySelector('.pip-clock').textContent = mmss(s.left);
    d.querySelector('.pip-bar i').style.width = `${Math.round(s.progress * 100)}%`;
    const main = d.querySelector('[data-pip="toggle"]');
    main.textContent = !s.open ? `开始 ${Math.round(s.planned / 60)} 分钟` : s.open.state === 'running' ? '暂停' : '继续';
    d.querySelector('[data-pip="finish"]').hidden = !s.open;
    d.querySelector('[data-pip="done"]').hidden = !s.taskId;
  }

  // ---------------------------------------------------------------- 退路：画布 → 视频画中画
  async function openVideoPip() {
    if (!video) {
      canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 270;
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = canvas.captureStream();
      // 画中画窗口自带的播放/暂停按钮 = 继续/暂停计时（tomodoro 的做法）
      video.addEventListener('pause', () => { if (state.view?.openFocus?.state === 'running') void commands.pause(); });
      video.addEventListener('play', () => { if (state.view?.openFocus?.state === 'paused') void commands.resume(); });
      video.addEventListener('leavepictureinpicture', () => { last = ''; });
    }
    last = '';
    update();
    await video.play();
    await video.requestPictureInPicture();
  }

  function drawVideoPip(s) {
    const css = getComputedStyle(document.documentElement);
    const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    ctx.fillStyle = v('--surface', 'white');
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = v('--muted', 'gray');
    ctx.font = '600 22px system-ui, sans-serif';
    ctx.fillText(`${s.status} · ${s.title}`.slice(0, 26), 28, 48);
    ctx.fillStyle = v('--ink', 'black');
    ctx.font = '600 110px system-ui, sans-serif';
    ctx.fillText(mmss(s.left), 28, 170);
    ctx.fillStyle = v('--track', 'lightgray');
    ctx.fillRect(28, 214, w - 56, 12);
    ctx.fillStyle = v('--accent', 'green');
    ctx.fillRect(28, 214, (w - 56) * s.progress, 12);
  }

  // ---------------------------------------------------------------- 对外
  function update() {
    if (!isOpen() && !(video && canvas)) return;
    const s = snapshot();
    const key = JSON.stringify([s.title, s.status, mmss(s.left), Math.round(s.progress * 100), s.taskId,
      document.documentElement.dataset.skin ?? '', s.open?.state ?? '', s.planned]);
    if (key === last) return;
    last = key;
    if (win) drawDocPip(s);
    else if (canvas) drawVideoPip(s);
  }

  async function toggle() {
    if (win) { win.close(); win = null; return; }
    if (video && document.pictureInPictureElement === video) { await document.exitPictureInPicture(); return; }
    if (!supported()) { notify('这个浏览器不支持悬浮小窗，请用新版 Chrome 或 Edge', 'bad'); return; }
    try {
      if (docPip) await openDocPip();
      else await openVideoPip();
    } catch (err) {
      win = null;
      notify(`悬浮小窗没有打开：${err?.message ?? err}`, 'bad');
    }
  }

  return { toggle, update, isOpen, supported };
}

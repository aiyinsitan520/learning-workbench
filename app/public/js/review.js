import { yesterdayReview, generateReview } from './review-data.js';
import { esc } from './icons.js';

const cacheName = 'workbench.yesterday.summary';
let tabKey = '';
let midnightTimer;
const cat = new Image();
cat.src = '/desk.png';

function localText(f) {
  const parts = [];
  if (f.completed.length) parts.push('完成了' + f.completed.slice(0, 3).map(t => '「' + t + '」').join('、') + (f.completed.length > 3 ? '等 ' + f.completed.length + ' 项任务。' : '。'));
  if (f.focus.length) parts.push('专注时间最多的是「' + f.focus[0].title + '」，累计 ' + duration(f.focus[0].seconds) + '。');
  if (f.noteTitle || f.noteBlocks) parts.push('留下了一篇学习手记' + (f.noteTitle ? '《' + f.noteTitle + '》' : '') + '。');
  if (!parts.length && f.scheduled) parts.push('昨日安排了 ' + f.scheduled + ' 个时间块，暂未记录任务完成或专注用时。');
  return parts.join('') || '昨天没有留下学习记录。之后完成的任务、专注和手记，会出现在对应日期的回顾里。';
}

function duration(seconds) {
  return seconds > 0 && seconds < 60 ? seconds + ' 秒' : Math.round(seconds / 60) + ' 分钟';
}

// 页面预览与 PNG 共享排版；根据当前画布宽度逐字换行。
function paint(canvas, width, facts, summary, ai) {
  const ctx = canvas.getContext('2d');
  const pad = width < 450 ? 20 : 35;
  const font = '"Microsoft YaHei","PingFang SC",sans-serif';
  const size = width < 450 ? 15 : 17;
  const lines = [];
  ctx.font = size + 'px ' + font;
  for (const paragraph of summary.split(/\r?\n/)) {
    let line = '';
    for (const c of paragraph) {
      if (line && ctx.measureText(line + c).width > width - 2 * pad) { lines.push(line); line = ''; }
      line += c;
    }
    lines.push(line);
  }
  const height = 258 + lines.length * 28 + pad;
  canvas.width = width * 2;
  canvas.height = height * 2;
  ctx.scale(2, 2);
  ctx.fillStyle = '#faf8ef';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#dfebe0';
  ctx.fillRect(0, 0, width, 133);
  const draw = (value, x, y, style, color) => {
    ctx.font = style + ' ' + font;
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  };
  const art = Math.min(width * .32, 190);
  if (cat.naturalWidth) ctx.drawImage(cat, width - art - 8, 66 - art * cat.naturalHeight / cat.naturalWidth / 2, art, art * cat.naturalHeight / cat.naturalWidth);
  draw(facts.day.replaceAll('-', ' / '), pad, 39, '14px', '#496b5d');
  draw('昨日学习手记', pad, 91, width < 450 ? 'bold 27px' : 'bold 36px', '#254739');
  const col = (width - 2 * pad) / 3;
  const metrics = [[facts.completed.length,'完成任务'],[duration(facts.seconds),'实际专注'],[facts.sessions,'专注次数']];
  metrics.forEach(([value,label], i) => {
    draw(String(value), pad + col*i, 174, 'bold ' + (width < 450 ? '18px' : '24px'), '#304c3e');
    draw(label, pad + col*i, 196, '13px', '#5a6e60');
  });
  ctx.fillStyle = '#cbd7c8';
  ctx.fillRect(pad, 214, width - pad*2, 1);
  draw(ai ? '贾维斯喵 · AI 回顾' : '贾维斯喵 · 本地回顾', pad, 243, 'bold 14px', '#547863');
  lines.forEach((line,i) => draw(line, pad, 274 + i*28, size + 'px', '#30463b'));
  canvas.setAttribute('aria-label', facts.day + '。完成 ' + facts.completed.length + ' 项，专注 ' + duration(facts.seconds) + '。' + summary);
}

export async function showYesterday(host) {
  if (host.querySelector('.review-page')) return;
  clearTimeout(midnightTimer);
  const panel = document.createElement('section');
  panel.className = 'review-page';
  host.replaceChildren(panel);
  panel.innerHTML = '<h1>昨日总结</h1><p role="status">正在读取昨日记录…</p>';
  const reload = () => { if (panel.isConnected) { panel.remove(); void showYesterday(host); } };
  let data;
  try {
    data = await yesterdayReview();
  } catch {
    panel.innerHTML = '<h1>昨日总结</h1><p>昨日记录读取失败。</p><button class="light">重新读取</button>';
    panel.querySelector('button').onclick = reload;
    return;
  }
  if (!panel.isConnected) return;
  const {facts:f, version} = data;
  midnightTimer = setTimeout(reload, Math.max(1000, data.expiresAt*1000 - Date.now() + 300));
  let summary = localText(f);
  let ai = false;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheName));
    if (cached?.version === version && typeof cached.text === 'string' && cached.text) { summary = cached.text; ai = true; }
  } catch { /* 浏览器可禁用本地缓存。 */ }
  const hasFacts = Boolean(f.sessions || f.completed.length || f.scheduled || f.noteTitle || f.noteBlocks);
  panel.innerHTML = `<div class="review-head"><h1>昨日总结</h1><button class="light" data-export>保存图片</button></div>
    <canvas role="img"></canvas>
    <details class="review-records"><summary>查看昨日记录</summary>
      <p>完成 ${f.completed.length} 项 · 安排 ${f.scheduled} 个时间块 · 手记 ${f.noteBlocks} 个内容块</p>
      ${f.completed.length ? '<h3>已完成</h3><ul>' + f.completed.map(t => '<li>'+esc(t)+'</li>').join('') + '</ul>' : ''}
      ${f.focus.length ? '<h3>专注用时</h3><ul>' + f.focus.map(t => '<li>'+esc(t.title)+' · '+duration(t.seconds)+'</li>').join('') + '</ul>' : ''}
      ${f.noteTitle ? '<p>手记 · '+esc(f.noteTitle)+'</p>' : ''}
    </details>
    <details class="review-ai"><summary>用 AI 写回顾</summary>
      <form><label>DeepSeek API Key<input type="password" autocomplete="off" required maxlength="1024" placeholder="输入本次使用的 Key"></label>
      <p>点击生成会将昨日日期、完成任务名、专注名称与用时、排期数量及手记标题和块数发给 DeepSeek。两份名称列表各取前 30 条。Key 仅在当前页面会话中使用。</p>
      <button class="primary" ${hasFacts ? '' : 'disabled'}>${hasFacts ? '生成 AI 总结' : '昨日暂无记录'}</button></form>
    </details><p class="review-status" role="status"></p>`;
  const canvas = panel.querySelector('canvas');
  const redraw = () => paint(canvas, Math.max(250, Math.floor(panel.clientWidth)), f, summary, ai);
  redraw();
  cat.decode().then(() => { if (panel.isConnected) redraw(); }).catch(() => {});
  const resize = new ResizeObserver(() => {
    if (!panel.isConnected) { resize.disconnect(); return; }
    if (Math.floor(panel.clientWidth)*2 !== canvas.width) redraw();
  });
  resize.observe(panel);
  panel.querySelector('[data-export]').onclick = () => {
    const output = document.createElement('canvas');
    paint(output, 760, f, summary, ai);
    output.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = f.day + '-昨日总结.png'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  };
  const input = panel.querySelector('input');
  input.value = tabKey;
  input.oninput = () => { tabKey = input.value.trim(); };
  const status = panel.querySelector('[role="status"]');
  panel.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    if (button.disabled || !input.value.trim()) return;
    button.disabled = true;
    status.textContent = '贾维斯喵正在整理昨日记录…';
    try {
      const text = await generateReview(f, input.value.trim());
      if (!panel.isConnected) return;
      summary = text;
      ai = true;
      try { localStorage.setItem(cacheName, JSON.stringify({version, text:summary})); } catch { /* 仍可导出。 */ }
      redraw();
      status.textContent = 'AI 回顾已生成。';
    } catch (err) { status.textContent = err.name === 'TimeoutError' ? '请求超时，请稍后重试。'
      : err instanceof TypeError ? '暂时无法连接 DeepSeek，请检查网络后重试。' : err.message; }
    finally { button.disabled = false; }
  };
}

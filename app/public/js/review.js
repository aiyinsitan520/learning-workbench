// 「每日维护」看板复用的排版工具：本地摘要文字与 PNG 画布。
// 2026-11-21 v2 起，「昨日总结」页由 board.js 的每日维护看板取代（页面 key 仍是 'review'），
// 这里只保留与页面无关的纯函数：localText 生成不依赖模型的摘要，paint 画预览图与导出图。
// 两者都不读全局状态，参数决定一切，所以看板可以对任意一天复用。

const cat = new Image();
cat.src = '/desk.png';

/** 本地摘要：每日维护看板与（旧的）昨日总结共用。when 是日期称谓（默认「昨天」）。 */
export function localText(f, { when = '昨天' } = {}) {
  const parts = [];
  if (f.completed.length) parts.push('完成了' + f.completed.slice(0, 3).map(t => '「' + t + '」').join('、') + (f.completed.length > 3 ? '等 ' + f.completed.length + ' 项任务。' : '。'));
  if (f.focus.length) parts.push('专注时间最多的是「' + f.focus[0].title + '」，累计 ' + duration(f.focus[0].seconds) + '。');
  if (f.noteTitle || f.noteBlocks) parts.push('留下了一篇学习手记' + (f.noteTitle ? '《' + f.noteTitle + '》' : '') + '。');
  if (!parts.length && f.scheduled) parts.push(when + '安排了 ' + f.scheduled + ' 个时间块，暂未记录任务完成或专注用时。');
  return parts.join('') || when + '没有留下学习记录。之后完成的任务、专注和手记，会出现在对应日期的回顾里。';
}

export function duration(seconds) {
  return seconds > 0 && seconds < 60 ? seconds + ' 秒' : Math.round(seconds / 60) + ' 分钟';
}

/**
 * 页面预览与 PNG 共享排版；根据当前画布宽度逐字换行。
 * options.title 换大标题（看板用「每日维护」），options.aiLabel 换落款那一行。
 */
export function paint(canvas, width, facts, summary, ai, options = {}) {
  const { title = '昨日学习手记', aiLabel } = options;
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
  draw(title, pad, 91, width < 450 ? 'bold 27px' : 'bold 36px', '#254739');
  const col = (width - 2 * pad) / 3;
  const metrics = [[facts.completed.length,'完成任务'],[duration(facts.seconds),'实际专注'],[facts.sessions,'专注次数']];
  metrics.forEach(([value,label], i) => {
    draw(String(value), pad + col*i, 174, 'bold ' + (width < 450 ? '18px' : '24px'), '#304c3e');
    draw(label, pad + col*i, 196, '13px', '#5a6e60');
  });
  ctx.fillStyle = '#cbd7c8';
  ctx.fillRect(pad, 214, width - pad*2, 1);
  draw(aiLabel ?? (ai ? '贾维斯喵 · AI 回顾' : '贾维斯喵 · 本地回顾'), pad, 243, 'bold 14px', '#547863');
  lines.forEach((line,i) => draw(line, pad, 274 + i*28, size + 'px', '#30463b'));
  canvas.setAttribute('aria-label', facts.day + '。完成 ' + facts.completed.length + ' 项，专注 ' + duration(facts.seconds) + '。' + summary);
}

const minutes = (seconds) => Math.round(seconds / 60);
const inline = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
  .replace(/[\\`*_{}\[\]<>|]/g, '\\$&');

function progress(log) {
  return [log.progress == null ? '' : `进度 ${log.progress}%`, inline(log.note)].filter(Boolean).join(' · ') || '无内容';
}

function projectStatus(project) {
  if (project.archivedAt != null) return '已归档';
  return project.completedAt != null ? '已完成' : '进行中';
}

function appendDay(lines, digest) {
  const { completed, focus, plan, projects } = digest;
  lines.push(`## ${digest.day} ${digest.weekday}`, '',
    `- 完成（${completed.length} 项）：${completed.map((task) => inline(task.title)).join('、') || '无'}`,
    `- 专注合计：${minutes(focus.seconds)} 分钟，${focus.sessions} 轮`);
  for (const task of focus.byTask) {
    lines.push(`  - ${inline(task.title)} · ${minutes(task.seconds)} 分钟 · ${task.sessions} 轮`);
  }
  const rate = plan.followRate == null ? '无计划' : Math.round(plan.followRate * 100) + '%';
  lines.push(`- 计划：${minutes(plan.plannedSeconds)} 分钟 · 计划内专注 ${minutes(plan.focusedOnPlannedSeconds)} 分钟 · 执行率 ${rate}`, '');
  if (plan.blocks.length) {
    lines.push('| 时间 | 标题 | 计划分钟 | 任务状态 | 当日专注分钟 |', '| --- | --- | ---: | --- | ---: |');
    for (const block of plan.blocks) {
      lines.push(`| ${block.start} | ${inline(block.title)} | ${block.minutes} | ${block.taskDone ? '已完成' : '未完成'} | ${minutes(block.focusSeconds)} |`);
    }
    lines.push('');
  }
  for (const project of projects) {
    const target = project.dailyMinutes == null ? '' : ` / 目标 ${project.dailyMinutes} 分钟`;
    const due = project.daysLeft == null ? '' : project.daysLeft < 0 ? ` · 逾期 ${-project.daysLeft} 天` : ` · 距截止 ${project.daysLeft} 天`;
    lines.push(`- 项目进展：${inline(project.title)} · 第 ${project.dayIndex} 天${due} · 专注 ${minutes(project.focusSecondsOnDay)} 分钟${target}${project.log ? ' · ' + progress(project.log) : ''}`);
  }
  if (projects.length) lines.push('');
}

/** @param {ReturnType<typeof import('./digest.js').contextSnapshot>} snapshot */
export function contextMarkdown(snapshot) {
  const { range, timeZone, guide, pendingTasks, projects, days, taskNotes, harvests } = snapshot;
  const lines = ['# 学习工作台数据快照', '', `${range.from} 至 ${range.to} · ${timeZone}`, '',
    '> 日期和 HH:MM 使用工作台时区。本文所有时长均取整为分钟。', ...Object.entries(guide)
      .filter(([field]) => field !== 'time').map(([, description]) => '> ' + description), '', '## 待办', ''];
  for (const task of pendingTasks) {
    const project = projects.find((item) => item.id === task.projectId);
    const details = [inline(task.course), project && inline(project.title)].filter(Boolean).join(' · ');
    lines.push(`- ${inline(task.title)}${details ? ' · ' + details : ''}`);
  }
  if (!pendingTasks.length) lines.push('无待办。');
  lines.push('', '## 长期项目', '');
  if (!projects.length) lines.push('无长期项目。', '');
  for (const project of projects) {
    lines.push(`### ${inline(project.title)}`, '',
      `- ${projectStatus(project)} · ${project.startDay} 开始 · ${project.dueDay ? project.dueDay + ' 截止' : '无截止'}`);
    if (project.goal) lines.push('- 目标：' + inline(project.goal));
    if (project.dailyMinutes != null) lines.push(`- 每日目标：${project.dailyMinutes} 分钟`);
    for (const log of project.logs) lines.push(`- ${log.day}：${progress(log)}`);
    lines.push('');
  }

  let blank = [];
  const flush = () => {
    if (!blank.length) return;
    const dates = blank.length === 1 ? blank[0] : `${blank[0]} 至 ${blank.at(-1)}`;
    lines.push(`- ${dates} · ${blank.length} 天无记录`, '');
    blank = [];
  };
  for (const day of days) {
    if (day.isEmpty && !day.projects.some((project) => project.log)) {
      blank.push(day.day);
      continue;
    }
    flush();
    appendDay(lines, day);
  }
  flush();

  if (harvests?.length) {
    lines.push('## 收获', '');
    for (const card of harvests) {
      lines.push(`### ${card.day} · ${inline(card.title)}`, '',
        `- 结论：${inline(card.conclusion) || '无'}`,
        `- 要点：${card.points.length ? '' : '无'}`);
      for (const point of card.points) lines.push(`  - ${inline(point)}`);
      lines.push(`- 待办：${card.todos.length ? '' : '无'}`);
      for (const todo of card.todos) lines.push(`  - ${inline(todo)}`);
      lines.push(`- 标签：${card.tags.map((tag) => '#' + inline(tag)).join(' ') || '无'}`, '');
    }
  }

  if (taskNotes) {
    lines.push('## 任务正文', '');
    if (!taskNotes.length) lines.push('无已保存的正文。', '');
    for (const note of taskNotes) {
      lines.push(`### ${inline(note.title)}`, '', note.body.trim(), '');
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

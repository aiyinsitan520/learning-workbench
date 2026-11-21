// 占位：把 contextSnapshot() 的结果排成 Markdown，由工单 T3（Codex）完善。
/** @param {ReturnType<typeof import('./digest.js').contextSnapshot>} snapshot */
export function contextMarkdown(snapshot) {
  return `# 学习工作台数据快照\n\n> 占位输出，完整格式待实现。\n\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\`\n`;
}

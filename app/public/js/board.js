// 每日维护看板（顶栏「维护」，快捷键 5）。占位实现：先沿用旧的昨日总结，工单 T4（DSH）重写。
// 约定：数据只从 ctx.api.get('/api/review?day=…') 取（DayDigest），写操作走 ctx.api.command / ctx.api.post；
// 按钮用 data-board-* 属性并在本模块内自己监听，不要用 data-page / data-task / data-day 等外壳已占用的属性。
import { showYesterday } from './review.js';

/**
 * @param {HTMLElement} host  #mainContent
 * @param {import('../../../architecture/workbench').ModuleContext} ctx
 */
export function showBoard(host, ctx) { // eslint-disable-line no-unused-vars
  void showYesterday(host);
}

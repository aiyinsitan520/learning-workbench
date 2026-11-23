// 收获速记（顶栏「收获」，快捷键 6；全局 Ctrl/⌘+Shift+V 打开粘贴框）。
// 占位实现：T-H1 只定接口和最小可用流程，完整页面由工单 T-H2 实现（见 NEXT_TASKS.md）。
// 契约见 architecture/workbench.d.ts 的 v4 一节；解析用 ./harvest-format.js，不要另写一份。
import { newId } from './api.js';
import { esc } from './icons.js';
import { parseHarvest } from './harvest-format.js';

/** @param {HTMLElement} host #mainContent  @param {import('../../../architecture/workbench').ModuleContext} ctx */
export function showHarvest(host, ctx) {
  host.innerHTML = `<div class="topline"><h1>收获</h1></div>
    <section class="harvest-page"><p>按 Ctrl+Shift+V 粘贴对话精华。</p>
    <button type="button" class="primary" data-harvest-open>粘贴收获</button><div data-harvest-list></div></section>`;
  host.querySelector('[data-harvest-open]').addEventListener('click', () => openHarvestCapture(ctx));
  void ctx.api.get('/api/harvests').then((r) => {
    const list = host.querySelector('[data-harvest-list]');
    if (list) list.innerHTML = r.harvests.map((h) => `<article class="harvest-card"><h3>${esc(h.title)}</h3><p>${esc(h.conclusion)}</p></article>`).join('');
  }).catch(() => {});
}

/** 打开粘贴框；text 可预填。 */
export function openHarvestCapture(ctx, text = '') {
  ctx.modal(`<h2>收获速记</h2><textarea data-harvest-text rows="10" aria-label="粘贴内容">${esc(text)}</textarea>
    <p data-harvest-msg></p><button type="button" class="primary" data-harvest-save>提炼并保存</button>`);
  const box = document.querySelector('[data-harvest-text]');
  box?.focus();
  document.querySelector('[data-harvest-save]')?.addEventListener('click', async () => {
    const raw = box.value;
    const local = parseHarvest(raw);
    const msg = document.querySelector('[data-harvest-msg]');
    try {
      const draft = local.ok ? local.draft : (await ctx.api.post('/api/ai/distill', { text: raw })).draft;
      await ctx.api.command({ type: 'createHarvest', id: newId('harvest'), ...draft, source: local.ok ? 'chatgpt' : 'ai' });
      ctx.closeDialog();
      ctx.notify('已存入收获');
      if (ctx.state.page === 'harvest') ctx.gotoPage('harvest');
    } catch (err) {
      if (msg) msg.textContent = err?.message ?? String(err);
    }
  });
}

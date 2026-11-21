// 模型接入页（顶栏齿轮按钮进入）。占位实现，工单 T2（Codex）重写成 CC Switch 式的供应商管理。
// 约定：只调用 /api/ai/* 接口（见 workbench.d.ts 的「AI」一节）；页面上永远看不到完整 API Key。
// 按钮用 data-ai-* 属性并在本模块内自己监听。

/**
 * @param {HTMLElement} host  #mainContent
 * @param {import('../../../architecture/workbench').ModuleContext} ctx
 */
export function showAiSettings(host, ctx) { // eslint-disable-line no-unused-vars
  if (host.querySelector('.ai-page')) return;
  host.innerHTML = `<section class="ai-page"><div class="topline"><h1>模型接入</h1></div>
    <p class="empty">模型接入功能正在开发中。</p></section>`;
}

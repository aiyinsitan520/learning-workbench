// 顶栏分组工具条：选中项共用一块滑动底板（参考素材 shell-001 / navigation-001）。
import { $, prefersReducedMotion } from './dom.js';
import { renderTools } from './views.js';

export function bindToolbar() {
  const bar = $('#tools');
  bar.innerHTML = renderTools();
  const pill = bar.querySelector('.toolbar-pill');
  let placed = false;

  function place(button, animate) {
    if (!button || !button.offsetWidth) { pill.style.opacity = '0'; return; }
    pill.style.transition = animate && placed && !prefersReducedMotion() ? '' : 'none';
    pill.style.opacity = '1';
    pill.style.width = `${button.offsetWidth}px`;
    pill.style.transform = `translateX(${button.offsetLeft}px)`;
    placed = true;
  }

  function select(page, { animate = true } = {}) {
    let current;
    for (const button of bar.querySelectorAll('.tool')) {
      const on = button.dataset.page === page;
      button.classList.toggle('selected', on);
      button.setAttribute('aria-pressed', String(on));
      if (on) current = button;
    }
    place(current, animate);
  }

  // 字体切换或窗口变化会改变按钮宽度，底板跟着对齐，不做动画。
  new ResizeObserver(() => place(bar.querySelector('.tool.selected'), false)).observe(bar);
  return { select };
}

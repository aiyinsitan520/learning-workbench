// 右键菜单（T-W7）：只在注册过的元素上拦截浏览器菜单，其余地方保持原生菜单。
// 用法：registerContextMenu(selector, build)。build(target, event) 返回菜单项数组或 null（null = 不拦截）。
// 菜单项：{ label, icon?, shortcut?, danger?, disabled?, children?, run }，'-' 表示分隔线。
// 打开方式：鼠标右键、触屏长按 500ms、聚焦元素上按 Shift+F10 或 ContextMenu 键。
// 键盘：↑↓ 移动、Enter/空格执行、→ 打开子菜单、← 收回子菜单、Esc 关闭；点外面、滚动、窗口失焦、改窗口大小都会关闭。
import { esc } from './icons.js';

const registry = [];
/** 输入框、文本框、正文编辑区：保留浏览器原生菜单（复制粘贴、拼写检查）。 */
const NATIVE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const LONG_PRESS = 500;
const MARGIN = 4;

let menus = [];          // 当前打开的菜单层：[根菜单, 子菜单?]
let opener = null;       // 打开菜单前的焦点，关闭后还给它
let openedAt = 0;
let bound = false;

/**
 * @param {string} selector  命中的最近祖先元素（closest）作为 target 传给 build
 * @param {(target: Element, event: Event) => Array<object|string>|null} build
 */
export function registerContextMenu(selector, build) {
  registry.push({ selector, build });
  bind();
}

export const isContextMenuOpen = () => menus.length > 0;

function match(el) {
  if (!(el instanceof Element) || el.closest(NATIVE)) return null;
  // 后注册的更具体（例如时间块注册在时间轴之后），优先
  for (let i = registry.length - 1; i >= 0; i -= 1) {
    const target = el.closest(registry[i].selector);
    if (target) return { target, build: registry[i].build };
  }
  return null;
}

/** 按命中元素生成菜单并打开；没有可显示的项时返回 false，让浏览器菜单照常出现。 */
function openFor(el, event, point) {
  const hit = match(el);
  if (!hit) return false;
  let items;
  try { items = hit.build(hit.target, event); } catch (err) { console.error(err); return false; }
  items = tidy(items);
  if (!items.length) return false;
  closeMenu({ restore: false });
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  openedAt = Date.now();
  const at = point ?? anchorOf(hit.target);
  menus = [renderMenu(items, at, 0)];
  focusItem(menus[0], 0);
  return true;
}

/** 去掉 null、首尾和连续的分隔线。 */
function tidy(items) {
  const out = [];
  for (const item of items ?? []) {
    if (!item) continue;
    if (item === '-') { if (out.length && out[out.length - 1] !== '-') out.push(item); continue; }
    out.push(item);
  }
  while (out[out.length - 1] === '-') out.pop();
  return out;
}

function anchorOf(target) {
  const r = target.getBoundingClientRect();
  return { x: r.left + Math.min(24, r.width / 2), y: r.top + Math.min(r.height, 28) };
}

function renderMenu(items, at, depth, parentRow = null) {
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.setAttribute('role', 'menu');
  el.tabIndex = -1;
  el.dataset.depth = String(depth);
  el.innerHTML = items.map((item, index) => {
    if (item === '-') return '<div class="ctx-sep" role="separator"></div>';
    const sub = Array.isArray(item.children) && item.children.length;
    return `<button type="button" role="menuitem" class="ctx-item${item.danger ? ' danger' : ''}"
      data-ctx-index="${index}"${item.disabled ? ' aria-disabled="true"' : ''}${sub ? ' aria-haspopup="menu" aria-expanded="false"' : ''}>
      <span class="ctx-icon" aria-hidden="true">${item.icon ? esc(item.icon) : ''}</span>
      <span class="ctx-label">${esc(item.label)}</span>
      ${item.shortcut ? `<kbd class="ctx-key">${esc(item.shortcut)}</kbd>` : ''}
      ${sub ? '<span class="ctx-arrow" aria-hidden="true">›</span>' : ''}
    </button>`;
  }).join('');
  el.ctxItems = items;
  el.ctxParentRow = parentRow;
  document.body.append(el);
  place(el, at, parentRow);
  return el;
}

/** 贴边自动翻转：右边放不下往左开，下边放不下往上开；仍放不下就贴住视口边。 */
function place(el, at, parentRow) {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const { width, height } = el.getBoundingClientRect();
  let x;
  let y;
  if (parentRow) {
    const r = parentRow.getBoundingClientRect();
    x = r.right + width + MARGIN <= vw ? r.right - 2 : r.left - width + 2;
    y = r.top - 5;
  } else {
    x = at.x + width + MARGIN <= vw ? at.x : at.x - width;
    y = at.y + height + MARGIN <= vh ? at.y : at.y - height;
  }
  x = Math.max(MARGIN, Math.min(x, vw - width - MARGIN));
  y = Math.max(MARGIN, Math.min(y, vh - height - MARGIN));
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
}

const rows = (menu) => [...menu.querySelectorAll('.ctx-item')];
const enabledRows = (menu) => rows(menu).filter((row) => row.getAttribute('aria-disabled') !== 'true');

function focusItem(menu, index) {
  const list = enabledRows(menu);
  if (!list.length) { menu.focus(); return; }
  list[(index + list.length) % list.length].focus();
}

function itemOf(row) {
  const menu = row.closest('.ctx-menu');
  return menu?.ctxItems?.[Number(row.dataset.ctxIndex)];
}

function openSub(row) {
  const item = itemOf(row);
  if (!item?.children?.length || row.getAttribute('aria-disabled') === 'true') return false;
  const depth = Number(row.closest('.ctx-menu').dataset.depth);
  closeFrom(depth + 1);
  row.setAttribute('aria-expanded', 'true');
  menus.push(renderMenu(tidy(item.children), null, depth + 1, row));
  return true;
}

function closeFrom(depth) {
  while (menus.length > depth) {
    const menu = menus.pop();
    menu.ctxParentRow?.setAttribute('aria-expanded', 'false');
    menu.remove();
  }
}

/** restore：键盘或 Esc 关闭时把焦点还给打开前的元素。 */
export function closeMenu({ restore = true } = {}) {
  if (!menus.length) return;
  closeFrom(0);
  const back = opener;
  opener = null;
  if (restore && back?.isConnected) back.focus({ preventScroll: true });
}

function activate(row) {
  if (!row || row.getAttribute('aria-disabled') === 'true') return;
  const item = itemOf(row);
  if (!item) return;
  if (item.children?.length) { openSub(row); focusItem(menus[menus.length - 1], 0); return; }
  closeMenu();
  try {
    const result = item.run?.();
    if (result && typeof result.catch === 'function') result.catch((err) => console.error(err));
  } catch (err) {
    console.error(err);
  }
}

function onKey(event) {
  // 聚焦元素上 Shift+F10 / ContextMenu 键打开
  if (!menus.length) {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const el = document.activeElement;
      if (el && el !== document.body && openFor(el, event, null)) event.preventDefault();
    }
    return;
  }
  const row = document.activeElement?.closest?.('.ctx-item');
  const menu = row?.closest('.ctx-menu') ?? menus[menus.length - 1];
  const list = enabledRows(menu);
  const index = list.indexOf(row);
  const keys = {
    ArrowDown: () => focusItem(menu, index + 1),
    ArrowUp: () => focusItem(menu, index < 0 ? -1 : index - 1),
    Home: () => focusItem(menu, 0),
    End: () => focusItem(menu, -1),
    ArrowRight: () => { if (row && openSub(row)) focusItem(menus[menus.length - 1], 0); },
    ArrowLeft: () => {
      const depth = Number(menu.dataset.depth);
      if (depth > 0) { const parent = menu.ctxParentRow; closeFrom(depth); parent?.focus(); }
    },
    Escape: () => {
      const depth = Number(menu.dataset.depth);
      if (depth > 0) { const parent = menu.ctxParentRow; closeFrom(depth); parent?.focus(); } else closeMenu();
    },
    Enter: () => activate(row),
    ' ': () => activate(row),
    Tab: () => closeMenu(),
    ContextMenu: () => closeMenu(),
  };
  const handler = keys[event.key];
  if (!handler) return;
  event.preventDefault();
  event.stopPropagation(); // 菜单开着时，Esc 等键不再交给页面（例如别取消拖动、别关对话框）
  handler();
}

let press = null;

function bind() {
  if (bound) return;
  bound = true;
  document.addEventListener('contextmenu', (event) => {
    // 长按或键盘刚打开过菜单，紧随其后的原生 contextmenu 只需吞掉
    if (menus.length && Date.now() - openedAt < 700) { event.preventDefault(); return; }
    const keyboard = event.button !== 2 && event.clientX === 0 && event.clientY === 0;
    const point = keyboard ? null : { x: event.clientX, y: event.clientY };
    if (openFor(event.target, event, point)) event.preventDefault();
  });
  document.addEventListener('pointerdown', (event) => {
    if (menus.length && !event.target.closest?.('.ctx-menu')) closeMenu({ restore: false });
    if (event.pointerType !== 'touch' || !match(event.target)) return;
    clearTimeout(press?.timer);
    const { clientX: x, clientY: y, target } = event;
    press = { x, y, timer: setTimeout(() => { press = null; openFor(target, event, { x, y }); }, LONG_PRESS) };
  }, true);
  const cancelPress = () => { clearTimeout(press?.timer); press = null; };
  document.addEventListener('pointermove', (event) => {
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelPress();
  }, true);
  document.addEventListener('pointerup', cancelPress, true);
  document.addEventListener('pointercancel', cancelPress, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('click', (event) => {
    const row = event.target.closest?.('.ctx-item');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    activate(row);
  }, true);
  document.addEventListener('pointerover', (event) => {
    const row = event.target.closest?.('.ctx-item');
    if (!row || event.pointerType === 'touch') return;
    const menu = row.closest('.ctx-menu');
    row.focus({ preventScroll: true });
    const depth = Number(menu.dataset.depth);
    if (itemOf(row)?.children?.length) openSub(row);
    else closeFrom(depth + 1);
  });
  window.addEventListener('scroll', (event) => {
    if (menus.length && !event.target?.closest?.('.ctx-menu')) closeMenu({ restore: false });
  }, true);
  window.addEventListener('blur', () => closeMenu({ restore: false }));
  window.addEventListener('resize', () => closeMenu({ restore: false }));
}

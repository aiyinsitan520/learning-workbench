// 单色线性图标，与样稿同一套路径。
const paths = {
  book: 'M3 4q5-1 9 2 4-3 9-2v15q-5-1-9 2-4-3-9-2z M12 6v15',
  home: 'M3 3h8v8H3z M14 3h7v5h-7z M3 14h8v7H3z M14 11h7v10h-7z',
  calendar: 'M3 6h18v15H3z M7 3v6 M17 3v6 M3 11h18',
  focus: 'M9 2h6 M12 5a8 8 0 1 0 .1 0 M12 9v5l3 1',
  notes: 'M5 3h14v18H5z M9 3v18 M12 8h4 M12 12h4',
  flow: 'M8 2h8v5H8z M2 16h7v5H2z M15 16h7v5h-7z M12 7v5 M5.5 16v-4h13v4',
  activity: 'M3 19V9 M9 19V4 M15 19v-7 M21 19V6',
  review: 'M4 4h16v12H9l-5 4z M8 9h8 M8 12h5',
  sidebar: 'M3 4h18v16H3z M9 4v16',
  download: 'M12 3v12 M8 11l4 4 4-4 M4 17v3h16v-3',
  folder: 'M3 6h6l2 3h10v11H3z',
  paw: 'M7 14q5-8 10 0 4 6-1 6-4-2-8 0-5 0-1-6z M3 10l1 2 M8 5l1 3 M15 5l-1 3 M20 10l-1 2',
  play: 'M7 4l12 8-12 8z',
  pause: 'M8 4h3v16H8z M13 4h3v16h-3z',
  edit: 'M4 16L16 4l4 4L8 20l-5 1z M13 7l4 4',
  gear: 'M12 9a3 3 0 1 0 .1 0 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M4.9 19.1L7 17 M17 7l2.1-2.1',
  bulb: 'M9 16c0-3-4-4-4-8a7 7 0 0 1 14 0c0 4-4 5-4 8z M9 19h6 M10 22h4',
  clock: 'M12 3a9 9 0 1 0 .1 0 M12 7v6l4 2',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 14h10l1-14',
  plus: 'M12 5v14 M5 12h14',
  check: 'M4 13l5 5L20 6',
  grip: 'M9 5h.1 M15 5h.1 M9 12h.1 M15 12h.1 M9 19h.1 M15 19h.1',
};

export function icon(name, cls = 'ico') {
  const d = paths[name] ?? paths.bulb;
  return `<svg class="${cls}" aria-hidden="true" viewBox="0 0 24 24"><path d="${d}"/></svg>`;
}

/** 把带 data-icon 的占位元素填上图标。 */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });
}

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

// 页面级小工具：选择器、提示条、弹窗、本地日期。只碰 DOM，不碰业务状态。

export const $ = (sel, root = document) => root.querySelector(sel);

/** 指定时区的今天（YYYY-MM-DD）。工作台按服务时区分日，不用浏览器所在时区。 */
export function localToday(timeZone, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

let toastTimer;
/** 底部提示条；kind = 'bad' 表示失败。 */
export function notify(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `on ${kind}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2400);
}

export function modal(html) {
  $('#dialogBody').innerHTML = html;
  $('#dialog').showModal();
}

export function closeDialog() {
  $('#dialog').close();
}

/** localStorage 在隐私模式或被禁用时会抛错；偏好读写一律走这里。 */
export const prefs = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* 忽略 */ }
  },
};

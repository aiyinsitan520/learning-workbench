// 页面级小工具：选择器、提示条、弹窗、本地日期。只碰 DOM，不碰业务状态。

export const $ = (sel, root = document) => root.querySelector(sel);

// 工作台时区的 UTC 偏移（秒），从服务返回的视图里推出来，不问浏览器。
// 原因：「改时区」类浏览器扩展会篡改 Intl / Date 的时区结果，用户装过一个，
// 导致日计划整体错开 8 小时、新块存错日子（2026-11-21）。UTC 运算不受影响。
const zoneOffsets = new Map();

/** 记下视图所在时区的偏移：view.range.start 是该日本地零点对应的 UTC 秒。 */
export function learnZone(view) {
  if (!view?.timeZone || !view.day || !view.range) return;
  const [y, m, d] = view.day.split('-').map(Number);
  zoneOffsets.set(view.timeZone, Date.UTC(y, m - 1, d) / 1000 - view.range.start);
}

/** 已知时区偏移时把 UTC 秒换成「本地钟面」的 Date（只用 getUTC* 读取）；未知返回 null。 */
export function zoneWall(epochSeconds, timeZone) {
  const offset = zoneOffsets.get(timeZone);
  return offset === undefined ? null : new Date((epochSeconds + offset) * 1000);
}

/** 指定时区的今天（YYYY-MM-DD）。工作台按服务时区分日，不用浏览器所在时区。 */
export function localToday(timeZone, date = new Date()) {
  const wall = zoneWall(Math.floor(date.getTime() / 1000), timeZone);
  if (wall) return wall.toISOString().slice(0, 10);
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

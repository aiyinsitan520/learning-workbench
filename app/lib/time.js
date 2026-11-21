// 本地日期 ↔ UTC 秒换算。全库时间都用 UTC 秒存储，只在边界处换算。
// 不依赖任何第三方库，用 Intl 取指定时区的偏移。

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(text) {
  const m = DATE_RE.exec(String(text ?? ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

function tzOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) parts[type] = value;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUTC - utcMs;
}

/** 某个本地日期 00:00 对应的 UTC 秒。 */
export function localMidnightSeconds(dateText, timeZone) {
  if (!isValidDate(dateText)) throw new RangeError(`非法日期：${dateText}`);
  const [y, mo, d] = dateText.split('-').map(Number);
  const base = Date.UTC(y, mo - 1, d, 0, 0, 0);
  // 两轮迭代即可收敛（夏令时切换时偏移会变，第二轮用第一轮的估计值取偏移）。
  let ts = base - tzOffsetMs(base, timeZone);
  ts = base - tzOffsetMs(ts, timeZone);
  return Math.floor(ts / 1000);
}

/** 本地日期的左闭右开 UTC 秒区间。 */
export function dayRange(dateText, timeZone) {
  const start = localMidnightSeconds(dateText, timeZone);
  const [y, mo, d] = dateText.split('-').map(Number);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const nextText = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  const end = localMidnightSeconds(nextText, timeZone);
  return { start, end };
}

/** UTC 秒 → 指定时区的本地日期 YYYY-MM-DD。 */
export function localDateOf(epochSeconds, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(new Date(epochSeconds * 1000))) parts[type] = value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 把本地日期字符串前后移动若干天。 */
export function shiftDate(dateText, days) {
  const [y, mo, d] = dateText.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** 月份 YYYY-MM 的所有本地日期。 */
export function datesOfMonth(monthText) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthText ?? ''));
  if (!m) throw new RangeError(`非法月份：${monthText}`);
  const [y, mo] = [Number(m[1]), Number(m[2])];
  if (mo < 1 || mo > 12) throw new RangeError(`非法月份：${monthText}`);
  const total = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return Array.from({ length: total }, (_, i) =>
    `${y}-${String(mo).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
  );
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

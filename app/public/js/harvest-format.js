// 收获卡片的固定格式：ChatGPT 按这个格式输出精华，工作台粘贴即解析。
// 纯函数、零依赖：页面（js/harvest.js）即时解析，服务端（app/lib/ai-routes.js）解析 AI 输出，共用这一份。
//
//   【收获】标题
//   结论：一句话
//   要点：
//   - …
//   待办：
//   - …（没有写「无」）
//   标签：#… #…
//   来源：https://chatgpt.com/c/…（可选）

export const HARVEST_LIMITS = Object.freeze({
  title: 60, conclusion: 500, point: 300, points: 12, todo: 120, todos: 12, tag: 20, tags: 10, url: 500,
});

const SECTION = /^(结论|要点|待办|标签|来源|链接)\s*[:：]\s*(.*)$/;
const TITLE = /^(?:【\s*收获\s*】|\[\s*收获\s*\]|收获\s*[:：]|标题\s*[:：])\s*(.*)$/;
const BULLET = /^(?:[-*•·+]|\d{1,2}\s*[.、)）]|[（(]\d{1,2}[)）])\s*/;
const NONE = /^(?:无|没有|暂无|none|n\/a|-)[。.]?$/i;

const clip = (text, max) => Array.from(String(text)).slice(0, max).join('').trim();

/** 去掉代码围栏、Markdown 加粗/标题符号和首尾空白，统一换行。 */
function cleanLines(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*```/.test(line))
    .map((line) => line
      .replace(/^\s*>\s?/, '')          // 引用块
      .replace(/^\s*#{1,6}\s+/, '')     // 标题符号（标签行的 #词 后面没有空格，不受影响）
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .trim());
}

/** 标签：按空白、逗号、顿号拆开，去掉开头的 #，去重。 */
export function splitTags(text) {
  const seen = new Set();
  for (const raw of String(text ?? '').split(/[\s,，、;；]+/)) {
    const tag = clip(raw.replace(/^[#＃]+/, ''), HARVEST_LIMITS.tag);
    if (tag && !NONE.test(tag)) seen.add(tag);
  }
  return [...seen].slice(0, HARVEST_LIMITS.tags);
}

function firstUrl(text) {
  const match = String(text ?? '').match(/https?:\/\/[^\s<>"'）)]+/);
  return match ? clip(match[0], HARVEST_LIMITS.url) : '';
}

/**
 * 解析固定格式。成功返回 { ok: true, draft }，draft 形如
 * { title, conclusion, points: string[], todos: string[], tags: string[], sourceUrl }。
 * 没有【收获】/「标题：」行，或者结论和要点都为空，返回 { ok: false }——调用方再交给 AI 提炼或让用户手填。
 */
export function parseHarvest(text) {
  const draft = { title: '', conclusion: '', points: [], todos: [], tags: [], sourceUrl: '' };
  let started = false;
  let section = null;
  for (const line of cleanLines(text)) {
    if (!line) continue;
    const title = line.match(TITLE);
    if (title && !started) {
      started = true;
      draft.title = clip(title[1], HARVEST_LIMITS.title);
      section = 'title';
      continue;
    }
    if (!started) continue; // 【收获】之前的寒暄不要
    const head = line.match(SECTION);
    if (head) {
      section = head[1] === '链接' ? '来源' : head[1];
      if (head[2]) take(draft, section, head[2], true);
      continue;
    }
    take(draft, section, line, false);
  }
  draft.points = draft.points.slice(0, HARVEST_LIMITS.points);
  draft.todos = draft.todos.slice(0, HARVEST_LIMITS.todos);
  draft.conclusion = clip(draft.conclusion, HARVEST_LIMITS.conclusion);
  if (!started || !draft.title || (!draft.conclusion && !draft.points.length)) return { ok: false };
  return { ok: true, draft };
}

function take(draft, section, raw, inline) {
  const item = raw.replace(BULLET, '').trim();
  if (!item) return;
  switch (section) {
    case 'title':
      // 标题行下面紧跟的说明文字：标题为空时补成标题，否则忽略
      if (!draft.title) draft.title = clip(item, HARVEST_LIMITS.title);
      break;
    case '结论':
      draft.conclusion = draft.conclusion ? `${draft.conclusion} ${item}` : item;
      break;
    case '要点':
      if (!NONE.test(item)) draft.points.push(clip(item, HARVEST_LIMITS.point));
      break;
    case '待办':
      if (!NONE.test(item)) draft.todos.push(clip(item, HARVEST_LIMITS.todo));
      break;
    case '标签':
      draft.tags = [...new Set([...draft.tags, ...splitTags(item)])].slice(0, HARVEST_LIMITS.tags);
      break;
    case '来源':
      draft.sourceUrl ||= firstUrl(item);
      break;
    default:
      void inline;
  }
}

/** 卡片 → 固定格式文本（复制、导出用）。todos 可以是字符串或 { text }。 */
export function formatHarvest(card) {
  const list = (items) => (items?.length ? items.map((t) => `- ${typeof t === 'string' ? t : t.text}`) : ['- 无']);
  return [
    `【收获】${card.title ?? ''}`,
    `结论：${card.conclusion ?? ''}`,
    '要点：', ...list(card.points),
    '待办：', ...list(card.todos),
    `标签：${(card.tags ?? []).map((t) => `#${t}`).join(' ')}`,
    ...(card.sourceUrl ? [`来源：${card.sourceUrl}`] : []),
  ].join('\n');
}

/** 给 ChatGPT 的提炼口令（说明文档和页面「复制口令」按钮共用）。 */
export const CHATGPT_PROMPT = `当我只发送「收」时，回顾本次对话，只保留对我有用的结论，去掉推导过程和客套话，按下面格式输出，并整体放进一个代码块：
【收获】标题（不超过20字）
结论：一句话
要点：
- （3–5 条，每条不超过40字）
待办：
- （没有就写「无」）
标签：#标签1 #标签2`;

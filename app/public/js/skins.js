// 皮肤：切换 <html data-skin>，记在本机偏好里。颜色定义在 skins.css，这里只管列表和选择器。
// index.html 的 <head> 里有一段内联脚本在首屏前套用皮肤，避免先闪一下默认配色。

import { $, modal, closeDialog, prefs } from './dom.js';
import { esc } from './icons.js';

// 只记「用户亲手选过」的皮肤；没选过就用 DEFAULT_SKIN。
// 旧键 workbench.skin 曾在每次打开时自动写入，分不清是不是用户选的，所以弃用（2026-11-21 默认改为奶糖 Mac）。
// index.html 内联脚本里的键名和默认值要与这里保持一致。
export const SKIN_KEY = 'workbench.skin-choice';
export const DEFAULT_SKIN = 'candy';

export const SKINS = [
  { id: 'candy', name: '奶糖 Mac', note: '可爱圆润 · 默认', source: '原创' },
  { id: 'mint', name: '薄荷', note: '清爽手绘', source: '原创' },
  { id: 'latte', name: '拿铁', note: '淡紫柔和', source: 'Catppuccin Latte' },
  { id: 'mocha', name: '摩卡夜', note: '深色护眼', source: 'Catppuccin Mocha' },
  { id: 'nord', name: '极光', note: '简洁冷静 · 系统字体', source: 'Nord' },
  { id: 'rose', name: '晨玫瑰', note: '温柔雅致 · 衬线标题', source: 'Rosé Pine Dawn' },
];

const known = (id) => SKINS.some((skin) => skin.id === id);

/** 页面上正在显示的皮肤；tokens.css 本身就是薄荷，所以没有 data-skin 即薄荷。 */
export function currentSkin() {
  return document.documentElement.dataset.skin || 'mint';
}

/** 套用皮肤；remember=true 表示用户亲手选的，记下来。 */
export function applySkin(id, { remember = false } = {}) {
  const skin = known(id) ? id : DEFAULT_SKIN;
  const root = document.documentElement;
  if (skin === 'mint') delete root.dataset.skin;
  else root.dataset.skin = skin;
  if (remember) prefs.set(SKIN_KEY, skin);
  // 浏览器标签栏 / 应用窗口标题栏跟着皮肤底色走
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--bg').trim() || meta.content;
  const label = $('#skinToggle b');
  if (label) label.textContent = SKINS.find((s) => s.id === skin).name;
  return skin;
}

function pickerHtml() {
  const active = currentSkin();
  return `<div class="dialoghead"><h2>换一套皮肤</h2>
      <p class="soft">只改外观，数据不变；选择会记在这台电脑上。</p></div>
    <div class="skin-grid">${SKINS.map((skin) => `
      <button type="button" class="skin-card" data-skin-pick="${skin.id}" aria-pressed="${skin.id === active}">
        <span class="skin-preview" data-skin="${skin.id}" aria-hidden="true">
          <span class="sp-head"><i></i><i></i><i></i></span>
          <span class="sp-body"><span class="sp-side"><i></i><i></i><i></i></span>
            <span class="sp-main"><i></i><i></i><em></em></span></span>
          <span class="sp-mascot"></span>
        </span>
        <span class="skin-name"><b>${esc(skin.name)}</b><small>${esc(skin.note)}</small></span>
        <small class="skin-source">${esc(skin.source)}</small>
      </button>`).join('')}
    </div>
    <p class="soft skin-credit">配色：Catppuccin、Nord、Rosé Pine（MIT）；吉祥物：Microsoft Fluent Emoji（MIT）。</p>`;
}

export function bindSkins() {
  applySkin(prefs.get(SKIN_KEY) || DEFAULT_SKIN);
  $('#skinToggle')?.addEventListener('click', () => modal(pickerHtml()));
  $('#dialogBody').addEventListener('click', (event) => {
    const card = event.target.closest('[data-skin-pick]');
    if (!card) return;
    applySkin(card.dataset.skinPick, { remember: true });
    for (const el of document.querySelectorAll('[data-skin-pick]')) {
      el.setAttribute('aria-pressed', String(el === card));
    }
    setTimeout(closeDialog, 160);
  });
}

const escape = (value = '') => String(value).replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const protocolName = (protocol) => protocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容';
const button = (action, label, classes = '') =>
  `<button type="button" data-ai-action="${action}" class="ai-button ${classes}">${label}</button>`;

function cards({ providers, activeId }) {
  return providers.map((item) => `
    <article class="ai-card" data-ai-provider="${escape(item.id)}">
      <div class="ai-card-heading">
        <h2>${escape(item.name)}</h2><span class="ai-pill">${protocolName(item.protocol)}</span>
        ${item.id === activeId ? '<span class="ai-pill ai-current">当前使用</span>' : ''}
      </div>
      <dl class="ai-meta">
        <div><dt>模型</dt><dd>${escape(item.model)}</dd></div>
        <div><dt>API Key</dt><dd>${item.hasKey ? '•••• ' + escape(item.keyHint.split('…').at(-1).replaceAll('•', '')) : '未设置'}</dd></div>
        <div><dt>连接</dt><dd aria-live="polite">${item.lastTest
          ? `${item.lastTest.ok ? '通过' : '失败'} · ${item.lastTest.latencyMs ?? '—'} ms · ${escape(item.lastTest.message)}`
          : '尚未测试'}</dd></div>
      </dl>
      <div class="ai-actions">
        ${item.id === activeId ? '' : button('activate', '设为当前', 'ai-primary')}
        ${button('test', '测试')}${button('edit', '编辑')}${button('delete', '删除', 'ai-danger')}
      </div>
    </article>`).join('');
}

function presetGrid(presets) {
  return `<section class="ai-card ai-choice">
    <h2>选择供应商</h2>
    <div class="ai-presets">${presets.map((item) => `
      <button type="button" class="ai-preset" data-ai-preset="${escape(item.id)}">
        <strong>${escape(item.name)}</strong><span>${escape(item.note)}</span>
      </button>`).join('')}</div>
  </section>`;
}

function editor(item, preset) {
  const name = item?.name ?? (preset?.id === 'custom' ? '' : preset?.name) ?? '';
  const protocol = item?.protocol ?? preset?.protocol ?? 'openai';
  const list = item?.models?.length ? item.models : preset?.models ?? [];
  return `<form class="ai-card ai-editor" data-ai-editor autocomplete="off">
    <h2>${item ? '编辑供应商' : '添加供应商'}</h2>
    <div class="ai-form-grid">
      <label>名称<input name="name" value="${escape(name)}" required maxlength="120"></label>
      <label>协议<select name="protocol"><option value="openai">OpenAI 兼容</option>
        <option value="anthropic" ${protocol === 'anthropic' ? 'selected' : ''}>Anthropic</option></select></label>
    </div>
    <label>Base URL<input name="baseUrl" type="url" value="${escape(item?.baseUrl ?? preset?.baseUrl)}" required></label>
    <div class="ai-field">
      <label>API Key<input name="apiKey" type="password" autocomplete="new-password"
        placeholder="${item?.hasKey ? '留空保留已保存的 Key' : '填写供应商 API Key'}"></label>
      ${button('visibility', '显示')}
    </div>
    <div class="ai-help">
      ${item?.hasKey ? '<span>留空保留已保存的 Key。</span>' : (preset?.needsKey === false ? '<span>本地服务可以留空。</span>' : '')}
      ${preset?.keyUrl ? `<a href="${escape(preset.keyUrl)}" target="_blank" rel="noopener noreferrer">去申请 Key</a>` : ''}
    </div>
    <div class="ai-field">
      <label>模型<input name="model" list="ai-models" value="${escape(item?.model ?? list[0])}" required maxlength="120"></label>
      ${button('models', '获取模型列表')}
    </div>
    <datalist id="ai-models">${list.map((model) => `<option value="${escape(model)}"></option>`).join('')}</datalist>
    <p class="ai-feedback" data-ai-feedback role="status"></p>
    <div class="ai-actions">
      <button class="ai-button ai-primary" type="submit">保存</button>
      ${button('save-test', '保存并测试连接')}${button('cancel', '取消')}
    </div>
  </form>`;
}

export function showAiSettings(host, ctx) {
  if (host.querySelector('.ai-page')) return;
  const root = document.createElement('section');
  root.className = 'ai-page';
  root.innerHTML = `<div class="ai-heading"><h1>模型接入</h1>
    <div class="ai-actions">${button('add', '添加供应商', 'ai-primary')}${button('import', '导入')}${button('export', '导出（不含 Key）')}</div>
    </div><p class="ai-feedback" data-ai-status role="status">正在读取配置…</p>
    <div data-ai-content></div>
    <footer class="ai-privacy"><strong>数据与隐私</strong>
      <p>生成回顾时会把这一天的完成任务、专注用时、计划块、长期项目进展，以及<strong>这一天新写的任务正文</strong>（和当天接触过的任务的正文摘录）、前 6 天的投入概况发送给当前模型，用来总结记录要点、收获和成长。</p>
      <p>Key 保存在本机 <code>app/data/ai-providers.json</code>，导出文件不包含 Key。</p>
    </footer>`;
  host.replaceChildren(root);
  const content = root.querySelector('[data-ai-content]');
  const status = root.querySelector('[data-ai-status]');
  let state;
  let presets;
  let selected = null;
  let selectedPreset = null;
  let models;
  let busy = false;
  const api = ctx.api;
  const post = (operation, body) => api.post('/api/ai/' + operation, body);
  const render = () => {
    content.innerHTML = state.providers.length ? `<div class="ai-cards">${cards(state)}</div>` : presetGrid(presets);
  };
  const refresh = async () => {
    state = await api.get('/api/ai/providers');
    render();
  };
  const openEditor = (item, preset) => {
    selected = item;
    selectedPreset = preset;
    models = item?.models?.length ? item.models : preset?.models ?? [];
    content.innerHTML = editor(item, preset);
    content.querySelector('[name=name]').focus();
  };

  function dialog(html, onSubmit) {
    ctx.modal(html);
    const form = document.querySelector('[data-ai-dialog]');
    const panel = form.closest('dialog');
    const close = () => {
      form.reset();
      ctx.closeDialog();
    };
    panel.addEventListener('close', () => form.reset(), { once: true });
    form.querySelector('[data-ai-dismiss]').addEventListener('click', close);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      const submit = form.querySelector('[type=submit]');
      submit.disabled = true;
      onSubmit(form, close).catch((error) => {
        form.querySelector('[role=status]').textContent = error.message;
      }).finally(() => {
        busy = false;
        submit.disabled = false;
      });
    });
  }

  function fields(form) {
    const provider = Object.fromEntries(new FormData(form));
    return { ...provider, id: selected?.id, presetId: selectedPreset?.id ?? null, models };
  }
  async function save(form, test) {
    const { provider } = await post('providers/save', { provider: fields(form) });
    form.reset();
    form.querySelector('[name=apiKey]').value = '';
    status.textContent = '已保存供应商';
    if (test) await testProvider(provider.id);
    await refresh();
  }
  async function testProvider(id) {
    const { result } = await post('providers/test', { id });
    status.textContent = (result.ok ? '连接通过' : '连接失败') + ' · ' + result.latencyMs + ' ms';
  }

  async function perform(target, action) {
    const item = state.providers.find((provider) => provider.id === target.closest('[data-ai-provider]')?.dataset.aiProvider);
    const form = target.closest('[data-ai-editor]');
    switch (action) {
      case 'add':
        content.innerHTML = presetGrid(presets);
        content.querySelector('[data-ai-preset]')?.focus();
        break;
      case 'cancel': render(); break;
      case 'edit': openEditor(item, presets.find((preset) => preset.id === item.presetId)); break;
      case 'activate':
        await post('providers/activate', { id: item.id });
        status.textContent = '已设为当前供应商';
        await refresh();
        break;
      case 'test':
        await testProvider(item.id);
        await refresh();
        break;
      case 'delete':
        dialog(`<form data-ai-dialog class="ai-dialog"><h2>删除供应商？</h2><p>${escape(item.name)}</p>
          <p role="status"></p><div class="ai-actions"><button type="button" class="ai-button" data-ai-dismiss>取消</button>
          <button type="submit" class="ai-button ai-danger">确认删除</button></div></form>`, async (_, close) => {
          await post('providers/delete', { id: item.id });
          close();
          status.textContent = '已删除供应商';
          await refresh();
        });
        break;
      case 'import':
        dialog(`<form data-ai-dialog class="ai-dialog"><h2>导入供应商</h2>
          <label>粘贴 JSON 或环境变量文本<textarea name="text" rows="7" required autocomplete="off" spellcheck="false"></textarea></label>
          <p role="status"></p><div class="ai-actions"><button type="button" data-ai-dismiss class="ai-button">取消</button>
          <button type="submit" class="ai-button ai-primary">导入配置</button></div></form>`, async (importForm, close) => {
          const { imported } = await post('import', { text: importForm.elements.text.value });
          close();
          status.textContent = `已导入 ${imported} 个供应商`;
          await refresh();
        });
        break;
      case 'export': {
        const { format, version, providers } = await api.get('/api/ai/export');
        const url = URL.createObjectURL(new Blob([JSON.stringify({ format, version, providers }, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = '工作台模型供应商.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.textContent = '已导出供应商配置';
        break;
      }
      case 'visibility': {
        const key = form.elements.apiKey;
        key.type = key.type === 'password' ? 'text' : 'password';
        target.textContent = key.type === 'password' ? '显示' : '隐藏';
        break;
      }
      case 'models': {
        if (!form.elements.baseUrl.reportValidity()) break;
        const { protocol, baseUrl, apiKey } = fields(form);
        const reuse = selected?.hasKey && !apiKey && selected.protocol === protocol
          && selected.baseUrl === baseUrl.trim().replace(/\/+$/, '');
        const result = await post('providers/models', reuse ? { id: selected.id } : { protocol, baseUrl, apiKey });
        models = result.models;
        const options = models.map((model) => Object.assign(document.createElement('option'), { value: model }));
        form.querySelector('datalist').replaceChildren(...options);
        if (models.length && !models.includes(form.elements.model.value)) form.elements.model.value = models[0];
        form.querySelector('[data-ai-feedback]').textContent = `已获取 ${models.length} 个模型`;
        break;
      }
      case 'save-test':
        if (form.reportValidity()) await save(form, true);
        break;
    }
  }

  async function run(target, operation) {
    if (!state || busy) return;
    busy = true;
    if (target) target.disabled = true;
    try { await operation(); } catch (error) {
      const message = target?.closest('[data-ai-editor]')?.querySelector('[data-ai-feedback]') ?? status;
      message.textContent = error.message;
    } finally {
      busy = false;
      if (target) target.disabled = false;
    }
  }
  root.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-ai-action], button[data-ai-preset]');
    if (!target) return;
    void run(target, () => {
      if (target.dataset.aiPreset) return openEditor(null, presets.find((preset) => preset.id === target.dataset.aiPreset));
      return perform(target, target.dataset.aiAction);
    });
  });
  root.addEventListener('submit', (event) => {
    if (!event.target.matches('[data-ai-editor]')) return;
    event.preventDefault();
    void run(event.submitter, () => save(event.target, false));
  });
  api.get('/api/ai/presets').then((response) => {
    presets = response.presets;
    return refresh();
  }).then(() => { status.textContent = ''; }, (error) => { status.textContent = error.message; });
}

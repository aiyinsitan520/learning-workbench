const sections = { days: '日计划', notes: '任务正文', harvests: '收获', projects: '长期项目' };

async function request(action = '', body) {
  const response = await fetch('/api/obsidian' + action, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Obsidian 请求失败。');
  return result;
}

export function mountObsidianSection(host) {
  if (host.querySelector('.wb-obsidian')) return;
  if (!document.querySelector('link[href="/obsidian.css"]')) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/obsidian.css';
    document.head.append(css);
  }
  host.innerHTML = `
    <form class="wb-obsidian">
      <h3>Obsidian 单向导出</h3>
      <label>已检测到的仓库<select name="candidate"><option value="">手动输入仓库路径</option></select></label>
      <label>仓库路径<input name="vaultPath" type="text" spellcheck="false"></label>
      <label>导出子文件夹<input name="folder" type="text" maxlength="80" required></label>
      <fieldset><legend>导出内容</legend><div class="wb-obsidian-options">
        ${Object.entries(sections).map(([key, label]) => `<label><input name="${key}" type="checkbox">${label}</label>`).join('')}
      </div></fieldset>
      <div class="wb-obsidian-options">
        <label><input name="enabled" type="checkbox">启用导出</label>
        <label><input name="auto" type="checkbox">变更后自动导出</label>
      </div>
      <div class="wb-obsidian-options">
        <button type="submit" disabled>保存设置</button>
        <button type="button" name="export" disabled>立即导出</button>
        <a data-obsidian-open hidden>在 Obsidian 中打开</a>
      </div>
      <p role="status" data-obsidian-status></p>
      <ul data-obsidian-conflicts hidden></ul>
    </form>`;
  const form = host.querySelector('form');
  const fields = form.elements;
  const status = form.querySelector('[role=status]');
  const conflicts = form.querySelector('[data-obsidian-conflicts]');
  const open = form.querySelector('[data-obsidian-open]');
  const save = form.querySelector('[type=submit]');
  const exportButton = fields.namedItem('export');
  let config;
  let working = false;
  let dirty = false;
  function buttons() {
    save.disabled = !config || working;
    exportButton.disabled = !config?.enabled || working || dirty;
    open.hidden = !config?.vaultPath || dirty;
  }
  function show(result, saved = false) {
    config = result.config;
    dirty = false;
    for (const field of ['vaultPath', 'folder']) fields[field].value = config[field];
    for (const field of ['enabled', 'auto']) fields[field].checked = config[field];
    for (const field of Object.keys(sections)) fields[field].checked = config.include[field];
    fields.candidate.value = config.vaultPath;
    const separator = config.vaultPath.includes('\\') ? '\\' : '/';
    const path = config.vaultPath.replace(/[\\/]$/, '') + separator + config.folder;
    open.href = 'obsidian://open?path=' + encodeURIComponent(path);
    const last = result.status;
    status.textContent = last.error || (last.lastExportAt
      ? '上次导出 ' + new Date(last.lastExportAt).toLocaleString() + ' · 写入 ' + last.written
        + ' · 无变化 ' + last.unchanged + ' · 冲突 ' + last.conflicts.length
      : saved ? '设置已保存，尚未导出。' : '尚未导出。');
    conflicts.replaceChildren(...last.conflicts.map(path => {
      const item = document.createElement('li');
      item.textContent = path;
      return item;
    }));
    conflicts.hidden = !last.conflicts.length;
    buttons();
  }
  async function submit(action, body) {
    working = true;
    for (const field of form.querySelectorAll('input, select')) field.disabled = true;
    buttons();
    status.textContent = action === '/export' ? '正在导出…' : '正在保存设置…';
    try {
      show(await request(action, body), action === '/config');
    } catch (error) {
      status.textContent = error.message;
    } finally {
      working = false;
      for (const field of form.querySelectorAll('input, select')) field.disabled = false;
      buttons();
    }
  }
  form.addEventListener('input', event => {
    if (event.target === fields.candidate && fields.candidate.value) fields.vaultPath.value = fields.candidate.value;
    if (event.target === fields.vaultPath) fields.candidate.value = fields.vaultPath.value;
    dirty = true;
    buttons();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!config || working) return;
    void submit('/config', {
      vaultPath: fields.vaultPath.value.trim(), folder: fields.folder.value.trim(),
      enabled: fields.enabled.checked, auto: fields.auto.checked,
      include: Object.fromEntries(Object.keys(sections).map(key => [key, fields[key].checked])),
    });
  });
  exportButton.addEventListener('click', () => void submit('/export', {}));
  request().then(show).catch(error => { status.textContent = error.message; });
  request('/detect').then(({ vaults }) => {
    for (const path of vaults) fields.candidate.add(new Option(path, path));
    fields.candidate.value = fields.vaultPath.value;
  }).catch(error => { fields.candidate.title = error.message; });
}

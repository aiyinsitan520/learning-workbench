// 长期项目（右栏「长期项目」区块）。占位实现，工单 T5（DSH）完成。
// 数据：view.projects（ProjectView[]），写操作：createProject / updateProject / setProjectState / saveProjectLog。
// 按钮用 data-project-* 属性并在 host 上自己监听；打开项目主任务的正文用 ctx.openTask(mainTaskId)。

/**
 * @param {HTMLElement} host  #projects
 * @param {import('../../../architecture/workbench').ModuleContext} ctx
 * @returns {{ render(view: import('../../../architecture/workbench').WorkbenchView): void }}
 */
export function bindProjects(host, ctx) { // eslint-disable-line no-unused-vars
  return {
    render(view) {
      host.hidden = !view.projects?.length;
    },
  };
}

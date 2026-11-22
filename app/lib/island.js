// 桌面灵动岛（app/island/island.ps1）的启停。浏览器不能直接拉起桌面程序，由本机服务代劳。
// 只在 Windows 上可用；其他系统返回「不支持」，前端退回浏览器画中画小窗。
// 测试时传 launcher: null（不支持）或一个假的 launcher，绝不在测试里真的弹窗。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { WorkbenchError } from './db.js';

/** 默认启动器：隐藏的 PowerShell（STA 线程，WPF 需要）运行灵动岛脚本。 */
export function defaultIslandLauncher(root) {
  if (process.platform !== 'win32') return null;
  const script = join(root, 'island', 'island.ps1');
  // 用系统里的完整路径：本机服务继承的 PATH 里不一定有 PowerShell 目录（实测 ENOENT）
  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return (port) => spawn(exe,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-File', script, '-Port', String(port)],
    // 不能用 detached：Windows 上那会让子进程没有控制台，PowerShell 约 80ms 就直接退出（实测）。
    // 不 detached 的子进程在服务退出后仍会继续运行，unref 让服务可以先退出。
    { stdio: 'ignore', windowsHide: true });
}

/**
 * @param {((port: number) => import('node:child_process').ChildProcess) | null} launcher
 */
export function createIslandController(launcher) {
  let child = null;
  const running = () => Boolean(child && child.exitCode === null && child.signalCode === null && !child.killed);

  /** 等进程真正起来（spawn 事件）再回复；起不来（如找不到 PowerShell）就报错，不假装成功。 */
  async function open(port) {
    if (!launcher) throw new WorkbenchError('invalid', '当前系统不支持桌面灵动岛');
    if (running()) return;
    const proc = launcher(port);
    await new Promise((resolve, reject) => {
      proc.once('spawn', resolve);
      proc.once('error', (err) => reject(new WorkbenchError('storage', `桌面灵动岛没有启动：${err.message}`)));
    });
    child = proc;
    proc.on('exit', () => { if (child === proc) child = null; });
    proc.unref?.();
  }

  function close() {
    if (!running()) { child = null; return; }
    try { child.kill(); } catch { /* 已退出 */ }
    child = null;
  }

  return {
    supported: Boolean(launcher),
    running,
    /** action: open | close | toggle → { supported, running } */
    async handle(action, port) {
      if (action === 'open') await open(port);
      else if (action === 'close') close();
      else if (action === 'toggle') { if (running()) close(); else await open(port); }
      else throw new WorkbenchError('invalid', `未知操作：${action}`);
      return { supported: Boolean(launcher), running: running() };
    },
  };
}

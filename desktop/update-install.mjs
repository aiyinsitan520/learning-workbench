// 桌面版自动更新的安装部分（Electron 主进程用）。下载和校验在 app/lib/updater.js。
// Windows（ZIP 便携版）：备份资料库 → 把新包解压到程序文件夹旁边 → 核对版本 → 交给 update-helper.ps1：
//   等本程序退出 → 旧文件夹改名为「<文件夹>.previous」（保留一版，方便手动回退）→ 新文件夹换上 → 重新打开。
// macOS（DMG）：校验通过后打开安装包，由用户把新版拖进「应用程序」替换（未公证的应用不做静默替换）。
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PENDING = 'pending-update.json';

/** 本机能怎样安装更新。 */
export async function detectInstallMode({ isPackaged, platform = process.platform, execPath = process.execPath }) {
  if (!isPackaged) return { mode: null, reason: '开发运行的桌面版不能自动安装，请重新打包。' };
  if (platform === 'darwin') return { mode: 'open', reason: '' };
  if (platform !== 'win32') return { mode: null, reason: '这个系统暂不支持自动更新。' };
  const parent = dirname(dirname(execPath));
  try {
    const probe = await mkdtemp(join(parent, '.lw-update-probe-'));
    await rm(probe, { recursive: true, force: true });
  } catch {
    return { mode: null, reason: `程序所在位置（${parent}）不能写入，无法自动替换。请把工作台解压到「文档」等可写的文件夹，或到发布页手动下载新版。` };
  }
  return { mode: 'restart', reason: '' };
}

function runQuiet(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${basename(file)} 退出码 ${code}`))));
  });
}

/**
 * 执行安装。返回给 /api/update 的结果；afterResponse 在响应发出后调用（Windows 上用来退出程序）。
 * @param {{file, version, from, mode}} job  updater 传来的任务（file 已校验 SHA-256）
 * @param {{app, shell, workbench, userData, quit}} env
 */
export async function installUpdate(job, { shell, workbench, userData, quit, execPath = process.execPath, pid = process.pid,
  launchArgs = process.argv.slice(1) }) {
  if (job.mode === 'open') {
    const problem = await shell.openPath(job.file);
    if (problem) throw new Error(problem);
    return { opened: true, message: '安装包已打开：把 Learning Workbench 拖进「应用程序」替换旧版，然后重新打开。资料保存在系统的应用数据目录里，不会丢。' };
  }
  if (job.mode !== 'restart' || process.platform !== 'win32') throw new Error('这里不能自动安装');

  const appDir = dirname(execPath);
  const exeName = basename(execPath);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  // 1. 备份资料库（和数据库迁移前的备份同一做法：VACUUM INTO 一份完整副本）
  const backups = join(userData, 'backups');
  await mkdir(backups, { recursive: true });
  const backup = join(backups, `update-${job.from}-to-${job.version}-${stamp}.db`);
  workbench.db.prepare('VACUUM INTO ?').run(backup);

  // 2. 解压到程序文件夹旁边的临时文件夹（系统自带 tar 可解 ZIP）
  const staging = join(dirname(appDir), `${basename(appDir)}.next-${job.version}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  try {
    await runQuiet(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', job.file, '-C', staging]);
    // 3. 核对解出来的确实是这一版的工作台
    await stat(join(staging, exeName));
    const meta = JSON.parse(await readFile(join(staging, 'resources', 'app', 'app', 'version.json'), 'utf8'));
    if (meta.version !== job.version) throw new Error(`安装包里的版本是 ${meta.version}，不是 ${job.version}`);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }

  // 4. 交给助手脚本：脚本先复制到临时目录，工作目录也放在那里，避免占住程序文件夹
  const work = await mkdtemp(join(tmpdir(), 'learning-workbench-update-'));
  const helper = join(work, 'update-helper.ps1');
  await copyFile(join(HERE, 'update-helper.ps1'), helper);
  await writeFile(join(userData, PENDING), JSON.stringify({ from: job.from, to: job.version, at: Date.now(), backup }));
  const log = join(userData, 'update.log');
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // 重新打开时带上原来的启动参数（例如 --user-data-dir），base64 JSON 传递，避免引号和中文路径问题
  const relaunch = Buffer.from(JSON.stringify(launchArgs), 'utf8').toString('base64');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helper,
    '-WaitPid', String(pid), '-AppDir', appDir, '-Staging', staging, '-ExeName', exeName, '-Log', log,
    '-ArgsB64', relaunch];
  // 助手必须活过本程序：Electron 退出时会连带结束自己启动的子进程（实测），detached 又会让隐藏的
  // PowerShell 立刻退出。所以经 WMI 的 Win32_Process.Create 由系统启动助手，再等它在日志里报到。
  const quote = (a) => `"${a}"`;
  const commandLine = [ps, ...args].map((a, i) => (i === 0 || /[\s"]/.test(a) || a.includes('\\') ? quote(a) : a)).join(' ');
  const launcher = [
    `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }`,
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}'; CurrentDirectory = '${work.replace(/'/g, "''")}'; ProcessStartupInformation = $si }`,
    'exit [int]$r.ReturnValue',
  ].join('\n');
  await runQuiet(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launcher, 'utf16le').toString('base64')]);
  const marker = `waiting for process ${pid} to exit`;
  for (let i = 0; i < 40; i += 1) {
    try { if ((await readFile(log, 'utf8')).includes(marker)) break; } catch { /* 日志还没建 */ }
    if (i === 39) {
      await rm(staging, { recursive: true, force: true });
      await rm(join(userData, PENDING), { force: true });
      throw new Error('更新助手没有启动');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { restarting: true, message: '正在安装，工作台会关闭并在几秒后重新打开。', afterResponse: quit };
}

/** 启动时读上次更新的结果：版本对上 = 成功；对不上 = 没装成。读完删除标记。 */
export async function readUpdateOutcome(userData, currentVersion) {
  const file = join(userData, PENDING);
  let pending;
  try { pending = JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
  await rm(file, { force: true });
  // 装好了：下载的安装包（一百多 MB）没用了，删掉；没装成则留着，下次可直接重试安装
  if (pending.to === currentVersion) await rm(join(userData, 'updates'), { recursive: true, force: true });
  return pending.to === currentVersion
    ? { ok: true, from: pending.from, to: pending.to, backup: pending.backup }
    : { ok: false, from: pending.from, to: pending.to, backup: pending.backup, log: join(userData, 'update.log') };
}

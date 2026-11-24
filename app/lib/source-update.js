import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { UpdateError } from './updater.js';

const exec = promisify(execFile);

export function createSourceUpdate({ root, repo, dataDir, backup, restart, execGit = exec, fetch: fetchImpl }) {
  async function git(...args) {
    const { stdout } = await execGit('git', ['-C', root, ...args], {
      windowsHide: true, timeout: args.includes('merge') ? 0 : 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout.trim();
  }
  const read = (...args) => git(...args).catch(() => null);
  const allowedOrigins = new Set([`https://github.com/${repo}`, `git@github.com:${repo}`, `ssh://git@github.com/${repo}`]);

  async function readGitHub(path) {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/${path}`, {
      redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/vnd.github+json' },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    return response.json();
  }

  async function inspect(version, { localOnly = false } = {}) {
    const reasons = [];
    const top = await read('rev-parse', '--show-toplevel');
    if (!top || await realpath(top).catch(() => null) !== await realpath(root)) {
      return { reasons: ['程序目录不是 Git 仓库根目录，或未安装 Git。'] };
    }
    const ref = `refs/tags/v${version}`;
    const [branch, status, origin, head, localCommit] = await Promise.all([
      read('symbolic-ref', '--short', 'HEAD'),
      read('status', '--porcelain', '--untracked-files=all'),
      read('remote', 'get-url', '--all', 'origin'),
      read('rev-parse', '--verify', 'HEAD'),
      read('rev-parse', '--verify', `${ref}^{commit}`),
    ]);
    if (branch !== 'main') reasons.push('请切换到 main 分支后再更新。');
    if (status !== '') reasons.push('工作区有未提交的改动，或无法读取工作区状态。');
    if (!allowedOrigins.has(origin?.replace(/\.git$/, ''))) reasons.push('origin 未指向配置的发布仓库。');
    let commit = localCommit;
    if (!head || (localCommit && (head === localCommit || await read('merge-base', '--is-ancestor', head, localCommit) === null))) {
      reasons.push('当前提交无法快进到目标版本。');
    }
    if (!localCommit) {
      if (!fetchImpl || localOnly || reasons.length) reasons.push(`本地找不到标签 v${version}。`);
      else {
        // 先核对远端标签和祖先关系，不在检查阶段改动本地 Git 对象或引用。
        try {
          const tag = await readGitHub(`commits/${encodeURIComponent(ref)}`);
          if (!tag || !/^[0-9a-f]{40}$/.test(tag.sha)) reasons.push(`发布仓库找不到标签 v${version}。`);
          else {
            commit = tag.sha;
            const comparison = await readGitHub(`compare/${head}...${commit}?per_page=1`);
            if (comparison?.status !== 'ahead' || comparison?.merge_base_commit?.sha !== head) {
              reasons.push('当前提交无法快进到目标版本。');
            }
          }
        } catch {
          reasons.push('暂时无法核对远端版本标签，请检查网络后重新检查。');
        }
      }
    }
    return { reasons, ref, head, commit };
  }

  return {
    async preflight(version) {
      return (await inspect(version)).reasons;
    },
    async install({ version, from, onStep }) {
      const outcome = { from, to: version, ok: false };
      const resultFile = join(dataDir, 'source-update-result.json');
      const before = await inspect(version);
      if (before.reasons.length) throw new UpdateError('source-preflight', before.reasons.join(' '));
      try {
        onStep('正在备份资料库…');
        outcome.backup = (await backup()).name;
        onStep('正在获取并核对版本标签…');
        await git('fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', 'origin', 'tag', `v${version}`);
        const after = await inspect(version, { localOnly: true });
        if (after.reasons.length || after.head !== before.head || after.commit !== before.commit) {
          throw new Error(after.reasons.join(' ') || '更新期间提交或版本标签发生变化。');
        }
        const target = JSON.parse(await git('show', `${after.commit}:app/version.json`));
        if (target.version !== version) throw new Error('目标提交里的 app/version.json 与发布版本不一致。');
        onStep('正在切换到新版本…');
        await git('-c', 'core.hooksPath=' + join(root, '.git', 'workbench-disabled-hooks'), '-c', 'submodule.recurse=false',
          'merge', '--quiet', '--ff-only', '--no-autostash', '--no-overwrite-ignore', after.commit);
        outcome.ok = true;
        await writeFile(resultFile, JSON.stringify(outcome));
        onStep('正在重启工作台…');
        return await restart();
      } catch (err) {
        const message = outcome.ok
          ? '代码已更新，请运行「启动学习工作台.ps1」恢复服务。'
          : '更新中止，请根据原因处理后重试。';
        await writeFile(resultFile, JSON.stringify({ ...outcome, ok: false, log: message })).catch(() => {});
        throw new UpdateError('source-install', `${message} ${err.message}`);
      }
    },
  };
}

export async function prepareSourceRestart({ root, port, stop }) {
  const child = spawn(process.execPath, [join(root, 'app', 'tools', 'restart-source.mjs'),
    String(process.pid), String(port)], {
    cwd: root, env: process.env, detached: true, windowsHide: true, stdio: 'ignore',
  });
  await once(child, 'spawn');
  child.unref();
  return { restarting: true, afterResponse: stop };
}

// 跑全部浏览器用例（app/test/*.test.mjs），工作目录放在临时目录，截图不覆盖 app/shots。
// 由 verify\run_all.cmd full 调用；新增浏览器测试文件不必改任何脚本。
import { readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const testDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'test');
const files = readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => join(testDir, f));
const cwd = join(tmpdir(), 'learning-space-ui-run');
mkdirSync(cwd, { recursive: true });
console.log(`浏览器用例文件：${files.length} 个`);
const { status } = spawnSync(process.execPath, ['--test', ...files], { cwd, stdio: 'inherit' });
process.exit(status ?? 1);

// 生成自动更新的签名密钥（只需做一次）。
//   node desktop/update-keys.mjs init
// 公钥写进 app/lib/update-config.js（随源码公开、打进安装包）；私钥写到本机用户目录，
// 不进仓库。之后把私钥存成 GitHub Actions secret：
//   gh secret set UPDATE_SIGNING_KEY -R aiyinsitan520/learning-workbench < <私钥文件>
// 私钥丢了就不能给已装的旧版推更新（只能让用户手动装一次带新公钥的版本），记得备份。
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG = fileURLToPath(new URL('../app/lib/update-config.js', import.meta.url));
const KEY_DIR = join(process.env.APPDATA || join(homedir(), '.config'), 'learning-workbench-release');
const KEY_FILE = join(KEY_DIR, 'update-signing-key.pem');

if (process.argv[2] !== 'init') {
  console.log('用法：node desktop/update-keys.mjs init');
  process.exit(2);
}
const source = readFileSync(CONFIG, 'utf8');
if (!source.includes('publicKey: null,')) {
  console.error('update-config.js 里已经有公钥了。换钥会让已安装的版本收不到更新，如确需更换请手动处理。');
  process.exit(1);
}
if (existsSync(KEY_FILE)) {
  console.error(`已存在私钥文件 ${KEY_FILE}，为免覆盖已停止。`);
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
mkdirSync(KEY_DIR, { recursive: true });
writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
writeFileSync(CONFIG, source.replace('publicKey: null,', `publicKey: \`${pem}\`,`));
console.log(`公钥已写入 ${CONFIG}`);
console.log(`私钥保存在 ${KEY_FILE}（不要提交，记得另外备份）`);
console.log('下一步：gh secret set UPDATE_SIGNING_KEY -R aiyinsitan520/learning-workbench < "' + KEY_FILE + '"');

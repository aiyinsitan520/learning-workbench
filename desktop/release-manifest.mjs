// 发版时生成并签名更新清单（GitHub Actions 的 release 任务调用；本机也可用来演练）。
//   node desktop/release-manifest.mjs <安装包目录> <标签>
// 需要环境变量 UPDATE_SIGNING_KEY（Ed25519 私钥 PEM）；缺少时直接失败，不发布没签名的清单。
// 产物：<目录>/latest.json 与 latest.json.sig（base64 签名），和安装包一起上传到 Release。
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_FORMAT, parseManifest, verifyManifest } from '../app/lib/updater.js';
import { UPDATE_CONFIG } from '../app/lib/update-config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PACKAGE_NAMES = {
  'win32-x64': 'Learning-Workbench-Windows-x64.zip',
  'darwin-arm64': 'Learning-Workbench-macOS-arm64.dmg',
  'darwin-x64': 'Learning-Workbench-macOS-x64.dmg',
};

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const spki = (key) => createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString().trim();

/** 生成、签名并自检清单。config 可换成测试配置（本机演练）。 */
export async function writeManifest({ dir, tag, privateKeyPem, config = UPDATE_CONFIG, version, notes, require = Object.keys(PACKAGE_NAMES) }) {
  version ??= JSON.parse(readFileSync(join(ROOT, 'app', 'version.json'), 'utf8')).version;
  if (tag !== `v${version}`) throw new Error(`标签 ${tag} 和 app/version.json 的版本 ${version} 不一致`);
  if (!privateKeyPem) throw new Error('缺少 UPDATE_SIGNING_KEY，拒绝发布没有签名的更新清单');
  if (!config.publicKey) throw new Error('app/lib/update-config.js 还没有公钥，先运行 node desktop/update-keys.mjs init');
  const privateKey = createPrivateKey(privateKeyPem);
  if (spki(privateKey) !== spki(config.publicKey)) throw new Error('签名私钥和源码里的公钥不是一对');

  const packages = {};
  for (const [platform, name] of Object.entries(PACKAGE_NAMES)) {
    const file = join(dir, name);
    if (!existsSync(file)) {
      if (require.includes(platform)) throw new Error(`缺少安装包 ${name}`);
      continue;
    }
    packages[platform] = {
      name, url: `${config.downloadBase ?? `https://github.com/${config.repo}/releases/download/`}${tag}/${name}`,
      size: statSync(file).size, sha256: await sha256(file),
    };
  }
  if (notes === undefined) {
    const notesFile = join(ROOT, 'desktop', 'release-notes', `${tag}.md`);
    notes = existsSync(notesFile) ? readFileSync(notesFile, 'utf8').trim() : `学习工作台 ${tag}`;
  }
  const manifest = {
    format: MANIFEST_FORMAT, repo: config.repo, version, tag,
    publishedAt: new Date().toISOString(), notes, packages,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const signature = sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64');
  // 自检：用客户端同一套代码验签、解析每个平台
  if (!verifyManifest(text, signature, config.publicKey)) throw new Error('清单签名自检失败');
  for (const platform of Object.keys(packages)) {
    parseManifest(text, { repo: config.repo, platform, downloadBase: config.downloadBase });
  }
  writeFileSync(join(dir, 'latest.json'), text);
  writeFileSync(join(dir, 'latest.json.sig'), `${signature}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [dir, tag] = process.argv.slice(2);
  if (!dir || !tag) {
    console.error('用法：node desktop/release-manifest.mjs <安装包目录> <标签>');
    process.exit(2);
  }
  writeManifest({ dir, tag, privateKeyPem: process.env.UPDATE_SIGNING_KEY })
    .then((m) => console.log(`已生成并签名 latest.json：${m.tag}，平台 ${Object.keys(m.packages).join(', ')}`))
    .catch((err) => { console.error(err.message); process.exit(1); });
}

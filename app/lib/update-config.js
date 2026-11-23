// 自动更新的发布源与签名公钥。只信任这个仓库的 GitHub Release，下载地址必须是
// https://github.com/<repo>/releases/download/v<版本>/<文件名>。
// publicKey 为 null 时桌面版只能手动更新：由 `node desktop/update-keys.mjs init` 生成密钥对并写入这里，
// 私钥只放在本机用户目录和 GitHub Actions secret UPDATE_SIGNING_KEY，绝不进仓库。
// （本机升级演练会在打包副本里改写这个文件，加 downloadBase 指向本机服务；正式配置不设 downloadBase。）
export const UPDATE_CONFIG = Object.freeze({
  repo: 'aiyinsitan520/learning-workbench',
  manifestUrl: 'https://github.com/aiyinsitan520/learning-workbench/releases/latest/download/latest.json',
  releasesUrl: 'https://github.com/aiyinsitan520/learning-workbench/releases',
  publicKey: null,
});

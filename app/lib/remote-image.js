import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { detectImageType, IMAGE_LIMIT } from './attachments.js';

export class RemoteImageError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function parseImageUrl(raw, base) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) throw new RemoteImageError(400, 'invalid-url');
  let url;
  try {
    url = new URL(raw, base);
  } catch {
    throw new RemoteImageError(400, 'invalid-url');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) {
    throw new RemoteImageError(400, 'invalid-url');
  }
  return url;
}

export async function readImageUrl(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RemoteImageError(400, 'invalid-url');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4096) throw new RemoteImageError(413, 'attachment-too-large');
    chunks.push(chunk);
  }
  try {
    return parseImageUrl(JSON.parse(Buffer.concat(chunks).toString('utf8'))?.url).href;
  } catch {
    throw new RemoteImageError(400, 'invalid-url');
  }
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(network, prefix, 'ipv4');

// 只接收 IPv6 全球单播，另排除特殊用途、文档及转换网段。
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blocked.addSubnet(network, prefix, 'ipv6');
}
const mappedV4 = new BlockList();
mappedV4.addSubnet('::ffff:0:0', 96, 'ipv6');

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6 || address.includes('%')) return false;
  // BlockList 的 IPv4 规则同样匹配 IPv4-mapped IPv6 地址。
  return (globalV6.check(address, 'ipv6') || mappedV4.check(address, 'ipv6')) && !blocked.check(address, 'ipv6');
}

async function requestImage(url, signal, lookup, isAllowedAddress) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await lookup(host, { all: true });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !isAllowedAddress(address))) {
    throw new RemoteImageError(403, 'blocked-address');
  }
  const pinned = addresses[0];
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.get(url, {
      signal, agent: false, family: pinned.family, autoSelectFamily: false,
      // 保留原域名用于 Host 和 TLS 证书检查；连接只使用本跳已校验的地址。
      lookup: (_hostname, _opts, callback) => callback(null, pinned.address, pinned.family),
      headers: { Accept: 'image/*', 'Accept-Encoding': 'identity', 'User-Agent': 'ImageFetcher/1.0' },
    }, resolve);
    req.on('error', reject);
  });
}

async function followImage(url, signal, lookup, isAllowedAddress) {
  for (let redirects = 0; ; redirects++) {
    const response = await requestImage(url, signal, lookup, isAllowedAddress);
    try {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        if (redirects === 3) throw new RemoteImageError(502, 'fetch-failed');
        url = parseImageUrl(response.headers.location, url);
        continue;
      }
      if (response.statusCode !== 200) throw new RemoteImageError(502, 'fetch-failed');
      if (Number(response.headers['content-length']) > IMAGE_LIMIT) throw new RemoteImageError(413, 'attachment-too-large');
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > IMAGE_LIMIT) throw new RemoteImageError(413, 'attachment-too-large');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, size);
      const type = detectImageType(bytes);
      if (!type) throw new RemoteImageError(415, 'invalid-image');
      return { bytes, type };
    } finally {
      response.destroy();
    }
  }
}

export async function fetchRemoteImage(raw, { lookup = dnsLookup, isAllowedAddress = isPublicAddress } = {}) {
  const url = parseImageUrl(raw);
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new RemoteImageError(504, 'fetch-timeout');
      controller.abort(error);
      reject(error);
    }, 10_000);
  });
  try {
    return await Promise.race([deadline, followImage(url, controller.signal, lookup, isAllowedAddress)]);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof RemoteImageError) throw error;
    throw new RemoteImageError(502, 'fetch-failed');
  } finally {
    clearTimeout(timer);
  }
}

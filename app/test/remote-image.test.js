import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchRemoteImage, isPublicAddress } from '../lib/remote-image.js';
import { IMAGE_LIMIT } from '../lib/attachments.js';

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const local = { address: '127.0.0.1', family: 4 };
const options = { lookup: async () => [local], isAllowedAddress: address => address === local.address };

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, local.address, resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return 'http://image.invalid:' + server.address().port;
}

test('uses only the validated DNS result, sends minimal headers and detects PNG by bytes', async t => {
  let headers, lookups = 0;
  const origin = await fixture(t, (req, res) => {
    headers = req.headers;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(png);
  });
  const result = await fetchRemoteImage(origin, { ...options, lookup: async (host, args) => {
    assert.equal(host, 'image.invalid');
    assert.deepEqual(args, { all: true });
    lookups++;
    return [local];
  } });
  assert.deepEqual(result, { bytes: png, type: 'image/png' });
  assert.equal(lookups, 1);
  assert.equal(headers.host, new URL(origin).host);
  assert.equal(headers.accept, 'image/*');
  assert.equal(headers['accept-encoding'], 'identity');
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.referer, undefined);
  assert.equal(headers['user-agent'], 'ImageFetcher/1.0');
});

test('allows only public addresses, including the embedded IPv4 in mapped addresses', () => {
  for (const address of ['0.1.2.3', '10.1.2.3', '100.127.255.255', '127.0.0.1', '169.254.1.2',
    '172.31.255.255', '192.0.0.1', '192.168.5.6', '198.19.255.255', '224.0.0.1', '240.1.2.3',
    '255.255.255.255']) {
    assert.equal(isPublicAddress(address), false, address);
    assert.equal(isPublicAddress('::ffff:' + address), false, address);
  }
  for (const address of ['::', '::1', 'fc00::1', 'fdab::1', 'febf::1', 'ff02::1', '::ffff:7f00:1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '::ffff:8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('blocks private literals and mixed DNS answers before connecting', async () => {
  const blocked = { status: 403, code: 'blocked-address' };
  for (const host of ['127.0.0.1', '[::1]', '[::ffff:127.0.0.1]']) {
    await assert.rejects(fetchRemoteImage('http://' + host), blocked);
  }
  await assert.rejects(fetchRemoteImage('http://mixed.invalid', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }, local],
  }), blocked);
});

test('rejects invalid URLs, credentials and unsupported protocols before lookup', async () => {
  for (const raw of ['::::', 'ftp://image.invalid', 'https://name:pw@image.invalid', 'http://image.invalid/' + 'x'.repeat(2048)]) {
    await assert.rejects(fetchRemoteImage(raw), { status: 400, code: 'invalid-url' });
  }
});

test('checks every redirect, allows three hops and stops before a fourth', async t => {
  const paths = [], resolved = [];
  const origin = await fixture(t, (req, res) => {
    paths.push(req.url);
    const hops = Number(req.url.slice(1));
    if (hops) res.writeHead(302, { location: '/' + (hops - 1) }).end();
    else res.end(png);
  });
  const pinned = { ...options, lookup: async host => { resolved.push(host); return [local]; } };
  assert.deepEqual((await fetchRemoteImage(origin + '/3', pinned)).bytes, png);
  assert.deepEqual(paths.splice(0), ['/3', '/2', '/1', '/0']);
  assert.equal(resolved.length, 4);
  await assert.rejects(fetchRemoteImage(origin + '/4', pinned), { status: 502, code: 'fetch-failed' });
  assert.deepEqual(paths, ['/4', '/3', '/2', '/1']);
});

test('revalidates redirects to blocked addresses and incompatible protocols', async t => {
  const origin = await fixture(t, (req, res) => {
    res.writeHead(307, { location: req.url === '/private' ? 'http://[::1]/image' : 'ftp://image.invalid/' }).end();
  });
  await assert.rejects(fetchRemoteImage(origin + '/private', options), { status: 403, code: 'blocked-address' });
  await assert.rejects(fetchRemoteImage(origin + '/scheme', options), { status: 400, code: 'invalid-url' });
});

test('rejects disguised SVG, non-200 responses and connection failures', async t => {
  const origin = await fixture(t, (req, res) => {
    res.writeHead(req.url === '/svg' ? 200 : 206, { 'Content-Type': 'image/png' }).end('<svg/>');
  });
  await assert.rejects(fetchRemoteImage(origin + '/svg', options), { status: 415, code: 'invalid-image' });
  await assert.rejects(fetchRemoteImage(origin + '/partial', options), { status: 502, code: 'fetch-failed' });
  await assert.rejects(fetchRemoteImage(origin, { lookup: async () => { throw new Error('DNS unavailable'); } }),
    { status: 502, code: 'fetch-failed' });
});

test('accepts 10 MiB and aborts a larger chunked stream before the server ends it', async t => {
  const bytes = Buffer.alloc(IMAGE_LIMIT);
  png.copy(bytes);
  const origin = await fixture(t, (req, res) => {
    res.write(bytes);
    if (req.url === '/limit') res.end();
    else res.write(png);
  });
  assert.equal((await fetchRemoteImage(origin + '/limit', options)).bytes.length, IMAGE_LIMIT);
  await assert.rejects(fetchRemoteImage(origin + '/over', options), { status: 413, code: 'attachment-too-large' });
});

test('the ten-second deadline also covers hanging DNS and continuously arriving body bytes', async t => {
  const origin = await fixture(t, (_req, res) => {
    res.write(png);
    const timer = setInterval(() => res.write(png), 200);
    res.on('close', () => clearInterval(timer));
  });
  const timeout = { status: 504, code: 'fetch-timeout' };
  const start = Date.now();
  await Promise.all([
    assert.rejects(fetchRemoteImage(origin, options), timeout),
    assert.rejects(fetchRemoteImage(origin, { lookup: () => new Promise(() => {}) }), timeout),
  ]);
  assert.ok(Date.now() - start >= 9900);
});

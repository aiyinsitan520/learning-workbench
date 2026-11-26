// 桌面版连服务器数据库时，发出的 Host 端口必须与远端服务实际端口一致。
// v1.3.1 及之前写死 7321，而服务器（T-W1 起）只认自己端口的 Host，于是一直 403，
// 桌面版退回本机旧库并弹「服务器数据库暂时连不上」。此处守住这条约定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'desktop', 'main.mjs'), 'utf8');

test('桌面版共享连接：Host 端口取自 sharedUrl，且远端是 17322', () => {
  const url = main.match(/let sharedUrl = '([^']+)'/)?.[1];
  assert.equal(new URL(url).port, '17322');
  assert.match(main, /let sharedServicePort = Number\(new URL\(sharedUrl\)\.port\);/);
  assert.doesNotMatch(main, /let sharedServicePort = \d+/);
});

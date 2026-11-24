import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, open } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const [pid, port] = process.argv.slice(2).map(Number);
if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Invalid restart arguments');
}

function oldServiceExited() {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}

function portFree() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

const deadline = Date.now() + 45_000;
while (!oldServiceExited() || !(await portFree())) {
  if (Date.now() >= deadline) process.exit(1);
  await setTimeout(250);
}

await mkdir('app/data', { recursive: true });
const stdout = await open('app/data/server.log', 'a');
const stderr = await open('app/data/server.log.err', 'a');
try {
  const service = spawn(process.execPath, ['app/server.js'], {
    env: { ...process.env, PORT: String(port) },
    detached: true, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd],
  });
  service.unref();
} finally {
  await stdout.close();
  await stderr.close();
}

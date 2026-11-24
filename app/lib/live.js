const POLL_MS = 1000;
const HEARTBEAT_MS = 25000;
const EVENT_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
};

export function createLive(workbench) {
  const clients = new Set();
  let version = workbench.dataVersion();
  let rev = 0;
  let closed = false;
  let poll;
  let heartbeat;

  function write(client, message) {
    if (!client.destroyed && !client.writableEnded && !client.write(message)) client.destroy();
  }

  function changed(origin) {
    const message = `event: change\ndata: ${JSON.stringify({ rev: ++rev, origin })}\n\n`;
    for (const client of clients) write(client, message);
  }

  function checkExternal() {
    const latest = workbench.dataVersion();
    if (latest === version) return;
    version = latest;
    changed('external');
  }

  function stopTimers() {
    clearInterval(poll);
    clearInterval(heartbeat);
  }

  return {
    committed: () => changed('self'),
    revision() {
      // 退回健康检查轮询时，可能没有任何 SSE 订阅者。
      checkExternal();
      return rev;
    },
    subscribe(res) {
      if (closed) {
        // 已到达的订阅也用正常 EOF 结束，让 EventSource 继续重连。
        res.writeHead(200, { ...EVENT_HEADERS, connection: 'close' });
        res.end();
        return;
      }
      checkExternal();
      res.writeHead(200, EVENT_HEADERS);
      clients.add(res);
      res.once('close', () => {
        clients.delete(res);
        if (!clients.size) stopTimers();
      });
      write(res, `event: hello\ndata: ${JSON.stringify({ rev })}\n\n`);
      if (clients.size === 1) {
        poll = setInterval(() => {
          try { checkExternal(); } catch { /* 下一次检查重试 */ }
        }, POLL_MS).unref();
        heartbeat = setInterval(() => {
          for (const client of clients) write(client, ': heartbeat\n\n');
        }, HEARTBEAT_MS).unref();
      }
    },
    close() {
      closed = true;
      stopTimers();
      for (const client of clients) {
        if (!client.destroyed && !client.writableEnded) client.end();
      }
      clients.clear();
    },
  };
}

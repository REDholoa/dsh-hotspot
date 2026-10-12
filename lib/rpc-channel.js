// RPC 通道：把插件自己的逻辑通道挂到 DSH 的 Web 服务器上。
//
// ── 为什么不能直接用 ctx.connection.rpc.handle() ──────────────────────────────
// DSH 的 HostConnectionService.rpc 是一个 getter，内部取 `this.ctx` 再调用
// `owner.webServer.register(route)`。而 `this.ctx` 解析到的是 **Connection 服务自己**
// 的 context（其 inject 只有 'credentials'，没有 webServer），并不是调用方插件。
// 实测在该版本上以插件身份调用会直接抛：
//     Error: cannot get property "webServer" without inject
// （Cordis 的 caller-context 追踪只对服务上的**原型方法**生效，对象 getter 返回的
//  方法逃过了包装，所以没有拿到调用方的 ctx。）
//
// ── 因此的做法 ───────────────────────────────────────────────────────────────
// 由本插件 inject 'webServer'，自己注册一条 prefix 路由，并在路由里逐字段复刻
// dsh-client-connection 的 /api 传输语义（信封校验、端点匹配、server-response 编码、
// 信任栅栏、node:http ⇄ fetch 桥接）。客户端侧完全不用改：
//     ctx.connection.rpc.call('/dsh-hotspot', 'feed', payload)
// 仍然是同一条线上协议。
//
// 行为与上游 1:1 对齐的点：
//   · 只接受 POST + application/json；
//   · 路径必须形如 {channel}/{endpoint}，端点为单段且字符集受限；
//   · 信封形如 { rpcId, method, payload }，method 必须等于 endpoint；
//   · 成功/失败都回 200 + { type:'server-response', rpcId, result }；
//   · 非 POST / 端点不合法 → 404；content-type 不对 → 415；body 非 JSON → 400；
//   · handler 抛异常 → 500（框架层错误，不是业务失败）。

/** 端点段允许的字符（与上游 ENDPOINT_SEGMENT_PATTERN 一致）。 */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/** 信封非法且无法取得 rpcId 时使用的兜底 id（与上游 INVALID_REQUEST_RPC_ID 一致）。 */
const INVALID_REQUEST_RPC_ID = 'invalid-request';

/**
 * 请求体上限：本插件的所有 endpoint 都只收发小体积控制 JSON，
 * 1 MiB 远大于实际需要，同时避免无界缓冲。
 */
const MAX_BODY_BYTES = 1024 * 1024;

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 从 `{channel}/<endpoint>` 中取出 endpoint；任何一段非法都返回 undefined。 */
function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  const segments = endpoint.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined;
  }
  return endpoint;
}

/** 构造 server-response 信封（与上游 fullResponse 的 JSON 分支一致）。 */
function fullResponse(rpcId, result) {
  if (!result || result.ok !== true) {
    return Response.json({ type: 'server-response', rpcId, result: result ?? { ok: false, error: { code: 'bad-request', message: 'empty result', details: {} } } });
  }
  const { attachments: _attachments, ...success } = result;
  return Response.json({ type: 'server-response', rpcId, result: success });
}

/** 构造失败信封。 */
function errorResponse(rpcId, code, message, details = {}) {
  return fullResponse(rpcId, { ok: false, error: { code, message, details } });
}

/**
 * 只有 ctx.connection.requestRejection 不可用时才会走到的兜底信任栅栏：
 * 仅放行 loopback Host，拒绝跨站 fetch 与 Origin 不匹配的请求。
 * 注意它不包含浏览器的会话 Cookie 认证，所以只是「不更弱于 loopback」的下限。
 */
function isTrustedLoopbackRequest(req) {
  const host = req.headers?.host;
  if (!host) return false;
  const hostname = host.split(':')[0];
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * node:http 请求 → fetch-shaped handler → node:http 响应。
 * 只实现 buffered 模式（本插件的请求体都很小），保留上游的背压与中断语义。
 */
async function bridge(req, res, fetchHandler) {
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  const url = new URL(req.url ?? '/', 'http://dsh.internal');
  const method = req.method ?? 'GET';
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([, value]) => typeof value === 'string'));

  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
    res.writeHead(413, { connection: 'close' });
    res.end();
    req.destroy();
    return;
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.byteLength;
    if (received > MAX_BODY_BYTES) {
      res.writeHead(413, { connection: 'close' });
      res.end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  }

  const request = new Request(url, {
    method,
    headers,
    ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
    signal: abort.signal,
  });

  const response = await fetchHandler.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body === null) {
    res.end();
    return;
  }
  for await (const chunk of response.body) {
    if (abort.signal.aborted) continue;
    if (!res.write(chunk) && !res.destroyed) {
      await new Promise((resolve) => {
        const done = () => {
          res.off('drain', done);
          res.off('close', done);
          resolve();
        };
        res.once('drain', done);
        res.once('close', done);
      });
    }
  }
  res.end();
}

/** 构造 fetch 形状的 handler：信封校验 + 端点分发。 */
function createFetchHandler(channel, handler, log) {
  return {
    async fetch(request) {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname);
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 });
      }
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('body is not JSON', { status: 400 });
      }

      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : INVALID_REQUEST_RPC_ID;
      const method = typeof body?.method === 'string' ? body.method : null;
      if (rpcId === INVALID_REQUEST_RPC_ID || method === null) {
        return errorResponse(rpcId, 'gateway/bad-request', 'invalid client-request message', { issues: [] });
      }
      if (method !== endpoint) {
        return errorResponse(
          rpcId,
          'gateway/bad-request',
          `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          { issues: [] },
        );
      }

      try {
        return fullResponse(rpcId, await handler(endpoint, body.payload, request.signal));
      } catch (error) {
        log?.error?.('RPC %s 处理失败：%s', endpoint, error?.message ?? error);
        return new Response(`handler failure: ${String(error)}`, { status: 500 });
      }
    },
  };
}

/**
 * 注册一条 RPC 逻辑通道。
 *
 * 必须在 `apply(ctx)` 中直接调用：这里读写的是**本插件自己的** ctx.webServer，
 * 所以路由会随本插件的 fiber 一起注册与释放（不需要手动保管 disposer）。
 *
 * @param {object} ctx 插件 context（inject 必须包含 'webServer'）
 * @param {string} channel 形如 '/dsh-hotspot'
 * @param {(endpoint: string, payload: unknown, signal: AbortSignal) => Promise<object>} handler
 * @param {{ error?: Function, warn?: Function }} [log]
 * @returns {void}
 */
export function installRpcChannel(ctx, channel, handler, log) {
  const connection = ctx.connection;
  const fetchHandler = createFetchHandler(channel, handler, log);

  const route = {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      let rejection;
      if (typeof connection?.requestRejection === 'function') {
        // 必须以方法形式调用：上游实现内部要读 this.trustedHosts / this.browserAuth，
        // 抽成裸函数再调用会因丢失 this 而恒判 403。
        try {
          rejection = connection.requestRejection(req);
        } catch {
          rejection = 403;
        }
      } else if (!isTrustedLoopbackRequest(req)) {
        rejection = 403;
      }

      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }

      await bridge(req, res, fetchHandler);
    },
  };

  ctx.effect(() => ctx.webServer.register(route), `dsh-hotspot: ${channel} rpc channel`);
}

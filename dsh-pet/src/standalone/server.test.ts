/**
 * 独立模式 HTTP 服务的契约测试。
 *
 * 这一层**不碰插件**（路由注入假 handler）：它钉的是独立模式自己写的那部分 ——
 * 前缀转交、运维端点（`/`、`/health`、`/shutdown`）、异常收口、端口顺延与关闭释放。
 * 插件路由表本身的契约由 integration.test.ts 覆盖（那份是真实 apply 注册出来的）。
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RegisteredRoute, StandaloneLogger } from './context.ts';
import { createRequestListener, listenStandaloneServer } from './server.ts';
import { createRequestSecurity } from './request-security.ts';
const security = createRequestSecurity();

/** 造一段 32kHz 单声道 16-bit WAV（前 0.4s 静音，其余正常音量正弦波） */
function makeWav(seconds: number): Buffer {
  const sampleRate = 32_000;
  const count = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    const t = i / sampleRate;
    const value = t < 0.4 ? 0 : Math.sin(2 * Math.PI * 220 * t) * 0.2;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 静默日志器（测试只断言行为） */
const silent: StandaloneLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** 最小响应桩：记状态码/响应头/正文，并支持断言"已断连" */
class FakeRes {
  status = 0;
  headers: Record<string, string> = {};
  headersSent = false;
  destroyed = false;
  private readonly chunks: string[] = [];

  getHeaderNames(): string[] {
    return Object.keys(this.headers);
  }
  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  removeHeader(name: string): void {
    delete this.headers[name];
  }

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }

  end(chunk?: string): void {
    if (typeof chunk === 'string') this.chunks.push(chunk);
  }

  destroy(): void {
    this.destroyed = true;
  }

  body(): string {
    return this.chunks.join('');
  }
}

/** 用假 req/res 驱动监听器（不必真的起 socket） */
function call(listener: (req: IncomingMessage, res: ServerResponse) => void, url: string, method = 'GET'): FakeRes {
  const res = new FakeRes();
  // 只给监听器真正会读的两个字段（method/url）；其余成员本测试不触碰
  listener(
    {
      method,
      url,
      headers: { host: '127.0.0.1:3080', 'x-dsh-pet-token': security.token },
      socket: { localPort: 3080 },
    } as unknown as IncomingMessage,
    res as unknown as ServerResponse,
  );
  return res;
}

/** 一个"插件式"路由：handler 自己写头与 body（与 DSH WebServer 的契约一致） */
function pluginLikeRoute(onCall?: (url: string) => void): RegisteredRoute {
  return {
    kind: 'prefix',
    path: '/dsh-pet-7340',
    handler: (req, res) => {
      onCall?.(req.url ?? '');
      const payload = JSON.stringify({ ok: true, seen: req.url });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(payload);
    },
  };
}

/** 占住一个端口，返回端口号与关闭函数 */
async function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => res.end('busy'));
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', () => accept()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { port, close: () => new Promise<void>((accept) => server.close(() => accept())) };
}

describe('createRequestListener —— 转交给插件路由', () => {
  test('前缀下的请求原样交给插件 handler（URL 含前缀，由插件自己切）', () => {
    let seen = '';
    const listener = createRequestListener({
      routes: [pluginLikeRoute((url) => (seen = url))],
      logger: silent,
      security,
    });
    const res = call(listener, '/dsh-pet-7340/config?force=1');
    assert.equal(res.status, 200);
    assert.equal(seen, '/dsh-pet-7340/config?force=1', '插件 handler 拿到的必须是完整 URL（它自己 slice 前缀）');
    assert.equal(res.body(), JSON.stringify({ ok: true, seen: '/dsh-pet-7340/config?force=1' }));
  });

  test('前缀之外 → 404，并把已注册路由列出来（"插件没注册"要能一眼看出）', () => {
    const listener = createRequestListener({ routes: [pluginLikeRoute()], logger: silent, security });
    const res = call(listener, '/nope');
    assert.equal(res.status, 404);
    assert.match(res.body(), /\/dsh-pet-7340/, '404 正文应带上已注册前缀');
    assert.equal(res.headers['access-control-allow-origin'], undefined, '独立模式禁止跨源读取');
  });

  test('kind=exact 的路由按全等匹配，不吃子路径', () => {
    const exact: RegisteredRoute = {
      kind: 'exact',
      path: '/dsh-pet-7340/state',
      handler: (_req, res) => {
        res.writeHead(200);
        res.end('exact');
      },
    };
    const listener = createRequestListener({ routes: [exact], logger: silent, security });
    assert.equal(call(listener, '/dsh-pet-7340/state').body(), 'exact');
    assert.equal(call(listener, '/dsh-pet-7340/state/extra').status, 404);
  });

  test('/ 与 /health → 运维 JSON（自定义 status 提供者）', () => {
    const listener = createRequestListener({
      routes: [],
      logger: silent,
      security,
      status: () => ({ name: 'dsh-pet-standalone', port: 3080 }),
    });
    for (const path of ['/', '/health']) {
      const res = call(listener, path);
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body()), { name: 'dsh-pet-standalone', port: 3080 });
      assert.equal(res.headers['access-control-allow-origin'], '*');
    }
  });

  test('OPTIONS → 204，无跨源头，且不落到插件 handler', () => {
    let calls = 0;
    const listener = createRequestListener({
      routes: [pluginLikeRoute(() => (calls += 1))],
      logger: silent,
      security,
    });
    const res = call(listener, '/dsh-pet-7340/config', 'OPTIONS');
    assert.equal(res.status, 204);
    assert.equal(calls, 0, '预检不该进插件路由');
    assert.equal(res.headers['access-control-allow-headers'], undefined);
  });

  test('/shutdown → 先回 200，再触发收尾回调（调用方要能拿到响应）', async () => {
    const reasons: string[] = [];
    const listener = createRequestListener({
      routes: [pluginLikeRoute()],
      logger: silent,
      security,
      onShutdown: () => reasons.push('shutdown'),
    });
    const res = call(listener, '/shutdown', 'POST');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body()), { ok: true, stopping: true });
    assert.deepEqual(reasons, [], '回调必须排在响应之后（否则调用方可能等不到 200）');
    await new Promise((accept) => setImmediate(accept));
    assert.deepEqual(reasons, ['shutdown']);
  });
});

describe('createRequestListener —— 异常收口', () => {
  test('handler 抛错且未写头 → 500 JSON（与插件自身的 500 口径一致）', () => {
    const exploding: RegisteredRoute = {
      kind: 'prefix',
      path: '/dsh-pet-7340',
      handler: () => {
        throw new Error('读盘失败');
      },
    };
    const res = call(createRequestListener({ routes: [exploding], logger: silent, security }), '/dsh-pet-7340/config');
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body()), { error: '本机服务暂时无法处理请求' });
  });

  test('handler 异步拒绝同样收口为 500', async () => {
    const exploding: RegisteredRoute = {
      kind: 'prefix',
      path: '/dsh-pet-7340',
      handler: async () => {
        throw new Error('异步失败');
      },
    };
    const res = call(createRequestListener({ routes: [exploding], logger: silent, security }), '/dsh-pet-7340/config');
    await new Promise((accept) => setImmediate(accept));
    assert.equal(res.status, 500);
    assert.match(res.body(), /本机服务暂时无法处理请求/);
  });

  test('头已发出的失败：断连而不是写坏响应（与插件 sendFile 的错误口径一致）', () => {
    const partial: RegisteredRoute = {
      kind: 'prefix',
      path: '/dsh-pet-7340',
      handler: (_req, res) => {
        res.writeHead(200);
        res.end('前半段');
        throw new Error('写一半炸了');
      },
    };
    const res = call(createRequestListener({ routes: [partial], logger: silent, security }), '/dsh-pet-7340/x');
    assert.equal(res.status, 200, '已经写出的头不改写');
    assert.equal(res.destroyed, true, '已写头之后必须断连');
  });
});

describe('listenStandaloneServer —— 端口与关闭', () => {
  const closers: Array<() => Promise<void>> = [];

  after(async () => {
    for (const close of closers.splice(0)) await close().catch(() => {});
  });

  test('首选端口被占用时向后顺延，关闭后端口真正释放', async () => {
    const blocker = await occupyPort();
    closers.push(blocker.close);
    const server = await listenStandaloneServer({
      routes: [pluginLikeRoute()],
      logger: silent,
      security,
      port: blocker.port,
    });
    closers.push(server.close);
    assert.ok(server.port > blocker.port, `期望顺延，实际 ${server.port}（被占 ${blocker.port}）`);

    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { name?: string };
    assert.equal(body.name, 'dsh-pet-standalone');

    const port = server.port;
    await server.close();
    // 关闭必须释放端口：再用同一个端口起一个服务应成功（keep-alive 连接没被断掉的话这里会 EADDRINUSE）
    const reuse = createServer((_req, res) => res.end('reused'));
    await new Promise<void>((accept, reject) => {
      reuse.once('error', reject);
      reuse.listen(port, '127.0.0.1', () => accept());
    });
    await new Promise<void>((accept) => reuse.close(() => accept()));
  });

  test('插件路由经真实 HTTP 可用（前缀下 200，前缀外 404）', async () => {
    const server = await listenStandaloneServer({ routes: [pluginLikeRoute()], logger: silent, security, port: 0 });
    closers.push(server.close);
    const inside = await fetch(`http://127.0.0.1:${server.port}/dsh-pet-7340/state`, {
      headers: { 'X-DSH-Pet-Token': security.token },
    });
    assert.equal(inside.status, 200);
    const outside = await fetch(`http://127.0.0.1:${server.port}/whatever`, {
      headers: { 'X-DSH-Pet-Token': security.token },
    });
    assert.equal(outside.status, 404);
  });
});

describe('HTTP boundary protects every route and settings', () => {
  test('blocks attacks, paid GET, unauthenticated reads and legacy wildcard CORS', async () => {
    let calls = 0;
    const server = await listenStandaloneServer({
      port: 0,
      security,
      logger: silent,
      routes: [
        {
          kind: 'prefix',
          path: '/dsh-pet-7340',
          handler: (_req, res) => {
            calls++;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'access-control-allow-headers': '*' });
            res.end('ok');
          },
        },
      ],
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      for (const path of ['/standalone-ai/settings', '/dsh-pet-7340/whisper', '/shutdown']) {
        assert.equal(
          (
            await fetch(base + path, {
              method: path === '/dsh-pet-7340/whisper' || path === '/shutdown' ? 'POST' : 'GET',
            })
          ).status,
          403,
        );
      }
      const headersList: Array<Record<string, string>> = [
        { Origin: 'https://evil.test' },
        { Origin: 'null' },
        { 'Sec-Fetch-Site': 'cross-site' },
      ];
      for (const headers of headersList) {
        assert.equal(
          (await fetch(base + '/health', { headers: { ...headers, 'X-DSH-Pet-Token': security.token } })).status,
          403,
          JSON.stringify(headers),
        );
      }
      const wrongHost = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(base + '/health', { headers: { Host: 'evil.test' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(wrongHost, 403);
      assert.equal(calls, 0);
      const response = await fetch(base + '/dsh-pet-7340/config', { headers: { 'X-DSH-Pet-Token': security.token } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal(response.headers.get('access-control-allow-headers'), null);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal((await fetch(base + '/shutdown', { headers: { 'X-DSH-Pet-Token': security.token } })).status, 405);
    } finally {
      await server.close();
    }
  });
  test('settings reads/saves are redacted, local-only, validated, bounded and rate limited', async () => {
    let saves = 0;
    const ai = {
      getSettings: () => ({ protocol: 'anthropic', model: 'x', hasKey: true, apiKey: 'secret-from-backend' }),
      saveSettings: async (input: unknown) => {
        saves++;
        return { ...(input as object), hasKey: true, apiKey: 'secret-from-backend' };
      },
      testConnection: async (input: { baseUrl?: string }) => {
        void input;
        return { ok: true, message: '连接成功', reply: 'pong' };
      },
      testTts: async (input?: { voice?: string; rate?: number }) => {
        ttsInput = input;
        return { ok: true, message: '合成成功', url: '/dsh-pet-7340/tts/x.mp3', text: '试听文本' };
      },
    };
    const server = await listenStandaloneServer({ port: 0, security, logger: silent, routes: [], ai });
    let ttsInput: { voice?: string; rate?: number; provider?: string; voiceId?: string; localUrl?: string } | undefined;
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const headers = { 'X-DSH-Pet-Token': security.token, 'Content-Type': 'application/json' };
      const shell = await fetch(base + '/standalone-ai/');
      assert.equal(shell.status, 200);
      assert.match(shell.headers.get('content-security-policy') ?? '', /default-src 'none'/);
      assert.match(shell.headers.get('content-security-policy') ?? '', /media-src 'self'/, '试听要能加载音频');
      assert.doesNotMatch(await shell.text(), new RegExp(security.token));
      assert.equal((await fetch(base + '/standalone-ai/settings')).status, 403);
      const read = await fetch(base + '/standalone-ai/settings', { headers });
      assert.deepEqual(await read.json(), { protocol: 'anthropic', model: 'x', hasKey: true });
      for (const body of ['null', '{broken', '{"whisperIntervalSec":59}']) {
        assert.equal((await fetch(base + '/standalone-ai/settings', { method: 'POST', headers, body })).status, 400);
      }
      assert.equal(saves, 0);
      assert.equal(
        (
          await fetch(base + '/standalone-ai/settings', {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: 'x'.repeat(17000) }),
          })
        ).status,
        413,
      );
      assert.equal(
        (
          await fetch(base + '/standalone-ai/settings', {
            method: 'POST',
            headers: { 'X-DSH-Pet-Token': security.token, 'Content-Type': 'text/plain' },
            body: '{}',
          })
        ).status,
        415,
      );
      const saved = await fetch(base + '/standalone-ai/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ apiKey: '', enabled: false }),
      });
      assert.equal(saved.status, 200);
      assert.deepEqual(await saved.json(), { enabled: false, hasKey: true });
      assert.equal(saves, 1);
      assert.equal((await fetch(base + '/standalone-ai/test')).status, 403);
      assert.equal((await fetch(base + '/standalone-ai/test', { headers })).status, 405);
      const testRes = await fetch(base + '/standalone-ai/test', { method: 'POST', headers, body: '{}' });
      assert.equal(testRes.status, 200);
      assert.deepEqual(await testRes.json(), { ok: true, message: '连接成功', reply: 'pong' });
      // 语音试听：与测试连接同一套令牌/方法口径；表单里未保存的音色/语速要原样传到底层
      assert.equal((await fetch(base + '/standalone-ai/tts/test')).status, 403);
      assert.equal((await fetch(base + '/standalone-ai/tts/test', { headers })).status, 405);
      const ttsRes = await fetch(base + '/standalone-ai/tts/test', {
        method: 'POST',
        headers,
        body: JSON.stringify({ voice: 'zh-CN-XiaoyiNeural', rate: 10 }),
      });
      assert.equal(ttsRes.status, 200);
      assert.deepEqual(await ttsRes.json(), {
        ok: true,
        message: '合成成功',
        url: '/dsh-pet-7340/tts/x.mp3',
        text: '试听文本',
      });
      assert.equal(ttsInput?.voice, 'zh-CN-XiaoyiNeural');
      assert.equal(ttsInput?.rate, 10);
      assert.equal(ttsInput?.provider, undefined);
      assert.equal(ttsInput?.voiceId, undefined);
      assert.equal(ttsInput?.localUrl, undefined);
      assert.equal(
        (await fetch(base + '/standalone-ai/tts/test', { method: 'POST', headers, body: '{broken' })).status,
        400,
      );
      let last = 0;
      for (let i = 0; i < 25; i++)
        last = (await fetch(base + '/standalone-ai/settings', { method: 'POST', headers, body: '{}' })).status;
      assert.equal(last, 429);
    } finally {
      await server.close();
    }
  });
  test('even delegated plugin bodies are capped before handler invocation', async () => {
    let calls = 0;
    const server = await listenStandaloneServer({
      port: 0,
      security,
      logger: silent,
      routes: [
        pluginLikeRoute(() => {
          calls++;
        }),
      ],
    });
    try {
      const result = await fetch(`http://127.0.0.1:${server.port}/dsh-pet-7340/config`, {
        method: 'POST',
        headers: { 'X-DSH-Pet-Token': security.token },
        body: 'x'.repeat(1024 * 1024 + 1),
      });
      assert.equal(result.status, 413);
      assert.equal(calls, 0);
    } finally {
      await server.close();
    }
  });
});

test('bounded body replay preserves plugin readBody; chunked and stalled inputs never invoke handlers', async () => {
  let calls = 0;
  const server = await listenStandaloneServer({
    port: 0,
    security,
    logger: silent,
    bodyTimeoutMs: 30,
    routes: [
      {
        kind: 'prefix',
        path: '/plugin',
        handler: async (req, res) => {
          calls++;
          const chunks: Buffer[] = [];
          await new Promise<void>((resolve, reject) => {
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.once('end', resolve);
            req.once('error', reject);
          });
          res.end(Buffer.concat(chunks));
        },
      },
    ],
  });
  try {
    const url = `http://127.0.0.1:${server.port}/plugin`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-DSH-Pet-Token': security.token },
      body: '中文 body',
    });
    assert.equal(await response.text(), '中文 body');
    assert.equal(calls, 1);
    async function chunked(body: string): Promise<number> {
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          url,
          { method: 'POST', headers: { 'X-DSH-Pet-Token': security.token, 'Transfer-Encoding': 'chunked' } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
            req.destroy();
          },
        );
        req.on('error', reject);
        req.write(body);
      });
    }
    assert.equal(await chunked('x'.repeat(1024 * 1024 + 1)), 413);
    assert.equal(await chunked('not finished'), 408);
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});

test('录制向导：页面公开、API 要令牌；会话/录音/完成整条链路落盘', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pet-voice-http-'));
  const server = await listenStandaloneServer({ port: 0, security, logger: silent, routes: [], home });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { 'X-DSH-Pet-Token': security.token };
    const json = { ...headers, 'Content-Type': 'application/json' };

    const shell = await fetch(base + '/standalone-ai/voice');
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-security-policy') ?? '', /media-src 'self' blob:/);
    assert.match(await shell.text(), /声音录制向导/);

    // 页面外壳公开，数据接口一律要令牌
    assert.equal((await fetch(base + '/standalone-ai/voice/script')).status, 403);
    assert.equal((await fetch(base + '/standalone-ai/voice/sessions')).status, 403);

    const scriptRes = await fetch(base + '/standalone-ai/voice/script', { headers });
    assert.equal(scriptRes.status, 200);
    const script = await scriptRes.json();
    assert.equal(script.ok, true);
    assert.equal(script.sentences.length, 40);
    assert.equal(script.sampleRate, 32_000);
    assert.equal(script.categories.long, '长句停顿');

    // 未同意 → 业务失败（200 + ok:false），不创建目录
    const refused = await fetch(base + '/standalone-ai/voice/session', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: '小蓝', consent: false }),
    });
    assert.equal(refused.status, 200);
    assert.equal((await refused.json()).ok, false);

    const created = await fetch(base + '/standalone-ai/voice/session', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: '小蓝', consent: true }),
    });
    assert.equal(created.status, 200);
    const session = (await created.json()).session;
    assert.match(session.id, /^v-\d{8}-\d{6}-[0-9a-f]{4}$/);

    // 内容类型不对 → 415；合法 WAV → 质检结果 + 落盘
    const wrongType = await fetch(base + `/standalone-ai/voice/session/${session.id}/clip/1`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'text/plain' },
      body: 'x',
    });
    assert.equal(wrongType.status, 415);
    const clipRes = await fetch(base + `/standalone-ai/voice/session/${session.id}/clip/1`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'audio/wav' },
      body: makeWav(3),
    });
    assert.equal(clipRes.status, 200);
    const clip = await clipRes.json();
    assert.equal(clip.ok, true, clip.message);
    assert.equal(clip.clip.id, 1);
    assert.deepEqual(clip.issues, []);
    assert.ok(Math.abs(clip.clip.metrics.durationSec - 3) < 0.1);
    const sessionDir = join(home, 'dsh-pet', 'voices', session.id);
    assert.equal(existsSync(join(sessionDir, 'dataset', '1.wav')), true);
    assert.equal(existsSync(join(sessionDir, 'dataset', '1.txt')), true);

    const finishRes = await fetch(base + `/standalone-ai/voice/session/${session.id}/finish`, {
      method: 'POST',
      headers: json,
      body: '{}',
    });
    assert.equal(finishRes.status, 200);
    const finished = await finishRes.json();
    assert.equal(finished.ok, true, finished.message);
    assert.equal(finished.ref, 'ref.wav');
    assert.equal(existsSync(join(sessionDir, 'ref.wav')), true);

    const sessions = await (await fetch(base + '/standalone-ai/voice/sessions', { headers })).json();
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0].name, '小蓝');
    assert.equal(sessions.sessions[0].recorded, 1);

    assert.equal((await fetch(base + '/standalone-ai/voice/nope', { headers })).status, 404);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

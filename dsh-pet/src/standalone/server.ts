/** Standalone loopback HTTP boundary. Desktop bridge requests never pass through this listener. */
import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { RegisteredRoute, StandaloneLogger } from './context';
import { createRequestSecurity, rejectRequest, secureResponse } from './request-security';
import type { RequestSecurity } from './request-security';
import { boundedRequest, MAX_REQUEST_BYTES, MAX_SETTINGS_BYTES, MAX_VOICE_PACK_BYTES } from './request-body';
import { publicSettings, validateSettings } from './settings';
import type { StandaloneSettingsService } from './settings';
import { settingsPage, settingsScript, settingsStyle } from './settings-page';
import { voicePage, voiceScript, voiceStyle } from './voice-page';
import { createVoiceStudio, listVoiceSessions } from './voice-recording';
import { VOICE_CATEGORY_LABELS, VOICE_SENTENCES } from './voice-sentences';
import { VOICE_MAX_SEC, VOICE_MIN_SEC, VOICE_SAMPLE_RATE } from './voice-format';
import { parseVoicePack, readVoicePackFolder, readVoiceZip } from './voice-pack';

export const DEFAULT_STANDALONE_PORT = 3080;
export const PORT_SCAN_LIMIT = 25;
export interface StandaloneServerOptions {
  routes: RegisteredRoute[];
  logger: StandaloneLogger;
  port?: number;
  status?: () => unknown;
  onShutdown?: () => void;
  security?: RequestSecurity;
  ai?: StandaloneSettingsService;
  /** DSH_HOME（= ~/.dsh）：录制会话落到 `<home>/dsh-pet/voices/`；不传时录制 API 回 503 */
  home?: string;
  /** Override only for deterministic timeout tests. */
  bodyTimeoutMs?: number;
}
export interface StandaloneServer {
  port: number;
  security: RequestSecurity;
  close(): Promise<void>;
}

function matches(route: RegisteredRoute, pathname: string): boolean {
  if (route.kind === 'exact') return pathname === route.path;
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}
function sendJson(res: ServerResponse, status: number, body: unknown, cors = false): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...(cors ? { 'access-control-allow-origin': '*' } : {}),
  });
  res.end(payload);
}
function sendAsset(res: ServerResponse, body: string, type: string): void {
  res.writeHead(200, {
    'content-type': `${type}; charset=utf-8`,
    'content-length': Buffer.byteLength(body),
    'content-security-policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  });
  res.end(body);
}
function fail(res: ServerResponse, _error: unknown, logger: StandaloneLogger): void {
  // Never echo or log provider errors: they may contain API keys or credential-bearing URLs.
  logger.error('独立模式路由处理失败（详细内容已省略以保护凭据）');
  if (res.headersSent) res.destroy();
  else sendJson(res, 500, { error: '本机服务暂时无法处理请求' });
}

function settingsHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let windowStart = Date.now();
  let count = 0;
  return async (req, res) => {
    if (!ai) {
      rejectRequest(res, 503, '本机 AI 设置尚未就绪');
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, {
        ...publicSettings(ai.getSettings()),
        ...(typeof ai.historyFilePath === 'function' ? { historyFile: ai.historyFilePath() } : {}),
      });
      return;
    }
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 GET 或 POST');
      return;
    }
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      count = 0;
    }
    count += 1;
    if (count > 20) {
      rejectRequest(res, 429, '保存过于频繁，请稍后再试');
      return;
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      rejectRequest(res, 415, '请使用 JSON 保存设置');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        req.once('end', resolve);
        req.once('error', reject);
      });
      const input = validateSettings(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      sendJson(res, 200, publicSettings(await ai.saveSettings(input)));
    } catch {
      rejectRequest(res, 400, '设置未保存：请检查接口地址、模型名称、密钥和数值范围');
    }
  };
}

function testHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 POST');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        req.once('end', resolve);
        req.once('error', reject);
      });
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      const input = bodyStr ? JSON.parse(bodyStr) : {};
      if (ai?.testConnection) {
        const result = await ai.testConnection(input);
        sendJson(res, 200, result);
      } else {
        sendJson(res, 200, { ok: false, message: '当前环境未配置测试能力' });
      }
    } catch {
      sendJson(res, 400, { ok: false, message: '请求格式无效' });
    }
  };
}

/**
 * 设置页「试听」：语音播放已经改到渲染端，所以这里只负责**合成**并回一个同源音频地址，
 * 播不播、怎么播由设置页自己的 HTMLAudioElement 决定（与桌宠窗口同一条渲染端链路）。
 * 合成失败（没装 Python / 没装 edge-tts / 断网）一律回 `ok:false` + 用户能动手的提示。
 */
function ttsTestHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!ai?.testTts) {
      rejectRequest(res, 503, '语音试听尚未就绪');
      return;
    }
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 POST');
      return;
    }
    let payload: unknown;
    try {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        req.once('end', resolve);
        req.once('error', reject);
      });
      const raw = Buffer.concat(chunks).toString('utf8');
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      rejectRequest(res, 400, '请求格式无效');
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      rejectRequest(res, 400, '请求格式无效');
      return;
    }
    const input = payload as {
      voice?: unknown;
      rate?: unknown;
      provider?: unknown;
      voiceId?: unknown;
      localUrl?: unknown;
    };
    sendJson(
      res,
      200,
      await ai.testTts({
        // 表单里未保存的引擎/音色/声线也能试听；类型不对就交给上层回落已保存值
        voice: typeof input.voice === 'string' ? input.voice : undefined,
        rate: typeof input.rate === 'number' && Number.isFinite(input.rate) ? input.rate : undefined,
        provider: input.provider === 'local' || input.provider === 'edge' ? input.provider : undefined,
        voiceId: typeof input.voiceId === 'string' ? input.voiceId : undefined,
        localUrl: typeof input.localUrl === 'string' ? input.localUrl : undefined,
      }),
    );
  };
}

function historyExportHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      rejectRequest(res, 405, '仅支持 GET');
      return;
    }
    const file = typeof ai?.historyFilePath === 'function' ? ai.historyFilePath() : undefined;
    if (!file) {
      rejectRequest(res, 404, '历史文件路径不可用');
      return;
    }
    let payload = '{}';
    try {
      payload = await readFile(file, 'utf8');
    } catch {
      // 还没有历史文件：导出一份空记录，不当作错误
    }
    const name = `dsh-pet-history-${new Date().toISOString().slice(0, 10)}.json`;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'content-disposition': `attachment; filename="${name}"`,
    });
    res.end(payload);
  };
}

function historyClearHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 POST');
      return;
    }
    const file = typeof ai?.historyFilePath === 'function' ? ai.historyFilePath() : undefined;
    if (!file) {
      rejectRequest(res, 404, '历史文件路径不可用');
      return;
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{}\n', 'utf8');
    sendJson(res, 200, { ok: true, path: file });
  };
}

/** 读取一个 JSON 对象请求体（录制会话创建等小请求） */
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.once('end', resolve);
    req.once('error', reject);
  });
  const raw = Buffer.concat(chunks).toString('utf8');
  const parsed: unknown = raw ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求格式无效');
  return parsed as Record<string, unknown>;
}

/** 读取二进制请求体（WAV 上传；boundedRequest 已按 MAX_REQUEST_BYTES 卡过总大小） */
async function readBinaryBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.once('end', resolve);
    req.once('error', reject);
  });
  return Buffer.concat(chunks);
}

function sessionSummaryOf(value: { id: string; name: string; dir: string; total: number; recorded: number }): {
  id: string;
  name: string;
  dir: string;
  total: number;
  recorded: number;
} {
  return { id: value.id, name: value.name, dir: value.dir, total: value.total, recorded: value.recorded };
}

/**
 * 录制向导的 API（全部要 `x-dsh-pet-token`；页面外壳本身是 publicRead）。
 *
 * 业务失败统一 HTTP 200 + `{ ok:false, message }`：页面直接把 message 显示给用户，
 * 不需要区分 4xx 种类；真正的协议错误（方法不对、body 非对象）才用 4xx。
 */
function voiceApiHandler(
  studio: ReturnType<typeof createVoiceStudio> | undefined,
  voicesRoot: string,
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<void> {
  return async (req, res, pathname) => {
    if (!studio) {
      rejectRequest(res, 503, '录制功能尚未就绪（未提供 DSH_HOME）');
      return;
    }
    const method = req.method ?? 'GET';
    if (pathname === '/standalone-ai/voice/script') {
      if (method !== 'GET' && method !== 'HEAD') {
        rejectRequest(res, 405, '仅支持 GET');
        return;
      }
      sendJson(res, 200, {
        ok: true,
        sampleRate: VOICE_SAMPLE_RATE,
        minSec: VOICE_MIN_SEC,
        maxSec: VOICE_MAX_SEC,
        categories: VOICE_CATEGORY_LABELS,
        sentences: VOICE_SENTENCES,
      });
      return;
    }
    if (pathname === '/standalone-ai/voice/sessions') {
      if (method !== 'GET' && method !== 'HEAD') {
        rejectRequest(res, 405, '仅支持 GET');
        return;
      }
      const settings = ai?.getSettings?.() as { ttsVoiceId?: unknown } | undefined;
      const activeId = typeof settings?.ttsVoiceId === 'string' ? settings.ttsVoiceId : '';
      const sessions = (await listVoiceSessions(voicesRoot)).map((session) => ({
        ...session,
        active: session.id === activeId,
      }));
      sendJson(res, 200, { ok: true, sessions });
      return;
    }
    if (pathname === '/standalone-ai/voice/active') {
      if (method !== 'POST') {
        rejectRequest(res, 405, '仅支持 POST');
        return;
      }
      if (!ai?.saveSettings) {
        rejectRequest(res, 503, 'AI 设置服务尚未就绪');
        return;
      }
      try {
        const input = await readJsonObject(req);
        const id = typeof input.id === 'string' ? input.id : '';
        if (id) {
          const session = await studio.getSession(id);
          if (session.status !== 'ready') throw new Error('这条声线还没完成录制，不能设为当前');
        }
        await ai.saveSettings({ ttsProvider: id ? 'local' : 'edge', ttsVoiceId: id });
        sendJson(res, 200, { ok: true, active: id });
      } catch (error) {
        sendJson(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (pathname === '/standalone-ai/voice/import/zip') {
      if (method !== 'POST') {
        rejectRequest(res, 405, '仅支持 POST');
        return;
      }
      try {
        const body = await readBinaryBody(req);
        if (body.length === 0) throw new Error('上传内容为空');
        if (body.length > MAX_VOICE_PACK_BYTES) throw new Error('语音包不能超过 100MB');
        const pack = parseVoicePack(readVoiceZip(body));
        sendJson(res, 200, { ok: true, session: await studio.importPack(pack) });
      } catch (error) {
        sendJson(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (pathname === '/standalone-ai/voice/import/folder') {
      if (method !== 'POST') {
        rejectRequest(res, 405, '仅支持 POST');
        return;
      }
      try {
        const input = await readJsonObject(req);
        const folder = typeof input.path === 'string' ? input.path.trim() : '';
        if (!folder || !isAbsolute(folder)) throw new Error('请填写本机文件夹的绝对路径');
        const pack = await readVoicePackFolder(folder);
        sendJson(res, 200, { ok: true, session: await studio.importPack(pack) });
      } catch (error) {
        sendJson(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    const managedSession = /^\/standalone-ai\/voice\/session\/([^/]+)$/.exec(pathname);
    if (managedSession) {
      const id = managedSession[1];
      if (method === 'PATCH') {
        try {
          const input = await readJsonObject(req);
          sendJson(res, 200, { ok: true, session: await studio.renameSession(id, input.name) });
        } catch (error) {
          sendJson(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (method === 'DELETE') {
        try {
          const settings = ai?.getSettings?.() as { ttsVoiceId?: unknown } | undefined;
          if (settings?.ttsVoiceId === id) throw new Error('这是当前正在使用的声线，请先切换到其它声线再删除');
          sendJson(res, 200, { ok: true, removed: await studio.deleteSession(id) });
        } catch (error) {
          sendJson(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      rejectRequest(res, 405, '仅支持 PATCH 或 DELETE');
      return;
    }
    if (pathname === '/standalone-ai/voice/session') {
      if (method !== 'POST') {
        rejectRequest(res, 405, '仅支持 POST');
        return;
      }
      try {
        const input = await readJsonObject(req);
        sendJson(res, 200, {
          ok: true,
          session: await studio.createSession({ name: input.name, consent: input.consent }),
        });
      } catch (error) {
        sendJson(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    const clipMatch = /^\/standalone-ai\/voice\/session\/([^/]+)\/clip\/(\d+)$/.exec(pathname);
    if (clipMatch) {
      if (method !== 'PUT') {
        rejectRequest(res, 405, '仅支持 PUT');
        return;
      }
      const type = String(req.headers['content-type'] ?? '').toLowerCase();
      if (!type.startsWith('audio/wav') && !type.startsWith('application/octet-stream')) {
        rejectRequest(res, 415, '请上传 WAV 录音');
        return;
      }
      try {
        const body = await readBinaryBody(req);
        const saved = await studio.saveClip(clipMatch[1], clipMatch[2], body);
        sendJson(res, 200, {
          ok: true,
          session: sessionSummaryOf(saved),
          clip: saved.clip,
          issues: saved.issues,
          warnings: saved.warnings,
        });
      } catch (error) {
        sendJson(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    const finishMatch = /^\/standalone-ai\/voice\/session\/([^/]+)\/finish$/.exec(pathname);
    if (finishMatch) {
      if (method !== 'POST') {
        rejectRequest(res, 405, '仅支持 POST');
        return;
      }
      try {
        const finished = await studio.finish(finishMatch[1]);
        sendJson(res, 200, {
          ok: true,
          session: sessionSummaryOf(finished),
          ref: finished.ref,
          manifest: finished.manifest,
        });
      } catch (error) {
        sendJson(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    rejectRequest(res, 404, '没有这条录制接口');
  };
}

function dispatch(
  options: StandaloneServerOptions,
  shutdownSecurity?: RequestSecurity,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => void {
  const settings = settingsHandler(options.ai);
  const tester = testHandler(options.ai);
  const ttsTester = ttsTestHandler(options.ai);
  const exporter = historyExportHandler(options.ai);
  const clearer = historyClearHandler(options.ai);
  const voicesRoot = options.home ? join(options.home, 'dsh-pet', 'voices') : '';
  const voiceApi = voiceApiHandler(voicesRoot ? createVoiceStudio(voicesRoot) : undefined, voicesRoot, options.ai);
  return (req, res, pathname) => {
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (pathname === '/' || pathname === '/health') {
      if (method !== 'GET' && method !== 'HEAD') {
        rejectRequest(res, 405, '仅支持 GET');
        return;
      }
      sendJson(res, 200, options.status?.() ?? { name: 'dsh-pet-standalone' }, true);
      return;
    }
    if (pathname === '/shutdown') {
      if (method !== 'POST') {
        rejectRequest(res, 405, '停机请使用 POST');
        return;
      }
      if (shutdownSecurity) {
        const supplied = req.headers['x-dsh-pet-token'];
        if (
          typeof supplied !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(shutdownSecurity.token))
        ) {
          rejectRequest(res, 403, '停机需要提供令牌');
          return;
        }
      }
      sendJson(res, 200, { ok: true, stopping: true });
      queueMicrotask(() => options.onShutdown?.());
      return;
    }
    const assets: Record<string, readonly [string, string]> = {
      '/standalone-ai/': [settingsPage, 'text/html'],
      '/standalone-ai/settings.js': [settingsScript, 'text/javascript'],
      '/standalone-ai/settings.css': [settingsStyle, 'text/css'],
      '/standalone-ai/voice': [voicePage, 'text/html'],
      '/standalone-ai/voice.js': [voiceScript, 'text/javascript'],
      '/standalone-ai/voice.css': [voiceStyle, 'text/css'],
    };
    const asset = assets[pathname];
    if (asset) {
      if (method !== 'GET' && method !== 'HEAD') {
        rejectRequest(res, 405, '仅支持 GET');
        return;
      }
      sendAsset(res, asset[0], asset[1]);
      return;
    }
    if (pathname.startsWith('/standalone-ai/voice/')) {
      void voiceApi(req, res, pathname).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    if (pathname === '/standalone-ai/settings') {
      void settings(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    if (pathname === '/standalone-ai/test') {
      void tester(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    if (pathname === '/standalone-ai/tts/test') {
      void ttsTester(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    if (pathname === '/standalone-ai/history/export') {
      void exporter(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    if (pathname === '/standalone-ai/history/clear') {
      void clearer(req, res).catch((error: unknown) => fail(res, error, options.logger));
      return;
    }
    const route = options.routes.find((candidate) => matches(candidate, pathname));
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        `dsh-pet-standalone: 没有匹配的路由（已注册：${options.routes.map((item) => item.path).join(', ') || '无'}）`,
      );
      return;
    }
    try {
      void Promise.resolve(route.handler(req, res)).catch((error: unknown) => fail(res, error, options.logger));
    } catch (error) {
      fail(res, error, options.logger);
    }
  };
}

export function createRequestListener(
  options: StandaloneServerOptions,
  injectedSecurity?: RequestSecurity,
): (req: IncomingMessage, res: ServerResponse) => void {
  const security = options.security ?? injectedSecurity;
  const route = dispatch(options, security);
  return (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      rejectRequest(res, 400, '请求地址无效');
      return;
    }
    secureResponse(res, pathname);
    if (security && !security.authorize(req, res)) return;
    // Do not log paths, fragments, query parameters, request bodies or authorization headers.
    options.logger.debug('收到本机 HTTP 请求');
    const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
    const bodyMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '');
    if ((hasBody || bodyMethod) && typeof req.on === 'function') {
      const limit =
        pathname === '/standalone-ai/settings'
          ? MAX_SETTINGS_BYTES
          : pathname === '/standalone-ai/voice/import/zip'
            ? MAX_VOICE_PACK_BYTES
            : MAX_REQUEST_BYTES;
      void boundedRequest(req, res, limit, options.bodyTimeoutMs)
        .then((bounded) => {
          if (bounded) route(bounded, res, pathname);
        })
        .catch((error: unknown) => fail(res, error, options.logger));
    } else route(req, res, pathname);
  };
}

async function bindFirstFree(server: HttpServer, preferred: number, logger: StandaloneLogger): Promise<number> {
  for (let port = preferred; port < preferred + PORT_SCAN_LIMIT; port += 1) {
    try {
      await new Promise<void>((accept, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          accept();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      if (preferred > 0 && bound !== preferred) logger.warn(`端口 ${preferred} 被占用，改用 ${bound}`);
      return bound;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`从 ${preferred} 起连续 ${PORT_SCAN_LIMIT} 个端口都被占用`);
}
export async function listenStandaloneServer(options: StandaloneServerOptions): Promise<StandaloneServer> {
  const security = options.security;
  const server = createServer(createRequestListener(options, security));
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.destroy());
  const port = await bindFirstFree(server, options.port ?? DEFAULT_STANDALONE_PORT, options.logger);
  options.logger.info(`独立模式服务已监听 http://127.0.0.1:${port}/`);
  return {
    port,
    security: security ?? createRequestSecurity(),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((accept) => server.close(() => accept()));
    },
  };
}

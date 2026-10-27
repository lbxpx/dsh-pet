import { z } from 'zod';
import { basename, join } from 'node:path';
import type { StandaloneLogger } from './context';
import { createAiConfig } from './ai-config';
import type { StandaloneAiPublicSettings } from './ai-config';
import { isAuthenticationFailure, isRateLimitFailure, sdkTextStream } from './ai-transport';
import type { AiFetch, AiRequest, AiTransportEvent } from './ai-transport';
import { synthesize } from '../host/tts';

/** 语音试听的固定文本（短句：合成快、缓存命中后瞬时返回；重复点击不会再发微软请求） */
export const TTS_TEST_TEXT = '你好呀，我是你的桌面宠物。听到这句话，就说明语音播放已经换成渲染端啦。';

/**
 * 语音合成失败的**用户可读**提示（不把整段命令行/路径抛到设置页）。
 * 三种真实场景各自给一句能动手的话：没装 Python、Python 里没有 edge-tts、联网合成超时。
 */
export function ttsFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/No module named ['"]?edge_tts/i.test(raw)) {
    return 'Python 里没有 edge-tts：请先安装（pip install edge-tts），或重新创建 tts-venv';
  }
  if (/ENOENT|not recognized|系统找不到指定的文件/i.test(raw)) {
    return '找不到 Python：请确认已安装 Python，或设置 DSH_PET_TTS_PYTHON 指向解释器';
  }
  if (/timed? ?out|ETIMEDOUT/i.test(raw)) {
    return '语音合成超时：请检查网络（合成需要联网访问微软语音服务）后重试';
  }
  return '语音合成失败：' + raw.slice(0, 200);
}

const PROVIDER = 'standalone';
const MAX_INPUT_CHARS = 32_768;
const MAX_OUTPUT_CHARS = 16_384;
const MAX_EVENTS = 4096;
const REQUESTS_PER_MINUTE = 6;
const RATE_WINDOW_MS = 60_000;
const textBlock = z.object({ type: z.literal('text'), text: z.string().max(MAX_INPUT_CHARS) });
const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string().max(MAX_INPUT_CHARS), z.array(z.unknown()).max(128)]),
});
const inputSchema = z.object({
  provider: z.literal(PROVIDER),
  model: z.string().max(200),
  system: z.string().max(MAX_INPUT_CHARS).optional(),
  messages: z.array(messageSchema).min(1).max(64),
  signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal).optional(),
});

export interface StandaloneAiService {
  currentSelection(): { provider: string; model: string };
  listProviders(): Array<{ id: string; name: string }>;
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>;
  resolveModelInfo(
    provider?: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<undefined | { id: string; name: string }>;
  stream(options: unknown): AsyncIterable<{ type: 'text'; text: string }>;
  getSettings(): StandaloneAiPublicSettings;
  saveSettings(input: unknown): Promise<StandaloneAiPublicSettings>;
  testConnection(input: {
    protocol?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; message: string; reply?: string }>;
  /** 设置页「试听」：用当前（或表单里未保存的）音色/语速合成一句固定话，返回可播放的宿主路径 */
  testTts?(input?: { voice?: string; rate?: number }): Promise<{
    ok: boolean;
    message: string;
    url?: string;
    text?: string;
  }>;
  isReady(): boolean;
  canWhisper(): boolean;
  /** 解析后的对话历史文件绝对路径（AI 设置里的 historyPath 或默认位置） */
  historyFilePath(): string;
  dispose(): void;
}
/** Optional third argument is an isolated transport/clock seam; production uses official SDKs. */
export interface StandaloneAiDependencies {
  fetch?: AiFetch;
  now?: () => number;
}

function parseRequest(options: unknown, model: string): { request: AiRequest; signal?: AbortSignal } {
  const parsed = inputSchema.safeParse(options);
  if (!parsed.success || parsed.data.model !== model)
    throw new Error('Invalid standalone AI model selection or input.');
  const { data } = parsed;
  const messages = data.messages
    .map((message) => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((block) => {
                // Unknown/non-text blocks and DSH source metadata never cross the API boundary.
                if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'text')
                  return '';
                const result = textBlock.safeParse(block);
                if (!result.success) throw new Error('Invalid standalone AI text input.');
                return result.data.text;
              })
              .join(''),
    }))
    .filter((message) => message.content.trim().length > 0);
  const system = data.system ?? '';
  const size = system.length + messages.reduce((sum, message) => sum + message.content.length, 0);
  if (
    size > MAX_INPUT_CHARS ||
    messages.length === 0 ||
    messages[0].role !== 'user' ||
    messages[messages.length - 1]?.role !== 'user'
  ) {
    throw new Error('Standalone AI input is empty or exceeds limits.');
  }
  return { request: { system, messages }, signal: data.signal };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Standalone AI request cancelled.'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Standalone AI request cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createStandaloneAi(
  home: string,
  logger: StandaloneLogger,
  dependencies: StandaloneAiDependencies = {},
): StandaloneAiService {
  let store: ReturnType<typeof createAiConfig>;
  try {
    store = createAiConfig(home);
  } catch {
    logger.error('Cannot securely load standalone AI settings.');
    // Corrupt/insecure persistence must never enable ambient or old credentials.
    throw new Error('Cannot securely load standalone AI settings.');
  }
  const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const now = dependencies.now ?? Date.now;
  let disposed = false;
  let paused = false;
  let saving = false;
  let requests: ReadonlyArray<number> = [];
  let active: AbortController | undefined;
  const ready = () =>
    !disposed &&
    !paused &&
    !saving &&
    store.current().enabled &&
    !!store.current().model &&
    !!store.current().baseUrl &&
    !!store.current().apiKey;
  const selection = () => ({ provider: PROVIDER, model: ready() ? store.current().model : '' });

  async function* stream(options: unknown): AsyncIterable<{ type: 'text'; text: string }> {
    if (!ready()) throw new Error('Standalone AI is not ready. Configure and enable the model first.');
    const settings = store.current();
    const { request, signal: callerSignal } = parseRequest(options, settings.model);
    if (callerSignal?.aborted) throw new Error('Standalone AI request cancelled.');
    if (active) throw new Error('Standalone AI is busy. Please wait.');
    const recent = requests.filter((time) => now() - time < RATE_WINDOW_MS);
    if (recent.length >= REQUESTS_PER_MINUTE) throw new Error('Standalone AI rate limit reached. Please wait.');
    requests = [...recent, now()];
    const controller = new AbortController();
    active = controller;
    const abort = () => controller.abort();
    callerSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, settings.timeoutMs);
    const iterator = sdkTextStream(settings, request, controller.signal, fetcher)[Symbol.asyncIterator]();
    let emitted = 0;
    let events = 0;
    try {
      while (true) {
        const part: IteratorResult<AiTransportEvent> = await abortable(iterator.next(), controller.signal);
        if (controller.signal.aborted || !ready()) throw new Error('Standalone AI request cancelled.');
        if (part.done) break;
        if (++events > MAX_EVENTS) throw new Error('Standalone AI response exceeds limits.');
        if (part.value.refusal) throw new Error('Standalone AI could not answer this request.');
        const text = part.value.text;
        if (!text) continue;
        emitted += text.length;
        if (emitted > MAX_OUTPUT_CHARS) throw new Error('Standalone AI response exceeds limits.');
        yield { type: 'text', text };
      }
      if (emitted === 0) throw new Error('Standalone AI returned no text.');
    } catch (error) {
      if (isAuthenticationFailure(error)) {
        paused = true;
        logger.warn('Standalone AI authentication failed; save settings again to resume.');
        throw new Error('Standalone AI authentication failed. Check credentials and save settings again.', {
          cause: error,
        });
      }
      if (controller.signal.aborted) {
        throw new Error('Standalone AI request cancelled or timed out.', { cause: error });
      }
      if (isRateLimitFailure(error)) {
        throw new Error('Standalone AI provider rate limit reached. Please wait.', { cause: error });
      }
      // Only our fixed messages are safe; never propagate SDK errors, URLs, headers, or bodies.
      if (
        error instanceof Error &&
        [
          'Standalone AI could not answer this request.',
          'Standalone AI returned no text.',
          'Standalone AI response exceeds limits.',
        ].includes(error.message)
      )
        throw error;
      logger.warn('Standalone AI request failed.');
      throw new Error('Standalone AI request failed. Check the endpoint and model settings.', { cause: error });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
      controller.abort();
      if (active === controller) active = undefined;
      // return() may await a pending transport read. Observe it, but never block cancellation.
      void iterator.return?.().catch(() => logger.debug('Standalone AI transport closed.'));
    }
  }

  return {
    currentSelection: selection,
    listProviders: () => (ready() ? [{ id: PROVIDER, name: 'Standalone AI' }] : []),
    listModels: async (provider) =>
      ready() && provider === PROVIDER ? [{ id: settingsModel(), name: settingsModel() }] : [],
    resolveModelInfo: async (provider = PROVIDER, model = settingsModel(), signal) =>
      ready() && !signal?.aborted && provider === PROVIDER && model === settingsModel()
        ? { id: model, name: model }
        : undefined,
    stream,
    getSettings: () => store.publicSettings(),
    async saveSettings(input) {
      if (disposed) throw new Error('Standalone AI is disposed.');
      if (saving) throw new Error('Standalone AI settings are being saved.');
      saving = true;
      active?.abort();
      try {
        const result = await store.save(input);
        if (!disposed) paused = false;
        return result;
      } catch (error) {
        paused = true;
        throw error;
      } finally {
        saving = false;
      }
    },
    isReady: ready,
    historyFilePath: () => store.historyFilePath(),
    async testConnection(input: { protocol?: string; baseUrl?: string; model?: string; apiKey?: string }) {
      if (disposed) return { ok: false, message: '服务已关闭' };
      const current = store.current();
      const protocol = input.protocol === 'anthropic' ? 'anthropic' : (input.protocol ?? current.protocol);
      const baseUrl = (input.baseUrl !== undefined ? input.baseUrl : current.baseUrl).trim();
      const model = (input.model !== undefined ? input.model : current.model).trim();
      const apiKey = (input.apiKey !== undefined && input.apiKey !== '' ? input.apiKey : current.apiKey).trim();

      if (!baseUrl) {
        return { ok: false, message: '请先填写接口地址（Base URL）' };
      }
      if (!model) {
        return { ok: false, message: '请先填写模型名称' };
      }
      if (!apiKey) {
        return { ok: false, message: '请先填写 API 密钥' };
      }

      const testSettings = {
        protocol: protocol as 'openai-compatible' | 'anthropic',
        baseUrl,
        model,
        apiKey,
        enabled: true,
        automaticWhispers: false,
        whisperIntervalSec: 300,
        maxTokens: 32,
        timeoutMs: 15_000,
        persona: '',
        historyPath: '',
        speakEnabled: false,
        ttsVoice: 'zh-CN-XiaoxiaoNeural',
        ttsRate: 0,
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const testStream = sdkTextStream(
          testSettings,
          { system: '', messages: [{ role: 'user', content: 'hi' }] },
          controller.signal,
          fetcher,
        );
        let reply = '';
        for await (const chunk of testStream) {
          if (chunk.refusal) {
            return { ok: false, message: '模型拒绝回答该测试请求' };
          }
          if (chunk.text) {
            reply += chunk.text;
            if (reply.length >= 40) break;
          }
        }
        if (!reply.trim()) {
          return { ok: true, message: '连接成功！接口已成功响应。', reply: '(模型返回了空白内容)' };
        }
        return { ok: true, message: '连接成功！模型响应正常。', reply: reply.trim() };
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: false, message: '连接超时（15 秒未响应）：请检查网络连通性或服务器状态' };
        }
        if (isAuthenticationFailure(error)) {
          return { ok: false, message: '身份验证失败 (HTTP 401/403)：请检查 API 密钥是否正确' };
        }
        if (isRateLimitFailure(error)) {
          return { ok: false, message: '请求受限或配额超限 (HTTP 429)：请检查 API 账户余额或调用频率' };
        }
        const rawMsg = error instanceof Error ? error.message : String(error);
        if (rawMsg.includes('404')) {
          return { ok: false, message: '接口路径或模型不存在 (HTTP 404)：请检查接口地址（通常以 /v1 结尾）与模型名称' };
        }
        if (rawMsg.includes('ECONNREFUSED') || rawMsg.includes('fetch failed')) {
          return { ok: false, message: '无法连接到目标服务器：请检查地址与端口是否正确、服务器是否正在运行' };
        }
        return { ok: false, message: `连接失败：${rawMsg}` };
      } finally {
        clearTimeout(timer);
      }
    },
    async testTts(input?: { voice?: string; rate?: number }) {
      if (disposed) return { ok: false, message: '服务已关闭' };
      const current = store.current();
      // 表单里改了音色/语速还没保存也能试听：合法就用表单值，否则回落已保存值
      const voice =
        typeof input?.voice === 'string' && /^[A-Za-z0-9-]+Neural$/.test(input.voice) ? input.voice : current.ttsVoice;
      const rateInput = Number(input?.rate);
      const rate =
        Number.isFinite(rateInput) && rateInput >= -50 && rateInput <= 100 ? Math.round(rateInput) : current.ttsRate;
      try {
        const file = await synthesize(TTS_TEST_TEXT, { userRoot: join(home, 'dsh-pet'), voice, rate });
        if (!file) return { ok: false, message: '语音合成失败：没有生成音频文件' };
        // 与宿主 publishVoice 写进 voice 叶子的地址同一口径：同源路径，设置页直接给 <audio> 播
        return {
          ok: true,
          message: '语音合成成功，正在播放',
          url: `/dsh-pet-7340/tts/${basename(file)}`,
          text: TTS_TEST_TEXT,
        };
      } catch (error) {
        logger.warn('Standalone TTS test failed: ' + (error instanceof Error ? error.message : String(error)));
        return { ok: false, message: ttsFailureMessage(error) };
      }
    },
    canWhisper: () => ready() && store.current().automaticWhispers,
    dispose() {
      disposed = true;
      active?.abort();
    },
  };
  function settingsModel(): string {
    return store.current().model;
  }
}

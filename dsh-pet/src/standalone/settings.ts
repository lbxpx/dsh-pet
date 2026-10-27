import { z } from 'zod';

/** No backend import: mocks and standalone HTTP can be exercised without any AI client. */
export interface StandaloneSettingsService {
  getSettings(): unknown;
  saveSettings(input: unknown): Promise<unknown>;
  /** 解析后的对话历史文件绝对路径（可选：老实现不提供时设置页不显示该行） */
  historyFilePath?(): string;
  testConnection?(input: {
    protocol?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; message: string; reply?: string }>;
  /** 语音试听（可选：老实现不提供时设置页明确报「尚未就绪」） */
  testTts?(input?: {
    voice?: string;
    rate?: number;
    provider?: 'edge' | 'local';
    voiceId?: string;
    localUrl?: string;
  }): Promise<{
    ok: boolean;
    message: string;
    url?: string;
    text?: string;
  }>;
}

const endpoint = z
  .string()
  .max(2048)
  .refine((value) => {
    if (value === '') return true;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }, '接口地址必须是 HTTP(S) 地址，且不能含账号、查询参数或片段');
const settingsSchema = z
  .object({
    protocol: z.enum(['openai-compatible', 'anthropic']).optional(),
    baseUrl: endpoint.optional(),
    model: z.string().max(200).optional(),
    apiKey: z.string().max(8192).optional(),
    clearApiKey: z.boolean().optional(),
    enabled: z.boolean().optional(),
    automaticWhispers: z.boolean().optional(),
    whisperIntervalSec: z.number().int().min(60).max(86400).optional(),
    maxTokens: z.number().int().min(128).max(4096).optional(),
    timeoutMs: z.number().int().min(1000).max(60000).optional(),
    persona: z.string().max(4000).optional(),
    historyPath: z
      .string()
      .max(1024)
      .refine((s) => s.trim() === '' || s.trim().toLowerCase().endsWith('.json'), '历史文件必须是 .json')
      .optional(),
    speakEnabled: z.boolean().optional(),
    ttsProvider: z.enum(['edge', 'local']).optional(),
    ttsVoice: z
      .string()
      .max(100)
      .refine((s) => /^[A-Za-z0-9-]+Neural$/.test(s), '音色名不合法')
      .optional(),
    ttsVoiceId: z
      .string()
      .max(80)
      .refine((s) => s === '' || /^[A-Za-z0-9_-]+$/.test(s), '本机声线 id 不合法')
      .optional(),
    ttsLocalUrl: z
      .string()
      .max(2048)
      .refine((s) => {
        try {
          const url = new URL(s);
          return (
            url.protocol === 'http:' &&
            (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
            !url.username &&
            !url.password &&
            (url.pathname === '/' || url.pathname === '') &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      }, '本机声线地址只能是 http://127.0.0.1 或 http://localhost')
      .optional(),
    ttsRate: z.number().int().min(-50).max(100).optional(),
  })
  .strict();

export function validateSettings(input: unknown): z.infer<typeof settingsSchema> {
  const result = settingsSchema.safeParse(input);
  if (!result.success) throw new Error('设置无效：请检查协议、接口地址、间隔（至少 60 秒）和输出上限（128–4096）');
  return result.data;
}

const publicNames = [
  'protocol',
  'baseUrl',
  'model',
  'enabled',
  'automaticWhispers',
  'whisperIntervalSec',
  'maxTokens',
  'timeoutMs',
  'persona',
  'historyPath',
  'speakEnabled',
  'ttsProvider',
  'ttsVoice',
  'ttsVoiceId',
  'ttsLocalUrl',
  'ttsRate',
  'hasKey',
] as const;
export function publicSettings(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object') return {};
  const record = input as Record<string, unknown>;
  return Object.fromEntries(
    publicNames
      .filter((name) => Object.prototype.hasOwnProperty.call(record, name))
      .map((name) => [name, record[name]]),
  );
}

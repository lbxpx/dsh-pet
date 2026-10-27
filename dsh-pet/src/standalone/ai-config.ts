import { join } from 'node:path';
import { z } from 'zod';
import { resolveHistoryPath } from '../host/history-path';
import { readAiSettings, writeAiSettings } from './ai-storage';

export interface StandaloneAiPublicSettings {
  protocol: 'openai-compatible' | 'anthropic';
  baseUrl: string;
  model: string;
  enabled: boolean;
  automaticWhispers: boolean;
  whisperIntervalSec: number;
  maxTokens: number;
  timeoutMs: number;
  /** 对话人格提示词（留空 = 用桌宠配置里的 whisperPrompt） */
  persona: string;
  /** 对话历史文件路径（留空 = <DSH_HOME>/dsh-pet/memory.json） */
  historyPath: string;
  /** 是否朗读回复（Edge 神经语音） */
  speakEnabled: boolean;
  /** 朗读引擎：edge = Edge 神经语音；local = 本机 GPT-SoVITS 克隆声线 */
  ttsProvider: 'edge' | 'local';
  /** Edge 音色名 */
  ttsVoice: string;
  /** 本机声线会话 id（P2 录制产物 voices/<id>） */
  ttsVoiceId: string;
  /** 本机 GPT-SoVITS API 地址（只允许本机 http） */
  ttsLocalUrl: string;
  /** 语速百分比（-50 ~ +100） */
  ttsRate: number;
  hasKey: boolean;
}
export type StandaloneAiSettings = Omit<StandaloneAiPublicSettings, 'hasKey'> & { apiKey: string };

export const DEFAULT_AI_SETTINGS: Readonly<StandaloneAiSettings> = Object.freeze({
  protocol: 'openai-compatible',
  baseUrl: '',
  model: '',
  enabled: false,
  automaticWhispers: false,
  whisperIntervalSec: 300,
  maxTokens: 1024,
  timeoutMs: 30_000,
  apiKey: '',
  persona: '',
  historyPath: '',
  speakEnabled: false,
  ttsProvider: 'edge',
  ttsVoice: 'zh-CN-XiaoxiaoNeural',
  ttsVoiceId: '',
  ttsLocalUrl: 'http://127.0.0.1:9880',
  ttsRate: 0,
});

function safeEndpoint(value: string): boolean {
  if (!value) return true;
  if (value !== value.trim() || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) {
      return false;
    }
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

/** 本机声线服务地址：只允许 http + 127.0.0.1/localhost（不把宠物宿主变成任意 URL 的代理） */
function safeLocalEndpoint(value: string): boolean {
  if (value === '') return false;
  if (value !== value.trim() || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
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
}

function containsControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) return true;
  }
  return false;
}

const fields = {
  protocol: z.enum(['openai-compatible', 'anthropic']),
  baseUrl: z.string().max(2048).refine(safeEndpoint),
  model: z
    .string()
    .trim()
    .max(200)
    .refine((s) => !containsControlChar(s)),
  enabled: z.boolean(),
  automaticWhispers: z.boolean(),
  whisperIntervalSec: z.number().int().min(60).max(86400),
  maxTokens: z.number().int().min(128).max(4096),
  timeoutMs: z.number().int().min(1000).max(60_000),
  persona: z
    .string()
    .max(4000)
    .refine((s) => !containsControlChar(s), '人设不能包含控制字符'),
  historyPath: z
    .string()
    .max(1024)
    .refine((s) => !containsControlChar(s), '历史路径不能包含控制字符')
    .refine((s) => s.trim() === '' || s.trim().toLowerCase().endsWith('.json'), '历史文件必须是 .json'),
  speakEnabled: z.boolean(),
  ttsProvider: z.enum(['edge', 'local']),
  ttsVoice: z
    .string()
    .max(100)
    .refine((s) => /^[A-Za-z0-9-]+Neural$/.test(s), '音色名不合法'),
  ttsVoiceId: z
    .string()
    .max(80)
    .refine((s) => s === '' || /^[A-Za-z0-9_-]+$/.test(s), '本机声线 id 不合法'),
  ttsLocalUrl: z
    .string()
    .max(2048)
    .refine(safeLocalEndpoint, '本机声线地址只能是 http://127.0.0.1 或 http://localhost'),
  ttsRate: z.number().int().min(-50).max(100),
  apiKey: z
    .string()
    .max(4096)
    .refine((s) => !containsControlChar(s) && !/\s/.test(s)),
};
const persistedSchema = z.object(fields).strict();
const patchSchema = persistedSchema.partial().extend({ clearApiKey: z.boolean().optional() }).strict();

export function validateSettings(input: unknown, previous: Readonly<StandaloneAiSettings>): StandaloneAiSettings {
  try {
    const patch = patchSchema.parse(input);
    if (patch.clearApiKey && patch.apiKey) throw new Error('Conflicting key changes');
    const { clearApiKey, ...values } = patch;
    const apiKey = clearApiKey ? '' : values.apiKey || previous.apiKey;
    const next = persistedSchema.parse({ ...previous, ...values, apiKey });
    if (next.enabled && (!next.model || !next.baseUrl || !next.apiKey)) throw new Error('Incomplete settings');
    return next;
  } catch {
    throw new Error('Invalid standalone AI settings.');
  }
}

function redact(settings: Readonly<StandaloneAiSettings>): StandaloneAiPublicSettings {
  const { apiKey, ...publicFields } = settings;
  return { ...publicFields, hasKey: apiKey.length > 0 };
}

export interface AiConfigStore {
  current(): Readonly<StandaloneAiSettings>;
  publicSettings(): StandaloneAiPublicSettings;
  save(input: unknown): Promise<StandaloneAiPublicSettings>;
  /** 解析后的对话历史文件绝对路径（配置为空 = DSH_HOME/dsh-pet/memory.json） */
  historyFilePath(): string;
}

export function createAiConfig(home: string): AiConfigStore {
  let settings: Readonly<StandaloneAiSettings> = DEFAULT_AI_SETTINGS;
  try {
    const loaded = readAiSettings(home);
    if (loaded !== undefined) {
      // 旧版本配置文件没有 persona / historyPath：先铺默认值再校验，升级不丢已有配置
      const merged = { ...DEFAULT_AI_SETTINGS, ...(loaded as Record<string, unknown>) };
      settings = Object.freeze(validateSettings(persistedSchema.parse(merged), DEFAULT_AI_SETTINGS));
    }
  } catch {
    throw new Error('Cannot securely load standalone AI settings.');
  }
  return {
    current: () => settings,
    publicSettings: () => redact(settings),
    historyFilePath: () => resolveHistoryPath(join(home, 'dsh-pet'), settings.historyPath),
    async save(input) {
      const next = validateSettings(input, settings);
      try {
        writeAiSettings(home, next);
      } catch {
        throw new Error('Cannot securely save standalone AI settings.');
      }
      settings = Object.freeze(next);
      return redact(settings);
    },
  };
}

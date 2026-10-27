/**
 * 录制向导的**服务端存储层**：一次录制 = 一个 `voices/<id>/` 会话目录。
 *
 * 目录约定（与 P3 GPT-SoVITS / P4 声线管理共用）：
 *   voices/<id>/
 *     manifest.json         会话与每句的元数据（含 consent，缺它不能用于克隆）
 *     dataset/<n>.wav       单句录音（32kHz 单声道 16-bit PCM，录制页在浏览器里转好）
 *     dataset/<n>.txt       该句文本（训练时与 wav 同名配对）
 *     ref.wav               自动挑出的参考音频（零样本克隆用）
 *
 * 为什么由服务端落盘而不是浏览器下载：录音要进入统一的 `~/.dsh/dsh-pet/voices/`，后续 GPT-SoVITS
 * 服务与声线管理都从这一份目录读；同时服务端才能做质检与 manifest 校验（客户端校验只防手滑）。
 * 会话 id 由服务端生成且只含安全字符——目录名永远不来自客户端输入。
 */
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VOICE_SAMPLE_RATE, analyzeSamples, judgeVoiceClip, parsePcm16Wav, type VoiceMetrics } from './voice-format';
import { VOICE_SENTENCES, voiceSentence, type VoiceCategory } from './voice-sentences';

export interface VoiceClipRecord {
  id: number;
  category: VoiceCategory;
  text: string;
  /** 相对会话目录的文件名（dataset/<id>.wav） */
  file: string;
  durationSec: number;
  pass: boolean;
  metrics: VoiceMetrics;
}

export interface VoiceManifest {
  version: 1;
  id: string;
  name: string;
  type: 'recorded';
  createdAt: string;
  /** 克隆真人声线必须本人同意；没有它 P3 不允许拿去做参考音频 */
  consent: true;
  language: 'zh-CN';
  sampleRate: number;
  status: 'recording' | 'ready';
  clips: VoiceClipRecord[];
  ref?: string;
  /** 参考音频来自哪一句（P3 合成时要把这句的文本当 prompt_text） */
  refClipId?: number;
  refText?: string;
}

export interface VoiceSessionSummary {
  id: string;
  name: string;
  dir: string;
  total: number;
  recorded: number;
}

export interface SavedClip extends VoiceSessionSummary {
  clip: VoiceClipRecord;
  issues: string[];
  warnings: string[];
}

export interface FinishedSession extends VoiceSessionSummary {
  ref: string;
  manifest: VoiceManifest;
}

export interface VoiceStudio {
  createSession(input: { name: unknown; consent: unknown }): Promise<VoiceSessionSummary>;
  saveClip(sessionId: string, sentenceId: unknown, wav: Buffer): Promise<SavedClip>;
  finish(sessionId: string): Promise<FinishedSession>;
}

const SESSION_ID = /^v-\d{8}-\d{6}-[0-9a-f]{4}$/;
const NAME_MAX = 40;

function sanitizeName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  // 名字只进 manifest 展示，不进路径；仍然去掉控制字符，避免把终端/页面搞乱
  const hasControl = [...name].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (!name || name.length > NAME_MAX || hasControl) {
    throw new Error('声音名称需要 1–' + NAME_MAX + ' 个字符');
  }
  return name;
}

async function writeManifest(file: string, manifest: VoiceManifest): Promise<void> {
  const temp = file + '.tmp';
  await writeFile(temp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await rename(temp, file);
}

function summary(id: string, dir: string, manifest: VoiceManifest): VoiceSessionSummary {
  return { id, name: manifest.name, dir, total: VOICE_SENTENCES.length, recorded: manifest.clips.length };
}

/**
 * @param voicesRoot 声线目录（= <DSH_HOME>/dsh-pet/voices）
 */
export function createVoiceStudio(voicesRoot: string, now: () => number = Date.now): VoiceStudio {
  const sessionDir = (id: string): string => {
    // 会话 id 只由本模块生成；这里仍按形状再验一次（防未来某条路径把它透传成输入）
    if (!SESSION_ID.test(id)) throw new Error('录制会话不存在');
    return join(voicesRoot, id);
  };

  async function load(id: string): Promise<{ dir: string; manifest: VoiceManifest }> {
    const dir = sessionDir(id);
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as VoiceManifest;
      if (!manifest || manifest.version !== 1 || manifest.id !== id || !Array.isArray(manifest.clips)) {
        throw new Error('bad manifest');
      }
      return { dir, manifest };
    } catch {
      throw new Error('录制会话不存在，或 manifest 已损坏');
    }
  }

  return {
    async createSession(input) {
      const name = sanitizeName(input.name);
      if (input.consent !== true) throw new Error('需要先确认「这是本人的声音，并同意用于声线克隆」');
      await mkdir(voicesRoot, { recursive: true });
      const date = new Date(now());
      const pad = (n: number): string => String(n).padStart(2, '0');
      const stamp =
        `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
        `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
      // 同一秒内重复开录：加 4 位随机后缀，冲突就重试（最多 8 次）
      let id = '';
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = `v-${stamp}-${randomBytes(2).toString('hex')}`;
        try {
          await mkdir(join(voicesRoot, candidate));
          id = candidate;
          break;
        } catch {
          /* 冲突（或目录已存在）→ 换一个后缀 */
        }
      }
      if (!id) throw new Error('无法创建录制目录：请检查数据目录的写入权限');
      const dir = join(voicesRoot, id);
      await mkdir(join(dir, 'dataset'), { recursive: true });
      const manifest: VoiceManifest = {
        version: 1,
        id,
        name,
        type: 'recorded',
        createdAt: date.toISOString(),
        consent: true,
        language: 'zh-CN',
        sampleRate: VOICE_SAMPLE_RATE,
        status: 'recording',
        clips: [],
      };
      await writeManifest(join(dir, 'manifest.json'), manifest);
      return summary(id, dir, manifest);
    },

    async saveClip(sessionId, sentenceId, wav) {
      const { dir, manifest } = await load(sessionId);
      const id = Number(sentenceId);
      const sentence = Number.isInteger(id) ? voiceSentence(id) : undefined;
      if (!sentence) throw new Error('未知的句子编号');
      const parsed = parsePcm16Wav(wav);
      if (parsed.sampleRate !== VOICE_SAMPLE_RATE) {
        throw new Error('采样率必须是 ' + VOICE_SAMPLE_RATE + 'Hz（录制页会自动转换）');
      }
      const metrics = analyzeSamples(parsed.samples, parsed.sampleRate, sentence.text);
      const verdict = judgeVoiceClip(metrics, sentence.maxSec);
      const relative = `dataset/${sentence.id}.wav`;
      await writeFile(join(dir, relative), wav);
      await writeFile(join(dir, `dataset/${sentence.id}.txt`), sentence.text + '\n', 'utf8');
      const clip: VoiceClipRecord = {
        id: sentence.id,
        category: sentence.category,
        text: sentence.text,
        file: relative,
        durationSec: metrics.durationSec,
        pass: verdict.pass,
        metrics,
      };
      manifest.clips = [...manifest.clips.filter((item) => item.id !== clip.id), clip].sort((a, b) => a.id - b.id);
      await writeManifest(join(dir, 'manifest.json'), manifest);
      return {
        ...summary(sessionId, dir, manifest),
        clip,
        issues: verdict.issues,
        warnings: verdict.warnings,
      };
    },

    async finish(sessionId) {
      const { dir, manifest } = await load(sessionId);
      if (manifest.clips.length === 0) throw new Error('还没有录任何一句，先录一句再完成');
      // 参考音频：优先「质检通过 + 3–10 秒」；同档里底噪越低、时长越接近 6 秒越好。
      // 没有完全通过的也能退回最好的一条（总比生成不了强），由 P3 决定要不要用。
      const score = (clip: VoiceClipRecord): number => {
        const durationPenalty = Math.abs(clip.durationSec - 6);
        return (clip.pass ? 1000 : 0) - clip.metrics.noiseFloorDb * 2 - durationPenalty * 10;
      };
      const ranked = [...manifest.clips].sort((a, b) => score(b) - score(a));
      const chosen = ranked[0];
      await copyFile(join(dir, chosen.file), join(dir, 'ref.wav'));
      manifest.ref = 'ref.wav';
      manifest.refClipId = chosen.id;
      manifest.refText = chosen.text;
      manifest.status = 'ready';
      await writeManifest(join(dir, 'manifest.json'), manifest);
      return { ...summary(sessionId, dir, manifest), ref: 'ref.wav', manifest };
    },
  };
}

/** 列出现有声线会话（按创建时间倒序；损坏的 manifest 跳过，不阻塞其余会话） */
export async function listVoiceSessions(voicesRoot: string): Promise<VoiceSessionSummary[]> {
  let entries: string[];
  try {
    entries = (await readdir(voicesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && SESSION_ID.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const out: VoiceSessionSummary[] = [];
  for (const id of entries) {
    try {
      const manifest = JSON.parse(await readFile(join(voicesRoot, id, 'manifest.json'), 'utf8')) as VoiceManifest;
      if (manifest?.version === 1 && manifest.id === id) {
        out.push(summary(id, join(voicesRoot, id), manifest));
      }
    } catch {
      /* 单个会话损坏不影响列表 */
    }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

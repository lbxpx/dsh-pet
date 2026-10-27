/**
 * 语音朗读（TTS）：把回复文本合成为 mp3，**播放交给渲染端**。
 *
 * - 合成引擎：Edge 神经语音（`edge-tts` Python 包，免费、无需 Key；文本会发到微软）。
 *   Python 解释器按「环境变量 → <userRoot>/tts-venv → PATH 上的 python」顺序探测。
 * - 缓存：按文本/音色/语速做 sha1，同一句话不重复合成（文件名即 sha1，永不覆盖）。
 * - 播放：合成结果落在 `<userRoot>/tts/`，经 /dsh-pet-7340/tts/<sha1>.mp3 发给渲染端，
 *   浏览器 overlay 与桌面窗口各自用 HTMLAudioElement 播（见 host/index.ts 的 publishVoice）。
 *   宿主**不再** spawn PowerShell / WinRT MediaPlayer：那条路只在 Windows 有效，还绕不开
 *   "后台进程没有音频会话"这类宿主环境问题，音量与输出设备也完全不受渲染端控制。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 一次合成的输入（来自 AI 设置的「语音朗读」区块） */
export interface VoiceOptions {
  /** 插件用户数据根（= <DSH_HOME>/dsh-pet） */
  userRoot: string;
  /** Edge 音色名，例如 zh-CN-XiaoxiaoNeural */
  voice: string;
  /** 语速百分比（-50 ~ +100） */
  rate: number;
}

/** 语音缓存目录（纯路径；合成时才会真正建目录，路由读它时不该有写副作用） */
export function ttsCacheDir(userRoot: string): string {
  return join(userRoot, 'tts');
}

/** 合成前确保缓存目录存在（只在真的要写文件时调用） */
function ensureCacheDir(userRoot: string): string {
  const directory = ttsCacheDir(userRoot);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  return directory;
}

/** 找带 edge_tts 的 Python：环境变量优先，其次插件目录下的 tts-venv，最后 PATH。 */
export function resolvePython(userRoot: string): string {
  const candidates = [
    process.env.DSH_PET_TTS_PYTHON,
    join(userRoot, 'tts-venv', 'Scripts', 'python.exe'),
    join(userRoot, 'tts-venv', 'bin', 'python'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** 合成一句语音，返回 mp3 绝对路径（失败抛错，由调用方决定是否忽略）。 */
export async function synthesize(text: string, options: VoiceOptions): Promise<string | undefined> {
  const clean = text.trim();
  if (!clean) return undefined;
  const rate = Math.max(-50, Math.min(100, Math.round(options.rate)));
  const key = createHash('sha1').update(`${clean}\u0000${options.voice}\u0000${rate}`).digest('hex');
  const file = join(ensureCacheDir(options.userRoot), `${key}.mp3`);
  if (existsSync(file)) return file;

  const python = resolvePython(options.userRoot);
  const rateArg = `${rate >= 0 ? '+' : ''}${rate}%`;
  await new Promise<void>((resolve, reject) => {
    execFile(
      python,
      ['-m', 'edge_tts', '--voice', options.voice, '--rate', rateArg, '--text', clean, '--write-media', file],
      { timeout: 30_000, windowsHide: true },
      (error) => (error ? reject(error) : resolve()),
    );
  });
  return existsSync(file) ? file : undefined;
}

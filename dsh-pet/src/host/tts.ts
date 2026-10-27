/**
 * 语音朗读（TTS）：把回复文本合成为 mp3 并播放。
 *
 * - 合成引擎：Edge 神经语音（`edge-tts` Python 包，免费、无需 Key；文本会发到微软）。
 *   Python 解释器按「环境变量 → <userRoot>/tts-venv → PATH 上的 python」顺序探测。
 * - 播放：Windows 上用 WPF `MediaPlayer` 子进程播放（异步、不阻塞宿主；失败只影响声音）。
 * - 缓存：按文本/音色/语速做 sha1，同一句话不重复合成。
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface VoiceSettings {
  /** 是否朗读回复 */
  enabled: boolean;
  /** Edge 音色名，例如 zh-CN-XiaoxiaoNeural */
  voice: string;
  /** 语速百分比（-50 ~ +100） */
  rate: number;
}

export interface SpeakOptions extends VoiceSettings {
  /** 插件用户数据根（= <DSH_HOME>/dsh-pet） */
  userRoot: string;
}

/** 找带 edge_tts 的 Python：环境变量优先，其次插件目录下的 tts-venv，最后 PATH。 */
export function resolvePython(userRoot: string): string {
  const candidates = [process.env.DSH_PET_TTS_PYTHON, join(userRoot, 'tts-venv', 'Scripts', 'python.exe'), join(userRoot, 'tts-venv', 'bin', 'python')].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function cacheDirectory(userRoot: string): string {
  const directory = join(userRoot, 'tts');
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  return directory;
}

/** 合成一句语音，返回 mp3 绝对路径（失败抛错，由调用方决定是否忽略）。 */
export async function synthesize(text: string, options: SpeakOptions): Promise<string | undefined> {
  const clean = text.trim();
  if (!clean) return undefined;
  const rate = Math.max(-50, Math.min(100, Math.round(options.rate)));
  const key = createHash('sha1').update(`${clean}\u0000${options.voice}\u0000${rate}`).digest('hex');
  const file = join(cacheDirectory(options.userRoot), `${key}.mp3`);
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

/** 异步播放 mp3（Windows），不阻塞、不抛错。 */
export function play(file: string): void {
  if (process.platform !== 'win32') return;
  const uri = `file:///${file.replace(/\\/g, '/')}`;
  // WinRT MediaPlayer 走 Media Foundation，后台进程也能出声；WPF MediaPlayer 在无消息泵的
  // 子进程里只走时钟、不出声（实测），WMP COM 在 Win11 上又打不开文件（playState 恒 9）。
  const script = [
    '[Windows.Media.Playback.MediaPlayer,Windows.Media,ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Media.Core.MediaSource,Windows.Media,ContentType=WindowsRuntime] | Out-Null',
    '$mp = New-Object Windows.Media.Playback.MediaPlayer',
    `$mp.Source = [Windows.Media.Core.MediaSource]::CreateFromUri([uri]'${uri}')`,
    '$mp.Play()',
    '$i = 0',
    'while ($i -lt 600) { Start-Sleep -Milliseconds 250; $i++; $s = $mp.PlaybackSession; if ($s.NaturalDuration.TotalSeconds -gt 0 -and $s.Position -ge $s.NaturalDuration) { break } }',
    '$mp.Dispose()',
  ].join('; ');
  try {
    spawn('powershell.exe', ['-STA', '-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch {
    /* 播放失败只影响声音，不影响对话 */
  }
}

/** 合成并播放；任何失败都吞掉（朗读是附加能力）。 */
export async function speak(text: string, options: SpeakOptions): Promise<void> {
  try {
    const file = await synthesize(text, options);
    if (file) play(file);
  } catch {
    /* 忽略 */
  }
}

/**
 * 录制片段的**服务端**校验与质检：只认 16-bit PCM 单声道 WAV（录制页在浏览器里就转成 32kHz
 * 单声道，免得服务端依赖 ffmpeg/sox），解析后算时长、峰值、RMS、底噪与语速。
 *
 * 这些指标全部来自样本本身，不猜、不调用外部进程：
 *   - 时长：data 字节数 / (采样率 × 2)
 *   - 峰值：20·log10(max|x| / 32768)；> -6dBFS 视为可能削波
 *   - 底噪：按 20ms 分帧算 RMS，取第 5 百分位（句子之间的换气/静音大约落在这一档）
 *   - 语速：去掉标点后的字数 / 时长（汉字/字母/数字都算一个字）
 */
export const VOICE_SAMPLE_RATE = 32_000;
export const VOICE_MIN_SEC = 2;
export const VOICE_MAX_SEC = 15;
export const VOICE_MAX_BYTES = 1024 * 1024;

export interface ParsedWav {
  sampleRate: number;
  durationSec: number;
  samples: Float32Array;
}

export interface VoiceMetrics {
  /** 秒，保留 1 位小数 */
  durationSec: number;
  /** dBFS，保留 1 位小数（0 = 满幅） */
  peakDb: number;
  rmsDb: number;
  noiseFloorDb: number;
  /** 去标点后的字数 / 秒 */
  charsPerSecond: number;
}

export interface VoiceVerdict {
  pass: boolean;
  /** 必须重录的问题（时长 / 削波 / 底噪） */
  issues: string[];
  /** 只提示、不拦下一句的问题（语速、声音偏小） */
  warnings: string[];
  metrics: VoiceMetrics;
}

/** 只接受 16-bit PCM 单声道 WAV；任何不符合预期的形状都明确抛错（调用方转成 400） */
export function parsePcm16Wav(buffer: Buffer): ParsedWav {
  if (buffer.length < 44) throw new Error('音频太短：不是完整的 WAV 文件');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是有效的 WAV 文件');
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  let data: Buffer | undefined;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) throw new Error('WAV 数据块被截断');
    if (id === 'fmt ') {
      if (size < 16) throw new Error('WAV 格式块过短');
      format = buffer.readUInt16LE(start);
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bits = buffer.readUInt16LE(start + 14);
    } else if (id === 'data') {
      data = buffer.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (format !== 1) throw new Error('只支持 16-bit PCM 的 WAV（当前不是 PCM）');
  if (channels !== 1) throw new Error('请上传单声道录音（当前是 ' + channels + ' 声道）');
  if (bits !== 16) throw new Error('请上传 16-bit 录音（当前是 ' + bits + '-bit）');
  if (sampleRate < 8000 || sampleRate > 96000) throw new Error('采样率不在 8k–96k 之间');
  if (!data || data.length < 2) throw new Error('WAV 里没有音频数据');
  const count = Math.floor(data.length / 2);
  const durationSec = count / sampleRate;
  if (durationSec > VOICE_MAX_SEC) throw new Error('单句录音不能超过 ' + VOICE_MAX_SEC + ' 秒');
  if (durationSec < 0.3) throw new Error('录音太短，请完整读一遍');
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { sampleRate, durationSec, samples };
}

function db(value: number): number {
  return value <= 0 ? -120 : Math.round(20 * Math.log10(value) * 10) / 10;
}

/** 去标点与空白后的字数：汉字/字母/数字各算一个字（英文缩写按字符算，够用来判断语速异常） */
export function spokenCharCount(text: string): number {
  return text.replace(/[\s，。！？、：；“”‘’（）《》…—,.!?:;'"()-]/g, '').length;
}

/** 计算质检指标；纯函数，样本最长 15s（48 万个样本），分帧排序的成本可以接受 */
export function analyzeSamples(samples: Float32Array, sampleRate: number, text: string): VoiceMetrics {
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    const abs = Math.abs(value);
    if (abs > peak) peak = abs;
    sumSquares += value * value;
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
  const frameSize = Math.max(1, Math.round(sampleRate * 0.02));
  const frames: number[] = [];
  for (let start = 0; start + frameSize <= samples.length; start += frameSize) {
    let sum = 0;
    for (let i = start; i < start + frameSize; i += 1) sum += samples[i] * samples[i];
    frames.push(Math.sqrt(sum / frameSize));
  }
  frames.sort((a, b) => a - b);
  const noiseFrame = frames.length > 0 ? frames[Math.floor(frames.length * 0.05)] : 0;
  const durationSec = Math.round((samples.length / sampleRate) * 10) / 10;
  return {
    durationSec,
    peakDb: db(peak),
    rmsDb: db(rms),
    noiseFloorDb: db(noiseFrame),
    charsPerSecond: Math.round((spokenCharCount(text) / Math.max(0.1, samples.length / sampleRate)) * 10) / 10,
  };
}

/** 按计划里的门禁判定一句录音；`maxSec` 是该句在句子库里的建议上限 */
export function judgeVoiceClip(metrics: VoiceMetrics, maxSec: number): VoiceVerdict {
  const issues: string[] = [];
  const warnings: string[] = [];
  if (metrics.durationSec < VOICE_MIN_SEC) issues.push('太短：至少说满 ' + VOICE_MIN_SEC + ' 秒');
  if (metrics.durationSec > maxSec) issues.push('太长：这句建议不超过 ' + maxSec + ' 秒');
  if (metrics.peakDb > -6) issues.push('爆音：离麦克风远一点，或把输入音量调低');
  if (metrics.noiseFloorDb > -45) issues.push('底噪偏高：找安静的环境，或关掉风扇/空调后再录');
  if (metrics.peakDb < -35) warnings.push('声音偏小：可以离麦克风近一点');
  if (metrics.charsPerSecond > 8) warnings.push('语速偏快：放慢一点，像平时说话就好');
  if (metrics.charsPerSecond < 1.5) warnings.push('语速偏慢：可以自然一点，不用一个字一个字念');
  return { pass: issues.length === 0, issues, warnings, metrics };
}

/**
 * 语音朗读（TTS）：把回复文本合成为音频文件，**播放交给渲染端**。
 *
 * 两套引擎，设置页可选：
 *   - Edge 神经语音（默认）：`edge-tts` Python 包，免费、无需 Key；文本会发到微软。
 *     Python 解释器按「环境变量 → <userRoot>/tts-venv → PATH 上的 python」顺序探测。
 *   - 本机声线（GPT-SoVITS，P3）：独立 Python 服务常驻在 127.0.0.1:9880，宠物宿主把
 *     `voices/<id>/ref.wav` + 参考文本发过去，拿回 wav。**服务不可用时自动回落 Edge**，
 *     朗读本身永远不能拖垮对话。
 * - 缓存：按文本/引擎/音色/语速做 sha1，同一句话不重复合成（文件名即 sha1，永不覆盖）。
 * - 播放：合成结果落在 `<userRoot>/tts/`，经 /dsh-pet-7340/tts/<sha1>.(mp3|wav) 发给渲染端，
 *   浏览器 overlay 与桌面窗口各自用 HTMLAudioElement 播（见 host/index.ts 的 publishVoice）。
 *   宿主**不再** spawn PowerShell / WinRT MediaPlayer：那条路只在 Windows 有效，还绕不开
 *   "后台进程没有音频会话"这类宿主环境问题，音量与输出设备也完全不受渲染端控制。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

/** 朗读引擎：edge = 联网神经语音；local = 本机 GPT-SoVITS 克隆声线 */
export type TtsProvider = 'edge' | 'local';

/** synthesizeVoice 的完整输入：在 Edge 参数之外带上本机声线的选择 */
export interface SpeakOptions extends VoiceOptions {
  provider?: TtsProvider;
  /** voices/<id> 的会话 id（P2 录制产物） */
  voiceId?: string;
  /** 本机 GPT-SoVITS API 地址（默认 http://127.0.0.1:9880） */
  localUrl?: string;
}

/** 一条可用的本机声线（从 voices/<id>/manifest.json 解析） */
export interface RecordedVoice {
  id: string;
  name: string;
  refPath: string;
  refText: string;
  /** GPT-SoVITS 语言代码：zh / en / ja / ko / yue（未知一律按中文） */
  language: 'zh' | 'en' | 'ja' | 'ko' | 'yue';
  /** P6：当前使用零样本还是精调权重 */
  variant: 'zero-shot' | 'finetuned';
  variantLabel: string;
  /** 精调权重绝对路径（variant=finetuned 时存在） */
  sovitsPath?: string;
  gptPath?: string;
}

/** 把 manifest.language（zh-CN / en-US / ja / yue…）收敛成 GPT-SoVITS 的代码 */
function ttsLanguage(value: unknown): RecordedVoice['language'] {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw.startsWith('yue') || raw.startsWith('zh-hk') || raw.startsWith('zh-tw')) return 'yue';
  const code = raw.slice(0, 2);
  return code === 'en' || code === 'ja' || code === 'ko' ? code : 'zh';
}

const SESSION_ID = /^v-\d{8}-\d{6}-[0-9a-f]{4}$/;

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

interface VoiceClipLike {
  id?: unknown;
  text?: unknown;
  file?: unknown;
}

interface VoiceVariantLike {
  id?: unknown;
  label?: unknown;
  kind?: unknown;
  sovits?: unknown;
  gpt?: unknown;
}

interface VoiceManifestLike {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  consent?: unknown;
  ref?: unknown;
  refClipId?: unknown;
  refText?: unknown;
  language?: unknown;
  clips?: unknown;
  variants?: unknown;
  activeVariant?: unknown;
}

function sha1File(file: string): string {
  return createHash('sha1').update(readFileSync(file)).digest('hex');
}

/** 从 manifest + 目录里解析「参考音频 + 参考文本」。
 *  新 manifest 直接带 refClipId/refText；旧 manifest（P2 第一版）按 ref.wav 与 dataset/*.wav
 *  的哈希匹配回原句——只做一次，结果缓存在进程内。 */
function parseRecordedVoice(dir: string, id: string): RecordedVoice | undefined {
  let manifest: VoiceManifestLike;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as VoiceManifestLike;
  } catch {
    return undefined;
  }
  if (manifest.status !== 'ready' || manifest.consent !== true || typeof manifest.ref !== 'string') return undefined;
  const refPath = join(dir, manifest.ref);
  if (!existsSync(refPath)) return undefined;
  const name = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : id;
  const language = ttsLanguage((manifest as { language?: unknown }).language);
  const clips = Array.isArray(manifest.clips) ? (manifest.clips as VoiceClipLike[]) : [];
  let refText = typeof manifest.refText === 'string' && manifest.refText.trim() ? manifest.refText : '';
  if (!refText) {
    if (typeof manifest.refClipId === 'number') {
      const hit = clips.find((clip) => clip.id === manifest.refClipId && typeof clip.text === 'string');
      if (hit && typeof hit.text === 'string') refText = hit.text;
    } else {
      const refHash = sha1File(refPath);
      for (const clip of clips) {
        if (typeof clip.file !== 'string' || typeof clip.text !== 'string') continue;
        try {
          if (sha1File(join(dir, clip.file)) === refHash) {
            refText = clip.text;
            break;
          }
        } catch {
          /* 单句文件缺失不影响其它句的匹配 */
        }
      }
    }
  }
  if (!refText || !refText.trim()) return undefined;
  const variants = Array.isArray(manifest.variants) ? (manifest.variants as VoiceVariantLike[]) : [];
  const activeId = typeof manifest.activeVariant === 'string' ? manifest.activeVariant : 'zero-shot';
  const selected = variants.find((item) => item.id === activeId && item.kind === 'finetuned');
  let variant: RecordedVoice['variant'] = 'zero-shot';
  let variantLabel = '零样本';
  let sovitsPath: string | undefined;
  let gptPath: string | undefined;
  if (selected && typeof selected.sovits === 'string' && typeof selected.gpt === 'string') {
    const sovits = join(dir, selected.sovits);
    const gpt = join(dir, selected.gpt);
    if (existsSync(sovits) && existsSync(gpt)) {
      variant = 'finetuned';
      variantLabel = typeof selected.label === 'string' && selected.label.trim() ? selected.label.trim() : '精调版';
      sovitsPath = sovits;
      gptPath = gpt;
    }
  }
  return { id, name, refPath, refText, language, variant, variantLabel, sovitsPath, gptPath };
}

/** 列出可用声线（只收 status=ready 且 consent=true、ref.wav 存在的会话） */
export function listRecordedVoices(userRoot: string): RecordedVoice[] {
  const root = join(userRoot, 'voices');
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SESSION_ID.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const out: RecordedVoice[] = [];
  for (const id of entries.sort()) {
    const voice = parseRecordedVoice(join(root, id), id);
    if (voice) out.push(voice);
  }
  return out;
}

/** 按 id 取一条可用声线（不存在 / 未完成 / 无 consent → undefined） */
export function resolveRecordedVoice(userRoot: string, voiceId: string): RecordedVoice | undefined {
  if (!SESSION_ID.test(voiceId)) return undefined;
  return parseRecordedVoice(join(userRoot, 'voices', voiceId), voiceId);
}

/** 语速百分比（-50~100）→ GPT-SoVITS 的 speed_factor（0.5~2） */
function speedFactor(rate: number): number {
  return Math.round(Math.min(2, Math.max(0.5, 1 + rate / 100)) * 100) / 100;
}

/** 预训练权重（零样本）在 GPT-SoVITS 仓库里的相对路径；api_v2 以仓库根为 cwd */
const BASE_SOVITS = 'GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2G2333k.pth';
const BASE_GPT = 'GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt';
const WEIGHT_TTL_MS = 120_000;

let activeWeightsKey = '';
let activeWeightsAt = 0;
let weightQueue: Promise<unknown> = Promise.resolve();

/** 调 /set_*_weights；服务端返回 {"message":"success"} 才算成功 */
async function applyWeights(baseUrl: string, sovits: string, gpt: string): Promise<void> {
  for (const [endpoint, weightPath] of [
    ['set_sovits_weights', sovits],
    ['set_gpt_weights', gpt],
  ] as const) {
    const response = await fetch(`${baseUrl}/${endpoint}?weights_path=${encodeURIComponent(weightPath)}`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`切换声线权重失败（HTTP ${response.status}${detail ? '：' + detail : ''}）`);
    }
    const body = await response.text();
    if (!body.includes('success')) throw new Error('切换声线权重失败：' + body.slice(0, 200));
  }
}

/**
 * 所有本机合成都串行执行：GPT-SoVITS 的权重是**全局状态**，切权重与合成之间不能插队。
 * 精调版权重每次 TTL 到期会重新加载（防止服务重启后状态不一致）；零样本需要时切回预训练权重。
 */
function runWithVoiceWeights<T>(voice: RecordedVoice, baseUrl: string, task: () => Promise<T>): Promise<T> {
  const key = voice.variant === 'finetuned' ? `${voice.id}:finetuned` : 'base';
  const apply = (): Promise<void> =>
    voice.variant === 'finetuned' && voice.sovitsPath && voice.gptPath
      ? applyWeights(baseUrl, voice.sovitsPath, voice.gptPath)
      : applyWeights(baseUrl, BASE_SOVITS, BASE_GPT);
  const run = weightQueue.then(async () => {
    if (activeWeightsKey !== key || Date.now() - activeWeightsAt > WEIGHT_TTL_MS) {
      await apply();
      activeWeightsKey = key;
      activeWeightsAt = Date.now();
    }
    return task();
  });
  weightQueue = run.then(
    () => undefined,
    () => {
      activeWeightsKey = '';
    },
  );
  return run;
}

/**
 * 用本机 GPT-SoVITS 合成一句话（返回 wav 绝对路径）。
 * 失败**抛错**（调用方 synthesizeVoice 会回落 Edge；设置页试听要把真实原因显示出来）。
 */
export async function synthesizeRecorded(
  text: string,
  options: { userRoot: string; voiceId: string; localUrl: string; rate: number },
): Promise<string | undefined> {
  const clean = text.trim();
  if (!clean) return undefined;
  const voice = resolveRecordedVoice(options.userRoot, options.voiceId);
  if (!voice) throw new Error('本机声线不存在或还没有生成 ref.wav');
  const rate = Math.max(-50, Math.min(100, Math.round(options.rate)));
  const weightsStamp = voice.sovitsPath ? statSync(voice.sovitsPath).mtimeMs : 0;
  const key = createHash('sha1')
    .update(`${clean}\u0000local\u0000${voice.id}\u0000${voice.variant}\u0000${weightsStamp}\u0000${rate}`)
    .digest('hex');
  const file = join(ensureCacheDir(options.userRoot), `${key}.wav`);
  if (existsSync(file)) return file;

  let origin: string;
  try {
    origin = new URL(options.localUrl.trim() || 'http://127.0.0.1:9880').origin;
  } catch {
    throw new Error('本机声线服务地址不合法');
  }
  try {
    return await runWithVoiceWeights(voice, origin, async () => {
      const response = await fetch(origin + '/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(180_000),
        body: JSON.stringify({
          text: clean,
          text_lang: voice.language,
          ref_audio_path: voice.refPath,
          prompt_text: voice.refText,
          prompt_lang: voice.language,
          top_k: 15,
          top_p: 1,
          temperature: 1,
          text_split_method: 'cut5',
          batch_size: 1,
          speed_factor: speedFactor(rate),
          media_type: 'wav',
          streaming_mode: false,
        }),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new Error(`本机声线服务 HTTP ${response.status}${detail ? '：' + detail : ''}`);
      }
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') {
        throw new Error('本机声线服务没有返回 WAV（检查 GPT-SoVITS 是否已加载完成）');
      }
      writeFileSync(file, audio);
      return file;
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error('本机声线合成超时（180 秒）', { cause: error });
    }
    throw error;
  }
}

/** 统一入口：按设置选引擎；本机声线失败时**回落 Edge**，不让朗读整段消失 */
export async function synthesizeVoice(text: string, options: SpeakOptions): Promise<string | undefined> {
  if (options.provider === 'local' && options.voiceId) {
    try {
      const file = await synthesizeRecorded(text, {
        userRoot: options.userRoot,
        voiceId: options.voiceId,
        localUrl: options.localUrl || 'http://127.0.0.1:9880',
        rate: options.rate,
      });
      if (file) return file;
    } catch (error) {
      console.warn(
        '[dsh-pet] 本机声线合成失败，回落 Edge：' + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return synthesize(text, options);
}

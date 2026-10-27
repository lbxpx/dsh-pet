/**
 * 语音包导入（P5）：把一个 **文件夹或 zip** 里的「manifest.json + ref.wav（+ 可选 dataset/）」
 * 校验成一份可用的声线包，再交给录制存储层落到 `voices/<new-id>/`。
 *
 * 包格式（与录制产物共用一套目录语义）：
 *   manifest.json   name / refText / consent:true / sourceUrl / license 必填；language 可选
 *   ref.wav         参考音频（PCM/float WAV，1–15 秒；GPT-SoVITS 会自行重采样）
 *   dataset/<n>.wav + <n>.txt   可选：精调数据集，成对出现
 *
 * 为什么要自己解析 zip：宿主不能依赖系统 unzip/PowerShell（跨平台 + 路径穿越风险），
 * 这里只支持 stored/deflate 两种压缩方式，逐条校验路径与解压后大小，遇到 `..`、绝对路径、
 * 加密条目、ZIP64 一律拒绝。导入的 id 由宿主重新生成，**绝不沿用包里的 id**，避免覆盖已有声线。
 */
import { inflateRawSync } from 'node:zlib';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface VoicePackManifest {
  name: string;
  refText: string;
  consent: true;
  sourceUrl: string;
  license: string;
  language: string;
  originalId?: string;
}

export interface VoicePackDatasetItem {
  id: number;
  text: string;
  file: string;
  durationSec: number;
  /** 原始 WAV 字节（导入时落盘；manifest 里不存） */
  wav: Buffer;
}

export interface VoicePack {
  manifest: VoicePackManifest;
  ref: Buffer;
  refSeconds: number;
  dataset: VoicePackDatasetItem[];
}

export const VOICE_PACK_MAX_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_REF_SECONDS = 15;
const MAX_DATASET_SECONDS = 30;

const ID_FORBIDDEN = /[\\/:*?"<>|]/;

/** 控制字符检查（不用带 \x00-\x1f 的正则：ESLint 的 no-control-regex 会拦） */
function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function fail(message: string): never {
  throw new Error(message);
}

/** 宽松读取 WAV 头：只认 PCM/float、8/16/24/32-bit、1–2 声道；不解码样本 */
export function inspectWav(buffer: Buffer): { sampleRate: number; channels: number; bits: number; seconds: number } {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    fail('不是有效的 WAV 文件');
  }
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataSize = -1;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) fail('WAV 数据块被截断');
    if (id === 'fmt ') {
      if (size < 16) fail('WAV 格式块过短');
      format = buffer.readUInt16LE(start);
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bits = buffer.readUInt16LE(start + 14);
    } else if (id === 'data') {
      dataSize = size;
    }
    offset = start + size + (size % 2);
  }
  if (format !== 1 && format !== 3) fail('只支持 PCM/float WAV');
  if (channels !== 1 && channels !== 2) fail('参考音频必须是单声道或双声道');
  if (![8, 16, 24, 32].includes(bits)) fail('参考音频位深必须是 8/16/24/32');
  if (sampleRate < 8000 || sampleRate > 96000) fail('参考音频采样率不在 8k–96k');
  if (dataSize < 0) fail('WAV 里没有音频数据');
  const bytesPerSample = bits / 8;
  const seconds = dataSize / (sampleRate * channels * bytesPerSample);
  if (!(seconds > 0)) fail('WAV 时长无效');
  return { sampleRate, channels, bits, seconds: Math.round(seconds * 100) / 100 };
}

/** 路径规范化 + 安全校验：拒绝绝对路径、盘符、`..`、控制字符；统一成 `/` 分隔 */
function safeEntryName(raw: string): string | undefined {
  if (!raw || hasControl(raw)) return undefined;
  const name = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return undefined;
  const parts = name.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) return undefined;
  return parts.join('/');
}

interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) fail('不是 zip 文件');
  // EOCD 可能带注释：从尾部向前找 0x06054b50
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66_000); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail('zip 找不到中央目录');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) fail('zip 条目太多');
  if (centralOffset + centralSize > buffer.length) fail('zip 中央目录被截断');
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) fail('zip 中央目录损坏');
    const flags = buffer.readUInt16LE(offset + 8);
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (flags & 0x1) fail('不支持加密 zip');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      fail('不支持 ZIP64');
    }
    if (offset + 46 + nameLength > buffer.length) fail('zip 条目名被截断');
    const rawName = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const name = safeEntryName(rawName);
    if (name) entries.push({ name, compression, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) fail('zip 局部文件头损坏');
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  if (start + entry.compressedSize > buffer.length) fail('zip 文件数据被截断');
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (entry.uncompressedSize > MAX_FILE_BYTES) fail('zip 内单个文件超过 50MB');
  if (entry.compression === 0) return Buffer.from(raw);
  if (entry.compression === 8) return inflateRawSync(raw, { maxOutputLength: MAX_FILE_BYTES });
  fail('只支持 stored/deflate 压缩的 zip');
}

/** 解析 zip → 文件名 map（已做路径安全校验；未知文件保留，由后续只挑 manifest/ref/dataset） */
export function readVoiceZip(buffer: Buffer): Map<string, Buffer> {
  const entries = readZipEntries(buffer);
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    if (entry.uncompressedSize > MAX_FILE_BYTES) fail('zip 内单个文件超过 50MB');
    total += entry.uncompressedSize;
    if (total > VOICE_PACK_MAX_BYTES) fail('zip 解压后超过 100MB');
    files.set(entry.name, extractZipEntry(buffer, entry));
  }
  return files;
}

/** 允许包外面再套一层目录：`pack/manifest.json` 等价于根目录的 `manifest.json` */
export function stripPackRoot(files: Map<string, Buffer>): Map<string, Buffer> {
  if (files.has('manifest.json')) return files;
  const names = [...files.keys()];
  const roots = new Set(names.map((name) => name.split('/')[0]));
  if (roots.size !== 1) return files;
  const root = [...roots][0];
  if (!root || !files.has(root + '/manifest.json')) return files;
  const stripped = new Map<string, Buffer>();
  for (const [name, data] of files) {
    if (!name.startsWith(root + '/')) continue;
    stripped.set(name.slice(root.length + 1), data);
  }
  return stripped;
}

function manifestField(value: unknown, field: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max || hasControl(text)) fail('manifest.' + field + ' 需要 1–' + max + ' 个字符');
  return text;
}

function parseSourceUrl(value: unknown): string {
  const text = manifestField(value, 'sourceUrl', 2048);
  if (text === 'self' || text === 'local') return text;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('bad');
  } catch {
    fail('manifest.sourceUrl 必须是 http(s) 地址、self 或 local');
  }
  return text;
}

/** 校验文件集合 → VoicePack（必填 manifest/ref，dataset 可选但必须成对） */
export function parseVoicePack(files: Map<string, Buffer>): VoicePack {
  const normalized = stripPackRoot(files);
  const manifestRaw = normalized.get('manifest.json');
  if (!manifestRaw) fail('包里缺少 manifest.json');
  const ref = normalized.get('ref.wav');
  if (!ref) fail('包里缺少 ref.wav');
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(manifestRaw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad');
    raw = parsed as Record<string, unknown>;
  } catch {
    fail('manifest.json 不是有效的 JSON 对象');
  }
  if (raw.consent !== true) fail('manifest.consent 必须为 true（克隆真人声线必须本人同意）');
  const refInfo = inspectWav(ref);
  if (refInfo.seconds > MAX_REF_SECONDS) fail('ref.wav 不能超过 ' + MAX_REF_SECONDS + ' 秒');
  if (refInfo.seconds < 1) fail('ref.wav 至少 1 秒');
  const manifest: VoicePackManifest = {
    name: manifestField(raw.name, 'name', 40),
    refText: manifestField(raw.refText, 'refText', 500),
    consent: true,
    sourceUrl: parseSourceUrl(raw.sourceUrl),
    license: manifestField(raw.license, 'license', 80),
    language: typeof raw.language === 'string' && raw.language.trim() ? raw.language.trim().slice(0, 20) : 'zh-CN',
  };
  if (typeof raw.id === 'string' && raw.id.length <= 80 && !ID_FORBIDDEN.test(raw.id) && !hasControl(raw.id)) {
    manifest.originalId = raw.id;
  }

  const dataset: VoicePackDatasetItem[] = [];
  for (const [name, data] of normalized) {
    if (!name.startsWith('dataset/') || !name.endsWith('.wav')) continue;
    const base = name.slice('dataset/'.length, -'.wav'.length);
    if (!/^\d{1,4}$/.test(base)) continue;
    const textRaw = normalized.get('dataset/' + base + '.txt');
    if (!textRaw) fail('dataset/' + base + '.wav 缺少同名 .txt');
    const text = textRaw.toString('utf8').trim();
    if (!text || text.length > 500) fail('dataset/' + base + '.txt 需要 1–500 个字符');
    const info = inspectWav(data);
    if (info.seconds > MAX_DATASET_SECONDS) fail('dataset/' + base + '.wav 超过 ' + MAX_DATASET_SECONDS + ' 秒');
    dataset.push({ id: Number(base), text, file: 'dataset/' + base + '.wav', durationSec: info.seconds, wav: data });
  }
  dataset.sort((a, b) => a.id - b.id);
  return { manifest, ref, refSeconds: refInfo.seconds, dataset };
}

/** 从本机文件夹读包（只用允许的文件名，不跟随子目录里的任意文件） */
export async function readVoicePackFolder(folder: string): Promise<VoicePack> {
  let info;
  try {
    info = await stat(folder);
  } catch {
    fail('文件夹不存在');
  }
  if (!info.isDirectory()) fail('不是文件夹');
  const files = new Map<string, Buffer>();
  async function load(root: string): Promise<boolean> {
    try {
      files.set('manifest.json', await readFile(join(root, 'manifest.json')));
      files.set('ref.wav', await readFile(join(root, 'ref.wav')));
    } catch {
      files.clear();
      return false;
    }
    try {
      for (const entry of await readdir(join(root, 'dataset'), { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!/^\d{1,4}\.(wav|txt)$/.test(entry.name)) continue;
        files.set('dataset/' + entry.name, await readFile(join(root, 'dataset', entry.name)));
      }
    } catch {
      /* dataset 可选 */
    }
    return true;
  }
  if (await load(folder)) return parseVoicePack(files);
  // 允许用户选到“包外面那一层”：若恰好只有一个子目录且它含 manifest，就用它
  const subdirs = (await readdir(folder, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith('.'),
  );
  for (const sub of subdirs) {
    if (await load(join(folder, sub.name))) return parseVoicePack(files);
  }
  fail('文件夹里没有找到 manifest.json 与 ref.wav');
}

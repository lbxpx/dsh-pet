import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeSamples, judgeVoiceClip, parsePcm16Wav, spokenCharCount } from './voice-format.ts';

/** 造一段 32kHz 单声道 16-bit WAV：前 0.4s 静音，其余为给定振幅的正弦波 */
function makeWav(seconds: number, amplitude = 0.2, sampleRate = 32_000): Buffer {
  const count = Math.round(seconds * sampleRate);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const t = i / sampleRate;
    samples[i] = t < 0.4 ? 0 : Math.sin(2 * Math.PI * 220 * t) * amplitude;
  }
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('parsePcm16Wav：合法文件取到采样率/时长/样本；非 PCM / 立体声 / 截断一律明确报错', () => {
  const parsed = parsePcm16Wav(makeWav(3));
  assert.equal(parsed.sampleRate, 32_000);
  assert.ok(Math.abs(parsed.durationSec - 3) < 0.01);
  assert.equal(parsed.samples.length, 96_000);

  assert.throws(
    () => parsePcm16Wav(Buffer.from('not a wav at all, but long enough to pass length check.......')),
    /WAV/,
  );

  const stereo = makeWav(3);
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => parsePcm16Wav(stereo), /单声道/);

  const truncated = makeWav(3).subarray(0, 1000);
  assert.throws(() => parsePcm16Wav(truncated), /截断|没有音频数据|短/);
});

test('analyzeSamples + judgeVoiceClip：安静、正常音量、3 秒 → 通过', () => {
  const parsed = parsePcm16Wav(makeWav(3, 0.2));
  const metrics = analyzeSamples(parsed.samples, parsed.sampleRate, '春风吹过竹林，竹叶沙沙地响。');
  assert.ok(Math.abs(metrics.durationSec - 3) < 0.01);
  assert.ok(metrics.peakDb < -10 && metrics.peakDb > -20, '峰值应约为 -14dBFS：' + metrics.peakDb);
  assert.ok(metrics.noiseFloorDb < -45, '静音段的底噪应很低：' + metrics.noiseFloorDb);
  const verdict = judgeVoiceClip(metrics, 10);
  assert.equal(verdict.pass, true, JSON.stringify(verdict.issues));
});

test('judgeVoiceClip：太短 / 爆音 / 底噪高各自给出可动手的失败原因', () => {
  const short = analyzeSamples(new Float32Array(32_000 * 1), 32_000, '短');
  assert.equal(judgeVoiceClip(short, 10).pass, false);
  assert.match(judgeVoiceClip(short, 10).issues.join(), /太短/);

  const loud = parsePcm16Wav(makeWav(3, 0.95));
  const loudVerdict = judgeVoiceClip(analyzeSamples(loud.samples, 32_000, '很大声的一句话'), 10);
  assert.equal(loudVerdict.pass, false);
  assert.match(loudVerdict.issues.join(), /爆音/);

  // 整段都有底噪（没有静音间隙）→ 第 5 百分位也不低，应判底噪高
  const count = 32_000 * 3;
  const noisy = new Float32Array(count);
  for (let i = 0; i < count; i += 1) noisy[i] = (Math.random() - 0.5) * 0.1;
  const noisyVerdict = judgeVoiceClip(analyzeSamples(noisy, 32_000, '底噪测试'), 10);
  assert.equal(noisyVerdict.pass, false);
  assert.match(noisyVerdict.issues.join(), /底噪/);
});

test('judgeVoiceClip：语速异常只提示、不拦下一句', () => {
  const parsed = parsePcm16Wav(makeWav(2, 0.2));
  const fast = analyzeSamples(parsed.samples, 32_000, '这是一句非常非常非常非常非常非常非常长的话');
  assert.ok(fast.charsPerSecond > 8, '前置：确实偏快：' + fast.charsPerSecond);
  const verdict = judgeVoiceClip(fast, 10);
  assert.ok(
    verdict.warnings.some((item) => /语速/.test(item)),
    verdict.warnings.join(),
  );
});

test('spokenCharCount：去掉标点与空白，汉字/字母/数字都算字', () => {
  assert.equal(spokenCharCount('你好，世界！'), 4);
  assert.equal(spokenCharCount('AI 与 GPT-4'), 7);
  assert.equal(spokenCharCount('  ，。！？ '), 0);
});

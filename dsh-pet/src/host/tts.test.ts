import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { listRecordedVoices, resolveRecordedVoice, synthesizeRecorded } from './tts.ts';

/** 最小合法 WAV（32kHz 单声道 16-bit，0.1 秒静音） */
function silentWav(): Buffer {
  const samples = 3200;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(32_000, 24);
  header.writeUInt32LE(64_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function makeVoice(root: string, id = 'v-20261027-205228-5b1e', legacy = false): string {
  const dir = join(root, 'voices', id);
  mkdirSync(join(dir, 'dataset'), { recursive: true });
  const wav = silentWav();
  writeFileSync(join(dir, 'ref.wav'), wav);
  writeFileSync(join(dir, 'dataset', '1.wav'), Buffer.from('other'));
  writeFileSync(join(dir, 'dataset', '7.wav'), wav);
  writeFileSync(join(dir, 'dataset', '7.txt'), '窗外下着小雨，屋里暖洋洋的。\n');
  const manifest = {
    version: 1,
    id,
    name: '彭欣',
    type: 'recorded',
    createdAt: '2026-10-27T12:52:28.661Z',
    consent: true,
    language: 'zh-CN',
    sampleRate: 32_000,
    status: 'ready',
    clips: [
      { id: 1, category: 'phoneme', text: '春风吹过竹林。', file: 'dataset/1.wav', durationSec: 3, pass: true },
      {
        id: 7,
        category: 'phoneme',
        text: '窗外下着小雨，屋里暖洋洋的。',
        file: 'dataset/7.wav',
        durationSec: 6.1,
        pass: true,
      },
    ],
    ref: 'ref.wav',
    ...(legacy ? {} : { refClipId: 7, refText: '窗外下着小雨，屋里暖洋洋的。' }),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

test('resolveRecordedVoice：新 manifest 直接读 refText；旧 manifest 按 ref.wav 哈希回找原句', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pet-tts-'));
  try {
    const userRoot = join(root, 'dsh-pet');
    makeVoice(userRoot);
    const voice = resolveRecordedVoice(userRoot, 'v-20261027-205228-5b1e');
    assert.equal(voice?.name, '彭欣');
    assert.equal(voice?.refText, '窗外下着小雨，屋里暖洋洋的。');

    const legacyId = 'v-20261027-205229-aaaa';
    makeVoice(userRoot, legacyId, true);
    const legacy = resolveRecordedVoice(userRoot, legacyId);
    assert.equal(legacy?.refText, '窗外下着小雨，屋里暖洋洋的。', '旧 manifest 没有 refClipId 也能回找');

    assert.equal(resolveRecordedVoice(userRoot, 'v-20261027-205229-bbbb'), undefined);
    assert.equal(resolveRecordedVoice(userRoot, '../../etc'), undefined);
    assert.equal(listRecordedVoices(userRoot).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('synthesizeRecorded：按声线取 ref 发请求，落 cache wav；同文本第二次命中缓存', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pet-tts-http-'));
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += String(chunk)));
    req.on('end', () => {
      requests.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(silentWav());
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const userRoot = join(root, 'dsh-pet');
    makeVoice(userRoot);
    const file = await synthesizeRecorded('你好呀，我是你的桌宠。', {
      userRoot,
      voiceId: 'v-20261027-205228-5b1e',
      localUrl: `http://127.0.0.1:${port}`,
      rate: 10,
    });
    assert.ok(file && file.endsWith('.wav'));
    assert.equal(readFileSync(file).toString('ascii', 0, 4), 'RIFF');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].prompt_text, '窗外下着小雨，屋里暖洋洋的。');
    assert.equal(String(requests[0].ref_audio_path).includes('ref.wav'), true);
    assert.equal(requests[0].speed_factor, 1.1);
    assert.equal(requests[0].text, '你好呀，我是你的桌宠。');

    const again = await synthesizeRecorded('你好呀，我是你的桌宠。', {
      userRoot,
      voiceId: 'v-20261027-205228-5b1e',
      localUrl: `http://127.0.0.1:${port}`,
      rate: 10,
    });
    assert.equal(again, file);
    assert.equal(requests.length, 1, '同文本/声线/语速应命中缓存');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('synthesizeRecorded：服务 500 / 非 WAV 响应都明确报错（由 synthesizeVoice 决定是否回落）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pet-tts-err-'));
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/tts' ? 500 : 404, { 'content-type': 'text/plain' });
    res.end('boom');
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const userRoot = join(root, 'dsh-pet');
    makeVoice(userRoot);
    await assert.rejects(
      synthesizeRecorded('测试', {
        userRoot,
        voiceId: 'v-20261027-205228-5b1e',
        localUrl: `http://127.0.0.1:${port}`,
        rate: 0,
      }),
      /HTTP 500/,
    );
    const cacheDir = join(userRoot, 'tts');
    assert.equal(existsSync(cacheDir) ? readdirSync(cacheDir).length : 0, 0, '失败不落缓存文件');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

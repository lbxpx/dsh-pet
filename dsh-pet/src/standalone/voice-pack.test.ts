import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { inspectWav, parseVoicePack, readVoicePackFolder, readVoiceZip, stripPackRoot } from './voice-pack.ts';
import { createVoiceStudio, listVoiceSessions } from './voice-recording.ts';

/** 最小 32kHz 单声道 16-bit PCM WAV（前 0.4s 静音，其余 0.2 振幅正弦） */
function makeWav(seconds = 3): Buffer {
  const sampleRate = 32_000;
  const count = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    const t = i / sampleRate;
    const value = t < 0.4 ? 0 : Math.sin(2 * Math.PI * 220 * t) * 0.2;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 造一个 stored（不压缩）zip：我们的解析器只关心中央目录/局部头，不校验 CRC */
function storedZip(files: Record<string, Buffer | string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    const nameBuffer = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 14); // crc
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuffer, body);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + body.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: '导入声线',
    refText: '窗外下着小雨，屋里暖洋洋的。',
    consent: true,
    sourceUrl: 'https://example.com/voice-pack',
    license: 'CC-BY-4.0',
    language: 'zh-CN',
    ...overrides,
  });
}

test('inspectWav：合法 PCM 取到时长；坏文件/非 WAV 明确报错', () => {
  const info = inspectWav(makeWav(3));
  assert.equal(info.sampleRate, 32_000);
  assert.equal(info.channels, 1);
  assert.equal(info.bits, 16);
  assert.ok(Math.abs(info.seconds - 3) < 0.01);
  assert.throws(() => inspectWav(Buffer.from('not a wav')), /WAV/);
});

test('parseVoicePack：根目录包 / 套一层目录的包都能解；dataset 成对解析', () => {
  const files = new Map<string, Buffer>([
    ['manifest.json', Buffer.from(manifest())],
    ['ref.wav', makeWav(3)],
    ['dataset/1.wav', makeWav(2)],
    ['dataset/1.txt', Buffer.from('第一句\n')],
    ['README.md', Buffer.from('ignored')],
  ]);
  const pack = parseVoicePack(files);
  assert.equal(pack.manifest.name, '导入声线');
  assert.equal(pack.manifest.sourceUrl, 'https://example.com/voice-pack');
  assert.equal(pack.refSeconds, 3);
  assert.equal(pack.dataset.length, 1);
  assert.equal(pack.dataset[0].text, '第一句');
  assert.equal(pack.dataset[0].file, 'dataset/1.wav');

  const wrapped = new Map<string, Buffer>();
  for (const [name, data] of files) wrapped.set('我的语音包/' + name, data);
  const stripped = stripPackRoot(wrapped);
  assert.equal(stripped.has('manifest.json'), true);
  assert.equal(parseVoicePack(wrapped).manifest.name, '导入声线');
});

test('parseVoicePack：缺 manifest/ref、无 consent、缺来源/许可、坏 WAV、缺 txt 都拒绝', () => {
  const base = new Map<string, Buffer>([
    ['manifest.json', Buffer.from(manifest())],
    ['ref.wav', makeWav(3)],
  ]);
  const without = (name: string) => {
    const copy = new Map(base);
    copy.delete(name);
    return copy;
  };
  assert.throws(() => parseVoicePack(without('manifest.json')), /manifest\.json/);
  assert.throws(() => parseVoicePack(without('ref.wav')), /ref\.wav/);

  for (const [field, value, pattern] of [
    ['consent', false, /consent/],
    ['sourceUrl', '', /sourceUrl/],
    ['license', '', /license/],
    ['name', '', /name/],
    ['refText', '', /refText/],
  ] as const) {
    const bad = new Map(base);
    bad.set('manifest.json', Buffer.from(manifest({ [field]: value })));
    assert.throws(() => parseVoicePack(bad), pattern, field);
  }

  const badWav = new Map(base);
  badWav.set('ref.wav', Buffer.from('not wav'));
  assert.throws(() => parseVoicePack(badWav), /WAV/);

  const missingTxt = new Map(base);
  missingTxt.set('dataset/1.wav', makeWav(2));
  assert.throws(() => parseVoicePack(missingTxt), /同名 \.txt/);
});

test('readVoiceZip：stored zip 正常解；路径穿越条目不会进文件表；套目录可导入', () => {
  const zip = storedZip({
    'manifest.json': manifest(),
    'ref.wav': makeWav(3),
    '../evil.txt': 'bad',
    '/abs.txt': 'bad',
    'pack/dataset/1.wav': makeWav(2),
    'pack/dataset/1.txt': '你好',
  });
  const files = readVoiceZip(zip);
  assert.equal(files.has('manifest.json'), true);
  assert.equal(files.has('../evil.txt'), false);
  assert.equal(files.has('/abs.txt'), false);
  // 根 manifest + pack/ 下 dataset 不属于同一种布局：这里只验证解析器不越界
  assert.equal(files.has('pack/dataset/1.wav'), true);
});

test('readVoicePackFolder：目录版；也支持用户选到包外面那一层', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pet-pack-'));
  try {
    const folder = join(root, 'pack');
    mkdirSync(join(folder, 'dataset'), { recursive: true });
    writeFileSync(join(folder, 'manifest.json'), manifest());
    writeFileSync(join(folder, 'ref.wav'), makeWav(3));
    writeFileSync(join(folder, 'dataset', '1.wav'), makeWav(2));
    writeFileSync(join(folder, 'dataset', '1.txt'), '第一句');

    const direct = await readVoicePackFolder(folder);
    assert.equal(direct.manifest.name, '导入声线');

    const fromParent = await readVoicePackFolder(root);
    assert.equal(fromParent.manifest.name, '导入声线');
    await assert.rejects(readVoicePackFolder(join(root, 'missing')), /不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('importPack：生成新 id、写 ref/dataset/manifest；两次导入不互相覆盖', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pet-import-'));
  try {
    const studio = createVoiceStudio(join(root, 'voices'), () => new Date(2026, 9, 27, 12, 0, 0).getTime());
    const pack = parseVoicePack(
      new Map<string, Buffer>([
        ['manifest.json', Buffer.from(manifest({ id: 'v-20200101-000000-dead' }))],
        ['ref.wav', makeWav(3)],
        ['dataset/1.wav', makeWav(2)],
        ['dataset/1.txt', Buffer.from('第一句')],
      ]),
    );
    const first = await studio.importPack(pack);
    const second = await studio.importPack(pack);
    assert.notEqual(first.id, second.id, '绝不沿用包里的 id / 不覆盖已有声线');
    assert.equal(first.type, 'imported');
    assert.equal(first.datasetCount, 1);
    assert.equal(first.status, 'ready');
    assert.equal(first.refSeconds, 3);
    const manifestOnDisk = JSON.parse(readFileSync(join(first.dir, 'manifest.json'), 'utf8'));
    assert.equal(manifestOnDisk.type, 'imported');
    assert.equal(manifestOnDisk.sourceUrl, 'https://example.com/voice-pack');
    assert.equal(manifestOnDisk.license, 'CC-BY-4.0');
    assert.equal(manifestOnDisk.refText, '窗外下着小雨，屋里暖洋洋的。');
    assert.equal(manifestOnDisk.dataset.length, 1);
    assert.equal(existsSync(join(first.dir, 'ref.wav')), true);
    const list = await listVoiceSessions(join(root, 'voices'));
    assert.equal(list.length, 2);
    assert.equal(list[0].type, 'imported');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

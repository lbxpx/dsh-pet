import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createVoiceStudio, listVoiceSessions } from './voice-recording.ts';

/** 本地时间 2026-10-27 12:00:00（会话 id 用的是本地时间字段；用 UTC 会随时区差 8 小时） */
const FIXED = new Date(2026, 9, 27, 12, 0, 0).getTime();

function makeWav(seconds: number, sampleRate = 32_000): Buffer {
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

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pet-voice-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('createSession：名称/同意校验；生成的 id 只含安全字符且目录结构正确', async () => {
  const f = fixture();
  try {
    const studio = createVoiceStudio(join(f.root, 'voices'), () => FIXED);
    await assert.rejects(studio.createSession({ name: '  ', consent: true }), /1–40/);
    await assert.rejects(studio.createSession({ name: '小蓝', consent: false }), /同意/);
    const session = await studio.createSession({ name: '小蓝', consent: true });
    assert.match(session.id, /^v-20261027-120000-[0-9a-f]{4}$/);
    assert.equal(session.recorded, 0);
    assert.equal(session.total, 40);
    assert.equal(existsSync(join(session.dir, 'dataset')), true);
    const manifest = JSON.parse(readFileSync(join(session.dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.name, '小蓝');
    assert.equal(manifest.consent, true);
    assert.equal(manifest.status, 'recording');
    assert.deepEqual(manifest.clips, []);
    const list = await listVoiceSessions(join(f.root, 'voices'));
    assert.equal(list.length, 1);
    assert.equal(list[0].name, '小蓝');
  } finally {
    f.cleanup();
  }
});

test('saveClip：合法录音落 dataset/<n>.wav + txt 并更新 manifest；重录覆盖同一句', async () => {
  const f = fixture();
  try {
    const studio = createVoiceStudio(join(f.root, 'voices'), () => FIXED);
    const session = await studio.createSession({ name: '小蓝', consent: true });
    const saved = await studio.saveClip(session.id, 1, makeWav(3));
    assert.equal(saved.clip.id, 1);
    assert.equal(saved.clip.pass, true, saved.issues.join());
    assert.equal(saved.recorded, 1);
    assert.equal(existsSync(join(session.dir, 'dataset', '1.wav')), true);
    assert.match(readFileSync(join(session.dir, 'dataset', '1.txt'), 'utf8'), /春风吹过竹林/);

    const again = await studio.saveClip(session.id, 1, makeWav(3));
    assert.equal(again.recorded, 1, '同一句重录是覆盖，不是追加');
    const manifest = JSON.parse(readFileSync(join(session.dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.clips.length, 1);
    assert.equal(manifest.clips[0].file, 'dataset/1.wav');
  } finally {
    f.cleanup();
  }
});

test('saveClip：未知句子 / 采样率不对 / 坏 WAV / 非法会话 id 一律拒绝，不落盘', async () => {
  const f = fixture();
  try {
    const studio = createVoiceStudio(join(f.root, 'voices'), () => FIXED);
    const session = await studio.createSession({ name: '小蓝', consent: true });
    await assert.rejects(studio.saveClip(session.id, 999, makeWav(3)), /未知的句子/);
    await assert.rejects(studio.saveClip(session.id, 1, makeWav(3, 16_000)), /32000/);
    await assert.rejects(studio.saveClip(session.id, 1, Buffer.from('not wav')), /WAV|音频/);
    await assert.rejects(studio.saveClip('../../etc', 1, makeWav(3)), /录制会话不存在/);
    assert.equal(existsSync(join(session.dir, 'dataset', '1.wav')), false);
  } finally {
    f.cleanup();
  }
});

test('finish：自动挑参考音频写 ref.wav 并把 manifest 标成 ready；空会话明确失败', async () => {
  const f = fixture();
  try {
    const studio = createVoiceStudio(join(f.root, 'voices'), () => FIXED);
    const empty = await studio.createSession({ name: '空', consent: true });
    await assert.rejects(studio.finish(empty.id), /还没有录/);

    const session = await studio.createSession({ name: '小蓝', consent: true });
    // 短句与长句各一条：参考音频应优先挑「通过 + 3–10 秒」
    await studio.saveClip(session.id, 1, makeWav(3));
    await studio.saveClip(session.id, 31, makeWav(8));
    const done = await studio.finish(session.id);
    assert.equal(done.ref, 'ref.wav');
    assert.equal(done.manifest.status, 'ready');
    assert.equal(existsSync(join(session.dir, 'ref.wav')), true);
    assert.equal(done.manifest.clips.length, 2);
  } finally {
    f.cleanup();
  }
});

test('listVoiceSessions：损坏的会话跳过，不影响其它会话', async () => {
  const f = fixture();
  try {
    const studio = createVoiceStudio(join(f.root, 'voices'), () => FIXED);
    const good = await studio.createSession({ name: '好的', consent: true });
    const bad = await studio.createSession({ name: '坏的', consent: true });
    writeFileSync(join(bad.dir, 'manifest.json'), '{broken', 'utf8');
    const list = await listVoiceSessions(join(f.root, 'voices'));
    assert.deepEqual(
      list.map((item) => item.id),
      [good.id],
    );
  } finally {
    f.cleanup();
  }
});

test('声线库：getSession 带 ref 信息；rename 只改名字；delete 删整目录', async () => {
  const f = fixture();
  try {
    const studio = createVoiceStudio(join(f.root, 'voices'), () => FIXED);
    const session = await studio.createSession({ name: '小蓝', consent: true });
    await studio.saveClip(session.id, 1, makeWav(3));
    await studio.finish(session.id);

    const detail = await studio.getSession(session.id);
    assert.equal(detail.status, 'ready');
    assert.equal(detail.recorded, 1);
    assert.equal(detail.refSeconds, 3);
    assert.ok((detail.refBytes ?? 0) > 44);
    assert.equal(typeof detail.createdAt, 'string');

    const renamed = await studio.renameSession(session.id, '  新名字  ');
    assert.equal(renamed.name, '新名字');
    const manifest = JSON.parse(readFileSync(join(session.dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.name, '新名字');
    assert.equal(manifest.id, session.id, 'id/目录不变');

    const removed = await studio.deleteSession(session.id);
    assert.deepEqual(removed, { id: session.id, name: '新名字' });
    assert.equal(existsSync(session.dir), false);
    await assert.rejects(studio.getSession(session.id), /不存在/);
    await assert.rejects(studio.renameSession(session.id, 'x'), /不存在/);
    await assert.rejects(studio.deleteSession('../../etc'), /不存在/);
  } finally {
    f.cleanup();
  }
});

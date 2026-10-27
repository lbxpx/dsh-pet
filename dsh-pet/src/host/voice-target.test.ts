import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { voiceSurface } from './voice-target.ts';

describe('voiceSurface —— 一段语音只让一端出声（display=both 时两端都在渲染）', () => {
  test('both + 桌面进程在跑 → desktop（否则网页与桌面窗口会重叠出声）', () => {
    assert.equal(voiceSurface('both', true), 'desktop');
  });

  test('both + 桌面进程没跑 → web（网页端是唯一渲染端，不能谁都不播）', () => {
    assert.equal(voiceSurface('both', false), 'web');
  });

  test('desktop + 桌面进程在跑 → desktop', () => {
    assert.equal(voiceSurface('desktop', true), 'desktop');
  });

  test('desktop + 桌面进程没跑 → null（网页端不渲染这只，不能凭空出声）', () => {
    assert.equal(voiceSurface('desktop', false), null);
  });

  test('web → 恒为 web（与桌面进程无关）', () => {
    assert.equal(voiceSurface('web', true), 'web');
    assert.equal(voiceSurface('web', false), 'web');
  });

  test('none → null（两端都不显示，谁都不该播）', () => {
    assert.equal(voiceSurface('none', true), null);
    assert.equal(voiceSurface('none', false), null);
  });

  test('缺失 / 非法值 → web（配置合并器保证合法；真拿到脏值也不静默丢这一句）', () => {
    assert.equal(voiceSurface(undefined, true), 'web');
    assert.equal(voiceSurface('DESKTOP', true), 'web');
    assert.equal(voiceSurface(42, true), 'web');
  });
});

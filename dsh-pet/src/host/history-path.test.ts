import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { DEFAULT_HISTORY_FILE, resolveHistoryPath } from './history-path';

const root = resolve('C:/Users/example/.dsh/dsh-pet');

test('未配置时回落到 userRoot 下的 memory.json', () => {
  assert.equal(resolveHistoryPath(root), join(root, DEFAULT_HISTORY_FILE));
  assert.equal(resolveHistoryPath(root, ''), join(root, DEFAULT_HISTORY_FILE));
  assert.equal(resolveHistoryPath(root, '   '), join(root, DEFAULT_HISTORY_FILE));
});

test('绝对路径原样使用', () => {
  const target = resolve('E:/dsh-pet/chat/history.json');
  assert.equal(resolveHistoryPath(root, target), target);
});

test('相对路径相对 userRoot 解析', () => {
  assert.equal(resolveHistoryPath(root, 'logs/chat.json'), join(root, 'logs/chat.json'));
});

test('切到别的历史文件后仍可切回默认', () => {
  assert.equal(resolveHistoryPath(root, resolve('E:/a.json')), resolve('E:/a.json'));
  assert.equal(resolveHistoryPath(root, ''), join(root, DEFAULT_HISTORY_FILE));
});

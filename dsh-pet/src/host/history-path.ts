import { isAbsolute, join, resolve } from 'node:path';

/** 默认对话历史文件名（放在 userRoot 下） */
export const DEFAULT_HISTORY_FILE = 'memory.json';

/**
 * 解析对话历史文件位置。
 *
 * - 未配置（空串）：`<userRoot>/memory.json`（旧行为，零迁移）
 * - 配置为绝对路径：原样使用
 * - 配置为相对路径：相对 `<userRoot>` 解析（方便只写文件名）
 *
 * 只做路径推导，不创建目录、不校验扩展名（写入方负责）。
 * @param userRoot 插件用户数据根（host 侧 `join(home,'dsh-pet')`）
 * @param configured 用户配置的路径（可空）
 * @returns 绝对路径
 */
export function resolveHistoryPath(userRoot: string, configured?: string): string {
  const raw = (configured ?? '').trim();
  if (!raw) return join(userRoot, DEFAULT_HISTORY_FILE);
  return isAbsolute(raw) ? resolve(raw) : resolve(userRoot, raw);
}

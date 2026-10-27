/**
 * 「这段语音交给哪一端播」——纯逻辑，便于单测。
 *
 * 浏览器 overlay 与桌面 Helper 窗口都可能渲染同一只宠物（`display: both`），两端都从
 * `/state` 读到同一条 `pets.<id>.voice`；如果都播，就是两路重叠的声音。规则：
 *
 *   - `none`：哪一端都不显示这只宠物 → 不播（看不见的宠物不出声）；
 *   - `desktop`：桌面 Helper 在跑 → 桌面窗口播；没在跑 → 不播（网页端本来就不渲染它，
 *     让它"在网页里出声"反而像是另一个看不见的宠物在说话）；
 *   - `both`：桌面 Helper 在跑 → 桌面窗口播（它是常驻置顶的那一端）；
 *     没在跑（首次下载 Electron / 崩溃熔断 / 无图形环境）→ 网页端播，网页是唯一渲染端；
 *   - `web`（及未知值）：网页端播。
 */
export type VoiceSurface = 'desktop' | 'web';

/**
 * @param display 宠物条目的 display 成品值（web / desktop / both / none）
 * @param desktopRunning 桌面 Helper 进程当前是否在跑（`helper.isRunning()`）
 * @returns 该由哪一端出声；`null` = 这一段不该出声（没有任何渲染端显示这只宠物）
 */
export function voiceSurface(display: unknown, desktopRunning: boolean): VoiceSurface | null {
  if (display === 'none') return null;
  if (display === 'desktop') return desktopRunning ? 'desktop' : null;
  if (display === 'both' && desktopRunning) return 'desktop';
  return 'web';
}

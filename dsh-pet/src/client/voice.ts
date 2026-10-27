/**
 * 网页端语音播放（client 半侧）。
 *
 * 声音从哪来：宿主把回复合成为 mp3 后写 `/state` 的 `pets.<id>.voice`（见 host 的 publishVoice），
 * 本模块只负责按顺序播放。为什么在渲染端播：macOS / Linux 也有声；音量、静音、输出设备都归
 * 浏览器管，宿主不再 spawn PowerShell / MediaPlayer 这类"只在 Windows 生效"的播放器。
 *
 * 两条去重规则（都是"同一段语音只出一次声"）：
 *   1. 桌面窗口也在渲染这只宠物（display=both）时，叶子里的 `surface: 'desktop'` 已把这段语音
 *      交给桌面端 → 网页端不播，否则两路声音重叠；
 *   2. 同一站点可能同时开在多个标签页：用 Web Locks 选一个"出声页"（拿到锁的页持有到关闭），
 *      其余页拿到的是排队状态 → 它们不播。浏览器不支持 Web Locks 时退化为每页都播（能出声优先）。
 *
 * `Audio` 元素不挂 DOM：Chromium / Firefox / Safari 都允许游离元素播放；播完或失败自动播下一条，
 * 队列满 3 条时丢最旧的，避免积压成一串"迟到的播报"。
 */
import type { VoiceCue } from '../shared/state';

/** 排队上限：超过就丢最旧的（语音是时效内容，播太晚没有意义） */
const MAX_QUEUE = 3;
/** Web Locks 锁名：同源的所有 DSH 页面共用一把 */
const LOCK_NAME = 'dsh-pet-7340-voice';

let queue: string[] = [];
let audio: HTMLAudioElement | undefined;
let playing = false;
let warnedAutoplay = false;

/** 本页是不是"出声页"：拿到 Web Locks 锁（或环境没有 Web Locks）后才为 true */
let leader = typeof navigator === 'undefined' || navigator.locks === undefined;

if (typeof navigator !== 'undefined' && navigator.locks !== undefined) {
  // 回调里返回永不 resolve 的 Promise = 一直持有锁；页面关闭时浏览器自动释放，
  // 排在后面的标签页随即接手（它的 request 回调这时才执行），所以"谁在播"始终只有一个。
  void navigator.locks
    .request(LOCK_NAME, { mode: 'exclusive' }, () => {
      leader = true;
      startNext();
      return new Promise<void>(() => {});
    })
    .catch(() => {
      // 环境禁用了 Web Locks（非安全上下文等）：退化为每页都播，声音比沉默好
      leader = true;
      startNext();
    });
}

/** 取（并按需创建）唯一的 Audio 元素；结束 / 失败都推进队列 */
function element(): HTMLAudioElement {
  if (audio === undefined) {
    audio = new Audio();
    audio.preload = 'auto';
    audio.addEventListener('ended', () => {
      playing = false;
      startNext();
    });
    // 地址 404 / 解码失败：跳过这条，继续下一条——不能让一条坏语音把整条队列卡死
    audio.addEventListener('error', () => {
      playing = false;
      startNext();
    });
  }
  return audio;
}

/** 没有在播时取下一条开始播；播放 / 结束 / 失败的回调都会再进这里 */
function startNext(): void {
  if (!leader || playing) return;
  const url = queue.shift();
  if (url === undefined) return;
  playing = true;
  const el = element();
  el.src = url;
  const started = el.play();
  if (started !== undefined) {
    void started.catch((error: unknown) => {
      // 浏览器的自动播放限制：没有用户手势时 unmuted 音频会被拒。沉默即可（不能伪造交互），
      // 只提示一次，免得每次碎碎念都刷一条同样的警告。
      playing = false;
      queue = [];
      if (!warnedAutoplay) {
        warnedAutoplay = true;
        console.warn(
          '[dsh-pet] 浏览器拦截了语音自动播放（先在页面上点一下即可）：' +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    });
  }
}

/**
 * 收到一条语音指令（`readVoice` 的结果）：入队并尝试播放。
 * 形状非法（null）/ 已交给桌面端（surface=desktop）/ 本页不是出声页 → 直接忽略。
 */
export function playVoice(cue: VoiceCue | null): void {
  if (cue === null || cue.surface === 'desktop' || !leader) return;
  queue.push(cue.url);
  if (queue.length > MAX_QUEUE) queue.shift();
  startNext();
}

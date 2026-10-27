/**
 * 录制向导的句子库（40 句）：四类各 10 句，覆盖音素、数字/英文、情绪语气、长句停顿。
 *
 * 为什么是固定句子而不是让用户随便读：声线克隆（尤其 GPT-SoVITS 的零样本/精调）吃的是
 * **音素覆盖 + 韵律多样性**。只读 10–30 秒日常话，拿到的是音色轮廓，咬字和情绪会明显不像。
 * 这 40 句按下面的目标配比，读完约 6–10 分钟：
 *   - 音素覆盖：zh/ch/sh、z/c/s、j/q/x、前后鼻音（an/ang、en/eng）
 *   - 数字与英文：手机号、日期、金额、房间号、缩写（AI / GPT）
 *   - 情绪语气：开心、撒娇、无奈、认真各 2 句
 *   - 长句停顿：30 字以上、带逗号，决定断句自然度
 *
 * 句子库是**配置**：增删/替换直接改这里的数组即可；`id` 必须唯一且稳定（它会成为
 * `dataset/<id>.wav` 与 `<id>.txt` 的文件名，重录也是覆盖同一个 id）。
 */
export type VoiceCategory = 'phoneme' | 'numbers' | 'emotion' | 'long';

export interface VoiceSentence {
  /** 稳定编号（1..40），对应 dataset/<id>.wav */
  id: number;
  category: VoiceCategory;
  /** 该句建议的最长录制秒数：超过自动停（长句给 12s，其余 10s） */
  maxSec: number;
  text: string;
}

export const VOICE_CATEGORY_LABELS: Record<VoiceCategory, string> = {
  phoneme: '音素覆盖',
  numbers: '数字与英文',
  emotion: '情绪语气',
  long: '长句停顿',
};

const PHONEME = [
  '春风吹过竹林，竹叶沙沙地响。',
  '四十四个石狮子，石狮子是石头的。',
  '你在做什么？我在吃葡萄。',
  '小姐姐，请借我一支铅笔。',
  '西安的西瓜又甜又沙。',
  '天安门广场上，红旗迎风飘扬。',
  '窗外下着小雨，屋里暖洋洋的。',
  '红鲤鱼与绿鲤鱼，游过小桥东。',
  '三月三，小三去登山。',
  '八百标兵奔北坡，炮兵并排北边跑。',
];

const NUMBERS = [
  '我的手机号是 138 0013 8000。',
  '今天是 2026 年 10 月 27 日，星期二。',
  '这件衣服打完折是 299 元。',
  '会议安排在下午 3 点半，B 座 1206 室。',
  '我平时用 AI 和 GPT 处理工作。',
  '高铁 G102 次列车，9 点 15 分发车。',
  '温度 26 度，湿度 65%，适合出门。',
  '我的快递单号是 SF1234567890。',
  '这道题的正确率只有 37.5%。',
  '请把音量调到 80%，再大一点。',
];

const EMOTION = [
  '太棒了！我们成功啦！',
  '主人，陪我玩一会儿嘛，好不好？',
  '唉，今天又加班，累死了……',
  '这件事很重要，请认真对待。',
  '哇，好漂亮的花呀！',
  '别担心，有我在呢。',
  '真是的，怎么又忘了带钥匙。',
  '谢谢你一直陪着我，我很开心。',
  '这个嘛……让我再想一想。',
  '请注意，前方路口减速慢行。',
];

const LONG = [
  '如果你今天有时间，我们可以一起去公园散步，顺便买点水果回来。',
  '窗外下着雨，我泡了一杯热茶，坐在书桌前，慢慢翻着昨天没看完的书。',
  '这个项目的重点是先跑通流程，把数据打通，然后再考虑优化界面和体验。',
  '他犹豫了一下，还是决定把事情的经过，从头到尾完整地说一遍。',
  '早上先开会讨论方案，中午前把修改意见汇总，下午再和设计确认细节。',
  '我小时候住在乡下，门口有一条小河，夏天的时候，我们常去河里捉鱼。',
  '请你在明天下午五点之前，把这份报告发到我的邮箱，并抄送给项目组。',
  '虽然今天遇到了一些困难，但是大家都没有放弃，最后还是按时完成了任务。',
  '夜深了，城市的灯光一盏一盏熄灭，只有远处的便利店还亮着温柔的光。',
  '学习一门新的语言，最重要的是坚持，每天进步一点点，时间久了就会看到变化。',
];

/** 40 句成品（顺序即录制顺序：先易后难，最后是长句） */
export const VOICE_SENTENCES: readonly VoiceSentence[] = [
  ...PHONEME.map((text, index) => ({ id: index + 1, category: 'phoneme' as const, maxSec: 10, text })),
  ...NUMBERS.map((text, index) => ({ id: index + 11, category: 'numbers' as const, maxSec: 10, text })),
  ...EMOTION.map((text, index) => ({ id: index + 21, category: 'emotion' as const, maxSec: 10, text })),
  ...LONG.map((text, index) => ({ id: index + 31, category: 'long' as const, maxSec: 12, text })),
];

/** 按 id 取句子（未知 id → undefined；服务端上传校验用） */
export function voiceSentence(id: number): VoiceSentence | undefined {
  return VOICE_SENTENCES.find((sentence) => sentence.id === id);
}

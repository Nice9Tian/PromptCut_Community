/**
 * 配音的静态数据:服务商、模型、系统音色、情绪。纯数据,前端和服务端都能引。
 *
 * 音色 id 只列实测过或官方文档里写明的;可灵的官方音色没有列表接口
 * (presets-voices 返回的那几个数字 id 拿去合成会 503),所以只放合成成功过的。
 */

export const PROVIDERS = ['minimax', 'kling', 'vidu'];

export const PROVIDER_LABELS = {
  minimax: 'MiniMax',
  kling: '可灵',
  vidu: 'Vidu',
};

export const MINIMAX_MODELS = ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo'];

/** MiniMax / Vidu 共用的情绪;空串 = 模型按文本自己判断 */
export const EMOTIONS = ['', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'];

export const EMOTION_LABELS = {
  '': '自动',
  happy: '高兴',
  sad: '悲伤',
  angry: '愤怒',
  fearful: '害怕',
  disgusted: '厌恶',
  surprised: '惊讶',
  calm: '平静',
};

/** MiniMax 系统音色。Vidu 的语音合成底层就是 MiniMax,同一套 id 通用 */
const MINIMAX_SYSTEM = [
  { voiceId: 'female-shaonv', name: '少女' },
  { voiceId: 'female-yujie', name: '御姐' },
  { voiceId: 'female-chengshu', name: '成熟女性' },
  { voiceId: 'female-tianmei', name: '甜美女性' },
  { voiceId: 'presenter_female', name: '女性主持人' },
  { voiceId: 'male-qn-qingse', name: '青涩青年' },
  { voiceId: 'male-qn-jingying', name: '精英青年' },
  { voiceId: 'male-qn-badao', name: '霸道青年' },
  { voiceId: 'male-qn-daxuesheng', name: '青年大学生' },
  { voiceId: 'presenter_male', name: '男性主持人' },
];

export const SYSTEM_VOICES = {
  minimax: MINIMAX_SYSTEM,
  vidu: MINIMAX_SYSTEM,
  kling: [
    { voiceId: 'chat1_female_new-3', name: '温柔姐姐' },
    { voiceId: 'ai_kaiya', name: '阳光男生' },
    { voiceId: 'genshin_vindi2', name: '阳光少年' },
    { voiceId: 'yizhipiannan-v1', name: '译制片男声' },
  ],
};

/** 单次合成的字数上限(官方限制,留一点余量) */
export const TEXT_LIMITS = { minimax: 5000, kling: 1000, vidu: 5000 };

/** 音色 id 的形状:字母数字和 - _ . ,1~256 位。防的是往请求体里塞奇怪的东西,不代表这个音色存在 */
export function isVoiceIdShape(v) {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(v);
}

/** MiniMax 复刻要求的自定义 id:8~256 位,字母开头,只含字母数字 - _,不以 - _ 结尾 */
export function isCloneIdShape(v) {
  return typeof v === 'string' && v.length >= 8 && v.length <= 256 && /^[A-Za-z][A-Za-z0-9_-]*[A-Za-z0-9]$/.test(v);
}

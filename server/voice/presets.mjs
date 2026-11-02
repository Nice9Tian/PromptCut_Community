import { tr } from "../i18n.mjs";
/**
 * 配音的静态数据:服务商、模型、系统音色、情绪。纯数据,前端和服务端都能引。
 *
 * 音色 id 只列实测过或官方文档里写明的;可灵的官方音色没有列表接口
 * (presets-voices 返回的那几个数字 id 拿去合成会 503),所以只放合成成功过的。
 */

export const PROVIDERS = ['minimax', 'kling', 'vidu'];

export const PROVIDER_LABELS = {
  minimax: 'MiniMax',
  kling: tr("Kling"),
  vidu: 'Vidu',
};

export const MINIMAX_MODELS = ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo'];

/** MiniMax / Vidu 共用的情绪;空串 = 模型按文本自己判断 */
export const EMOTIONS = ['', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'];

export const EMOTION_LABELS = {
  '': 'auto',
  happy: tr("Happy"),
  sad: tr("Sad"),
  angry: tr("Angry"),
  fearful: tr("Fearful"),
  disgusted: tr("Disgusted"),
  surprised: tr("Surprised"),
  calm: tr("Calm"),
};

/** MiniMax 系统音色。Vidu 的语音合成底层就是 MiniMax,同一套 id 通用 */
const MINIMAX_SYSTEM = [
  { voiceId: 'female-shaonv', name: tr("Young girl") },
  { voiceId: 'female-yujie', name: tr("Mature elder sister") },
  { voiceId: 'female-chengshu', name: tr("Mature woman") },
  { voiceId: 'female-tianmei', name: tr("Sweet woman") },
  { voiceId: 'presenter_female', name: tr("Female presenter") },
  { voiceId: 'male-qn-qingse', name: tr("Naive young man") },
  { voiceId: 'male-qn-jingying', name: tr("Elite young man") },
  { voiceId: 'male-qn-badao', name: tr("Domineering young man") },
  { voiceId: 'male-qn-daxuesheng', name: tr("Young college student") },
  { voiceId: 'presenter_male', name: tr("Male presenter") },
];

export const SYSTEM_VOICES = {
  minimax: MINIMAX_SYSTEM,
  vidu: MINIMAX_SYSTEM,
  kling: [
    { voiceId: 'chat1_female_new-3', name: tr("Gentle big sister") },
    { voiceId: 'ai_kaiya', name: tr("Sunny guy") },
    { voiceId: 'genshin_vindi2', name: tr("Sunny youth") },
    { voiceId: 'yizhipiannan-v1', name: tr("Dubbed-film male voice") },
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

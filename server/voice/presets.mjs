/**
 * Static voiceover data: providers, models, system voices, emotions. Pure data, importable by
 * both frontend and server.
 *
 * Voice IDs only list those verified in testing or stated in official docs; Kling official voices
 * lack a listing API (the numeric IDs returned by presets-voices give 503 when synthesizing), so
 * only successfully synthesized ones are included.
 */

export const PROVIDERS = ['minimax', 'kling', 'vidu'];

export const PROVIDER_LABELS = {
  minimax: 'MiniMax',
  kling: 'Kling',
  vidu: 'Vidu',
};

export const MINIMAX_MODELS = ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo'];

/** Emotions shared by MiniMax / Vidu; empty string = model determines on its own from text */
export const EMOTIONS = ['', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'];

export const EMOTION_LABELS = {
  '': 'Auto',
  happy: 'Happy',
  sad: 'Sad',
  angry: 'Angry',
  fearful: 'Fearful',
  disgusted: 'Disgusted',
  surprised: 'Surprised',
  calm: 'Calm',
};

/** MiniMax system voices. Vidu voice synthesis uses MiniMax underneath; the same IDs work for both */
const MINIMAX_SYSTEM = [
  { voiceId: 'female-shaonv', name: 'Young girl' },
  { voiceId: 'female-yujie', name: 'Mature elder sister' },
  { voiceId: 'female-chengshu', name: 'Mature woman' },
  { voiceId: 'female-tianmei', name: 'Sweet woman' },
  { voiceId: 'presenter_female', name: 'Female presenter' },
  { voiceId: 'male-qn-qingse', name: 'Naive young man' },
  { voiceId: 'male-qn-jingying', name: 'Elite young man' },
  { voiceId: 'male-qn-badao', name: 'Domineering young man' },
  { voiceId: 'male-qn-daxuesheng', name: 'Young college student' },
  { voiceId: 'presenter_male', name: 'Male presenter' },
];

export const SYSTEM_VOICES = {
  minimax: MINIMAX_SYSTEM,
  vidu: MINIMAX_SYSTEM,
  kling: [
    { voiceId: 'chat1_female_new-3', name: 'Gentle big sister' },
    { voiceId: 'ai_kaiya', name: 'Sunny guy' },
    { voiceId: 'genshin_vindi2', name: 'Sunny youth' },
    { voiceId: 'yizhipiannan-v1', name: 'Dubbed-film male voice' },
  ],
};

/** Maximum character limit per synthesis (official limit, leaving a small buffer) */
export const TEXT_LIMITS = { minimax: 5000, kling: 1000, vidu: 5000 };

/** Voice id format: alphanumeric and - _ . , 1~256 chars. Prevents bad request bodies, does not mean it exists */
export function isVoiceIdShape(v) {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(v);
}

/** Custom id for MiniMax clone: 8~256 chars, starts with letter, alphanumeric and - _ only, no - _ at end */
export function isCloneIdShape(v) {
  return typeof v === 'string' && v.length >= 8 && v.length <= 256 && /^[A-Za-z][A-Za-z0-9_-]*[A-Za-z0-9]$/.test(v);
}

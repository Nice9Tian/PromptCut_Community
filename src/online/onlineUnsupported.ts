import { tr } from "../i18n/index.ts";

/**
 * 在线浏览器模式里置灰的入口悬停时的说明(C10 契约第 10 节、第 17 节表 A):
 * 「在线浏览器模式暂不支持{入口名}，请在电脑上的 PromptCut 里使用。」
 * 入口名用用户在界面上看到的叫法(「导入媒体」「语音识别」「配音」……)。
 * 单独放一个文件:声音 Worker 会引 `pageFlag.ts`,不能顺带把翻译表载进 Worker。
 */
export function onlineUnsupported(entry: string): string {
  return tr("{0} is not supported in online browser mode yet. Please use it in PromptCut on your computer.", entry);
}

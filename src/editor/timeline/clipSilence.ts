/**
 * 时间轴上「这一段一点声音都不出」的判断，桌面版和手机版共用一份。
 *
 * 判据本身在 kernel（`cardAudioRendition.mjs` 的 `clipGoesSilentBySpeed`）：变速段不出原声，
 * 但挂在它上面的声画一体卡照常出声、音频素材效果卡也出声，所以只有两样都没有才算哑的。
 * 这里只多补一件 kernel 够不着的事：**同步来的定制卡**——在线页面上用户卡的定义不在本机的卡册里，
 * 卡自己声明的内嵌声音只能从 `syncedUserCards()` 里问（别处也是这么补的，见
 * `src/editor/preview/MediaLayers.tsx`、`src/editor/io/exportSounds.ts`）。
 *
 * 放在这一层而不是 kernel：`syncedUserCards` 是卡册（`src/kernel/registry.ts`）的运行期状态，
 * 不属于项目数据；kernel 的那条判据只看项目和传进去的卡片定义，拿它单测才不用起卡册。
 */
import { clipGoesSilentBySpeed } from "../../kernel/cardAudioRendition.mjs";
import { getCard, syncedUserCards } from "../../kernel/registry";
import type { Project, TrackClip } from "../../kernel/project";

export function clipMakesNoSound(
  project: Pick<Project, "cardNodes" | "media">,
  clip: Partial<TrackClip>,
): boolean {
  if (!clipGoesSilentBySpeed(project, clip, getCard)) return false;
  return !syncedUserCards().get(clip.cardId ?? "")?.embeddedAudio;
}

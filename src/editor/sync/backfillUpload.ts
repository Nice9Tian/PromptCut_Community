/**
 * 打开项目后的后台补入库(`io/mediaUpload.ts` 的 `startTierBackfill`)要挂的两件事,由 `Preview` 传进去:
 *
 * - `shared`:共享项目里不给素材标「(缺失)」—— 本机取不取得到是这台机器的事,标记会经文档服务同步给别的成员;
 * - `afterIngest`:项目已经「放云端」时,后台补上哈希的素材交给上传队列,补不上的用同步气泡列给用户
 *   (与开启放云端时 `collab.ts` 的 `queueExistingMedia` 同一句话、同一种提示);
 * - `afterImport`:共享项目里导入完成的素材按哈希交给上传队列;打开项目后、上传目标就绪之前导入的先记下,就绪后补交
 *   (`media/assetTiers.ts` 的 queueImportedMedia),本机内容库里没有的同样列给用户。
 *
 * 单独成一个文件:`mediaUpload.ts` 不能引同步层(`syncManager` 在 Node 单测里加载不了,io 也不该反过来依赖 sync)。
 */
import type { BackfillHooks } from "../io/mediaUpload";
import { getState } from "../../store/project";
import { queueBackfilledMedia, queueImportedMedia } from "../media/assetTiers";
import { getSyncView, pushToast } from "./syncManager";
import { postEnqueue, uploadMissingMessage } from "./collab";

const shared = () => !!getSyncView().shared;
/**
 * 这个文件还带着协作关联(云端或局域网项目,连上了没有都算;被证明转成本地项目之后才没有)。
 * 没连上时(断网、要认证、等主机)`shared` 是空的,但它仍然不是本机项目:只在远端有的素材不能在这时认定缺失。
 */
const associated = () => !!getSyncView().association;

const notify = (names: string[]) => {
  console.warn("[collab] 这些素材传不上去:", names);
  pushToast(uploadMissingMessage(names), "warn", Infinity);
};

export const backfillHooks: BackfillHooks = {
  shared,
  associated,
  afterIngest: (r) => queueBackfilledMedia(r, getState().project.media ?? [], { post: postEnqueue, shared, notify }),
  afterImport: (media) => queueImportedMedia(media, { post: postEnqueue, shared, notify }),
};

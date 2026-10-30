import { useSyncExternalStore } from "react";
import { useStore, actions } from "../../store/project";
import { findClip } from "../../kernel/project";
import { getCard, allCards, onSyncedUserCardsChanged, syncedCardView, syncedUserCardsGen } from "../../kernel/registry";
import { paramsCardView } from "./paramsView";
import { ParamsForm } from "./ParamsForm";
import { PartsForm } from "./PartsForm";
import { isComposite } from "../../kernel/envelope";
import { CodeTab } from "./CodeTab";
import { Frame3DForm } from "./Frame3DForm";
import { ClipFilterForm } from "./ClipFilterForm";
import { ClipSpeedForm } from "./ClipSpeedForm";
import { ClipAudioFxForm } from "./ClipAudioFxForm";
import { SoundEffectForm, TypingSoundControls } from "./SoundEffectForm";
import { CardAudioForm } from "./CardAudioForm";
import { CutSegmentForm } from "./CutSegmentForm";
import { isCutSegment } from "../../kernel/cutSegments";
import { NumberField } from "../fields/NumberField";
import { ReadOnlyFence } from "../ReadOnlyFence";

/**
 * 编辑分区的参数 / 代码两页。哪一页显示由分区头部的胶囊分页决定(tab),
 * 但两页在这里**都常驻挂载**、只切 display:代码框里没提交的草稿切到参数页再回来还在。
 * 片段头部(卡名、换卡、开始/结束)两页共用一份。
 */
export function Inspector({ tab }: { tab: "form" | "code" }) {
  const selId = useStore(s => s.selection[0]);
  const project = useStore(s => s.project);
  // 在线页面同步来的用户卡表变了(新同步到一张卡、源码改了控件):参数面板跟着换
  useSyncExternalStore(onSyncedUserCardsChanged, syncedUserCardsGen);

  const hit = selId ? findClip(project, selId) : null;

  if (!hit) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 text-center text-xs pc-left-muted">
        在时间轴上点一个片段,或在「动画」里点一张卡片添加一个
      </div>
    );
  }

  const { clip } = hit;

  // 剪辑段:没有卡也没有素材,属性是引用哪条剪辑、偏移,以及框、不透明度、淡入淡出、音量与静音
  if (isCutSegment(clip)) return <ReadOnlyFence><CutSegmentForm key={clip.id} clip={clip} /></ReadOnlyFence>;

  if (clip.mediaId && !clip.cardId) {
    const media = project.media.find(m => m.id === clip.mediaId);
    // 参数面板整块进只读围栏:这个项目只给了只读权限(游客)时值照常显示、控件一起置灰(悬停是 viewOnlyText())
    return (
      <div className="flex-1 min-h-0 overflow-y-auto pc-left-scroll flex flex-col p-3 text-xs">
        <ReadOnlyFence>
        <div className="pc-left-muted mb-2">标签: <span className="pc-left-strong">{clip.label || "无"}</span></div>
        <div className="flex items-center gap-2 mb-2 pc-left-muted">
          <span>开始</span>
          <NumberField attrs={{ "data-pc": "clip-start" }} step={0.1} min={0} value={clip.start} onCommit={v => actions.moveClip(clip.id, { start: v })} className="w-16 pc-left-input is-sm" />
          <span>结束</span>
          <NumberField attrs={{ "data-pc": "clip-end" }} step={0.1} min={0} value={clip.end} onCommit={v => actions.moveClip(clip.id, { end: v })} className="w-16 pc-left-input is-sm" />
          <span className="pc-left-faint">{(clip.end - clip.start).toFixed(2)}s</span>
        </div>
        {clip.soundEffect && <SoundEffectForm key={clip.id} clip={clip} />}
        {(media?.kind === "video" || media?.kind === "audio") && <ClipSpeedForm key={clip.id} clip={clip} />}
        {media && (media.kind === "video" || media.kind === "image") && <ClipFilterForm clip={clip} />}
        {media && (media.kind === "video" || media.kind === "audio") && <ClipAudioFxForm clip={clip} />}
        </ReadOnlyFence>
      </div>
    );
  }

  // 先查能跑的定义;在线页面同步来的用户卡没有定义,用源码里解析出的只读视图(名字、默认值、控件)
  const cardDef = paramsCardView(clip.cardId, { getCard, syncedCardView });
  const magic = allCards().filter(c => c.source === "magicui");
  const native = allCards().filter(c => c.source === "native");
  const user = allCards().filter(c => c.source === "user");
  const asset = allCards().filter(c => c.source === "asset");

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ReadOnlyFence><CardAudioForm key={clip.id} clip={clip} /></ReadOnlyFence>
      <ReadOnlyFence>
      <div className="px-3 pb-2 pc-left-divider-b flex flex-col gap-2 shrink-0">
        <div className="flex items-center justify-between">
          <div className="font-semibold text-xs pc-left-strong truncate pr-2">{cardDef?.name ?? clip.cardId}</div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] pc-left-faint shrink-0">换卡会清空参数</span>
            <select
              data-pc="switch-card"
              value={clip.cardId}
              onChange={e => actions.setClipCard(clip.id, e.target.value)}
              className="pc-left-select is-sm w-24 shrink-0"
            >
              {user.length > 0 && (
                <optgroup label="新建">
                  {user.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              )}
              {asset.length > 0 && (
                <optgroup label="动效素材">
                  {asset.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              )}
              <optgroup label="Magic UI">
                {magic.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </optgroup>
              <optgroup label="自家">
                {native.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </optgroup>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs pc-left-muted">
          <span>开始</span>
          <NumberField attrs={{ "data-pc": "clip-start" }} step={0.1} min={0} value={clip.start} onCommit={v => actions.moveClip(clip.id, { start: v })} className="w-16 pc-left-input is-sm" />
          <span>结束</span>
          <NumberField attrs={{ "data-pc": "clip-end" }} step={0.1} min={0} value={clip.end} onCommit={v => actions.moveClip(clip.id, { end: v })} className="w-16 pc-left-input is-sm" />
          <span className="pc-left-faint ml-auto">{(clip.end - clip.start).toFixed(2)}s</span>
        </div>
        {/* 套了素材效果卡的视频段(片段同时带 cardId 和 mediaId):速度照样能改,取帧走素材节点的倍率 */}
        {clip.mediaId && project.media.find(m => m.id === clip.mediaId)?.kind === "video" && <ClipSpeedForm key={`speed-${clip.id}`} clip={clip} />}
      </div>
      </ReadOnlyFence>

      <div className="flex-1 min-h-0 overflow-y-auto pc-left-scroll" style={{ display: tab === "form" ? "block" : "none" }}>
        <ReadOnlyFence>
        {clip.cardId === "mu-typing" && <TypingSoundControls key={clip.id} clip={clip} />}
        {isComposite(clip) ? <PartsForm clip={clip} /> : <ParamsForm clip={clip} cardDef={cardDef} />}
        {/* 三维排在卡片参数后面:它改的是「这张卡摆在哪」,不是卡片自己的内容 */}
        <Frame3DForm clip={clip} />
        </ReadOnlyFence>
      </div>
      <div className="flex-1 min-h-0 flex flex-col" style={{ display: tab === "code" ? "flex" : "none" }}>
        {/* 按片段 id 做 key:换了片段就换一份草稿,不会把上一段没提交的内容带过来 */}
        <CodeTab key={clip.id} clip={clip} />
      </div>
    </div>
  );
}

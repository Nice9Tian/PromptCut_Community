/** update_clip 的 params 说明：工具定义里的静态版本与按 cardId 注入的真实 schema（server/card-params-schema.mjs）共用这一句 */
export const PARAMS_PATCH_DESC = "增量补丁：只写这次要改的参数键，没写的键保持当前值（不会被重置）；不要凭记忆把旧的整份参数带回来，那会把用户刚改过或撤销过的值写回去。要知道现在的值先 get_clip。";

export const clipsTools = [
  {
    name: "add_clip",
    description: "在时间轴上添加一张新卡片。需要提供 cardId 和 start 时间。params 会和卡片 defaults 合并，只写你要改的项即可；但键名必须是该卡真有的参数、标了必填的参数不能为空，否则直接报错——先用 list_cards({cardId}) 看清 schema 再建。字幕卡不要手写 lines，用 fill_captions。返回新建的 clip，外加 `look`（为这张卡准备好的 see_frames 调用，涉及位置和遮挡的决定请照着调去看真实画面）和 `timeline`（当前全部轨道与 clip 的 id、起止一览，之后引用 clipId 以它为准；里面的 `duration` 是整条片子多长、`contentEnd` 是内容实际结束在哪，两个数对不上就用 set_project_meta 把 duration 设成 contentEnd）。",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string" },
        start: { type: "number" },
        duration: { type: "number" },
        trackId: { type: "string" },
        params: { type: "object" }
      },
      required: ["cardId", "start"]
    },
    side: "agent"
  },
  {
    name: "update_clip",
    description: "更新某张卡片,可修改参数、时段、更换卡片类型(cardId),以及不透明度 / 淡入淡出 / 标签 / 所在序列。**已经在时间轴上的卡要改就用它**，不要 remove_clip 再 add_clip 重建。**params 是增量补丁，不是整份替换**：只传你这次要改的键（只改颜色就只传 {color:\"…\"}），没传的键保持它现在的值，不会被重置；**不要凭记忆把以前读到的整份参数带回来**——那些值可能已经被用户或别的操作改过（比如用户刚点了「撤销这步」），整份带回会把它们悄悄写回去。要知道现在的值先 get_clip。**片段在别的（没激活的）剪辑里也直接改，不用 user_interface_switch_cut**（clipId 用 list_cuts({cutId}) 里的；trackId 要用那条剪辑自己的序列 id，回包里标了 `cut`）。返回里的 `changedParams` 列出这次真正变了的键（from → to），`params` 是改完后的参数（太大时只给键名）。opacity 0~1(遮到人又挪不开时降它);fadeIn/fadeOut 是秒;trackId 换序列——**时间轴上靠上的序列盖住靠下的**(get_project 里 tracks[0] 就是最上面那条、也是最上层),要让一张卡压在另一张上面就把它挪到更靠上的序列。位置、尺寸、缩放不在这里改,用 set_rect / set_position / align / nudge;声音音量也不在这里,用 set_clip_volume(传 volume 会被拒)。**挂着转场的片段**(list_transitions 看得到)相对时间关系是锁住的:只给 start 的整组平移可以(同组一起走),改时长 / 换序列 / 手改转场那一侧的 fadeIn·fadeOut 会被拒,要改先 remove_transition。返回 `look`（去看这张卡真实画面的 see_frames 调用）和 `timeline`（当前全部 clip 的 id、起止一览，外加 `duration` / `contentEnd` —— 对不上就用 set_project_meta 修）。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        start: { type: "number" },
        end: { type: "number" },
        cardId: { type: "string" },
        params: { type: "object", description: PARAMS_PATCH_DESC },
        opacity: { type: "number", description: "0~1,默认 1" },
        fadeIn: { type: "number", description: "淡入秒数" },
        fadeOut: { type: "number", description: "淡出秒数" },
        label: { type: "string", description: "时间轴上显示的名字" },
        trackId: { type: "string", description: "挪到哪条序列;时间轴上靠上的序列在上层(tracks[0] 最上层)" }
      },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "remove_clip",
    description: "删除某张卡片(根据 clipId)。有门槛：你自己刚用 add_clip 建的卡、或者一口气连删超过 5 张，会被拒——要改卡用 update_clip；确实要删就传 force:true 并在 reason 里写明理由（用户会看到这句话）。返回 `timeline`（删完后全部 clip 的 id、起止一览，之后引用 clipId 以它为准。**删完尤其要看 `duration` 和 `contentEnd`**：时长不会自己缩短，片尾很容易挂着一段黑，用 set_project_meta 修掉）。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        force: { type: "boolean", description: "越过门槛（删自己刚建的卡 / 连删超过 5 张）。必须同时给 reason。" },
        reason: { type: "string", description: "为什么要删这张卡。force 为 true 时必填，原样回显给用户。" }
      },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "duplicate_clip",
    description: "在原卡片后复制一张一模一样的卡片。",
    inputSchema: {
      type: "object",
      properties: { clipId: { type: "string" } },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "split_clip",
    description: "在指定时间点(t)将卡片切分为两段。挂着转场的片段切不开(转场两头会对不上),先 remove_transition。",
    inputSchema: {
      type: "object",
      properties: { 
        clipId: { type: "string" },
        t: { type: "number" }
      },
      required: ["clipId", "t"]
    },
    side: "agent"
  },
  {
    name: "get_clip",
    description: "读一张卡的**约定封装**:card(哪张卡 + lifecycle:进场多久落定 settleMs、之后 hold 停住 / loop 循环 / evolve 持续变化、支持的退场 exit)、time(start / end / duration)、frame(local 存下来的框,null 即铺满;world 算出来的画面绝对位置,只读)、blend(opacity / fadeIn / fadeOut)、motion(是否绑了轨迹)、parts(部件树:每个部件带自己的参数值和进场时序)、params(全量参数)。要判断「动画早就播完了后面都是静止」看 lifecycle.settleMs 和 time.duration;要知道哪个参数管哪一块看 parts。改它用 set_clip,或者 update_clip / set_rect 等单项工具 —— 它们改的是同一份数据。",
    inputSchema: {
      type: "object",
      properties: { clipId: { type: "string" } },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "set_clip",
    description: "按约定封装改一张卡:把 get_clip 拿到的对象改好后整份传回来(也可以只传要改的段)。可写:card.id(换卡)、params(**全量**——这一段是整份替换,没写进去的键回到卡片默认值,和 update_clip 的增量补丁不同;只想改个别参数就用 update_clip,或先 get_clip 拿到现在的整份再改)或 parts 里各部件的 params、time.start / time.end、frame.local(x / y / w / h / anchor / scale / rotate,以及三维的 rotateX / rotateY / translateZ —— 三维要先 set_camera3d 打开才有透视,而且只对卡片段生效,素材段会被拒;或 null 铺满)、blend.opacity / fadeIn / fadeOut(声音音量不在 blend 里,用 set_clip_volume)。只写有差异的段,任一处不合法整份不写;frame.world、motion、card.lifecycle 是只读的,传了会被忽略。返回改了哪些段、新的封装和 look。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        envelope: { type: "object", description: "get_clip 返回的那个对象(改过的),或只含要改的段" }
      },
      required: ["clipId", "envelope"]
    },
    side: "agent"
  },
  {
    name: "set_emphasis",
    description: "给一段加「强调」:kind 为 shadow(阴影)或 outline(描边),none 是去掉。**两种都沿着画面里不透明部分的边缘走**(CSS drop-shadow 按 alpha 通道算),所以描的是文字、图形、抠好的人物的边,不是那个方框 —— 透明底的卡片效果最明显,整块不透明的画面(视频、满幅图片)只会在方框外圈看到一条边。参数:color CSS 颜色(阴影默认黑、描边默认白),size 舞台像素(阴影是模糊半径、描边是线宽,0~80),opacity 0~1,dx/dy 阴影偏移(描边用不到)。字幕、标题压在花哨背景上看不清时优先用它,比降低背景不透明度更不伤画面。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        kind: { type: "string", description: "shadow / outline / none" },
        color: { type: "string", description: "CSS 颜色,如 #000000" },
        size: { type: "number", description: "舞台像素:阴影=模糊半径,描边=线宽" },
        opacity: { type: "number", description: "0~1" },
        dx: { type: "number", description: "阴影横向偏移(舞台像素)" },
        dy: { type: "number", description: "阴影纵向偏移(舞台像素)" }
      },
      required: ["clipId", "kind"]
    },
    side: "agent"
  }
];

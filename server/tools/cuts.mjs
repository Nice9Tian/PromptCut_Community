export const cutsTools = [
  {
    name: "list_transitions",
    description: "列出当前剪辑里的全部转场(交叉溶解 / 淡入 / 淡出)。**转场会把它引用的片段绑成一组**:那几段的相对时间关系被锁住 —— 单独改时长、换序列、split_clip 都会被拒(update_clip 只给 start 的整组平移仍然可以,同组的会跟着一起走)。要单独调先 remove_transition。返回每条的 id、kind、aId/bId、dur。",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "add_transition",
    description: "加一处转场,并把相关片段绑成一组。kind 三种:crossfade 交叉溶解——要两段**首尾相接**的片段(clipId 和 otherClipId,前后顺序写反也认),会把后一段往前拉出重叠、必要时挪到另一条序列(同一条序列内不允许重叠);fadeIn 淡入——只加在片段**开头**;fadeOut 淡出——只加在**结尾**。dur 是秒(默认交叉溶解 0.5、淡入淡出 0.6)。加完那几段的相对时间关系就锁住了,要再单独调先 remove_transition。中间空着一段、时长比片段还长、那一端已经有转场了,都会被拒并告诉你原因。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "crossfade / fadeIn / fadeOut" },
        clipId: { type: "string", description: "淡入淡出:那一段;交叉溶解:两段中的任意一段" },
        otherClipId: { type: "string", description: "只有交叉溶解要:另一段" },
        dur: { type: "number", description: "秒,0.1~10" }
      },
      required: ["kind", "clipId"]
    },
    side: "agent"
  },
  {
    name: "remove_transition",
    description: "删掉一处转场(transitionId 从 list_transitions 或 get_project 的 transitions 里拿)。淡化会被擦掉,交叉溶解还会尽量把后一段放回加转场之前的位置;删完这几段就解锁,可以单独改时间了。",
    inputSchema: {
      type: "object",
      properties: { transitionId: { type: "string" } },
      required: ["transitionId"]
    },
    side: "agent"
  },
  {
    name: "list_cuts",
    description: "列出项目里的全部剪辑(时间轴)。**用户要你改的片段在别的剪辑里时,先看这个工具的返回,不要 user_interface_switch_cut**:没激活的剪辑里的片段(id、cardId / 标签、起止、所在序列)就在返回的 `parkedCuts` 里,拿到 clipId 直接交给 update_clip 等就地改。一个项目可以有多条剪辑,新项目只有「剪辑1」,其余由用户或你新建(add_cut)。用户在时间轴上方的标签栏和素材库的「剪辑」组里切换、打开。**add_clip / 序列 / 导出 / get_layout 等工具只作用于当前激活的那条剪辑**(active:true 的;see_frames 可以传 cutId 看别的剪辑),get_project 的 tracks 也是它的内容。**但改别的剪辑里已有的片段不用 user_interface_switch_cut**:返回里的 `parkedCuts` 已列出各停放剪辑的片段(太多时有上限,会指路);要某一条的全部就传 `cutId` 给本工具,多返回那条剪辑的 timeline 一览(片段 id、起止)。拿到 clipId 后把 clipId 直接交给 update_clip / set_clip / get_clip / set_position / set_rect / align / nudge / set_emphasis / set_clip_volume / set_clip_muted,它们会就地改那条剪辑里的片段,**不切换激活的剪辑**(激活的剪辑是共享状态,切换会让所有成员的界面一起翻,所以能不切就不切)。**看它的画面也不用切**:see_frames 传 cutId。只有要在别的剪辑里新增 / 删除 / 切分 / 复制片段时才 user_interface_switch_cut(名字带 user_interface_ 的工具会动用户的界面)。一条剪辑可以作为**剪辑段**放进另一条剪辑(add_cut_segment),引用而不是复制。返回每条的 id、name、active、trackCount、clipCount、duration,以及 referencedBy(哪些剪辑的哪几段引用了它)和 references(它里面的剪辑段引用了哪些剪辑)。",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string", description: "给了就多返回这条剪辑的 timeline 一览(各序列和片段的 id、起止),不用切换过去;要改它里面已有的片段,拿到 clipId 直接交给 update_clip 等" }
      }
    },
    side: "agent"
  },
  {
    name: "user_interface_switch_cut",
    description: "**会动用户的界面**:把所有成员共享的激活剪辑切到另一条(按 cutId 或 name 二选一),所有成员的界面一起翻过去,播放头回到这条上次离开的位置,选中清空。" +
      "**只有用户明说要「切到 / 打开某某剪辑」,或你要在别的剪辑里新增 / 删除 / 切分 / 复制片段时才用。**" +
      "只是改别的剪辑里已有的片段不要用它(clipId 在 list_cuts 或 get_project 的 parkedCuts 里,直接交给 update_clip 等就地改);" +
      "只是看别的剪辑的画面也不要用它(see_frames 传 cutId)。切过去再切回来是两次多余的写入,也会打断别人正在看的时间轴。" +
      "切换后 get_project / add_clip / update_clip 等看到和改到的都是这条的内容。返回切换后的 cuts 列表和这条的 timeline 摘要。",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string" },
        name: { type: "string", description: "剪辑名,和 cutId 二选一" }
      }
    },
    side: "agent"
  },
  {
    name: "add_cut",
    description: "新建一条剪辑(默认名 剪辑N),带两条空序列、时长 30 秒。**只建不切**:激活的剪辑不变,谁的界面都不动;返回新剪辑的 id。" +
      "要往里放东西:新增片段要先 user_interface_switch_cut 切过去(会动所有成员的界面,用户明说要切或非切不可时才用);" +
      "或者把它当剪辑段放进当前剪辑(add_cut_segment)。用户说「另起一条时间轴 / 再做一版」就是它。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" }
      }
    },
    side: "agent"
  },
  {
    name: "rename_cut",
    description: "给剪辑改名。",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string" },
        name: { type: "string" }
      },
      required: ["cutId", "name"]
    },
    side: "agent"
  },
  {
    name: "remove_cut",
    description: "删除一条剪辑。最后一条不能删。里面有内容(clipCount > 0)、或正被别的剪辑引用着(list_cuts 的 referencedBy 不为空)时会被拒并告诉你被哪些剪辑的哪几段用着;确实要删就传 force:true 并在 reason 里写明理由(用户会看到),引用它的剪辑段(连同绑着它们的转场)会一起删掉,返回里 removedSegments 列出删了哪些;用户可以撤销。删的是当前激活那条时会自动切到相邻的一条,返回里 switchedTo 说明切去了哪。",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string" },
        force: { type: "boolean" },
        reason: { type: "string" }
      },
      required: ["cutId"]
    },
    side: "agent"
  },
  {
    name: "add_cut_segment",
    description: "在当前激活的剪辑里放一个**剪辑段**:引用另一条剪辑(cutId 或 name 二选一),画面是那条剪辑在对应时刻的整帧,声音是它的混音。引用不是复制 —— 被引用的剪辑改了,这里跟着变。start 是放在当前剪辑的第几秒;duration 缺省 = 被引用剪辑(从 cutOffset 起)剩下的长度,给了也不能超出它;cutOffset 是从被引用剪辑的第几秒开始(缺省 0);trackId 缺省挑一条这段时间空着的序列。**不能放进它自己,也不能形成循环引用**(A 引用 B、B 再引用 A,任意深度),会被拒并说明原因。放好以后和别的片段一样用 update_clip 改起止 / 不透明度 / 淡入淡出、set_position / set_rect 改框、set_clip_volume / set_clip_muted 调声音、split_clip 切开(后半段的 cutOffset 自动累加)、duplicate_clip 复制;get_clip 的 cutSegment 里看引用哪条、偏移和被引用剪辑的总时长。返回 segment 与 timeline。",
    inputSchema: {
      type: "object",
      properties: {
        cutId: { type: "string", description: "被引用的剪辑 id(list_cuts 里拿)" },
        name: { type: "string", description: "被引用的剪辑名,和 cutId 二选一" },
        start: { type: "number", description: "放在当前剪辑的第几秒" },
        duration: { type: "number", description: "秒;缺省 = 被引用剪辑剩下的长度,不能超出它" },
        cutOffset: { type: "number", description: "从被引用剪辑的第几秒开始,缺省 0" },
        trackId: { type: "string", description: "放到哪条序列;缺省挑这段时间空着的" }
      },
      required: ["start"]
    },
    side: "agent"
  },
  {
    name: "set_cut_segment",
    description: "改一个剪辑段从被引用剪辑的第几秒开始(cutOffset)。偏移超出被引用剪辑的总时长会被拒;改完段比被引用剪辑剩下的还长时,出点截到剩下的长度。**剪辑段引用哪条剪辑不能改**:带了 cutId / name 会被拒;要换就 remove_clip 删掉这段,用 add_cut_segment 放一段新的。起止、框、不透明度、淡入淡出、音量与静音不在这里改(见 add_cut_segment 的说明)。不是剪辑段的片段用 update_clip。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        cutOffset: { type: "number", description: "秒,不小于 0" }
      },
      required: ["clipId"]
    },
    side: "agent"
  }
];

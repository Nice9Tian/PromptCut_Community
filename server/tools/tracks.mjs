export const tracksTools = [
  {
    name: "add_track",
    description: "添加一条新的序列(序列不分种类,卡片段和素材段都能放)。不给 index 就加在最下面。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        index: { type: "integer", description: "插在第几条(从 0 起,0 = 最上面、画在最上层)" }
      }
    },
    side: "agent"
  },
  {
    name: "list_tracks",
    description: "列出当前剪辑的全部序列(轨道),很轻:每条给 trackId、index(0 = 最上面、画在最上层)、name、clipCount、卡片 / 素材各几段、占用的时间范围,空序列标 empty:true,隐藏 / 静音 / 锁定的标出来。整理序列、找空序列、决定放哪一层时用它,不要为此去拉整个 get_project。",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "remove_track",
    description: "删除序列,一次可删几条(trackIds),一步撤销。空序列直接删;上面还有片段的会被拒 —— 删序列会连片段一起删,确实要删就传 force:true 并在 reason 里写明理由(用户会看到)。锁定的序列不删;至少要留一条。被删片段上挂着的转场会一并撤掉。用户说「删掉空轨道 / 清理没用的序列」就是它:先 list_tracks 找出 empty:true 的,一次传进来。",
    inputSchema: {
      type: "object",
      properties: {
        trackId: { type: "string", description: "删一条" },
        trackIds: { type: "array", items: { type: "string" }, description: "删几条,和 trackId 二选一" },
        force: { type: "boolean", description: "序列上有片段时才需要" },
        reason: { type: "string", description: "force 时必填" }
      }
    },
    side: "agent"
  },
  {
    name: "update_track",
    description: "改一条序列的名字、隐藏、静音、锁定,给哪个改哪个。hidden:true 预览和导出里都看不见(不是删除);muted:true 只关声音;locked:true 之后上面的片段改不了、序列也删不了。用户说「把这条改名叫配乐」「先把字幕轨藏起来」「这条静音」就是它。锁定是用户用来保护内容的,没被要求就别去解锁。",
    inputSchema: {
      type: "object",
      properties: {
        trackId: { type: "string" },
        name: { type: "string" },
        hidden: { type: "boolean" },
        muted: { type: "boolean" },
        locked: { type: "boolean" }
      },
      required: ["trackId"]
    },
    side: "agent"
  },
  {
    name: "move_track",
    description: "调整序列的上下顺序,把它挪到第 index 条(从 0 起)。时间轴上靠上的序列画在上层:字幕、卡片要压在画面之上就挪到上面。只改画面遮挡关系,不动任何片段的时间,声音不受影响。",
    inputSchema: {
      type: "object",
      properties: {
        trackId: { type: "string" },
        index: { type: "integer", description: "0 = 最上面" }
      },
      required: ["trackId", "index"]
    },
    side: "agent"
  }
];

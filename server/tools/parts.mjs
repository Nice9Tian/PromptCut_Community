export const partsTools = [
  {
    name: "list_parts",
    description: "列出**部件库**里可用的部件(组合卡的零件:标题、要点列表、环形指标、排行条、Lottie……)。不带参数返回摘要(id、name、description、useWhen 什么时候用、role、tags、参数名列表),带 partId 再调一次拿完整 controls / defaults / defaultFrame。部件只能放进组合卡(cardId \"composite\"):add_composite 建卡时一次给 parts,或建完用 add_part 逐个加。",
    inputSchema: {
      type: "object",
      properties: {
        partId: { type: "string", description: "只要这一个部件的完整 schema" },
        detail: { type: "string", enum: ["summary", "full"] }
      }
    },
    side: "agent"
  },
  {
    name: "add_composite",
    description: "在时间轴上加一张**组合卡**:由部件库里的部件自由搭出来的卡,每个部件有自己的框(相对卡的画布,默认 1920×1080)、参数和进场时机 enterMs。parts 可以一次给全(每项 { partId, params?, frame?, enterMs?, label?, children? }),也可以先建空的再 add_part。返回新建 clip 的封装(get_clip 的格式,parts 里每个实例带 id、画面位置 world 和落定时刻)、look 和 timeline。之后改它用 add_part / set_part / remove_part / move_part,或 set_clip 整棵写回。",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "number" },
        duration: { type: "number", description: "秒,默认 3" },
        trackId: { type: "string" },
        parts: { type: "array", items: { type: "object" }, description: "部件实例列表;partId 必填,其余可省(frame 省略用部件的 defaultFrame)" }
      },
      required: ["start"]
    },
    side: "agent"
  },
  {
    name: "add_part",
    description: "往组合卡里加一个部件实例。partId 来自 list_parts;params 只写要改的,其余用部件默认值;frame 省略用部件的 defaultFrame(相对父框的框:x / y 是锚点位置(像素),w / h 尺寸,anchor [ax, ay] 默认 [0,0],scale、rotate 可选;null 铺满父框);enterMs 相对父级进场的毫秒;parentId 省略 = 放在根,给了就成为那个实例的子部件(子部件的框相对父部件的框);index 省略 = 追加。返回新实例 id 和整张卡的封装。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        partId: { type: "string" },
        params: { type: "object" },
        frame: { type: "object", description: "相对父框的框:x / y 是锚点位置(像素),w / h 尺寸,anchor [ax, ay] 默认 [0,0],scale、rotate 可选;null 铺满父框" },
        enterMs: { type: "number" },
        label: { type: "string" },
        parentId: { type: "string" },
        index: { type: "number" }
      },
      required: ["clipId", "partId"]
    },
    side: "agent"
  },
  {
    name: "set_part",
    description: "改组合卡里一个部件实例:params(稀疏合并)、frame(整个替换,null 铺满父框)、enterMs、label。partInstanceId 是 get_clip 里 parts[].id。返回整张卡的封装。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        partInstanceId: { type: "string" },
        params: { type: "object" },
        frame: { type: "object", description: "相对父框的框:x / y 是锚点位置(像素),w / h 尺寸,anchor [ax, ay] 默认 [0,0],scale、rotate 可选;要铺满父框传 { clear: true }" },
        enterMs: { type: "number" },
        label: { type: "string" }
      },
      required: ["clipId", "partInstanceId"]
    },
    side: "agent"
  },
  {
    name: "remove_part",
    description: "从组合卡里删掉一个部件实例(连同它的子部件)。返回整张卡的封装。",
    inputSchema: {
      type: "object",
      properties: { clipId: { type: "string" }, partInstanceId: { type: "string" } },
      required: ["clipId", "partInstanceId"]
    },
    side: "agent"
  },
  {
    name: "move_part",
    description: "把组合卡里的部件实例挪到别的父级 / 别的次序:parentId 为 null 或省略 = 根;index 省略 = 末尾。次序靠后的画在上面。不能挪进自己的子树。",
    inputSchema: {
      type: "object",
      properties: { clipId: { type: "string" }, partInstanceId: { type: "string" }, parentId: { type: "string", description: "目标父实例 id;省略或传空串 = 根" }, index: { type: "number" } },
      required: ["clipId", "partInstanceId"]
    },
    side: "agent"
  }
];

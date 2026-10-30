export const cardsTools = [
  {
    name: "list_cards",
    description: "列出可用卡片。不带参数返回摘要（id、name、description、useWhen 什么时候用这张卡、tags、参数名列表，带 * 的是必填），一次就能扫完所有卡并选定用哪张。选定之后带 cardId 再调一次拿这张卡的完整 controls 和 defaults，然后才 add_clip。",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "只要这一张卡的完整 schema" },
        detail: { type: "string", enum: ["summary", "full"], description: "full 表示所有卡都要完整 schema，通常不需要" }
      }
    },
    side: "page"
  },
  {
    name: "card_authoring_guide",
    description: "取建卡规则全文（两种写法 remotion 式 / motion 式及各自的规矩、CardDef 契约、控件类型、硬性约束、可用依赖、完整示例）。新卡只按这两种写法写，用必填的 frameMode 声明：\"direct\" 是 remotion 式，\"stateful\" 是 motion 式，不规定优先用哪一种。要用 create_card 新建卡片前**必须先调它**，不要凭印象写。",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "get_card_source",
    description: "读回一张卡片的原始源码。用户卡和内置卡都能读。返回定义文件的源码，外加 files：这张卡一路用到的卡片 / 部件文件，每个带 sharedBy（被几张卡共用）。传 file 读其中某一个——inspect_card_dom 标出的源码位置常常落在共用部件或 vendor 文件里。**要改已有的卡之前必须先调它**：不读回来就改，等于凭记忆重写整张卡，没提到的地方每改一轮就会漂一点。",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "卡片 id" },
        file: { type: "string", description: "要读的文件相对路径，必须在这张卡的 files 列表里；不传就是卡片定义文件" }
      },
      required: ["cardId"]
    },
    side: "agent"
  },
  {
    name: "edit_card",
    description: "改一张卡的源码（用户卡和内置卡都行）：把源码里的 find 这一段替换成 replace，只动这一处，别的地方原样不变。**这是修改已有卡片的唯一正确方式**，不要用 create_card + overwrite 整篇重写。用法：先 get_card_source 读回源码，照着它原样复制要改的那几行当 find（缩进空格都要一致），写上改完的样子当 replace。find 必须在源码里唯一命中：命中 0 次说明你手上的版本旧了，命中多次就把 find 写长一点带上周围几行。带 file 可以改这张卡用到的部件 / vendor 文件（必须在 get_card_source 返回的 files 里）；sharedBy > 1 的文件被多张卡共用，改了它们都会跟着变。**只能改源码，不能改 HTML**：舞台上的 DOM 是源码渲染出来的，直接改 DOM 下一帧就被盖掉。内置文件改之前会自动备份到 out/card-edits/。落盘前会做语法检查，并拒绝新引入 Date.now / setTimeout / setAnimationLoop 这类不跟帧走的写法；声明成 remotion 式（frameMode: \"direct\"）的卡还会按 remotion 式的规矩逐条检查，违规的指出行号。",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string" },
        file: { type: "string", description: "要改的文件相对路径，必须在 get_card_source 返回的 files 里；不传就改卡片定义文件" },
        find: { type: "string", description: "要被替换掉的原文，逐字照抄源码" },
        replace: { type: "string", description: "替换成的新内容" },
        replaceAll: { type: "boolean", description: "find 有意匹配多处且都要改时传 true" }
      },
      required: ["cardId", "find", "replace"]
    },
    side: "agent"
  },
  {
    name: "inspect_card_dom",
    description: "只读地看一张卡某一刻渲染出来的 HTML（DOM 树），每个节点标出是哪个组件、源码哪一行渲染的。用来在「画面上这一块」和「源码里那一行」之间对上号，再用 get_card_source + edit_card 去改那一行。**只能看，不能改**：HTML 是源码渲染出来的，要改就改源码。只有一个子节点、自己又没字的包装层会被折叠掉；默认往下 3 层，超出的节点标「…还有 N 个后代，传 ref:N 往下看」，把那个数字传给 ref 就从那个节点继续展开（同一时刻的树有缓存，往下看不用重新渲染）。同一行源码生成多个兄弟节点（列表）时会标出来——改那一行它们一起变。用的是导出同一条渲染管线，看到的就是成片那一帧的结构；第一次调要起一个渲染进程，几秒。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "要看的片段 id" },
        t: { type: "number", description: "时间轴第几秒；不传取这个片段的中点" },
        ref: { type: "number", description: "从这个节点往下展开（上一次返回里的 ref 数字）；不传从最外层开始" },
        depth: { type: "number", description: "往下展开几层，默认 3，最多 8" }
      },
      required: ["clipId"]
    },
    // 不放宽超时:片段会被挪到 0.5 秒的起跑线上再渲(见 vite-plugin-cards 的 /api/cards/dom),
    // 不管它排在时间轴哪里都只推几十帧,远在桥的默认 60 秒以内
    side: "agent"
  },
  {
    name: "create_card",
    description: "创建可复用卡片定义：TSX `CardDef`；要多输入或 GPU 滤镜、转场、音频时写 `kind` / `inputs` / `card` / `audio`，先读 `card_authoring_guide`。必须写 `frameMode`：\"direct\"（remotion 式，画面只由 t、参数、输入素材决定，只许用框架 remotionStyle 和 react 写，违规的逐条带行号被拒）或 \"stateful\"（motion 式，可用 Motion、CSS 动画等）。建完用 apply_card 把它应用到片段。改现有源码用 get_card_source 和 edit_card，不要用 create_card + overwrite 整篇重写。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "小写 kebab-case，全局唯一，例如 price-tag" },
        source: { type: "string", description: "完整 TSX CardDef 源码" },
        overwrite: { type: "boolean", description: "只在确实要把同名卡整篇换掉时传 true；改细节请用 edit_card" }
      },
      required: ["id", "source"]
    },
    side: "agent"
  },
  {
    name: "apply_card",
    description: "把一张素材效果卡定义应用为实例。同一定义可用于多段素材。clipId为已有片段；或trackId/start/end创建新动画或音频片段。inputs以名称映射到{clipId}（指素材段 = 该素材，指素材效果卡片段 = 那张素材效果卡的输出）或{nodeId}另一卡输出，可加offset秒和rate倍率；不传inputs时：片段上已有素材效果卡就接它的输出，否则接目标clip的原始素材。多输入转场常用A/B。params作为实例参数传入。nodeId不传自动生成，传当前clip.nodeId可编辑该实例参数和输入。",
    inputSchema: { type: "object", properties: {
      cardId: { type: "string" }, clipId: { type: "string" }, trackId: { type: "string" }, start: { type: "number" }, end: { type: "number" },
      nodeId: { type: "string" }, params: { type: "object" }, frame: { type: "object" },
      inputs: { type: "object", additionalProperties: { type: "object", properties: {
        clipId: { type: "string" }, nodeId: { type: "string" }, offset: { type: "number" }, rate: { type: "number" }
      } } }
    }, required: ["cardId"] }, side: "agent"
  },
  {
    name: "bake_card",
    description:
      "把一张卡**渲染成一张图片**存进素材库,返回它的 URL。目前唯一的用处是给 `scene-3d` 当贴图 —— " +
      "把 URL 填进那张卡的 `texture` 参数,就得到「立体物件表面印着这张卡」。" +
      "\n\n" +
      "画这张图的是**导出成片的那个渲染器**(和 see_frames 同一条管线),所以贴上去之后预览和成片长得一样。" +
      "\n\n" +
      "**它是一张 PNG 快照,不是活的**:卡片的动画会定格在 `t` 那一帧;之后你改了这张卡的参数,贴图**不会**跟着变," +
      "要重新渲染一次再把新 URL 填回去。所以顺序是「先把卡调好,再渲染」" +
      "(在 3D 视图与导出中贴图会跟着播放动,不再定格在 `t`;bake_card 产出的是指定时刻 `t` 的 PNG 快照)。" +
      "\n\n" +
      "两种观感,由 `bg` 决定,**渲染的时候就定死**:" +
      "不传 bg = 透明底,物体在卡片没画的地方也透空,内容像浮在空间里(适合标志、招牌);" +
      "传了 bg = 压平成不透明,得到实心物体表面印着这张卡 —— 大多数时候说「把卡贴到立方体上」要的是这个。" +
      "\n\n" +
      "画幅会被改成正方形再渲(贴到立体表面上,16:9 会被拉变形);卡片本来就是响应式的,所以这是重排不是裁切。" +
      "素材段(视频 / 图片)不用渲染,它本来就是位图,直接拿它的 URL 当贴图即可。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "要渲染哪一张卡(时间轴上的片段 id)" },
        t: { type: "number", description: "渲染哪一刻的样子(秒,时间轴绝对时间)。不传取这一段的中点 —— 起止两端常卡在进出场动画上,渲染出来是个半透明的中间态" },
        size: { type: "number", description: "贴图边长(像素,正方形),256~2048,默认 1024。要贴的物件在画面里很小就调小,省内存" },
        bg: { type: "string", description: "底色,六位十六进制如 \"#0b0f17\"。不传 = 透明底(挖空观感);传了 = 实心观感" },
      },
      required: ["clipId"],
    },
    side: "agent",
    // 和 see_frames 一样要当场起一个 Chrome 渲一帧
    timeoutMs: 150000
  }
];

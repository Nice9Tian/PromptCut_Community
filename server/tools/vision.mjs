export const visionTools = [
  {
    name: "see_frames",
    /*
     * 原来是 see_preview(成片)和 see_sequences(素材)两个工具。合成一个、名字里不再有 preview:
     * 「预览」这个词暗示「粗看一眼、草稿」,模型会跟着放低标准。现在统一叫「画面帧」。
     */
    description:
      "看画面帧。两种来源,用 source 分开:\n\n" +
      "**source: \"timeline\" —— 成片画面。** 把时间轴某一刻渲染成图片交回来,用的就是导出那条渲染管线,看到的即导出所得。" +
      "不传 t 取当前播放头所在时刻;传 clipId 只渲那一张卡、其余轨道全部不画,用来分辨「这张卡自己不对」还是「被上面别的卡盖住了」" +
      "(不同时传 t 的话取该片段的中点,避开进出场动画的中间态)。要对比几个时刻就传 times 数组,一次最多 10 个。" +
      "**要看别的剪辑(没激活的那条)的画面就传 cutId**(list_cuts 里的剪辑 id),不传就是当前激活的剪辑:不切换激活剪辑、不改项目、不动任何人的界面," +
      "不要为了看画面去 user_interface_switch_cut。传了 cutId 时 t / times 是那条剪辑自己的秒数,不给 t 取那条剪辑上次停下的位置;clipId 也要是那条剪辑里的片段。回包的 cut 写着看的是哪条剪辑(id 和名字)。**改完卡片的样式后应当看一眼再下结论**,不要凭源码想象效果。" +
      "每次要起一个渲染进程,大约几秒到十几秒,别连着刷。**画面里的灰色棋盘格是「透明」,不是内容** —— 那里什么都没画;" +
      "卡片盖住的地方看不到格子。所以「一片棋盘格」= 这一刻真的什么都没有,不要再反复换 t 去试。\n\n" +
      "**source: \"media\" —— 素材本身。** 按镜头(list_shots 的划分)把视频拼成缩略图,每个镜头一张 4 格或 9 格拼图" +
      "(等间隔抽帧,格子按行从左到右对应返回里的 frames 秒数),一次交回一页最多 N 张,翻页看后面的镜头。" +
      "**判断一段素材里到底有什么、人物在哪一侧、画面是什么调性、哪几段能用,不要只靠字幕猜 —— 字幕说的是「说了什么」,这里看的是「画面是什么」。** " +
      "用法:1) 直接调 see_frames({ source: \"media\", mediaId }),没跑过镜头识别会自动跑并等它(5 分钟素材约 36 秒;识别不了就按 10 秒一段切,返回里标 fallback);" +
      "2) 返回里 pages 是总页数、nextPage 是下一页,翻到 nextPage 为 null 为止;" +
      "3) 某个镜头看不清就 see_frames({ source: \"media\", mediaId, scene: 镜头序号, grid: 9 }) 单独放大看;" +
      "4) 只关心某段时间用 from / to 秒数缩小范围。每张拼图都附这个镜头的起止秒数、进出转场、这段时间的字幕文本(有转写的话)和主体侧别(有检测的话),看图时把它们对上。" +
      "一页别要太多:默认 6 张,上限 12 张,能说清就停,不要为了「看完」把所有页都翻一遍。",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["timeline", "media"], description: "timeline = 时间轴上的成片画面;media = 素材本身按镜头拼的缩略图" },
        t: { type: "number", description: "[timeline] 时间轴第几秒;不传就用当前播放头" },
        clipId: { type: "string", description: "[timeline] 只看这一个片段的画面" },
        cutId: { type: "string", description: "[timeline] 看哪条剪辑的画面(list_cuts 里的剪辑 id);不传就是当前激活的剪辑。不切换激活剪辑,谁的界面都不动;id 不存在会报错" },
        times: { type: "array", items: { type: "number" }, description: "[timeline] 一次看多个时刻(秒),最多 10 个,按顺序各返回一张;给了 times 就忽略 t。对比镜头节奏、看同一张卡进场中途和落定之后用它" },
        mediaId: { type: "string", description: "[media,必填] list_media 里的素材 id。视频按镜头拼图;图片直接返回这张图本身(分页、grid、scene 对图片无意义);音频没有画面会被拒" },
        page: { type: "number", description: "[media] 第几页,从 1 起;默认 1" },
        perPage: { type: "number", description: "[media] 每页几个镜头,默认 6,最多 12。一个镜头一张拼图" },
        grid: { type: "number", description: "[media] 每张拼图几格:4(2×2)或 9(3×3),默认 4。镜头长、变化多、或要看细节时用 9" },
        scene: { type: "number", description: "[media] 只看这一个镜头(list_shots 里的序号,从 1 起),忽略分页;默认配 9 格" },
        from: { type: "number", description: "[media] 只看从这一秒起的镜头(素材内秒数)" },
        to: { type: "number", description: "[media] 只看到这一秒为止的镜头(素材内秒数)" }
      },
      required: ["source"]
    },
    side: "agent",
    // 当场起一个 Chrome 渲一帧(timeline),或先跑一遍镜头识别再拼十几张图(media),60 秒的默认上限不够
    timeoutMs: 180000
  },
  {
    name: "get_gif",
    description:
      "把一张卡从头到尾均匀抽 8 帧,做成一张动图(GIF)给用户看,同时把这 8 帧拼成一张 4×2 的图交给你。" +
      "第 k 格对应返回里 times 的第 k 个时刻(按行从左到右)。用来一眼看清这张卡整段的动效:进场怎么来、落定长什么样、有没有退场。" +
      "只渲那一张卡,其余轨道不画(和 see_frames 传 clipId 一样)。一次要渲 8 帧,比看一张画面慢,别连着刷。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "要看的卡(时间轴上的片段 id)" },
      },
      required: ["clipId"],
    },
    side: "agent",
    // 8 帧一趟渲完(renderFrames 顺推一遍沿途截),再用 ffmpeg 编 GIF;冷启动 Chrome 可能过分钟
    timeoutMs: 180000
  }
];

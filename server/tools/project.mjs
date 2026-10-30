export const projectTools = [
  {
    name: "get_project",
    description: "获取整个多轨 Project 对象,了解项目配置、素材和时间轴上的所有轨道与 clip。返回里 media 的 transcript 只是段数摘要，完整文字稿请用 get_transcript。**多条剪辑时注意**:`tracks` 只是当前激活那条剪辑的内容;别的(没激活的)剪辑里的片段在最前面的 `parkedCuts` 里列好了(每条剪辑的 cutId、片段 id、cardId / 标签、起止、所在 trackId,太多时有上限并指路 list_cuts 的 cutId)。**要改那些片段不用 user_interface_switch_cut**:把 clipId 直接交给 update_clip / set_clip / get_clip / set_position / set_rect / align / nudge / set_emphasis / set_clip_volume / set_clip_muted 就地改(切换会让所有成员的界面一起翻)。",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "list_media",
    description: "列出素材库里所有素材，返回每条素材的 id、name、kind（video / image / audio）、duration、width、height、cardUrl、path、hasTranscript、transcriptSegments（文字稿段数）；想拿完整文字稿要用 get_transcript。需要素材的 mediaId 时优先用本工具，不要为了找 mediaId 去调 get_project。**卡片参数里要引用某张素材图片 / 视频，填它的 cardUrl**（形如 /@media/<文件名>，预览、渲染、导出都取得到）；path 是服务端磁盘路径，只给服务端内部用，你没有能读它的工具——想看素材长什么样用 see_frames({ source: \"media\", mediaId })。",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "get_selection",
    description: "获取选区中的全部 clip 及其当前项目详情。账号云端模式返回项目内所有在线有效成员的每个页面选区，标明用户名和发起人；发起人离线时仅显示发消息时的非实时快照。本机/LAN 模式返回本页面的全部选区。",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  },
  {
    name: "set_project_meta",
    description: "设置项目元数据:名称、画布宽高、帧率、主题,以及截断整条片子。总时长默认跟着内容走,只有要截断时才传 `duration`。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "项目名" },
        width: { type: "number", description: "画布宽(像素)" },
        height: { type: "number", description: "画布高(像素)" },
        fps: { type: "number", description: "帧率" },
        duration: {
          type: "number",
          description:
            "把片子截断到这一秒,单位秒。时长缺省等于内容末尾(工具返回的 timeline 里的 contentEnd)," +
            "加内容会撑长、删内容会缩短,不用你维护。给一个比 contentEnd 小的数就是截断:预览和导出都在这一刻切断," +
            "之后再加的内容也被切掉,直到取消。给等于或大于 contentEnd 的数就是取消截断、回到跟着内容走 —— 拉不长。"
        },
        themeId: { type: "string", description: "全局主题 id" }
      }
    },
    side: "agent"
  },
  {
    name: "set_theme",
    description: "设置项目的全局主题(如 'midnight' 等)。",
    inputSchema: {
      type: "object",
      properties: { themeId: { type: "string" } },
      required: ["themeId"]
    },
    side: "agent"
  },
  {
    name: "import_media",
    description: "把一个文件装进项目素材库。两种来源:(1) 用户用「+」发来的附件——附件放在对话的工作目录里，和素材库是两回事，`list_media` 看不到它，必须先用本工具导入才能转写、配字幕、配动效；url 就是用户消息末尾附件清单里的「站内地址」（形如 /@pcwork/<会话id>/<文件名>）。用户发了视频还让你处理它时，第一步就调它，不要回一句「请先手动导入」。(2) 网上的图片直链（https://…），素材库里缺配图时自己找来用；这时顺手传 name（带扩展名，如 asakusa.jpg）。按文件内容分类登记：视频放到视频轨上；图片、音频只进素材库、不上时间轴。返回 mediaId、kind 和 cardUrl——卡片参数里要引用这张图 / 这段视频就填 cardUrl。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "附件的站内地址，取自用户消息末尾的附件清单" },
        name: { type: "string", description: "文件名，不传就从地址里取" }
      },
      required: ["url"]
    },
    side: "page"
  },
  {
    name: "list_media_effects",
    description: "查看某个媒体连接在当前时间轴上的全部效果和顺序：普通滤镜、像素映射、音频效果，以及项目效果库定义。mediaId 可省略以列出全部片段。创建映射前先调用它，确认 source/to 的 stage 是 origin 还是 after_filters。",
    inputSchema: { type: "object", properties: { mediaId: { type: "string" } } },
    side: "agent"
  }
];

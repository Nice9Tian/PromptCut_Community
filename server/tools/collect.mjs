export const collectTools = [
  {
    name: "collect_status",
    description: "查素材收集拓展的状态:yt-dlp 装没装(及版本)、ffmpeg 在不在、有哪些站点预设(bilibili / generic),以及各站登录态 cookies(键是站点 id,值有 loggedIn / expired / userId / expiresAt)。ready 为 true 才能 collect_probe / collect_download;为 false 时看 ytdlp.installed —— 没装就 collect_install,其余原因(没有 ffmpeg、没有内置 Python)不是工具能修的,如实告诉用户。抓链接之前先调它。",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  },
  {
    name: "collect_install",
    description: "安装素材收集拓展(pip 装 yt-dlp,纯 Python 轮子约 3 MB,几十秒)。立刻返回 jobId;用 background_job_status 查这个 jobId,或再调 collect_status 看 ready 有没有变 true。不要重复启动。",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  },
  {
    name: "collect_search",
    description: "站内搜索视频,给「从 B 站找素材」这类需求用:返回候选列表,每条带 url、title、duration(秒)、uploader、view_count、max_height。**找素材走这条,不要用 web_open 去翻搜索页**——搜索页上的结果点了会开新标签,web_click 点不动,也拿不到 BV 号。拿到候选后按标题、时长、播放量挑,再 collect_probe / collect_download 那条 url。参数 query 必填;site 可选(bilibili 默认,generic 搜 YouTube);limit 可选(默认 5,最多 10,每条要单独探测,多了慢)。单条 error 表示那条探测失败,跳过即可。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词,中文即可" },
        site: { type: "string", enum: ["bilibili", "generic"], description: "默认 bilibili" },
        limit: { type: "number", description: "最多几条,1~10,默认 5" }
      },
      required: ["query"]
    },
    side: "page"
  },
  {
    name: "collect_probe",
    description: "只探测不下载:给一条网页链接(B 站 BV 号 / av 号 / b23.tv 短链 / 完整链接,或 yt-dlp 支持的其他站点),返回标题、时长、上传者、可选清晰度(heights,像素高度从高到低)、是不是多 P 稿件(parts 列表)、有没有站方字幕(subtitles)。**下载前先探一眼**:合集、要登录才有的清晰度、根本不是视频页,这些都能提前说清。哔哩哔哩偶发 412 会自动重试,notes 里能看到。参数 url 必填;site 可选(auto / bilibili / generic,默认按链接判断);quality 可选(只影响返回的 selected_format 说明)。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "视频页链接、BV 号或短链" },
        site: { type: "string", enum: ["auto", "bilibili", "generic"], description: "站点预设,默认 auto 按链接判断" },
        quality: { type: "number", description: "清晰度上限(像素高度),只认 2160 / 1440 / 1080 / 720 / 480 / 360,别的值按 1080 处理" }
      },
      required: ["url"]
    },
    side: "page"
  },
  {
    name: "collect_download",
    description: "从网页链接把视频抓下来并装进素材库。下载在服务端后台跑(视频流 + 音频流分开下再用 ffmpeg 合并,非 H.264 的自动转码),**立刻返回 jobId**,用 collect_job 轮询,两次之间用 wait 工具等 3 秒(**不要用 shell 命令自己睡**,无人值守模式下会被拒绝并中断整轮),done 且带 mediaId 才算收进素材库。参数:url 必填;quality 可选(默认 1080;未登录的 B 站最高就是 1080,更高要 cookies);site 可选(auto / bilibili / generic);audioOnly 只要音频;allParts 多 P 稿件全部下载(默认只取链接指定的那一 P);cookies 是 Netscape 格式 cookies.txt 的磁盘路径,登录才有的清晰度要它。同一条链接正在下时再调会直接回已有的 jobId(reused: true)。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "视频页链接、BV 号或短链" },
        // 不写 enum:Gemini 的 OpenAI 兼容接口要求枚举值必须是字符串,数字枚举整个请求 400,
        // agent 一个工具都调不了(诊断报告里抓到的)。取值范围写进说明,服务端照样有白名单兜底。
        quality: { type: "number", description: "清晰度上限(像素高度),默认 1080;只认 2160 / 1440 / 1080 / 720 / 480 / 360,别的值按 1080 处理" },
        site: { type: "string", enum: ["auto", "bilibili", "generic"] },
        audioOnly: { type: "boolean", description: "只要音频(m4a)" },
        allParts: { type: "boolean", description: "多 P 稿件全部下载" },
        keepCodec: { type: "boolean", description: "true 表示不把 HEVC / AV1 转成 H.264(默认会转,浏览器预览才稳)" },
        cookies: { type: "string", description: "一般不用传:user_interface_collect_login 存下的登录态会自动带上。要传只认应用数据目录 cookies/ 下的文件,别处的路径会被忽略" }
      },
      required: ["url"]
    },
    side: "page"
  },
  {
    name: "collect_job",
    description: "查 collect_download 的进度和结果。返回 status(running / done / error)、stage(video 视频流 / audio 音频流 / merge 合并 / transcode 转码)、percent 整体进度、speed(字节/秒)、eta(秒)、info(探到的标题时长)、notes(412 重试之类的记录)。done 时带 items(每个文件的 path / 标题 / 时长 / 分辨率 / 编码)和 mediaIds —— 文件已经登记进素材库并放到视频轨上,list_media 看得到,可以直接 transcribe_media / detect_shots。error 时看 message。作业只在内存里,服务重启就查不到。",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"]
    },
    side: "page"
  },
  {
    name: "user_interface_collect_login",
    description: "**会动用户的界面**(在编辑台里弹出登录框):登录视频站点(目前只有 bilibili),拿到登录才有的清晰度(B 站 1080p60 / 4K 要大会员登录)。它在编辑台里弹出登录框:默认 method 为 qr,二维码直接显示在编辑台里,用户用手机扫;method 为 browser 则打开站点自己的登录页(账号密码 / 短信 / 验证码都在那里),用户自己输。**调完就停下来**:用中文告诉用户「登录框已经弹出来了,扫码或切到账号密码登录,登录完回我一句」,**不要继续调工具**;用户回话之后再调 collect_login_check。已经登录且没过期时不弹框,直接返回 alreadyLoggedIn: true。登录态存成 cookies.txt,之后 collect_probe / collect_download 自动带上,不用再传 cookies 参数。**不要替用户输账号密码或验证码**。",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", enum: ["bilibili"], description: "默认 bilibili" },
        method: { type: "string", enum: ["qr", "browser"], description: "qr 扫码(默认);browser 打开站点登录页,账号密码 / 短信也行" },
        force: { type: "boolean", description: "已登录也强制重新登录(换账号时用)" }
      }
    },
    side: "page"
  },
  {
    name: "collect_login_check",
    description: "用户说扫完码之后调:从浏览器取出登录态,登录了就存盘、把窗口藏回去,返回 loggedIn: true、userId、expiresAt(过期后要重新 user_interface_collect_login)。loggedIn: false 时看 missing / hint,让用户在窗口里完成登录后再查一次;不要连着轮询,等用户回话。",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", enum: ["bilibili"], description: "默认 bilibili" },
        hide: { type: "boolean", description: "登录成功后是否把窗口藏回屏幕外,默认 true" }
      }
    },
    side: "page"
  },
  {
    name: "collect_logout",
    description: "退出站点登录:删掉存盘的 cookies.txt,之后下载按未登录画质。用户说「退出登录」「换个账号」「别用我的账号下」时用。",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string", enum: ["bilibili"], description: "默认 bilibili" } }
    },
    side: "page"
  }
];

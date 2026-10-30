export const audioTools = [
  {
    name: "render_card_audio",
    description: "生成动效卡片自身 audio() 的持久 WAV，声音仍属于同一个视觉片段，不新建独立音频片段。先通过 create_card/edit_card 提供视觉 Component/card 与确定性的 audio；本工具等待实际入库完成，返回 mediaId。改参数/源码后重新调用。缺失/失败不静默导出缺声，取消或迟到结果不覆盖旧引用。在线页面只能读取已同步的 WAV，不能运行用户声音代码。",
    inputSchema: { type: "object", properties: { clipId: { type: "string" }, force: { type: "boolean", description: "忽略可复用结果，重新计算" } }, required: ["clipId"] },
    side: "page", timeoutMs: 120000,
  },
  {
    name: "cancel_card_audio", description: "取消指定动效片段正在进行的声音生成或上传，保留原有可用音频引用。",
    inputSchema: { type: "object", properties: { clipId: { type: "string" } }, required: ["clipId"] }, side: "page",
  },
  {
    name: "sound_presets",
    description: "查可复用的原生合成音效(短提示音、键盘声)、来源、完整默认参数和资源限制。先选现成预设再 sound_generate,不用新建音频卡或外部服务。",
    inputSchema: { type: "object", properties: {} }, side: "page",
  },
  {
    name: "sound_generate",
    description: "生成可编辑的 WAV 音效并经素材服务入库。preset:notification 为提示音,keyboard 为键盘声。给 sourceClipId(mu-typing)自动复用其文字、每字毫秒、延迟、停顿、种子,放到相同时间轴锚点的独立音频段;不能再给该段挂音频素材效果卡。普通提示音用 start 放置,不传只进素材库。给 clipId 重生成原音效段,成功上传才替换,取消/失败保持旧声音。recipe 可传之前完整配方;params 只改声音参数;refreshSource:true 从当前打字卡重建事件(改文字/速度后用)。工具等待合成和入库完成后返回结果,页面显示进度并可取消;其它会话可用 sound_status 查询、sound_cancel 取消。requestId 是幂等请求键,重试必须复用,不同音效必须换键。音效不会隐式延长项目出点,指定序列重叠会报错。",
    inputSchema: { type: "object", properties: {
      preset: { type: "string", enum: ["notification", "keyboard"] },
      sourceClipId: { type: "string" }, clipId: { type: "string" },
      start: { type: "number", minimum: 0 }, trackId: { type: "string" },
      params: { type: "object", description: "sound_presets 给出的可调完整参数的部分覆盖" },
      typing: { type: "object", description: "无 sourceClipId 时的文字节奏:{text,duration(每字ms),delayMs,punctuationPauseMs,newlinePauseMs,jitterMs,seed,pauses}" },
      recipe: { type: "object", description: "已持久化的完整音效配方" },
      seed: { type: "integer", minimum: 0, maximum: 4294967295 },
      requestId: { type: "string", maxLength: 200 }, name: { type: "string" },
      refreshSource: { type: "boolean" },
    }, required: ["requestId"] }, side: "page", timeoutMs: 120000,
  },
  {
    name: "sound_status", description: "查询音效生成任务进度及结果。不传 jobId 列出当前项目任务(可供另一个会话查询或取消正在生成的任务)。succeeded 才表示已入库并切换片段;failed/cancelled/stale 不会覆盖旧声音。",
    inputSchema: { type: "object", properties: { jobId: { type: "string" } } }, side: "page",
  },
  {
    name: "sound_cancel", description: "取消音效生成或上传。已经可用的旧音效保持不变,迟到结果不会覆盖。",
    inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] }, side: "page",
  },
  {
    name: "set_clip_volume",
    description: "设置音频或视频卡片的独立声音音量。volume 范围 0~1，0=无声，0.5=50%，1=原声（默认）。不改变画面不透明度，保留淡入淡出；不会解除序列静音、隐藏或音画分离后的原视频静音。支持撤销，锁定序列须先解锁。",
    inputSchema: { type: "object", properties: { clipId: { type: "string" }, volume: { type: "number", minimum: 0, maximum: 1 } }, required: ["clipId", "volume"] },
    side: "agent",
  },
  {
    name: "set_clip_muted",
    description: "单独静音或恢复一个带声音的素材/动效卡片。只改声音，不改画面；时间轴醒目标注已静音，支持撤销与保存。不能绕过序列静音或锁定。",
    inputSchema: { type: "object", properties: { clipId: { type: "string" }, muted: { type: "boolean" } }, required: ["clipId", "muted"] },
    side: "agent",
  },
  {
    name: "separate_audio",
    description: "分离普通视频素材的音轨：原视频静音，声音放在下方新序列，保留位置、偏移、音量和淡入淡出。clipId 单选或 clipIds 多选，只给一个。动效卡片代码内嵌的声音不能分离，明确返回 ok:false/code:EMBEDDED_CARD_AUDIO_UNSEPARABLE；不自动生成替代素材、不创建空轨。多选任一失败则整批不修改。",
    inputSchema: { type: "object", properties: { clipId: { type: "string" }, clipIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } } }, oneOf: [{ required: ["clipId"] }, { required: ["clipIds"] }] },
    side: "agent",
  },
  {
    name: "measure_audio",
    description: "测响度(EBU R128,和导出用的同一个 ffmpeg)。你听不见声音,调音量前先用它看数:给 clipId 测时间轴上那一段(只测它用到的那一截素材、**素材原声**,不含片段音量 / 淡入淡出 / 效果),给 mediaId 测整个素材,scope:'timeline' 测整条时间轴混在一起的结果(含每段音量和淡入淡出;**音频效果不含**,有效果时会标 note)。返回 integrated(整体响度 LUFS,越大越响,-14 是常见的发布目标)、truePeak(峰值 dBTP,超过 0 会削波爆音,发布要在 -1 以下)、lra / lraLow / lraHigh(响度范围,滤掉静音后的第 10 / 95 百分位)。timeline 档另给 series:逐秒的响度和那一秒正在出声的 clipId,好找出哪一秒太吵、是谁吵。经验:人声比配乐 / 环境音响 12~15 LU 才听得清;把两段的 integrated 相减就是差值,要压低 X dB 就 set_clip_volume 到 10^(-X/20)(压 12 dB ≈ 0.25),要抬高只能用 create_audio_fx 的 gain。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "测时间轴上这一段" },
        mediaId: { type: "string", description: "测整个素材" },
        scope: { type: "string", enum: ["clip", "media", "timeline"], description: "不传就按给了 clipId 还是 mediaId 判" },
        series: { type: "boolean", description: "clip / media 档也要逐秒曲线时传 true(timeline 档总是给)" }
      }
    },
    side: "agent"
  },
  {
    name: "measure_audio_js",
    description: "自定义测量:内置的 measure_audio 测不了的(RMS、峰值、过零率、某个频段的能量、静音段、节拍、两段的相关性……),自己写一段 JS 算。**只在创造力等级「高」时能用**;低、中档会被拒,那时只用 measure_audio。测谁和 measure_audio 一样:clipId 测时间轴上那一段用到的素材原声,mediaId 测整个素材,scope:'timeline' 测整条时间轴的混音(含片段音量和淡入淡出,不含音频效果;和导出一样是立体声,单声道素材每路低 3 dB);start / duration 在那段声音里再截一个窗口(秒)。服务端把声音解成 32 位浮点 PCM(缺省 16000 Hz,sampleRate 可调 8000~48000;最多 2 声道,mono:true 混成单声道;所有声道合计最多 1200 万个样本),在隔离的沙箱里(无头 Chrome 的 Worker,不能联网、没有 Node 能力)执行 code。code 是一个 async 函数体,参数 input = { channels: Float32Array[](每声道一个,值域约 -1~1), sampleRate, duration(秒), frames, numberOfChannels, scope, start, clipId?, mediaId? },用 return 返回可 JSON 序列化的汇总(不超过 256 KB,不要返回原始样本)。时限缺省 10 秒(timeoutMs 最多 30000),超时、抛错、语法错、结果不能序列化或太大都回 ok:false 与 error(带报错文字和行号),改代码重试。例:code:'const x = input.channels[0]; let s = 0, pk = 0; for (const v of x) { s += v * v; pk = Math.max(pk, Math.abs(v)); } return { rmsDb: 10 * Math.log10(s / x.length), peakDb: 20 * Math.log10(pk) };'",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", maxLength: 20000, description: "async 函数体,收到 input,用 return 返回结果" },
        clipId: { type: "string", description: "测时间轴上这一段" },
        mediaId: { type: "string", description: "测整个素材" },
        scope: { type: "string", enum: ["clip", "media", "timeline"], description: "不传就按给了 clipId 还是 mediaId 判,都没给测时间轴" },
        start: { type: "number", minimum: 0, description: "在那段声音里从第几秒开始(缺省 0)" },
        duration: { type: "number", exclusiveMinimum: 0, description: "只测这么多秒(缺省测到结尾)" },
        sampleRate: { type: "number", minimum: 8000, maximum: 48000, description: "解码的采样率,缺省 16000" },
        mono: { type: "boolean", description: "true 就混成单声道" },
        timeoutMs: { type: "number", minimum: 1000, maximum: 30000, description: "代码的时限,缺省 10000" }
      },
      required: ["code"]
    },
    side: "agent",
    timeoutMs: 90000
  },
  {
    name: "create_audio",
    description: "把视频变成声音。两种用法:给 mediaId —— 在素材库里派生出一份「只有声音」的素材(和源视频同一个文件,不转码,所以是瞬间的),之后 add_clip 用这个 mediaId 就是纯音频段;给 clipId —— 把时间轴上**这一段**就地转成声音,画面没了、位置长度素材内偏移淡入淡出全留着,素材库里同时也留一份。同一段视频只会派生一份声音素材,重复调返回同一个 mediaId。图片没有声音会被拒;本来就是声音的原样返回。淡入淡出对声音一样有效(预览按音量、导出按 afade),要给声音加淡入淡出用 add_transition。",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string", description: "素材库里的视频:派生一份声音素材" },
        clipId: { type: "string", description: "时间轴上的一段视频:就地转成声音" }
      }
    },
    side: "agent"
  },
  {
    name: "list_audio_fx",
    description: "列出音频效果库(素材库「音频效果」页里的那些),以及能用的效果种类、每种的参数(范围 / 默认 / 单位)、几条预设和表达式写法。每条效果给 fxId、name、description、params(挂到片段上可逐段调的参数)、ops、summary、animated、usedBy(挂在哪几段上)。挂效果前先看有没有现成能复用的;不确定该用哪种时看 kinds 里每种的 hint。",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "create_audio_fx",
    description: "新建一个音频效果,放进素材库「音频效果」页 —— 用户能看到、能复用,你也能挂到任意视频 / 声音片段上。ops 是依次作用的几步,每步 { kind, <参数名>: 值 },kind 十一种:gain 增益(db,-60~24,**能超过 0 dB,是把太轻的声音放大的唯一办法**)、highpass 高通(freq, q)、lowpass 低通(freq, q)、peaking 峰值均衡(freq, q, db)、lowshelf 低架(freq, db)、highshelf 高架(freq, db)、compressor 压缩(threshold, ratio, knee, attack, release)、limiter 限幅(ceiling)、delay 回声(time, feedback, mix)、reverb 混响(decay, mix)、pan 声像(pan)。没填的参数取默认(list_audio_fx 的 kinds 里有)。参数写数字,或写**随时间变化的表达式字符串**:t = 片段内秒数、d = 片段时长、p = t/d,还能引用 params 里声明的参数。例:{ name:'压低背景', params:{ amount:{ default:-12, min:-40, max:0, label:'分贝' } }, ops:[{ kind:'gain', db:'amount' }] };人声清晰:ops:[{ kind:'highpass', freq:100 }, { kind:'peaking', freq:3000, q:1, db:3 }, { kind:'compressor', threshold:-24, ratio:3 }]。传 clipId 就顺手挂到那一段上。预览和导出用同一张节点图(Web Audio),听到的和导出的一致。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "素材库里显示的名字,30 字以内" },
        description: { type: "string", description: "一句话说它是什么效果、适合什么声音" },
        params: {
          type: "object",
          description: "可选:可逐段调的参数,键是参数名(小写字母开头,不能和种类的参数名 freq / db / q 等重名),值是 { default, min?, max?, label? }。表达式里直接用参数名",
          additionalProperties: {
            type: "object",
            properties: {
              default: { type: "number" },
              min: { type: "number" },
              max: { type: "number" },
              label: { type: "string" }
            },
            required: ["default"]
          }
        },
        ops: {
          type: "array",
          description: "依次作用的步骤,1~8 步,每步 { kind, <参数名>: 数字或表达式 }",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["gain", "highpass", "lowpass", "peaking", "lowshelf", "highshelf", "compressor", "limiter", "delay", "reverb", "pan"] }
            },
            required: ["kind"],
            additionalProperties: true
          }
        },
        clipId: { type: "string", description: "可选:建完直接挂到这一段(视频 / 声音)" },
        clipParams: { type: "object", description: "可选:挂上时这一段的参数值,覆盖 params 的 default" }
      },
      required: ["name", "ops"]
    },
    side: "agent"
  },
  {
    name: "update_audio_fx",
    description: "改音频效果库里的一个效果。挂着它的片段**全部**跟着变(片段引用的是它,不是复制了一份)。给了 ops / params 就整项替换。只想改某一段,用 apply_audio_fx 给那一段传 params 覆盖,或另建一个效果。",
    inputSchema: {
      type: "object",
      properties: {
        fxId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        params: { type: "object", description: "同 create_audio_fx" },
        ops: { type: "array", items: { type: "object" }, description: "同 create_audio_fx" }
      },
      required: ["fxId"]
    },
    side: "agent"
  },
  {
    name: "remove_audio_fx",
    description: "从音频效果库删掉一个效果。还挂在片段上时会被拒;确实要删就传 force:true 并在 reason 里写明理由(用户会看到),所有剪辑里挂着它的片段会一起摘掉。",
    inputSchema: {
      type: "object",
      properties: {
        fxId: { type: "string" },
        force: { type: "boolean" },
        reason: { type: "string" }
      },
      required: ["fxId"]
    },
    side: "agent"
  },
  {
    name: "apply_audio_fx",
    description: "把音频效果库里的一个效果挂到视频 / 声音片段上(每段只挂一个,再挂就是替换;要叠几种效果就在一个效果里写多步 ops);params 给这一段单独的参数值。fxId 传空字符串就是摘掉。图片和卡片没有声音,不收。挂完可以 measure_audio 看一眼数值。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        fxId: { type: "string", description: "空字符串 = 摘掉这一段的音频效果" },
        params: { type: "object", description: "可选:这一段的参数值,只能是这个效果 params 里声明过的" }
      },
      required: ["clipId", "fxId"]
    },
    side: "agent"
  },
  {
    name: "voice_list",
    description: "查配音(voice_generate)的设置:默认服务(minimax / kling / vidu)、各服务的默认音色和参数、能用的音色(systemVoices 系统音色 + customVoices 用户在「配音设置」里建的或登记的「我的音色」,如复刻出来的人声)、API Key 设没设(apiKeySet)。第一次配音前先调一次,voiceId 从这里挑,不要自己编。",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  },
  {
    name: "voice_generate",
    description: "把一段文字配成语音(云端 TTS,走 API),同步返回,几秒钟。不传的参数取「配音设置」里的设置(出厂是 MiniMax speech-2.8-hd)。生成的 mp3 装进素材库;传 start(秒)就同时放到时间轴那个位置(可配 trackId),不传只进素材库。一次一段:MiniMax / Vidu 单次最多 5000 字、可灵 1000 字;长稿按句群拆开多次调,下一段的 start = 上一段 start + 上一段 duration(可留 0.2~0.4 秒气口)。voiceId 只能用 voice_list 里列出的音色,别的会被拒;没有新建音色的工具 —— 新音色首次合成要另收 ¥9.9,只能由用户在「配音设置」里建。没配 API Key、额度用完会报错,把报错原样告诉用户,不要反复重试。返回 mediaId、duration(秒)、clipId(放了时间轴才有)、provider、voiceId、chars(计费字数)。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要念的文字。数字、英文按想要的读法写(「130 毫秒」「PromptCut 零点五」)" },
        start: { type: "number", description: "放到时间轴的起点(秒);不传只进素材库" },
        trackId: { type: "string", description: "放到哪条序列;不传自动挑" },
        provider: { type: "string", enum: ["minimax", "kling", "vidu"], description: "不传用设置里的默认服务" },
        voiceId: { type: "string", description: "音色 id,只能取 voice_list 里有的;不传用该服务的默认音色" },
        speed: { type: "number", description: "语速,MiniMax / Vidu 0.5~2、可灵 0.8~2;不传用设置" },
        emotion: { type: "string", enum: ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm"], description: "情绪,只对 MiniMax / Vidu 有效;不传由模型按文字判断" },
        name: { type: "string", description: "素材名里带上的简短标签,如「开场旁白」" }
      },
      required: ["text"]
    },
    side: "page"
  }
];

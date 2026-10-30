# 项目数据模型：机制

本册写 `../product/project-model.md` 背后的具体机制（三级），从属于它，与它冲突时以它为准。2026-10-20 随「剪辑段」新建；本册各条都是实现者落定的〔裁：剪辑任务 2026-10-20，出处 `docs/reports/AGENT-cut-nesting.md`（三级）〕，任务书 `docs/plan/cut-nesting-task.md`，审核意见 `docs/plan/cut-nesting-argon-review.md`。

## 剪辑的存法

- 激活那条剪辑的序列、转场、总时长住在项目本身上，停放的各自带着（`src/kernel/cuts.ts`）。没有 `cuts` 字段的项目加载时只补「剪辑1」一条（`DEFAULT_CUT_COUNT = 1`）；已经带着 `cuts` 的原样不动。
- 就地改停放剪辑里的片段（Agent 按片段 id 改属性的工具，`src/mcp/clipCut.ts`）：把那条剪辑当激活的视图交给现成动作，提交时折回，只改它条目里的 tracks / duration / transitions（`kernel/cuts.ts` 的 `cutEditView` / `foldCutEdit`，`store/core.ts` 的 `runInCutScope`）；激活剪辑与它的序列保持原对象，一次工具调用是一次提交、一步撤销。删、复制、切分片段与 `get_layout` 仍只认激活剪辑，片段在别的剪辑里时报出它在哪条剪辑、要先 `user_interface_switch_cut`（2026-10-21 改名）。就地改的回包里「看一眼画面」的调用带上那条剪辑的 `cutId`。〔裁：cut-look-ui 2026-10-22〕
- 看别的剪辑的画面（`see_frames` 的 `cutId`，`../product/project-model.md`「剪辑」2026-10-21 用户定）：出图前把项目换成「那条剪辑当激活」的视图（`src/kernel/agentScopes.mjs` 的 `cutLookView`，与 `cutEditView` 同一个形状，纯 JS 版供服务端直接用），只交给这一次出图，不进 store、不进文档同步、不改 `activeCutId`。请求体里只有这份视图、不带 `cutId`，所以只认 `project` 的旧版渲染进程也出得对。不给时刻时取那条剪辑停放时存的播放头 `t`（没有就 0），给了 `clipId` 时照旧取片段中点。〔裁：cut-look-ui 2026-10-22〕
- 剪辑段的引用不能改（`../product/project-model.md`「片段」2026-10-21 用户定）：store 动作 `setCutSegment` 只收 `cutOffset`，带 `cutId` 就抛；Agent 的 `set_cut_segment` 不再声明 `cutId` / `name`，带了回「剪辑段引用的剪辑不能改，要换就删掉这段，用 add_cut_segment 放一段新的」（`src/kernel/cutSegments.ts` 的 `CUT_SEGMENT_REF_FIXED`）。

## 剪辑段的存法

- 剪辑段是序列上的一个普通片段：`cardId` 是空串、没有 `mediaId`，带 `cutId`（引用哪条剪辑）和 `cutOffset`（从被引用剪辑的第几秒开始，缺省 0）。框、不透明度、淡入淡出、独立静音（`audioMuted`）、音量（`audioVolume`）和素材段同名同义（`src/kernel/cutSegments.ts`）。
- 0.7.18 及更早的页面读到它：画面那条路跳过没有 `cardId` 的段，素材层跳过没有 `mediaId` 的段，所以只是不画、不出声，字段原样保留。
- 被引用剪辑的总时长按它自己的「总时长」取（激活的取项目的，停放的取条目上的），素材库显示的时长、拖进来时剪辑段的默认长度都是这个数。
- 修头时 `cutOffset` 跟着走（画面留在原处），不能往前越过被引用剪辑的开头；往外拉出点，上限是被引用剪辑此刻剩下的长度；已经超出的不自动裁。切分时后半段的 `cutOffset` = 前半段的偏移 + 前半段的长度。

## 循环引用

- 引用图：每条剪辑直接引用了哪些剪辑（它的序列里的剪辑段）。放进剪辑段之前从被引用剪辑出发沿图走（任意深度），走得到当前剪辑就拒绝；原因分「放进它自己」「已经引用了」「间接引用了」三种说法。拖放的落点预览、Agent 工具（`add_cut_segment`、`set_cut_segment`）、store 的写入（`placeCutSegment`）共用这一条判断。
- 协作合并可能造出环、或引用已删掉的剪辑：渲染时每层带着从根剪辑起的路径，被引用剪辑已经在路径上、找不到、或嵌套超过 32 层，那一段返回空，不抛。

## 删除被引用的剪辑

- 删之前列出直接引用它的剪辑和各自哪几段；确认后在所有剪辑（激活的与停放的）里删掉这些段，引用它们的转场一起删、另一头的淡化擦掉（和删片段同一个规矩），整个是一步，撤销一次全回来。
- Agent 的 `remove_cut`：被引用着、或里面有内容，不带 `force` 就拒绝并列出引用；带 `force` 必须带 `reason`，回包里 `removedSegments` 列出删了哪些段。

## 剪辑标签

- 打开了哪几个标签按项目 id 存在浏览器或桌面版页面的本地存储里（键 `pc.cutTabs.v1:<项目 id>`），不进项目文档、不同步。存储不可用时（隐私窗口、被禁）只留在内存里。
- 每次渲染时和项目对齐：激活的那条一定在（Agent 切过去、撤销切回去都会补上），已经不存在的剪辑拿掉，一个都不剩时就是激活的那条。关掉激活的标签时切到右邻，没有右邻切左邻。

## 缓存与预渲染的身份

- 激活剪辑经剪辑段（任意深度）能走到的那些剪辑的内容（序列、总时长、转场），只在有剪辑段时并进三处身份：镜像的项目哈希（`src/render/changedClips.mjs` 的 `projectHash`）、快照签名（`src/render/frameClient.ts`）、帧服务的帧身份（`server/frame-identity.mjs`）。没有剪辑段的项目三处一个字节不变，旧缓存照用（`src/kernel/cutIdentity.mjs`）。
- 帧服务按轨道前缀拆层、依赖下层的流判「有没有画面素材」、导出前的原尺寸素材拦截，都把被引用剪辑里用到的素材算进去。

## 片段速度

〔裁：clip-speed 2026-10-23，三级；产品功能见 `../product/project-model.md`「视频段的速度」〕

- **换算**：纯函数 `src/kernel/clipTime.mjs`。取帧时刻 `素材时刻 = mediaOffset + (t − start) × speed`；没有字段、不是有限正数时速度按 1。缺省 1 倍的项目**身份键逐字不变**：速度只在不等于 1 时才进键（`withMediaRates` 只给变速段的 `@clip/<id>/source` 节点加 `rate`），所以老项目不会因为这次改动全部判「已过期」重产。
- **不碰共享快照键的代码指纹**：变速声音的重采样放在 `server/bakery/mux-audio.mjs`，**不放进 `audio-mix.mjs`** —— 后者和 `export.mjs` 等七个模块进 `server/frame-code.mjs` 的 `SNAPSHOT_FILES`，改一个字所有片段的 contentKey / snapshotKey 都要变（实测：改了键比对 45/57，还原后 57/57）。
- **两条导出混音路怎么对齐**：`playableAudioPlan` 先用 ffmpeg 把变速声音段做成一段时间轴长度的 wav（读 `时长 × 速度` 秒素材，滤镜 `aresample=48000,asetrate=48000×速度,aresample=48000`），**Chrome 离线混音的裁段与 ffmpeg 混音都从这同一份 wav 起**。预览走 `<audio>` 的 `playbackRate` 加 `preservesPitch = false`；在线浏览器导出走 `browserExport.ts` 的 `resampleVarispeed`（同一语义，插值算法与 ffmpeg 的 swr 不同，**这一路还没有实测**）。选变调而不选保调，是因为预览与在线浏览器导出只能做变调，选保调两边会不一致。
- **音频素材效果卡的声音输入**（2026-10-23 用户定「放开。」后补；〔裁：speed-audio-input 2026-10-23，三级〕）：倍率在**页面取样这一层**生效（`src/render/cards/audioSources.ts` 的 `varispeedBlock`），不进 `/@media/<hash>/pcm` 路由。下游第 `i` 个采样取素材第 `mediaOffset + (start + 边.offset + i) × 倍率` 个采样：按倍率多取那一截原始采样（读「时长 × 倍率」秒，多 1～2 帧给插值），再按**绝对采样坐标**线性插值，和在线浏览器导出的 `resampleVarispeed` 同一语义、同一插值。不让服务端的 ffmpeg 按 `ffmpegVarispeed` 做，是因为卡片声音按块取（生成卡片声音 8192 帧一块，导出离线混音另有块），块起点落到素材上一般不在整数采样上，`asetrate` 每块重起滤镜，块缝相位对不上、还有滤波器的过渡段，每块一声咔哒；按绝对坐标插值，同一时刻落在哪一块都取到同一个值。代价是线性插值没有抗混叠滤波，和 ffmpeg 那一路（swr 的 sinc）不逐采样相同，随「失真问题记待办」一并记待办。倍率取素材节点上的 `rate`（`withMediaRates`），没有时按节点的 `clipId` 查片段速度；边上的 `rate ≠ 1` 仍不支持（另一条既有限制）。卡片声音的身份（`cardAudioIdentity`）里输入素材那一项在倍率不是 1 时带上 `speed`，1 倍逐字不变。挂在变速视频段上的音频素材效果卡，预览（`generatedCardAudioClipsAt`）与导出（`mux-audio.mjs` 的 `buildAudioPlan` 卡片声音那一路）都照常出。探针 `speed-audio-input-probe`。
- **声画一体卡在变速段上照常出声**（2026-10-23 用户定「出声。」，推翻〔裁〕V21-28；〔裁：av-card-speed-sound，三级〕）：难点是卡的时钟——`projectCardGraph` 原把卡节点的 `timeOffset` 写成 `mediaOffset`（素材秒），而卡的画面与声音按**时间轴秒**走；切分、裁剪按倍率推进 `mediaOffset`（往后 dt 秒时间轴，`mediaOffset` 加 dt × 倍率），于是 2 倍段在第 d 秒切开时，后半段的卡片时钟凭空前跳 d 秒：画面在切点硬跳（实测红条 382 → 512 像素），已生成的卡片声音被判「未覆盖、要重新生成」（2 倍）或播错位置（0.5 倍）。改法是卡片时钟起点改成 **`cardClockOffset = mediaOffset ÷ 倍率`**（`clipTime.mjs`），切分、裁剪只把它推进 dt，和切之前那一刻接得上；1 倍时逐位回原值，卡读这段素材的位置一个采样不变（`withMediaRates` 给那条边补同样的差）。**不改 `cardGraph.mjs`**：它进内置音频卡的源码指纹，改了所有用户已生成的卡片声音都判过期。探针 `av-card-speed-sound-probe`（导出后测主频：1× 439.6、2× 880.0、0.5× 220.0 Hz；切开后清单为空、两半共用同一份 WAV、后半偏移 = 前半 + 2 秒；切点前后红条 254 / 256 像素）与 `av-card-speed-1x-compare`（1 倍时卡图、舞台清单、时钟、身份、播放偏移、两条混音路 14/14 逐项相同）。
- **让位的实现**：`store.setClipSpeed` 判范围（`clipTime.mjs` 的 `speedInRange`），超出就拒绝并提示，不夹到边界。变长时把同序列后面的段整体后移；变短时尾部留空。转场装不下时缩到「新长度 − 0.01 秒」，不短于 0.1 秒；连 0.1 秒都装不下才拒绝。推不开时整个操作不生效并说明原因。
- **四支探针**：`clip-speed-export-probe`（导出端到端与声音）、`clip-speed-key-compare`（与开工提交逐项比键）、`clip-speed-ui-probe`（桌面与手机界面）、`speed-audio-input-probe`（变速段接音频素材效果卡，导出后测主频）。

/**
 * 浏览器侧 MCP 工具 → EditorApi 方法的路由表。
 *
 * 以前这张表是 src/ai/mcpExecutor.ts 里一条一百多个分支的 `else if (tool === "xxx")` 链。
 * 加一个工具要在三处登记(server/tools/*.mjs 的 schema、这条链、src/mcp/handlers/* 的实现),
 * 上一次重构就因此漏掉过两个工具 —— 漏在这条链上不会编译失败,只会在运行时报「未知工具」。
 * 现在链变成查表,server/test/mcp-routes.test.mjs 拿 server/mcp-tools.mjs 和这张表对账,
 * 漏登记当场测试失败。
 *
 * 写成纯数据的 .mjs(类型在同名 .d.mts)是为了让 node:test 能直接 import 它;
 * 仓库里 src/kernel/frameMode.mjs 等已经是这个写法。
 *
 * 每项逐条照抄原来那条分支的语义,不做统一:
 *   - passArgs:原分支传不传 args(`api.getProject()` 和 `api.listCards(args)` 是两种写法,
 *              前者的方法签名压根没有参数);
 *   - awaited :原分支 await 不 await。对非 Promise 值 await 本身是安全的,但它会多插一个
 *              微任务,改变这次调用和后面 getState() / flushDataMirror 之间的时序。
 *              纯重构不赌这个,原样保留。
 *
 * 顺序照抄原分发链,方便逐条对账。
 *
 * 键是模型侧的工具名。会动用户界面的工具名字带 `user_interface_`(2026-10-21 用户定,server/tools/ui-names.mjs);
 * 发给页面的内部操作名还是旧名,页面执行器进门先换成新名再查这张表(两种都认)。
 */
export const TOOL_ROUTES = {
  sound_presets: { method: "soundPresets", passArgs: false, awaited: false },
  sound_generate: { method: "soundGenerate", passArgs: true, awaited: true },
  sound_status: { method: "soundStatus", passArgs: true, awaited: false },
  sound_cancel: { method: "soundCancel", passArgs: true, awaited: false },
  background_job_status: { method: "backgroundJobStatus", passArgs: true, awaited: false },
  list_cards: { method: "listCards", passArgs: true, awaited: false },
  get_project: { method: "getProject", passArgs: false, awaited: false },
  list_media: { method: "listMedia", passArgs: false, awaited: false },
  get_selection: { method: "getSelection", passArgs: false, awaited: false },
  add_clip: { method: "addClip", passArgs: true, awaited: false },
  update_clip: { method: "updateClip", passArgs: true, awaited: false },
  list_cuts: { method: "listCuts", passArgs: true, awaited: false },
  user_interface_switch_cut: { method: "switchCut", passArgs: true, awaited: false },
  add_cut: { method: "addCut", passArgs: true, awaited: false },
  rename_cut: { method: "renameCut", passArgs: true, awaited: false },
  remove_cut: { method: "removeCut", passArgs: true, awaited: false },
  // 剪辑段(src/mcp/handlers/cutSegments.ts)
  add_cut_segment: { method: "addCutSegment", passArgs: true, awaited: false },
  set_cut_segment: { method: "setCutSegment", passArgs: true, awaited: false },
  set_position: { method: "setPosition", passArgs: true, awaited: false },
  set_rect: { method: "setRect", passArgs: true, awaited: false },
  align: { method: "align", passArgs: true, awaited: false },
  nudge: { method: "nudge", passArgs: true, awaited: false },
  get_layout: { method: "getLayout", passArgs: true, awaited: true },
  get_clip: { method: "getClip", passArgs: true, awaited: false },
  list_parts: { method: "listParts", passArgs: true, awaited: false },
  add_composite: { method: "addComposite", passArgs: true, awaited: false },
  add_part: { method: "addPart", passArgs: true, awaited: false },
  set_part: { method: "setPart", passArgs: true, awaited: false },
  remove_part: { method: "removePart", passArgs: true, awaited: false },
  move_part: { method: "movePart", passArgs: true, awaited: false },
  set_clip: { method: "setClip", passArgs: true, awaited: false },
  remove_clip: { method: "removeClip", passArgs: true, awaited: false },
  duplicate_clip: { method: "duplicateClip", passArgs: true, awaited: false },
  split_clip: { method: "splitClip", passArgs: true, awaited: false },
  set_clip_volume: { method: "setClipVolume", passArgs: true, awaited: false },
  set_clip_muted: { method: "setClipMuted", passArgs: true, awaited: false },
  render_card_audio: { method: "renderCardAudio", passArgs: true, awaited: true },
  cancel_card_audio: { method: "cancelCardAudio", passArgs: true, awaited: false },
  separate_audio: { method: "separateAudio", passArgs: true, awaited: false },
  create_audio: { method: "createAudio", passArgs: true, awaited: false },
  set_emphasis: { method: "setEmphasis", passArgs: true, awaited: false },
  list_transitions: { method: "listTransitions", passArgs: false, awaited: false },
  add_transition: { method: "addTransition", passArgs: true, awaited: false },
  remove_transition: { method: "removeTransition", passArgs: true, awaited: false },
  add_track: { method: "addTrack", passArgs: true, awaited: false },
  list_tracks: { method: "listTracks", passArgs: false, awaited: false },
  remove_track: { method: "removeTrack", passArgs: true, awaited: false },
  update_track: { method: "updateTrack", passArgs: true, awaited: false },
  move_track: { method: "moveTrack", passArgs: true, awaited: false },
  list_filters: { method: "listFilters", passArgs: false, awaited: false },
  create_filter: { method: "createFilter", passArgs: true, awaited: false },
  update_filter: { method: "updateFilter", passArgs: true, awaited: false },
  remove_filter: { method: "removeFilter", passArgs: true, awaited: false },
  apply_filter: { method: "applyFilter", passArgs: true, awaited: false },
  list_pixel_maps: { method: "listPixelMaps", passArgs: false, awaited: false },
  create_pixel_map: { method: "createPixelMap", passArgs: true, awaited: false },
  update_pixel_map: { method: "updatePixelMap", passArgs: true, awaited: false },
  remove_pixel_map: { method: "removePixelMap", passArgs: true, awaited: false },
  apply_pixel_map: { method: "applyPixelMap", passArgs: true, awaited: false },
  list_media_effects: { method: "listMediaEffects", passArgs: true, awaited: false },
  list_audio_fx: { method: "listAudioFx", passArgs: false, awaited: false },
  create_audio_fx: { method: "createAudioFx", passArgs: true, awaited: false },
  update_audio_fx: { method: "updateAudioFx", passArgs: true, awaited: false },
  remove_audio_fx: { method: "removeAudioFx", passArgs: true, awaited: false },
  apply_audio_fx: { method: "applyAudioFx", passArgs: true, awaited: false },
  measure_audio: { method: "measureAudio", passArgs: true, awaited: true },
  measure_audio_js: { method: "measureAudioJs", passArgs: true, awaited: true },
  user_interface_seek: { method: "seek", passArgs: true, awaited: false },
  user_interface_play: { method: "play", passArgs: false, awaited: false },
  user_interface_pause: { method: "pause", passArgs: false, awaited: false },
  set_theme: { method: "setTheme", passArgs: true, awaited: false },
  set_project_meta: { method: "setProjectMeta", passArgs: true, awaited: false },
  set_camera3d: { method: "setCamera3d", passArgs: true, awaited: false },
  bake_card: { method: "bakeCard", passArgs: true, awaited: true },
  stt_status: { method: "sttStatus", passArgs: false, awaited: true },
  stt_install: { method: "sttInstall", passArgs: true, awaited: true },
  transcribe_media: { method: "transcribeMedia", passArgs: true, awaited: true },
  get_transcript: { method: "getTranscript", passArgs: true, awaited: false },
  detect_shots: { method: "detectShots", passArgs: true, awaited: true },
  list_shots: { method: "listShots", passArgs: true, awaited: false },
  track_points: { method: "trackPoints", passArgs: true, awaited: true },
  get_track: { method: "getTrack", passArgs: true, awaited: false },
  track_status: { method: "trackStatus", passArgs: false, awaited: true },
  track_install: { method: "trackInstall", passArgs: false, awaited: true },
  detect_subjects: { method: "detectSubjects", passArgs: true, awaited: true },
  list_subjects: { method: "listSubjects", passArgs: true, awaited: false },
  subject_status: { method: "subjectStatus", passArgs: false, awaited: true },
  subject_install: { method: "subjectInstall", passArgs: false, awaited: true },
  attach_clip_motion: { method: "attachClipMotion", passArgs: true, awaited: false },
  detach_clip_motion: { method: "detachClipMotion", passArgs: true, awaited: false },
  auto_workflow: { method: "autoWorkflow", passArgs: true, awaited: true },
  auto_workflow_status: { method: "autoWorkflowStatus", passArgs: true, awaited: false },
  fill_captions: { method: "fillCaptions", passArgs: true, awaited: false },
  list_captions: { method: "listCaptions", passArgs: true, awaited: false },
  edit_caption: { method: "editCaption", passArgs: true, awaited: false },
  import_media: { method: "importMedia", passArgs: true, awaited: true },
  voice_list: { method: "voiceList", passArgs: false, awaited: true },
  voice_generate: { method: "voiceGenerate", passArgs: true, awaited: true },
  collect_status: { method: "collectStatus", passArgs: false, awaited: true },
  collect_search: { method: "collectSearch", passArgs: true, awaited: true },
  collect_install: { method: "collectInstall", passArgs: false, awaited: true },
  collect_probe: { method: "collectProbe", passArgs: true, awaited: true },
  collect_download: { method: "collectDownload", passArgs: true, awaited: true },
  collect_job: { method: "collectJob", passArgs: true, awaited: true },
  user_interface_collect_login: { method: "collectLogin", passArgs: true, awaited: true },
  collect_login_check: { method: "collectLoginCheck", passArgs: true, awaited: true },
  collect_logout: { method: "collectLogout", passArgs: true, awaited: true },
  create_card: { method: "createCard", passArgs: true, awaited: true },
  apply_card: { method: "applyCard", passArgs: true, awaited: true },
  get_card_source: { method: "getCardSource", passArgs: true, awaited: true },
  edit_card: { method: "editCard", passArgs: true, awaited: true },
  inspect_card_dom: { method: "inspectCardDom", passArgs: true, awaited: true },
  card_authoring_guide: { method: "cardAuthoringGuide", passArgs: false, awaited: true },
};

/**
 * 不走路由表的浏览器侧工具。它们在 mcpExecutor 里各有各的特殊处理,留在表外:
 *
 *   - see_frames:一个工具两种画面 —— source="media" 走 seeSequences、
 *     source="timeline" 或不给走 seePreview;还要先剥掉 source 字段,并对缺 mediaId、
 *     非法 source 两种情况回错误对象(不是抛错)。一对一的表表达不了。
 *   - get_gif:实现不在 EditorApi 上,是 mcpExecutor 自己的 getGif()(直接打预渲染的
 *     /api/ai/visual);而且它成功之后不再走 withVisual,结果里自带 visualId。
 *   - web_*:浏览器整个在服务端,这八个工具不碰编辑台的任何状态。挂进 EditorApi 只会逼
 *     编辑台那边实现 8 个纯转发的方法,所以按 `web_` 前缀交给 runWebTool。
 *
 * 这张表也参与对账:每个 side === "browser" 的工具必须要么在 TOOL_ROUTES 里、
 * 要么在这里,多一个少一个都算漏登记。
 */
export const SPECIAL_TOOLS = [
  "see_frames",
  "get_gif",
  "web_open",
  "web_view",
  "web_click",
  "web_type",
  "web_scroll",
  "web_read",
  "user_interface_web_handoff",
  "web_close",
];

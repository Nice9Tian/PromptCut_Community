/**
 * Routing table from browser-side MCP tools → EditorApi methods.
 *
 * Previously, this table was an `else if (tool === "xxx")` chain of over a hundred branches in
 * src/ai/mcpExecutor.ts. Adding a tool required registering in three places (schema in
 * server/tools/*.mjs, this chain, and implementation in src/mcp/handlers/*), and the last refactor
 * missed two tools because of this: missing on this chain causes no compile failure, only
 * reporting "unknown tool" at runtime. Now the chain is converted to a table lookup;
 * server/test/mcp-routes.test.mjs reconciles server/mcp-tools.mjs with this table, and missing
 * registrations fail the test on the spot.
 *
 * Written as pure-data .mjs (types in .d.mts of the same name) so node:test can directly import it;
 * src/kernel/frameMode.mjs and others in the repo already use this pattern.
 *
 * Each entry copies the semantics of its original branch item by item, without unifying them:
 *   - passArgs: whether the original branch passed args (`api.getProject()` and
 *              `api.listCards(args)` are two patterns, where the former's signature has no
 *              parameters at all);
 *   - awaited : whether the original branch awaited. Awaiting non-Promise values is inherently
 *              safe, but inserts an extra microtask, altering timing between this call and
 *              subsequent getState() / flushDataMirror. Pure refactoring does not gamble on this,
 *              preserving it as-is.
 *
 * Order copies the original dispatch chain to facilitate item-by-item reconciliation.
 *
 * Keys are model-side tool names. Tools that touch the user interface have names containing
 * `user_interface_` (user decision, 2026-10-21, server/tools/ui-names.mjs); internal operation
 * names sent to the page are still legacy names; the page executor converts them to new names upon
 * entry before looking up this table (both are accepted).
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
  set_cut_kind: { method: "setCutKind", passArgs: true, awaited: false },
  prerender_cut_to_2d: { method: "prerenderCutTo2D", passArgs: true, awaited: true },
  rename_cut: { method: "renameCut", passArgs: true, awaited: false },
  remove_cut: { method: "removeCut", passArgs: true, awaited: false },
  list_cameras: { method: "listCameras", passArgs: true, awaited: false },
  add_camera: { method: "addCamera", passArgs: true, awaited: false },
  update_camera: { method: "updateCamera", passArgs: true, awaited: false },
  remove_camera: { method: "removeCamera", passArgs: true, awaited: false },
  // Cut segments (src/mcp/handlers/cutSegments.ts)
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
 * Browser-side tools that do not go through the routing table. They have their own special
 * handling in mcpExecutor and remain outside the table:
 *
 *   - see_frames: one tool, two visual sources: source="media" goes to seeSequences,
 *     source="timeline" or omitted goes to seePreview; must also strip the source field first, and
 *     return error objects (not throw errors) for missing mediaId or invalid source. A one-to-one
 *     table cannot express this.
 *   - get_gif: implementation is not on EditorApi, but is mcpExecutor's own getGif() (calling
 *     prerender /api/ai/visual directly); and after success it does not go through withVisual, as
 *     the result already contains visualId.
 *   - web_*: the browser is entirely on the server; these eight tools touch no editor state.
 *     Hooking them into EditorApi would only force the editor to implement 8 pure-forwarding
 *     methods, so they are routed to runWebTool by `web_` prefix.
 *
 * This table also participates in reconciliation: every tool with side === "browser" must either
 * be in TOOL_ROUTES or here; one extra or one missing is considered a missed registration.
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

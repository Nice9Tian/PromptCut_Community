/*
 * How to format the two lines of text on the overlay. Kept in a separate file so it can be tested
 * with node in desktop/test (overlay.html imports it via <script src> and mounts it on
 * window.pcOverlay; node runs the same file via vm).
 *
 * Input is pc-overlay-state pushed by the shell (OverlayState in desktop/src-tauri/src/skill_shell.rs):
 *   { skill, since, editor_up, sessions: [{ id, vendor, label, current: { tool, since } | null,
 *     last: { tool, ok, at } | null, lastSeen }] }
 * sessions comes from GET /api/agent/desktop of the editor process (A4 desktop session groups),
 * only present under SKILL.
 */
(function (root) {
  'use strict';

  // The system display language: 0 English, 1 Chinese, 2 Japanese. The editor's own choice lives on another origin.
  var LANG = (function () {
    var l = (typeof navigator !== 'undefined' && navigator.language) || '';
    return /^zh/i.test(l) ? 1 : /^ja/i.test(l) ? 2 : 0;
  })();

  // i18n-allow-start: the overlay brings its own Chinese and Japanese
  /** English → [Chinese, Japanese]; {0} {1} are filled in by t() */
  var TEXT = {
    'PromptCut is running in background mode': ['PromptCut 在后台运行', 'PromptCut はバックグラウンドで動作中'],
    'Editor is collapsed, Agent keeps working': ['编辑界面已收起，Agent 照常工作', '編集画面は閉じていますが、エージェントは作業を続けています'],
    'SKILL mode': ['SKILL 模式', 'SKILL モード'],
    'The editor is not responding': ['编辑器没有响应', 'エディターが応答しません'],
    'Waiting for the desktop app\'s Agent to connect': ['等桌面 APP 的 Agent 接入', 'デスクトップアプリのエージェントの接続を待っています'],
    '{0}: {1}': ['{0} 正在{1}', '{0}：{1}'],
    '{0} and others: {1} sessions working': ['{0} 等 {1} 个会话正在工作', '{0} ほか {1} 件のセッションが作業中'],
    '{0} connected': ['{0} 已接入', '{0} が接続しました'],
    '{0}, last step: {1}': ['{0} 上一步：{1}', '{0} 前回のステップ：{1}'],
    '{0}, last step failed: {1}': ['{0} 上一步失败：{1}', '{0} 前回のステップが失敗：{1}'],
    'Action': ['操作', '操作'],
    'Click to open the editor, right-click to quit PromptCut': ['单击打开编辑界面，右键可关闭 PromptCut', 'クリックで編集画面を開く、右クリックで PromptCut を終了'],
    'Click to open · right-click to quit': ['单击打开 · 右键关闭', 'クリックで開く · 右クリックで終了'],
    'The AI\'s last timeline action, and the picture at that moment': ['AI 上一步做成的时间轴动作，那一刻的画面', 'AI が直前に行ったタイムライン操作と、その時点の画面'],
    'Picture of the last action': ['上一步动作的画面', '直前の操作の画面'],
    'Last step': ['上一步', '前回のステップ'],
    'Starting PromptCut…': ['正在启动 PromptCut…', 'PromptCut を起動しています…'],
  };
  // i18n-allow-end

  function t(en) {
    var row = TEXT[en];
    var out = LANG && row ? row[LANG - 1] : en;
    for (var i = 1; i < arguments.length; i++) out = out.split('{' + (i - 1) + '}').join(String(arguments[i]));
    return out;
  }

  // Tool name → plain words; a name not listed is shown as it is.
  // i18n-allow-start
  // [English, Chinese, Japanese] by tool name
  var TOOL_NAMES = {
    add_clip: ['Add card', '加卡片', 'カードを追加'],
    update_clip: ['Edit card', '改卡片', 'カードを編集'],
    remove_clip: ['Delete card', '删卡片', 'カードを削除'],
    duplicate_clip: ['Duplicate card', '复制卡片', 'カードを複製'],
    split_clip: ['Split card', '切开卡片', 'カードを分割'],
    fill_captions: ['Fill captions', '灌字幕', '字幕を流し込み'],
    set_position: ['Move', '挪位置', '移動'],
    set_rect: ['Fit into rectangle', '放进矩形', '矩形に収める'],
    align: ['Align', '对齐', '整列'],
    nudge: ['Nudge', '微调', '微調整'],
    attach_clip_motion: ['Attach follow', '绑跟随', '追従を設定'],
    detach_clip_motion: ['Detach follow', '解跟随', '追従を解除'],
    add_track: ['Add track', '加序列', 'トラックを追加'],
    remove_track: ['Delete track', '删序列', 'トラックを削除'],
    update_track: ['Edit track', '改序列', 'トラックを編集'],
    move_track: ['Move track', '挪序列', 'トラックを移動'],
    create_filter: ['Create filter', '建滤镜', 'フィルターを作成'],
    update_filter: ['Edit filter', '改滤镜', 'フィルターを編集'],
    remove_filter: ['Delete filter', '删滤镜', 'フィルターを削除'],
    apply_filter: ['Apply filter', '挂滤镜', 'フィルターを適用'],
    create_audio_fx: ['Create audio effect', '建音频效果', 'オーディオエフェクトを作成'],
    update_audio_fx: ['Edit audio effect', '改音频效果', 'オーディオエフェクトを編集'],
    remove_audio_fx: ['Delete audio effect', '删音频效果', 'オーディオエフェクトを削除'],
    apply_audio_fx: ['Apply audio effect', '挂音频效果', 'オーディオエフェクトを適用'],
    measure_audio: ['Measure loudness', '测响度', 'ラウドネスを測定'],
    switch_cut: ['Switch cut', '切换剪辑', 'カットを切り替え'],
    add_cut: ['New cut', '新建剪辑', 'カットを新規作成'],
    set_theme: ['Change theme', '换主题', 'テーマを変更'],
    // Tools that modify the UI carry the user_interface_ prefix since 2026-10-21; legacy names
    // (switch_cut etc. above) are kept because older sessions still report legacy names
    user_interface_switch_cut: ['Switch cut', '切换剪辑', 'カットを切り替え'],
    user_interface_seek: ['Seek playhead', '跳播放头', '再生ヘッドを移動'],
    user_interface_play: ['Play', '播放', '再生'],
    user_interface_pause: ['Pause', '暂停', '一時停止'],
    seek: ['Seek playhead', '跳播放头', '再生ヘッドを移動'],
    play: ['Play', '播放', '再生'],
    pause: ['Pause', '暂停', '一時停止'],
    user_interface_web_handoff: ['Hand off web page', '交出网页', 'Web ページを引き渡し'],
    web_handoff: ['Hand off web page', '交出网页', 'Web ページを引き渡し'],
    user_interface_collect_login: ['Show login dialog', '弹登录框', 'ログイン画面を表示'],
    collect_login: ['Show login dialog', '弹登录框', 'ログイン画面を表示'],
    get_project: ['Read project', '读项目', 'プロジェクトを読み込み'],
    report_progress: ['Report progress', '交进度', '進捗を報告'],
    get_skill_guide: ['Read guide', '读说明', 'ガイドを読む'],
  };
  // i18n-allow-end

  function toolName(name) {
    return (name && TOOL_NAMES[name] && TOOL_NAMES[name][LANG]) || name || t('Action');
  }

  function who(s) {
    return (s && (s.label || s.vendor)) || 'Agent';
  }

  /** @returns {{ title: string, sub: string, busy: boolean, skill: boolean }} */
  function summarize(state) {
    var st = state || {};
    if (!st.skill) {
      return { title: t('PromptCut is running in background mode'), sub: t('Editor is collapsed, Agent keeps working'), busy: false, skill: false };
    }
    var title = t('SKILL mode');
    if (st.editor_up === false) {
      return { title: title, sub: t('The editor is not responding'), busy: false, skill: true };
    }
    var list = Array.isArray(st.sessions) ? st.sessions : [];
    if (!list.length) {
      return { title: title, sub: t('Waiting for the desktop app\'s Agent to connect'), busy: false, skill: true };
    }
    var running = list.filter(function (s) { return s && s.current && s.current.tool; });
    if (running.length === 1) {
      return { title: title, sub: t('{0}: {1}', who(running[0]), toolName(running[0].current.tool)), busy: true, skill: true };
    }
    if (running.length > 1) {
      return { title: title, sub: t('{0} and others: {1} sessions working', who(running[0]), running.length), busy: true, skill: true };
    }
    // None are running: show the last step of the most recently active session (the server already
    // orders them with the most recently active first)
    var recent = list.filter(function (s) { return s && s.last && s.last.tool; });
    if (!recent.length) {
      return { title: title, sub: t('{0} connected', who(list[0])), busy: false, skill: true };
    }
    var s0 = recent[0];
    var failed = s0.last.ok === false;
    return {
      title: title,
      sub: t(failed ? '{0}, last step failed: {1}' : '{0}, last step: {1}', who(s0), toolName(s0.last.tool)),
      busy: false,
      skill: true,
    };
  }

  /** The line below the preview: "Last step Edit card · 3.2s · 12:03:04" */
  function previewCaption(d, fmtTime) {
    var p = d || {};
    var at = typeof p.t === 'number' ? ' · ' + p.t.toFixed(1) + 's' : '';
    var when = p.at ? fmtTime(p.at) : '';
    return { what: toolName(p.tool), rest: at + (when ? ' · ' + when : '') };
  }

  root.pcOverlay = { summarize: summarize, previewCaption: previewCaption, toolName: toolName, t: t };
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * 悬浮窗上那两行字怎么写。单独成一个文件,是为了能在 desktop/test 里用 node 测
 * (overlay.html 用 <script src> 引进来,挂在 window.pcOverlay 上;node 里用 vm 跑同一份)。
 *
 * 输入是外壳推来的 pc-overlay-state(desktop/src-tauri/src/skill_shell.rs 的 OverlayState):
 *   { skill, since, editor_up, sessions: [{ id, vendor, label, current: { tool, since } | null,
 *     last: { tool, ok, at } | null, lastSeen }] }
 * sessions 来自编辑器进程的 GET /api/agent/desktop(A4 的桌面会话分组),只在 SKILL 下有。
 */
(function (root) {
  'use strict';

  // 工具名 → 人话。没列到的照原名显示。
  var TOOL_NAMES = {
    add_clip: 'Add card', update_clip: 'Edit card', remove_clip: 'Delete card',
    duplicate_clip: 'Duplicate card', split_clip: 'Split card', fill_captions: 'Fill captions',
    set_position: 'Move', set_rect: 'Fit into rectangle', align: 'Align', nudge: 'Nudge',
    attach_clip_motion: 'Attach follow', detach_clip_motion: 'Detach follow', add_track: 'Add track',
    remove_track: 'Delete track', update_track: 'Edit track', move_track: 'Move track',
    create_filter: 'Create filter', update_filter: 'Edit filter', remove_filter: 'Delete filter', apply_filter: 'Apply filter',
    create_audio_fx: 'Create audio effect', update_audio_fx: 'Edit audio effect', remove_audio_fx: 'Delete audio effect', apply_audio_fx: 'Apply audio effect',
    measure_audio: 'Measure loudness', switch_cut: 'Switch cut', add_cut: 'New cut', set_theme: 'Change theme',
    // 会动用户界面的工具 2026-10-21 起名字带 user_interface_ 前缀;旧名(上面的 switch_cut 等)留着,老会话报上来的还是旧名
    user_interface_switch_cut: 'Switch cut', user_interface_seek: 'Seek playhead', user_interface_play: 'Play', user_interface_pause: 'Pause',
    seek: 'Seek playhead', play: 'Play', pause: 'Pause', user_interface_web_handoff: 'Hand off web page', web_handoff: 'Hand off web page',
    user_interface_collect_login: 'Show login dialog', collect_login: 'Show login dialog',
    get_project: 'Read project', report_progress: 'Report progress', get_skill_guide: 'Read guide',
  };

  function toolName(t) {
    return (t && TOOL_NAMES[t]) || t || 'Action';
  }

  function who(s) {
    return (s && (s.label || s.vendor)) || 'Agent';
  }

  /** @returns {{ title: string, sub: string, busy: boolean, skill: boolean }} */
  function summarize(state) {
    var st = state || {};
    if (!st.skill) {
      return { title: 'PromptCut is running in background mode', sub: 'Editor is collapsed, Agent keeps working', busy: false, skill: false };
    }
    var title = 'SKILL mode';
    if (st.editor_up === false) {
      return { title: title, sub: 'The editor is not responding', busy: false, skill: true };
    }
    var list = Array.isArray(st.sessions) ? st.sessions : [];
    if (!list.length) {
      return { title: title, sub: 'Waiting for the desktop app\'s Agent to connect', busy: false, skill: true };
    }
    var running = list.filter(function (s) { return s && s.current && s.current.tool; });
    if (running.length === 1) {
      return { title: title, sub: who(running[0]) + ' is: ' + toolName(running[0].current.tool), busy: true, skill: true };
    }
    if (running.length > 1) {
      return { title: title, sub: who(running[0]) + ' and ' + running.length + ' sessions working', busy: true, skill: true };
    }
    // 都没在跑:显示最近动过的那个会话的上一步(服务端给的顺序就是最近动过的在前)
    var recent = list.filter(function (s) { return s && s.last && s.last.tool; });
    if (!recent.length) {
      return { title: title, sub: who(list[0]) + ' connected', busy: false, skill: true };
    }
    var s0 = recent[0];
    var failed = s0.last.ok === false;
    return {
      title: title,
      sub: who(s0) + (failed ? ' last step failed: ' : ' last step: ') + toolName(s0.last.tool),
      busy: false,
      skill: true,
    };
  }

  /** 预览图下面那一行:「上一步 改卡片 · 3.2s · 12:03:04」 */
  function previewCaption(d, fmtTime) {
    var p = d || {};
    var at = typeof p.t === 'number' ? ' · ' + p.t.toFixed(1) + 's' : '';
    var when = p.at ? fmtTime(p.at) : '';
    return { what: toolName(p.tool), rest: at + (when ? ' · ' + when : '') };
  }

  root.pcOverlay = { summarize: summarize, previewCaption: previewCaption, toolName: toolName };
})(typeof window !== 'undefined' ? window : globalThis);

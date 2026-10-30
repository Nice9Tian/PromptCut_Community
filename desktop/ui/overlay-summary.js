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
    add_clip: '加卡片', update_clip: '改卡片', remove_clip: '删卡片',
    duplicate_clip: '复制卡片', split_clip: '切开卡片', fill_captions: '灌字幕',
    set_position: '挪位置', set_rect: '放进矩形', align: '对齐', nudge: '微调',
    attach_clip_motion: '绑跟随', detach_clip_motion: '解跟随', add_track: '加序列',
    remove_track: '删序列', update_track: '改序列', move_track: '挪序列',
    create_filter: '建滤镜', update_filter: '改滤镜', remove_filter: '删滤镜', apply_filter: '挂滤镜',
    create_audio_fx: '建音频效果', update_audio_fx: '改音频效果', remove_audio_fx: '删音频效果', apply_audio_fx: '挂音频效果',
    measure_audio: '测响度', switch_cut: '切换剪辑', add_cut: '新建剪辑', set_theme: '换主题',
    // 会动用户界面的工具 2026-10-21 起名字带 user_interface_ 前缀;旧名(上面的 switch_cut 等)留着,老会话报上来的还是旧名
    user_interface_switch_cut: '切换剪辑', user_interface_seek: '跳播放头', user_interface_play: '播放', user_interface_pause: '暂停',
    seek: '跳播放头', play: '播放', pause: '暂停', user_interface_web_handoff: '交出网页', web_handoff: '交出网页',
    user_interface_collect_login: '弹登录框', collect_login: '弹登录框',
    get_project: '读项目', report_progress: '交进度', get_skill_guide: '读说明',
  };

  function toolName(t) {
    return (t && TOOL_NAMES[t]) || t || '操作';
  }

  function who(s) {
    return (s && (s.label || s.vendor)) || 'Agent';
  }

  /** @returns {{ title: string, sub: string, busy: boolean, skill: boolean }} */
  function summarize(state) {
    var st = state || {};
    if (!st.skill) {
      return { title: 'PromptCut 在后台运行', sub: '编辑界面已收起，Agent 照常工作', busy: false, skill: false };
    }
    var title = 'SKILL 模式';
    if (st.editor_up === false) {
      return { title: title, sub: '编辑器没有响应', busy: false, skill: true };
    }
    var list = Array.isArray(st.sessions) ? st.sessions : [];
    if (!list.length) {
      return { title: title, sub: '等桌面 APP 的 Agent 接入', busy: false, skill: true };
    }
    var running = list.filter(function (s) { return s && s.current && s.current.tool; });
    if (running.length === 1) {
      return { title: title, sub: who(running[0]) + ' 正在' + toolName(running[0].current.tool), busy: true, skill: true };
    }
    if (running.length > 1) {
      return { title: title, sub: who(running[0]) + ' 等 ' + running.length + ' 个会话正在工作', busy: true, skill: true };
    }
    // 都没在跑:显示最近动过的那个会话的上一步(服务端给的顺序就是最近动过的在前)
    var recent = list.filter(function (s) { return s && s.last && s.last.tool; });
    if (!recent.length) {
      return { title: title, sub: who(list[0]) + ' 已接入', busy: false, skill: true };
    }
    var s0 = recent[0];
    var failed = s0.last.ok === false;
    return {
      title: title,
      sub: who(s0) + (failed ? ' 上一步失败：' : ' 上一步：') + toolName(s0.last.tool),
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

import { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { findClip } from "../../kernel/project";
import { cameraFor, clampFov, DEFAULT_FOV_DEG, MAX_FOV_DEG, MIN_FOV_DEG } from "../../kernel/space3d";
import { mediaCardUrl } from "../../ai/mediaRef";
import { parkedCutsIndex } from "../../kernel/agentScopes.mjs";
import { getCard } from "../../kernel/registry";

/**
 * `set_project_meta` 收的字段,和 `server/tools/project.mjs` 里它的 inputSchema.properties 一一对应
 * (`server/test/creativity-gate.test.mjs` CR-2 核对两边一致)。三维透视走 `set_camera3d`、主题也可走 `set_theme`;
 * 三维渲染路线(`glRoute`)和创造力等级(`creativity`)只在项目设置里改,Agent 不写。
 */
export const SET_PROJECT_META_FIELDS = ["name", "width", "height", "fps", "duration", "themeId"] as const;

/** 参数里不认的键(按出现顺序) */
export function undeclaredProjectMetaKeys(args: unknown): string[] {
  if (args === undefined || args === null) return [];
  if (typeof args !== "object" || Array.isArray(args)) return ["(arguments are not an object)"];
  return Object.keys(args).filter((k) => !(SET_PROJECT_META_FIELDS as readonly string[]).includes(k));
}

export function projectMetaRejection(unknown: string[]): string {
  const creativity = unknown.includes("creativity")
    ? "Creativity level can only be changed by the user in project settings or the AI panel; the Agent cannot write it."
    : "";
  return `set_project_meta does not accept these fields: ${unknown.join(", ")}. This call was not executed at all, no field was written.` +
    ` It only accepts ${SET_PROJECT_META_FIELDS.join(", ")}. ${creativity}` +
    "Use set_camera3d for 3D perspective; change other project content with the matching tool, it cannot be written directly through set_project_meta.";
}


export const projectHandlers = {
  getProject: () => {
    const p = getState().project;
    // 停放剪辑的片段索引放在最前面:tracks 只是激活剪辑的,没有它模型想看别的剪辑里有什么只能 switch_cut
    const parkedCuts = parkedCutsIndex(p, { cardName: (id) => getCard(id)?.name });
    return {
      ...(parkedCuts ? { parkedCuts } : null),
      ...p,
      media: p.media.map(m => {
        if (m.transcript) {
          return {
            ...m,
            transcript: {
              engine: m.transcript.engine,
              model: m.transcript.model,
              language: m.transcript.language,
              createdAt: m.transcript.createdAt,
              segments: m.transcript.segments.length,
              hint: "Use get_transcript for the full transcript"
            }
          };
        }
        return m;
      })
    };
  },
  listMedia: () => {
    const p = getState().project;
    return p.media.map(m => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      duration: m.duration,
      width: m.width,
      height: m.height,
      // 卡片里引用用 cardUrl。不再给 url:导入的素材那是 blob: 开头的编辑器私有地址,
      // 模型拿去填卡片只会得到空白画面(见 src/ai/mediaRef.ts)
      cardUrl: mediaCardUrl(m),
      path: m.path,
      hasTranscript: !!m.transcript,
      transcriptSegments: m.transcript ? m.transcript.segments.length : 0
    }));
  },
  getSelection: () => {
    const state = getState();
    return { selection: { clipIds: [...state.selection] },
      items: state.selection.map((id) => {
        const hit = findClip(state.project, id);
        return hit ? { id, trackId: hit.track.id, clip: hit.clip } : { id, missing: true };
      }) };
  },
  /**
   * 总时长不走 setProjectMeta:直接写进项目会被时间轴立刻按内容末尾改回去。
   * 走手动截断那条路,和用户手动缩短是同一个规则(kernel/duration.ts)。
   *
   * 只收 `set_project_meta` schema 里声明的字段(`SET_PROJECT_META_FIELDS`),带了别的键整次拒绝、一个都不写。
   * 以前 `...rest` 原样交给 `setProjectMeta`,Agent 能借它改项目的任意字段(tracks、media、创造力等级……),
   * 违反「Agent 不能绕过工具直接改项目」(`user-workflow.md`「保护」)。页面和 Agent 服务端(ssr-host)跑的都是这一份。
   */
  setProjectMeta: (args) => {
    const unknown = undeclaredProjectMetaKeys(args);
    if (unknown.length) throw new Error(projectMetaRejection(unknown));
    const { duration, ...rest } = args ?? {};
    if (Object.keys(rest).length) actions.setProjectMeta(rest);
    if (typeof duration === "number" && Number.isFinite(duration)) actions.setDurationManual(duration);
    return { ok: true, duration: getState().project.duration };
  },
  /**
   * 三维总开关。**只认 fov,不收相机距离** —— 距离是 fov 和画布高度推出来的,
   * 让人填距离的话换个画幅透视强度就变了(见 kernel/space3d.ts 里的那张表)。
   * 关掉时把字段整个删掉而不是设 0:老项目没有这个字段,存盘结果要和从没开过三维一样。
   */
  setCamera3d: (args) => {
    const hasFov = args?.fovDeg !== undefined && args.fovDeg !== null;
    /*
     * 非数字直接抛,不走 clampFov。
     * clampFov 对 NaN 返回默认值 40,于是 set_camera3d({fovDeg:"很强"}) 会得到
     * 「fovDeg 被夹到 40(允许 5~120)」—— Agent 以为自己传的数字越界了,
     * 其实是**类型**就错了,它会去调数字而不是去改类型。
     * 同一个仓库里 framePatchFromArgs 对非数字就是直接抛,两处要一个标准。
     */
    if (hasFov && (typeof args.fovDeg !== "number" || !Number.isFinite(args.fovDeg))) {
      throw new Error(`fovDeg must be a finite number (${MIN_FOV_DEG}~${MAX_FOV_DEG}), got ${JSON.stringify(args.fovDeg)}`);
    }
    const turnOff = args?.enabled === false;
    if (turnOff) {
      /*
       * 关掉时把调过的 fov 记在一边。不记的话「关掉看看对比、再打开」会静悄悄
       * 退回默认 40 —— 用户调到 60 的那个感觉没了,而且没有任何提示。
       * 记在 store 之外的模块变量里:它不该进项目文件(存盘结果要和从没开过三维一样)。
       */
      const remembered = getState().project.camera3dFov ?? getState().lastCamera3dFov ?? undefined;
      actions.setProjectMeta({ camera3dFov: undefined });
      actions.rememberCamera3dFov(remembered ?? null);
      return {
        ok: true,
        enabled: false,
        hint: `3D is off. rotateX/rotateY/translateZ on cards are kept, there is just no perspective anymore${remembered ? `; turning it back on (enabled:true) restores ${remembered}°` : ""}`,
      };
    }
    if (!hasFov && args?.enabled !== true) {
      const cur = getState().project;
      return {
        ok: true,
        enabled: !!cur.camera3dFov,
        fovDeg: cur.camera3dFov ?? null,
        hint: "Nothing was passed, this only reported the current state. To turn it on pass fovDeg (or enabled:true), to turn it off pass enabled:false",
      };
    }
    const fov = clampFov(hasFov ? args.fovDeg : (getState().project.camera3dFov ?? getState().lastCamera3dFov ?? DEFAULT_FOV_DEG));
    actions.setProjectMeta({ camera3dFov: fov });
    const cur = getState().project;
    const cam = cameraFor({ width: cur.width, height: cur.height }, fov);
    return {
      ok: true,
      enabled: true,
      fovDeg: fov,
      ...(hasFov && fov !== args.fovDeg
        ? { clamped: `fovDeg was clamped to ${fov} (allowed ${MIN_FOV_DEG}~${MAX_FOV_DEG})` }
        : null),
      cameraDistancePx: Math.round(cam.distance),
      hint: "set_position rotateX / rotateY / translateZ now use true perspective. After changing, check with see_frames: perspective strength can only be judged by eye, not computed",
    };
  },
  setTheme: (args) => { actions.setProjectMeta({ themeId: args.themeId }); return { ok: true }; },
} satisfies Partial<EditorApi>;

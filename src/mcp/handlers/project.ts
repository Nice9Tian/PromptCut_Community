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
  if (typeof args !== "object" || Array.isArray(args)) return ["(参数不是对象)"];
  return Object.keys(args).filter((k) => !(SET_PROJECT_META_FIELDS as readonly string[]).includes(k));
}

export function projectMetaRejection(unknown: string[]): string {
  const creativity = unknown.includes("creativity")
    ? "创造力等级只能由用户在项目设置或 AI 栏里改,Agent 不能写。"
    : "";
  return `set_project_meta 不认这些字段:${unknown.join("、")}。这次调用整个没有执行,一个字段都没写。` +
    `它只收 ${SET_PROJECT_META_FIELDS.join("、")}。${creativity}` +
    "三维透视用 set_camera3d;别的项目内容用对应的工具改,不能经 set_project_meta 直接写。";
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
              hint: "完整文字稿请用 get_transcript"
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
      throw new Error(`fovDeg 必须是有限数字(${MIN_FOV_DEG}~${MAX_FOV_DEG}),收到 ${JSON.stringify(args.fovDeg)}`);
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
        hint: `三维已关。卡片上的 rotateX/rotateY/translateZ 还在,只是不再有透视${remembered ? `;再打开(enabled:true)会回到 ${remembered}°` : ""}`,
      };
    }
    if (!hasFov && args?.enabled !== true) {
      const cur = getState().project;
      return {
        ok: true,
        enabled: !!cur.camera3dFov,
        fovDeg: cur.camera3dFov ?? null,
        hint: "什么都没传,这里只是报了下当前状态。要打开传 fovDeg(或 enabled:true),要关掉传 enabled:false",
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
        ? { clamped: `fovDeg 被夹到 ${fov}(允许 ${MIN_FOV_DEG}~${MAX_FOV_DEG})` }
        : null),
      cameraDistancePx: Math.round(cam.distance),
      hint: "现在 set_position 的 rotateX / rotateY / translateZ 会走真透视了。改完用 see_frames 看一眼 —— 透视强度只能看,算不出来",
    };
  },
  setTheme: (args) => { actions.setProjectMeta({ themeId: args.themeId }); return { ok: true }; },
} satisfies Partial<EditorApi>;

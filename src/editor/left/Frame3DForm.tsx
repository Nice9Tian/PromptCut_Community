import { actions, useStore } from "../../store/project";
import { resolveFrame } from "../../kernel/layout";
import { clampFov, DEFAULT_FOV_DEG, MAX_FOV_DEG, MIN_FOV_DEG, perspectivePx } from "../../kernel/space3d";
import type { ClipFrame } from "../../kernel/types";
import type { TrackClip } from "../../kernel/project";
import { NumberField } from "../fields/NumberField";
import { RangeField } from "../fields/RangeField";

/**
 * 编辑 → 三维:把这张卡摆进空间。
 *
 * # 为什么相机开关也放在这儿
 *
 * 三维是**整个项目一档**的(一个画面只有一台相机),而这三个旋钮是**每张卡**的。
 * 分在两个地方的话必然出现这一幕:用户把 rotateY 拉到 40°,画面只是斜切了一下,
 * 没有近大远小,然后他以为是这个功能不好用 —— 其实只是相机没开。
 * 所以把开关放在同一屏,而且没开的时候直接把话说出来。
 *
 * # 没有 frame 的卡怎么办
 *
 * 大多数卡没有 frame(铺满画幅)。要给它加三维就得先有个 frame,
 * 这里补的是 `{x:0, y:0}` —— resolveFrame 会把 w/h 补成整个画幅、锚点补成左上角,
 * 也就是和「没有 frame」一模一样的位置。所以加这个 frame 不会让画面动,
 * 只是让它有地方存三维那三个值。
 */

const RESET: Partial<ClipFrame> = { rotateX: 0, rotateY: 0, translateZ: 0 };

export function Frame3DForm({ clip }: { clip: TrackClip }) {
  const project = useStore((s) => s.project);
  const stage = { width: project.width, height: project.height };
  const f = resolveFrame(clip.frame, stage);
  const on = !!project.camera3dFov;
  const fov = project.camera3dFov ?? DEFAULT_FOV_DEG;

  /** 只改传进来的那几项,其余保留;没有 frame 就补一个和「铺满」等价的 */
  const patch = (p: Partial<ClipFrame>) => {
    const prev = clip.frame ?? { x: 0, y: 0 };
    actions.setClipFrame(clip.id, { ...prev, ...p } as ClipFrame);
  };

  const row = (
    label: string,
    key: "rotateX" | "rotateY" | "translateZ",
    min: number,
    max: number,
    step: number,
    unit: string,
    hint: string,
  ) => (
    <div className="flex items-center gap-2" key={key} title={hint}>
      <span className="w-14 shrink-0 pc-left-muted">{label}</span>
      <RangeField
        attrs={{ "data-pc": `frame3d-${key}` }}
        min={min}
        max={max}
        step={step}
        value={f[key]}
        onValue={(v) => patch({ [key]: v })}
        className="flex-1 min-w-0 pc-left-range"
      />
      <NumberField
        step={step}
        digits={2}
        value={f[key]}
        onCommit={(v) => patch({ [key]: v })}
        className="w-16 pc-left-input is-sm"
      />
      <span className="w-6 shrink-0 pc-left-faint">{unit}</span>
    </div>
  );

  const is3D = f.rotateX !== 0 || f.rotateY !== 0 || f.translateZ !== 0;

  return (
    <div className="px-3 py-2 flex flex-col gap-2 text-xs pc-left-divider">
      <div className="flex items-center justify-between">
        <span className="font-semibold pc-left-strong">三维</span>
        <label className="flex items-center gap-1 pc-left-muted" title="整个项目一档:一个画面只有一台相机">
          <input
            data-pc="frame3d-camera"
            type="checkbox"
            className="pc-left-range"
            checked={on}
            onChange={(e) =>
              actions.setProjectMeta({ camera3dFov: e.target.checked ? (project.camera3dFov ?? DEFAULT_FOV_DEG) : undefined })
            }
          />
          <span>透视相机</span>
        </label>
      </div>

      {/*
        没开相机却已经拧了旋钮 —— 这是最容易让人以为"功能坏了"的状态:
        画面确实变了(仿射斜切),但没有近大远小。所以直接说破,并给一个一键打开。
      */}
      {!on && is3D && (
        <button
          type="button"
          onClick={() => actions.setProjectMeta({ camera3dFov: DEFAULT_FOV_DEG })}
          className="text-left text-[11px] leading-relaxed text-amber-400/90 bg-amber-500/10 border border-amber-500/25 rounded px-2 py-1"
        >
          相机没开,现在只是把卡斜切了一下,没有近大远小 —— 点这里打开透视。
        </button>
      )}

      {row("绕横轴", "rotateX", -180, 180, 1, "°", "正值 = 顶边往里倒、底边朝观众抬起来")}
      {row("绕纵轴", "rotateY", -180, 180, 1, "°", "正值 = 右边往里转、左边朝观众转过来")}
      {row("深度", "translateZ", -2000, 1200, 10, "px", "正值朝观众(变大),负值往里(变小)")}

      {on && (
        <div className="flex items-center gap-2 pc-left-muted" title="越小透视越弱(接近正交),越大越夸张。相机距离由它和画幅推出来,不单独设">
          <span className="w-14 shrink-0">视角</span>
          <RangeField
            attrs={{ "data-pc": "frame3d-fov" }}
            min={MIN_FOV_DEG}
            max={MAX_FOV_DEG}
            step={1}
            value={fov}
            onValue={(v) => actions.setProjectMeta({ camera3dFov: clampFov(v) })}
            className="flex-1 min-w-0 pc-left-range"
          />
          <span className="w-16 text-right pc-left-faint">{fov}°</span>
          <span className="w-6" />
        </div>
      )}

      <div className="flex items-center justify-between text-[10px] pc-left-faint">
        <span>
          {on
            ? `相机距画面 ${Math.round(perspectivePx(stage, fov))}px`
            : "整个项目共用一台相机"}
        </span>
        {is3D && (
          <button type="button" onClick={() => patch(RESET)} className="pc-left-link">
            归零
          </button>
        )}
      </div>

      {/*
        深度推过头会越过相机 —— 那时画面上这张卡会涨到占满整幅甚至更大,
        看起来像"炸了"。与其让人自己猜,不如在越界时直接说。
      */}
      {on && f.translateZ >= perspectivePx(stage, fov) && (
        <div className="text-[11px] leading-relaxed text-rose-400/90">
          深度已经越过相机({Math.round(perspectivePx(stage, fov))}px),这张卡跑到镜头后面去了。往回拉小一点。
        </div>
      )}
    </div>
  );
}

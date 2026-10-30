/**
 * 缩略图那一排里的一格:一个项目,或者第一格的「Create A New」。
 *
 * 缩略图外框固定 16:9,项目自己的画幅按比例套在框里居中 —— 这样一排的高度齐平,又一眼看得出
 * 哪个是竖屏、哪个是方屏。
 *
 * 画面:这台浏览器打开过这个项目时记下的首帧(`thumbCache.ts`);没打开过、取不到时是按 id 哈希出来的色块(`hue.ts`),
 * 不空白、不破图。画幅、时长同样是打开过才知道,不知道的不写。
 */
import type { JSX } from "react";
import { hueOf } from "./hue";
import { humanDuration, humanWhen } from "./format";
import type { Ratio, VibeProject } from "./types";

const RATIO: Record<Ratio, string> = { "16:9": "16 / 9", "9:16": "9 / 16", "1:1": "1 / 1" };
const ROLE: Record<VibeProject["role"], string> = { owned: "我创建的", joined: "我加入的", guest: "游客项目" };

export function ProjectThumb({ project, onOpen }: { project: VibeProject; onOpen: (id: string) => void }): JSX.Element {
  const hue = hueOf(project.id);
  const ratio = project.ratio ?? "16:9";
  const dur = humanDuration(project.duration);
  const when = humanWhen(project.seenAt);
  const meta = when ? `${ROLE[project.role]} · 上次打开 ${when}` : ROLE[project.role];
  return (
    <button
      type="button"
      className="ps-tile"
      data-pc="start-project-tile"
      data-project={project.id}
      data-thumb={project.thumb ? "real" : "color"}
      title={`${project.name}（${meta}）`}
      onClick={() => onOpen(project.id)}
    >
      <span className="ps-frame">
        <span
          className="ps-shot"
          style={{
            aspectRatio: RATIO[ratio],
            background: `linear-gradient(145deg, hsl(${hue} 52% 44%), hsl(${(hue + 38) % 360} 48% 26%))`,
          }}
        >
          {project.thumb ? <img className="ps-shot-img" src={project.thumb} alt="" draggable={false} /> : project.ratio ?? ""}
        </span>
        {dur && <span className="ps-badge">{dur}</span>}
      </span>
      <span className="ps-tile-name">{project.name}</span>
      <span className="ps-tile-meta">{meta}</span>
    </button>
  );
}

/**
 * 第一格恒定是它(翻到第几页都在),点了走和侧栏「新建项目」同一条路。
 *
 * 格子里那行「Create A New」已经说清这一格是干什么的,底下不再重复一句「空白画布」
 * (issue #10:游客首屏上这句话是冗余的)。项目名那一行留着,一排里的名字才对得齐。
 */
export function CreateTile({ onCreate, disabled, title }: { onCreate: () => void; disabled?: boolean; title?: string }): JSX.Element {
  return (
    <button type="button" className="ps-tile ps-tile-new" data-pc="start-create-tile" aria-label="新建项目" disabled={disabled} title={title} onClick={onCreate}>
      <span className="ps-frame">
        <span className="ps-tile-new-plus" aria-hidden="true">+</span>
        <span className="ps-tile-new-text">Create A New</span>
      </span>
      <span className="ps-tile-name">新建项目</span>
    </button>
  );
}

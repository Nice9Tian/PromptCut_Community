/**
 * 最近项目那一排缩略图。
 *
 * 一排放几个按**画面宽度**算:量一下这一条的实际宽度,除以一格的宽度加间距。窗口一变就重算
 * (ResizeObserver),所以不会出现半格或者挤成一团。第一格恒定是「Create A New」,剩下的位置
 * 给项目,多出来的用「<」「>」翻页 —— 不做横向滚动条:鼠标用户找不到它,触控板又容易误触。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { CreateTile, ProjectThumb } from "./ProjectThumb";
import type { VibeProject } from "./types";

/** 一格的宽度和间距,与 `start.css` 里 `.ps-tile` 的 flex-basis、`.ps-strip` 的 gap 对齐 */
const TILE_W = 196;
const GAP = 12;

export function ProjectRail(props: {
  title: string;
  projects: VibeProject[];
  /** 换文件夹时翻回第一页用:值变了就重头看 */
  resetKey: string;
  onCreate: () => void;
  /** 新建不可用(游客已经建过一个)时置灰,悬停说为什么 */
  createDisabled?: string | null;
  onOpen: (id: string) => void;
  /**
   * 列表还在取、取不到、没登录时这一排说什么(不显示假数据、不白屏)。
   * 不给就什么都不写 —— 「一个项目都没有」用户自己看得见,不用多一句话(issue #10)。
   */
  empty?: string;
}): JSX.Element {
  const strip = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState(5);
  const [page, setPage] = useState(0);

  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => setSlots(Math.max(2, Math.floor((el.clientWidth + GAP) / (TILE_W + GAP))));
    measure();
    // 窗口拖动、侧栏宽度变化都要跟着重算
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { setPage(0); }, [props.resetKey]);

  const perPage = Math.max(1, slots - 1); // 第一格让给 Create A New
  const pages = Math.max(1, Math.ceil(props.projects.length / perPage));
  // 窗口变宽之后每页能放更多,原来的页码可能已经越界,渲染时收回范围内
  const at = Math.min(page, pages - 1);
  const shown = props.projects.slice(at * perPage, at * perPage + perPage);

  return (
    <section className="ps-rail" data-pc="start-rail">
      <div className="ps-rail-head">
        <h2 className="ps-rail-title">{props.title}</h2>
        <span className="ps-muted" data-pc="start-rail-count">共 {props.projects.length} 个</span>
        <span className="ps-rail-spacer" />
        <span className="ps-page-at" data-pc="start-rail-page">第 {at + 1} / {pages} 页</span>
        <button
          type="button"
          className="ps-page-btn"
          data-pc="start-rail-prev"
          aria-label="上一页"
          disabled={at <= 0}
          onClick={() => setPage(at - 1)}
        >
          ‹
        </button>
        <button
          type="button"
          className="ps-page-btn"
          data-pc="start-rail-next"
          aria-label="下一页"
          disabled={at >= pages - 1}
          onClick={() => setPage(at + 1)}
        >
          ›
        </button>
      </div>
      <div className="ps-strip" ref={strip}>
        <CreateTile onCreate={props.onCreate} disabled={!!props.createDisabled} title={props.createDisabled ?? undefined} />
        {shown.map((p) => (
          <ProjectThumb key={p.id} project={p} onOpen={props.onOpen} />
        ))}
      </div>
      {/*
        空着的时候只说**用户不知道的事**(列表还在取、取不到、没登录);一个都没有本身不用再写一句
        「这里还没有项目。点第一格的『Create A New』建一个。」—— 第一格就在眼前,这句话是冗余的
        (issue #10:游客首屏上这块被指出来)。
      */}
      {props.projects.length === 0 && props.empty && (
        <p className="ps-empty" data-pc="start-rail-empty">{props.empty}</p>
      )}
    </section>
  );
}

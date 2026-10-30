import { useCallback, useEffect, useMemo, useState } from "react";
import type { CardDef } from "../../../kernel/types";
import type { PartDef } from "../../../kernel/partTypes";
import { allCards } from "../../../kernel/registry";
import { allParts } from "../../../kernel/partRegistry";
import { assetCardKind, featuredParticleIds } from "../../../cards/assets";
import { isCardVisible, loadScopes, readVisibility, usedCardIds, type CardVisibility, type ScopeEntry } from "../../cardScope";
import { useStore } from "../../../store/project";
import { CardCell } from "../CardCell";
import { PartCell } from "../PartCell";
import { ThumbTile } from "./ThumbTile";
import type { GroupData, GroupItem } from "./groups";

type AnyCard = CardDef<any>;

/**
 * 卡片库的唯一数据源:可见性三档(CardScopeBar)、归属表、按搜索词过滤、按来源分组。
 * 「动画」分区(AnimationsSection)只调一次,几个卡片组共用 —— 归属表只加载一次,筛选一改所有组一起变。
 */
export interface CardLibrary {
  vis: CardVisibility;
  setVis: (v: CardVisibility) => void;
  scopes: Record<string, ScopeEntry>;
  /** 右键改完档位后重新拉归属表 */
  reloadScopes: () => void;
  user: AnyCard[];
  magic: AnyCard[];
  native: AnyCard[];
  lottie: AnyCard[];
  particles: AnyCard[];
}

/** 按名字、说明、id 搜;素材封装卡还按标签搜:「雪花」「星空」这种词在 tags 里,不在 name / description 里 */
function cardMatches(c: AnyCard, q: string): boolean {
  if (!q) return true;
  return (
    c.name.toLowerCase().includes(q) ||
    c.description.toLowerCase().includes(q) ||
    c.id.toLowerCase().includes(q) ||
    (c.source === "asset" && (c.tags ?? []).some((t) => t.toLowerCase().includes(q)))
  );
}

/** q 是已经 trim + 小写的搜索词 */
export function useCardLibrary(q: string): CardLibrary {
  // 三档筛选。scopes 是服务端那张归属表(哪张定制卡属于哪个项目)
  const [vis, setVis] = useState<CardVisibility>(() => readVisibility());
  const [scopes, setScopes] = useState<Record<string, ScopeEntry>>({});
  useEffect(() => {
    loadScopes().then(setScopes).catch(() => {});
  }, []);
  const reloadScopes = useCallback(() => {
    loadScopes(true).then(setScopes).catch(() => {});
  }, []);

  // 归属认项目自己的 id(跟着 .proc 走),再加上「时间轴上正用着」这一条 ——
  // 以前认的是草稿 id,从桌面打开的 .proc 没有草稿 id,片子里正用着的定制卡在这里一张都看不到。
  // 用到的卡拼成字符串做依赖:项目每改一下都会换对象,卡表不必跟着每次重算
  const projectId = useStore((s) => s.project.id ?? null);
  const usedKey = useStore((s) => [...usedCardIds(s.project)].sort().join("\n"));

  const lists = useMemo(() => {
    const used = new Set(usedKey ? usedKey.split("\n") : []);
    const all = allCards()
      // 音频素材效果卡不进卡片面板:拖进去的音频素材效果卡没有 nodeId,既不出声也不出画,是个空片段。
      // 它只能经 apply_card 挂到片段上。
      .filter((c) => c.kind !== "audio")
      .filter((c) => isCardVisible(c, vis, scopes, projectId, used))
      .filter((c) => cardMatches(c, q));
    return {
      // AI 或用户现场建的卡:刚建出来的东西要立刻看得见,否则建完只有 AI 知道有这张卡
      user: all.filter((c) => c.source === "user"),
      magic: all.filter((c) => c.source === "magicui"),
      native: all.filter((c) => c.source === "native"),
      // 素材封装卡:素材目录翻译出来的 Lottie / 粒子卡(src/cards/assets),按种类分两组
      lottie: all.filter((c) => assetCardKind(c) === "lottie"),
      particles: all.filter((c) => assetCardKind(c) === "particles"),
    };
  }, [q, vis, scopes, projectId, usedKey]);

  return { vis, setVis, scopes, reloadScopes, ...lists };
}

/** 部件库:组合卡的零件。按名字、说明、id、标签搜 */
export function usePartsList(q: string): PartDef<any>[] {
  return useMemo(
    () =>
      allParts().filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          (p.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      ),
    [q],
  );
}

const THUMBS = 8;

/** 卡片没悬停时就是「名字 + 说明」,缩略也照这个样子画 */
const cardThumbs = (list: { id: string; name: string; description: string }[]): GroupItem[] =>
  list.slice(0, THUMBS).map((def) => ({ id: def.id, node: <ThumbTile name={def.name} desc={def.description} /> }));

/** 六个卡片类组的内容(定制卡片 / Magic UI / 自家卡片 / 部件库 / Lottie / 粒子背景) */
export function useCardGroups(
  lib: CardLibrary,
  parts: PartDef<any>[],
  searching: boolean,
  onUserMenu: (e: React.MouseEvent, cardId: string) => void,
): Record<string, GroupData> {
  const { user, magic, native, lottie, particles } = lib;
  return useMemo(() => {
    const cards = (list: AnyCard[]): GroupItem[] => list.map((def) => ({ id: def.id, node: <CardCell def={def} fill /> }));
    const none = (
      <div className="pc-left-note">
        {searching ? "没有匹配的卡片" : "这一组的卡片被卡片筛选藏起来了;点搜索框旁边的筛选按钮调整"}
      </div>
    );
    const featured = particles.filter((c) => featuredParticleIds.has(c.id));
    return {
      "user-cards": {
        items: user.map((def) => ({
          id: def.id,
          // 右键换档:项目素材 ⇄ 自定义素材(见 UserCardMenu,菜单本身由分区常驻渲染)
          node: (
            <div className="pc-lib-fill" onContextMenu={(e) => onUserMenu(e, def.id)}>
              <CardCell def={def} fill />
            </div>
          ),
        })),
        thumbs: cardThumbs(user),
        emptyDetail: none,
      },
      magicui: { items: cards(magic), thumbs: cardThumbs(magic), emptyDetail: none },
      native: { items: cards(native), thumbs: cardThumbs(native), emptyDetail: none },
      parts: {
        items: parts.map((def) => ({ id: def.id, node: <PartCell def={def} fill /> })),
        thumbs: cardThumbs(parts),
        emptyDetail: <div className="pc-left-note">{searching ? "没有匹配的部件" : "部件库是空的"}</div>,
      },
      lottie: { items: cards(lottie), thumbs: cardThumbs(lottie), emptyDetail: none },
      // 粒子卡多(五十多种):总览只露精选,详情和计数都是全部;搜索时精选里没命中就露命中的前几个
      particles: { items: cards(particles), thumbs: cardThumbs(featured.length ? featured : particles), emptyDetail: none },
    };
  }, [user, magic, native, lottie, particles, parts, searching, onUserMenu]);
}

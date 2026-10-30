import { useEffect, useMemo, useState, type RefObject } from "react";
import { measureAcrossTime, type Box } from "../../render/contentBox";
import { lookupBox, rememberBox } from "./previewBoxes";
import { startPrewarm } from "./prewarmBoxes";
import { getState } from "../../store/project";

/**
 * 预览卡的缩放:按动效**跑完整段**时内容最大的包围盒来缩。
 *
 * 盒子有两层来源(previewBoxes.ts):
 *   1. **已经算好的**:随包发的静态表(`src/cards/preview-boxes.json`)或本机缓存 ——
 *      悬停时直接拿来用,一步到位,没有测量跑、没有黑屏;
 *   2. **现场量**:表里没有(用户 / AI 新建的卡、刚加的部件、静态表还没生成)就退回
 *      这里的 DOM 测量:先藏着舞台(opacity 0)挂上去,等动画建好之后把里面的
 *      Web Animations 逐档拨过去量并集,量完存进缓存、推近视野、从头正常播一遍。
 *
 * 另外第一次用到这个 hook(= 第一次打开卡片页)会顺手启动后台补量(prewarmBoxes.tsx),
 * 把表里缺的卡片在屏幕外慢慢算完,之后就都走第 1 条路了。
 */
export interface PreviewZoom {
  /** 用来缩放的盒子;null = 内容铺满整幅,按整幅显示 */
  box: Box | null;
  /** 正在测量跑:舞台藏起来 */
  measuring: boolean;
  /** 每次重播 +1,用它做 key 重挂载 */
  token: number;
}

const MAX_MEASURE_MS = 4000;
/** 挂上去之后等动画建好再量;motion 在挂载后的下一帧才创建 Web Animations */
const SETTLE_DELAY_MS = 80;

/** 卡片源码热更新之后想重量:previewBoxes 的 forgetBoxes 丢缓存,再刷新页面 */
export { forgetBoxes as invalidatePreviewZoom } from "./previewBoxes";

export function usePreviewZoom(key: string, stageRef: RefObject<HTMLElement | null>, hot: boolean, animMs: number): PreviewZoom {
  const [measured, setMeasured] = useState<{ key: string; box: Box | null } | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [token, setToken] = useState(0);
  const { width, height } = getState().project;

  // 渲染时就查一次表:等 effect 跑完再套盒子的话,第一帧会先按整幅画出来,肉眼能看见一下跳变
  const known = useMemo(() => lookupBox(key, width, height), [key, width, height, measured]);

  // 第一次有格子用到预览 = 卡片页开了,顺手把后台补量支起来
  useEffect(() => { startPrewarm(); }, []);

  useEffect(() => {
    if (!hot) return;
    setToken((n) => n + 1);

    // 算好过了(静态表 / 本机缓存 / 这次会话早先量的):直接用,不再量
    if (lookupBox(key, width, height).has) {
      setMeasuring(false);
      return;
    }

    // 没算过:现场量一遍
    setMeasuring(true);
    const total = Math.min(MAX_MEASURE_MS, Math.max(400, animMs) + 300);
    const timer = window.setTimeout(() => {
      const stage = stageRef.current;
      let union: Box | null = null;
      try {
        union = stage ? measureAcrossTime(stage, total) : null;
      } catch {
        union = null; // 量炸了就按整幅,别把预览卡住
      }
      rememberBox(key, width, height, union);
      setMeasured({ key, box: union });
      setMeasuring(false);
      // 量完从头正常速度再播一遍
      setToken((n) => n + 1);
    }, SETTLE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [hot, key, animMs, stageRef, width, height]);

  return { box: measured?.key === key ? measured.box : known.box, measuring, token };
}

/** 有盒子就推到盒子(留一圈边),没有就整幅;返回舞台该放的位置和比例 */
export function zoomFor(box: Box | null, view: { w: number; h: number }, stage: { width: number; height: number }, pad = 0.1) {
  const fullScale = view.w && view.h ? Math.min(view.w / stage.width, view.h / stage.height) : 1;
  let scale = fullScale;
  let left = (view.w - stage.width * scale) / 2;
  let top = (view.h - stage.height * scale) / 2;
  if (box) {
    const bw = Math.max(1, box.r - box.l);
    const bh = Math.max(1, box.b - box.t);
    scale = Math.min(view.w / (bw * (1 + pad * 2)), view.h / (bh * (1 + pad * 2)));
    // 别推得比整幅还远(盒子量错成一大片时退回整幅),也别放大到糊成马赛克
    scale = Math.max(fullScale, Math.min(scale, 2));
    const cx = (box.l + box.r) / 2;
    const cy = (box.t + box.b) / 2;
    left = view.w / 2 - cx * scale;
    top = view.h / 2 - cy * scale;
  }
  return { scale, left, top };
}

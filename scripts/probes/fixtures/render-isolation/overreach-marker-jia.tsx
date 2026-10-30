/**
 * 越权探测卡的配套夹具：**只有项目甲才有**的一张用户卡（测试夹具，防御性测试，不是攻击代码）。
 *
 * 它什么都不探，只在模块顶层留一个记号（一段假凭证形状的占位字符串，探针知道它）。隔离探针用它验「渲完甲换去渲乙时，
 * 乙的页面里不存在甲的卡片代码」：乙的越权探测卡在自己的页面里找这个记号、试着取这个文件，都不该得到。
 */
import type { CardDef } from "../../kernel/types";

const G = globalThis as any;
G.__pcOverreachLoaded = { ...(G.__pcOverreachLoaded ?? {}), "marker-jia": "PROBE-FAKE-JIA-CARD-CODE-7d1f0c" };

function MarkerJia() {
  return <div className="absolute inset-0 grid place-items-center text-white text-4xl">项目甲的记号卡</div>;
}

export const overreachMarkerJia: CardDef<Record<string, never>> = {
  id: "overreach-marker-jia",
  name: "项目甲的记号卡",
  description: "隔离验收用的测试夹具：只有项目甲才有的卡片代码",
  tags: ["探针"],
  frameMode: "stateful",
  defaults: {},
  controls: [],
  Component: MarkerJia,
};

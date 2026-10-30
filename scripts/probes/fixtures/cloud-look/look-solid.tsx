/**
 * 「云端 Agent 看画面」探针的测试夹具（`scripts/probes/cloud-agent-look-probe.mjs`）：一张把整个舞台涂成一种颜色的用户卡。
 *
 * 探针让云端 Agent 用 `create_card` 把它建进项目的内容库、放上时间轴，再 `see_frames`：画面中心的像素就是 `color` 参数的颜色，
 * 据此断言「拿到的是这一版项目、这张用户卡渲出来的样子」。它什么都不探、不发任何请求。
 */
import type { CardDef, CardProps } from "../../kernel/types";

type P = { color: string };

function LookSolid({ params }: CardProps<P>) {
  return <div className="absolute inset-0" style={{ background: params.color }} />;
}

export const lookSolid: CardDef<P> = {
  id: "look-solid",
  name: "看画面探针的纯色卡",
  description: "测试夹具：整个舞台涂成 color 参数的颜色",
  tags: ["探针"],
  frameMode: "stateful",
  defaults: { color: "#ff0000" },
  controls: [{ key: "color", label: "颜色", type: "color" }],
  Component: LookSolid,
};

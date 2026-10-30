/**
 * 越权探测卡的配套夹具：Node 一侧处理脚本时的读盘尝试（测试夹具，防御性测试，不是攻击代码；
 * 定义见 `docs/plan/sound-online-render-task.md`「越权探测卡」一节）。
 *
 * 脚本由工作进程里的 Vite 在 Node 一侧转译、解析导入。这份文件把「让 Node 一侧去读或去列工作目录以外的文件」的几种写法各写一条，
 * 指向探针放了假凭证（`PROBE-FAKE-…`）的测试文件（`__OUTSIDE__` 由探针换成那个文件的绝对路径、`__OUTSIDE_REL__` 换成从用户卡目录
 * 走到它的相对路径）。只读：没有任何一条会写、会删、会执行别的程序。它也被样式夹具当作构建插件点名（`@plugin`），所以顶层留一个
 * 「在 Node 里被执行过」的记号文件名——只在被当成插件载入时才会有 `process`；探针核对这个记号**没有**出现。
 * 预期：托管方渲染服务的同步文件预检拒掉整份文件（不装、不交给 Vite）。
 */
import outsideRaw from "__OUTSIDE_REL__?raw";
import outsideUrl from "/@fs/__OUTSIDE__?url";

export const outsideGlob = import.meta.glob("__OUTSIDE_DIR_REL__/**/*", { query: "?raw", eager: true });
export const outsideNames = import.meta.glob("/../../**/*.json");
export const outsideAsset = new URL("__OUTSIDE_REL__", import.meta.url).href;
export const outsideDynamic = (name: string) => import(`__OUTSIDE_DIR_REL__/${name}.json`);
export const outside = { outsideRaw, outsideUrl };

// 只有被当成构建插件在 Node 里载入时才成立（浏览器里没有 process）：只报告「被执行过」，不读不写别的东西
const g = globalThis as any;
if (typeof g.process?.versions?.node === "string") console.log("OVERREACH-NODE-SIDE-EXECUTED PROBE-FAKE-NODE-EXEC-MARK");

export default function overreachNodeSidePlugin() { return { handler() {} }; }

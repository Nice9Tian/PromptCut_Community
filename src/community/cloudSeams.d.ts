/*
 * 浏览器侧云端扩展包别名的类型契约。
 *
 * 这几个说明符由 `server/vite-plugin-cloud-seams.ts` 在构建时解析：有闭源目录就指到那边的加载表，
 * 没有就指到 `./cloudSeamStub.ts`（什么都不导出）。两个仓库里这个文件逐字一致，所以**它就是
 * 两侧共同认的那份接口**：闭源侧的加载表要按这里声明的形状导出，公开侧的加载点按这里的形状调用。
 *
 * 都声明成可选（`?`）是故意的：空桩一个都不导出，所以加载点必须先判「在不在」再调。
 * 第七节那四道闸门管不住形状（G4 只验「表能被同步 require 进来、有 default 或 manifest 导出」），
 * 这份声明是目前唯一把形状写下来的地方 —— 改了闭源侧加载表的签名，就要改这里。
 */
declare module "#promptcut-cloud-ai" {
  /** 云端 AI 提供方的加载表，交给 `src/ai/extensions.ts` 的 `applyAiManifest` 归一化并登记 */
  export const manifest: readonly unknown[] | undefined;
  const fallback: readonly unknown[] | undefined;
  export default fallback;
}

declare module "#promptcut-cloud-account" {
  /** 注册网站账号扩展（`registerAccountExtensions` 等），由 `cloud/account/manifest.ts` 导出 */
  export const register: (() => Promise<void> | void) | undefined;
}

declare module "#promptcut-cloud-account-ui" {
  /** 注册账号相关的 UI 扩展（含 JSX），由 `cloud/account/ui-manifest.tsx` 导出 */
  export const registerUi: (() => Promise<void> | void) | undefined;
}

declare module "#promptcut-cloud-online" {
  /** 在线构建的贯穿型接缝表（buildInfo / apiGuard / updateCheck / UpdateNotice / 同步后端） */
  export const manifest: Record<string, unknown> | undefined;
  const fallback: Record<string, unknown> | undefined;
  export default fallback;
}

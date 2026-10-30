import { Component, type ReactNode } from "react";
import { noteCardRenderError } from "./cardTrouble";

/**
 * 运行时载入的卡(在线浏览器里执行的同步来的用户卡与素材效果卡)的错误边界:组件渲染时抛错不带垮整个舞台,
 * 这张卡记 `runtime-error`(`cardTrouble.ts`),舞台随后把它撤下、退回原做法(`docs/plan/online-card-exec-contract.md` 第 8 节)。
 * 只包运行时载入的卡:构建时就有的卡(桌面的全部卡、在线包自带的卡)不包,React 树与以前逐字相同。
 */
export class RuntimeCardBoundary extends Component<{ cardId: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { noteCardRenderError(this.props.cardId, error); }
  render() { return this.state.failed ? null : this.props.children; }
}

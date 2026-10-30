/**
 * 「这次打开项目，新认定了哪些素材确认缺失」的通知，界面据此弹一次窗口列出来（`MissingMaterialsDialog.tsx`）。
 * 认定在 `mediaUpload.ts`（打开本机项目后的后台检查）；这里只传话，不判断。
 */
export interface MissingMaterialNotice {
  id: string;
  /** 原素材的显示名（不带「(缺失) 」标记） */
  name: string;
  kind: "video" | "audio" | "image";
  /** 原位置上有文件，但内容已经不是原来那一份（内容哈希对不上） */
  changed?: boolean;
}

let pending: MissingMaterialNotice[] = [];
const listeners = new Set<() => void>();

export function publishMissingMaterials(items: MissingMaterialNotice[]): void {
  if (!items.length) return;
  const seen = new Set(pending.map((item) => item.id));
  pending = [...pending, ...items.filter((item) => !seen.has(item.id))];
  for (const listener of [...listeners]) { try { listener(); } catch { /* 一个订阅者出错不挡别的 */ } }
}
export function takeMissingMaterials(): MissingMaterialNotice[] { const out = pending; pending = []; return out; }
export function onMissingMaterials(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}

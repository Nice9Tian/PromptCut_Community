export const CARD_RUNTIME_ABI: number;
export const CARD_KINDS: string[];
export const CARD_ADAPTERS: string[];
export interface UnifiedCardDefinition {
  id: string; name?: string; language: 'tsx' | 'builtin';
  kind: 'animation' | 'filter' | 'transition' | 'emphasis' | 'audio';
  entry?: string; source?: string; defaults?: Record<string, unknown>;
  need_prerendering?: boolean; compositing?: import('./frameMode.mjs').CardCompositing;
  styleKeys?: string[] | null;
}
export interface CardInput { nodeId: string; offset?: number; rate?: number }
export interface CardNode {
  id: string; adapter: 'card' | 'chrome' | 'media' | 'filter' | 'audio' | 'emphasis' | 'transition';
  /** 素材效果卡节点指向 src/cards/user/<id>.tsx 的那张卡 */
  cardId?: string;
  /** 定义里的 kind 抄进节点:Node 侧脚本读不到 TSX 定义,只能看节点 */
  kind?: string;
  /** validateCardGraph 丢掉的悬空 `@clip/` 输入名(片段被删了) */
  missingInputs?: string[];
  definitionId?: string; params?: Record<string, unknown>; inputs?: Record<string, CardInput | string>;
  [key: string]: unknown;
}
export function cardJson(value: unknown): string;
export function normalizeCardDefinition(raw: unknown): UnifiedCardDefinition;
export function selectedCardStyle(definition: UnifiedCardDefinition, style?: Record<string, unknown>): Record<string, unknown>;
export function normalizeCardInput(input: CardInput | string): Required<CardInput>;
export function validateCardGraph(raw: unknown): { nodes: CardNode[]; outputs: any[]; levels: string[][] };
export function projectCardGraph(project: any, getLegacyCard?: (id: string) => any): { abi: number; nodes: CardNode[]; outputs: any[]; levels: string[][] };

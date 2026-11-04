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
  /** Media effect card node pointing to that card in src/cards/user/<id>.tsx */
  cardId?: string;
  /**
   * Copy kind from definition into node: Node-side scripts cannot read TSX definitions and can only
   * inspect nodes
   */
  kind?: string;
  /** Dangling `@clip/` input names dropped by validateCardGraph (clip was deleted) */
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

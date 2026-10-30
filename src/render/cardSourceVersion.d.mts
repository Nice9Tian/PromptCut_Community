import type { CardDef } from '../kernel/types';
export function normalizeEol(text: string): string;
export function cardSourceVersion(card: Pick<CardDef, 'id' | 'defaults' | 'controls' | 'lifecycle' | 'frameMode' | 'need_prerendering' | 'compositing'>, files: Record<string, string>, entryPath?: string): string;

import type { Project, TrackClip, MediaAsset } from './project';
import type { CardDef } from './types';
export interface CardAudioIdentity { cardId: string; sourceVersion: string; defaults: Record<string, unknown>; params: Record<string, unknown>; inputs: Record<string, any>; timeOffset?: number }
export interface CardAudioRendition { version: 1; mediaId: string; cardId: string; sourceKey: string; sourceOffset: number; duration: number; sampleRate: 48000; frames: number; channels: number; identity: CardAudioIdentity }
export interface CardAudioIdentityHooks { getCard?: (id: string) => CardDef<any> | undefined; sourceVersionOf?: (id: string) => string | undefined }
export function isAudiovisualCard(def: unknown): boolean;
export function assertAudiovisualCardKind(def: unknown): void;
export function clipHasEmbeddedAudio(project: Pick<Project, 'cardNodes'>, clip: Partial<TrackClip>, getCard?: (id: string) => CardDef<any> | undefined): boolean;
export function clipHasAudio(project: Pick<Project, 'cardNodes' | 'media'>, clip: Partial<TrackClip>, getCard?: (id: string) => CardDef<any> | undefined): boolean;
export function clipHasCardAudio(project: Pick<Project, 'cardNodes'>, clip: Partial<TrackClip>, getCard?: (id: string) => CardDef<any> | undefined): boolean;
export function clipGoesSilentBySpeed(project: Pick<Project, 'cardNodes' | 'media'>, clip: Partial<TrackClip>, getCard?: (id: string) => CardDef<any> | undefined): boolean;
export function cardAudioSourceOffset(project: Pick<Project, 'cardNodes'>, clip: Partial<TrackClip>): number;
export class CardAudioRenditionError extends Error { code: 'missing' | 'stale' }
export function cardAudioIdentity(project: Project, clip: TrackClip, hooks?: CardAudioIdentityHooks, saved?: CardAudioIdentity): CardAudioIdentity;
export function resolveCardAudioRendition(project: Project, clip: TrackClip, hooks?: CardAudioIdentityHooks): { media: MediaAsset; offset: number; rendition: CardAudioRendition };

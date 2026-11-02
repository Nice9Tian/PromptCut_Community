/**
 * Types for `server/qr.mjs` (imported directly on the page side to render QR codes: invite QR code
 * in collaboration settings, "Open on phone").
 * The implementation is zero-dependency pure JS; only the two used exports are declared here.
 */

export type QrEcLevel = "L" | "M" | "Q" | "H";

export interface QrOptions {
  /** Error correction level, defaults to `M` */
  ec?: QrEcLevel;
  /** Quiet zone module count, defaults to 4 */
  quiet?: number;
  /** Pixels per module, defaults to 6 */
  scale?: number;
  /** Dark color, defaults to `#000` */
  dark?: string;
  /** Light color, defaults to `#fff` */
  light?: string;
}

/** Encodes into a boolean matrix (`true` = dark module) */
export function encodeQr(text: string, opts?: { ec?: QrEcLevel; mask?: number | null }): boolean[][];

/** Directly outputs an SVG string */
export function qrSvg(text: string, opts?: QrOptions): string;

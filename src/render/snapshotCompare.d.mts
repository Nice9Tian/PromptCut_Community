export const NUMBER_RELATIVE_TOLERANCE: number;
export const NUMBER_ABSOLUTE_FLOOR: number;

export type HtmlToken =
  | { kind: 'text'; text: string }
  | { kind: 'comment'; text: string }
  | { kind: 'open'; name: string; attrs: Map<string, string>; selfClosing: boolean }
  | { kind: 'close'; name: string };

export function tokenizeHtml(html: string): HtmlToken[];

export function numbersClose(a: number, b: number, tolerance?: number): boolean;

export function valuesCloseEnough(a: string, b: string, tolerance?: number): boolean;

export interface SnapshotCompareResult {
  same: boolean;
  /** For diagnostics and reports; does not participate in determination */
  reason?: string;
  at?: number;
  expected?: string;
  actual?: string;
}

export function compareSnapshotHtml(a: string, b: string, opts?: { tolerance?: number }): SnapshotCompareResult;

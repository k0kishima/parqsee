import { RowData } from './row';
import { formatCellValue } from './format';

/**
 * Column width estimation for the virtualized data table.
 *
 * With only the visible columns rendered, the browser can no longer size
 * columns from their content, so widths are computed up front from the
 * header text and the values on the current page. Header text is measured
 * with the real font; cell values are rendered monospaced, so their width is
 * the number of grid cells they occupy times one glyph width — two cells for
 * an ideograph, a fullwidth form or an emoji, none for a combining mark.
 */

export const CELL_HORIZONTAL_PADDING = 32; // px-4 on both sides
export const MIN_COLUMN_WIDTH = 64;
export const MAX_COLUMN_WIDTH = 480;

interface MeasureFonts {
  header: string;
  type: string;
  mono: string;
  sans: string;
}

let canvasContext: CanvasRenderingContext2D | null | undefined;

function getContext(): CanvasRenderingContext2D | null {
  if (canvasContext === undefined) {
    canvasContext = typeof document !== 'undefined'
      ? document.createElement('canvas').getContext('2d')
      : null;
  }
  return canvasContext;
}

function resolveFonts(): MeasureFonts {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const rootStyle = root ? getComputedStyle(root) : null;
  const sans = rootStyle?.getPropertyValue('--font-sans').trim() || 'ui-sans-serif, system-ui, sans-serif';
  const mono = rootStyle?.getPropertyValue('--font-mono').trim() || 'ui-monospace, SFMono-Regular, Menlo, monospace';
  return {
    header: `600 14px ${sans}`, // text-sm font-semibold
    type: `12px ${sans}`,       // text-xs
    mono: `12px ${mono}`,       // font-mono text-xs
    sans: `14px ${sans}`,       // text-sm
  };
}

function textWidth(ctx: CanvasRenderingContext2D | null, font: string, text: string): number {
  if (!ctx) return text.length * 8; // jsdom and friends: rough estimate
  ctx.font = font;
  return ctx.measureText(text).width;
}

export interface ColumnWidthInput {
  name: string;
  /** Second header line (type label); may be empty. */
  typeLabel: string;
}

export interface MeasureOptions {
  /** Must produce the same text the cells render (null for NULL).
   * Defaults to `formatCellValue`, which is what both grids pass — a local
   * fallback here used to stringify a nested column as "[object Object]"
   * and size it several characters too narrow. */
  format?: (value: unknown) => string | null;
  /** Font the cell values are rendered in. Values are not measured one by
   * one; an average glyph width for the font is multiplied by the cells the
   * value occupies. */
  valueFont?: 'mono' | 'sans';
  /** Width in px the header carries beside its text (a button), if any. */
  headerExtra?: number;
}

const SAMPLE = '0123456789.-abcdefghijklmnopqrstuvwxyz_';

/**
 * Characters a monospaced font draws two cells wide: East Asian Wide and
 * Fullwidth, approximated by the blocks that are entirely one or the other,
 * plus the pictographs. Halfwidth kana (U+FF61-U+FF9F) are deliberately left
 * out — they are Halfwidth, one cell, and sit between two of the ranges here.
 */
const WIDE = /^(?:\p{Extended_Pictographic}|[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{20000}-\u{3FFFD}])$/u;

/** Marks are drawn over the character before them and take no cell. */
const COMBINING = /^\p{M}$/u;

/**
 * How many cells of a monospaced grid `text` occupies. A cell is the width of
 * one digit; an ideograph, a fullwidth form or an emoji takes two of them and
 * a combining mark takes none. Counting characters instead measured a column
 * of Japanese strings at half its width, and every cell was ellipsised.
 */
export function displayCells(text: string): number {
  let cells = 0;
  for (const ch of text) { // by code point, so an astral character counts once
    if (COMBINING.test(ch)) continue;
    cells += WIDE.test(ch) ? 2 : 1;
  }
  return cells;
}

/** The width in px a cell showing `text` needs, before padding. */
export function estimateCellWidth(text: string, charWidth: number): number {
  return displayCells(text) * charWidth;
}

/**
 * Whether a cell showing `text` can be clipped by a column `width` px wide.
 *
 * Called for every rendered cell, so it opens with the bound the character
 * count gives — no character is wider than two cells — and only walks the
 * text when that bound leaves the question open.
 */
export function cellOverflows(text: string, charWidth: number, width: number): boolean {
  if (text.length * 2 * charWidth + CELL_HORIZONTAL_PADDING <= width) return false;
  return estimateCellWidth(text, charWidth) + CELL_HORIZONTAL_PADDING > width;
}

/**
 * Width in px of one grid cell in the font the values are rendered in. The
 * grids ask for it once per render and size their cells from it, rather than
 * measuring every value against the canvas.
 */
export function measureCharWidth(valueFont: 'mono' | 'sans'): number {
  const ctx = getContext();
  const fonts = resolveFonts();
  return valueFont === 'mono'
    ? textWidth(ctx, fonts.mono, '0') || 7.2
    : (textWidth(ctx, fonts.sans, SAMPLE) || SAMPLE.length * 7.5) / SAMPLE.length;
}

/**
 * Width in px for each column: the widest of the header name, the type label
 * and any value on the page, plus cell padding, clamped to a sane range.
 */
export function measureColumnWidths(
  columns: ColumnWidthInput[],
  rows: RowData[],
  { format = formatCellValue, valueFont = 'mono', headerExtra = 0 }: MeasureOptions = {}
): number[] {
  const ctx = getContext();
  const fonts = resolveFonts();
  const charWidth = measureCharWidth(valueFont);

  const maxCells = new Array<number>(columns.length).fill(4); // "NULL"
  for (const row of rows) {
    for (let c = 0; c < columns.length; c++) {
      const text = format(row[columns[c].name]);
      if (text === null) continue;
      const cells = displayCells(text);
      if (cells > maxCells[c]) maxCells[c] = cells;
    }
  }

  return columns.map((col, c) => {
    const content = Math.max(
      textWidth(ctx, fonts.header, col.name) + headerExtra,
      col.typeLabel ? textWidth(ctx, fonts.type, col.typeLabel) + headerExtra : 0,
      maxCells[c] * charWidth
    );
    const width = Math.ceil(content) + CELL_HORIZONTAL_PADDING + 1; // +1 for border-r
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width));
  });
}

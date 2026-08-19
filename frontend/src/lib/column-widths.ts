/**
 * Column width estimation for the virtualized data table.
 *
 * With only the visible columns rendered, the browser can no longer size
 * columns from their content, so widths are computed up front from the
 * header text and the values on the current page. Header text is measured
 * with the real font; cell values are rendered monospaced, so their width is
 * just the character count times one glyph width.
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

const defaultFormat = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

export interface MeasureOptions {
  /** Must produce the same text the cells render (null for NULL). */
  format?: (value: unknown) => string | null;
  /** Font the cell values are rendered in. Values are not measured one by
   * one; an average glyph width for the font is multiplied by the length. */
  valueFont?: 'mono' | 'sans';
}

const SAMPLE = '0123456789.-abcdefghijklmnopqrstuvwxyz_';

/**
 * Width in px for each column: the widest of the header name, the type label
 * and any value on the page, plus cell padding, clamped to a sane range.
 */
export function measureColumnWidths(
  columns: ColumnWidthInput[],
  rows: Record<string, unknown>[],
  { format = defaultFormat, valueFont = 'mono' }: MeasureOptions = {}
): number[] {
  const ctx = getContext();
  const fonts = resolveFonts();
  const charWidth = valueFont === 'mono'
    ? textWidth(ctx, fonts.mono, '0') || 7.2
    : (textWidth(ctx, fonts.sans, SAMPLE) || SAMPLE.length * 7.5) / SAMPLE.length;

  const maxChars = new Array<number>(columns.length).fill(4); // "NULL"
  for (const row of rows) {
    for (let c = 0; c < columns.length; c++) {
      const text = format(row[columns[c].name]);
      if (text === null) continue;
      if (text.length > maxChars[c]) maxChars[c] = text.length;
    }
  }

  return columns.map((col, c) => {
    const content = Math.max(
      textWidth(ctx, fonts.header, col.name),
      col.typeLabel ? textWidth(ctx, fonts.type, col.typeLabel) : 0,
      maxChars[c] * charWidth
    );
    const width = Math.ceil(content) + CELL_HORIZONTAL_PADDING + 1; // +1 for border-r
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width));
  });
}

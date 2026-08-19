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

/**
 * Width in px for each column: the widest of the header name, the type label
 * and any value on the page, plus cell padding, clamped to a sane range.
 */
export function measureColumnWidths(
  columns: ColumnWidthInput[],
  rows: Record<string, unknown>[]
): number[] {
  const ctx = getContext();
  const fonts = resolveFonts();
  const monoCharWidth = textWidth(ctx, fonts.mono, '0') || 7.2;

  const maxChars = new Array<number>(columns.length).fill(4); // "NULL"
  for (const row of rows) {
    for (let c = 0; c < columns.length; c++) {
      const value = row[columns[c].name];
      if (value === null || value === undefined) continue;
      const len = String(value).length;
      if (len > maxChars[c]) maxChars[c] = len;
    }
  }

  return columns.map((col, c) => {
    const content = Math.max(
      textWidth(ctx, fonts.header, col.name),
      col.typeLabel ? textWidth(ctx, fonts.type, col.typeLabel) : 0,
      maxChars[c] * monoCharWidth
    );
    const width = Math.ceil(content) + CELL_HORIZONTAL_PADDING + 1; // +1 for border-r
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width));
  });
}

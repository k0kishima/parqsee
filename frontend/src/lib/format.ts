const FILE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

/**
 * Format a byte count for display (e.g. 1024 -> "1.0 KB").
 * Returns an empty string for undefined or zero so callers can omit the label.
 */
export function formatFileSize(size?: number | null): string {
  if (!size) return '';
  let i = 0;
  let formattedSize = size;
  while (formattedSize >= 1024 && i < FILE_SIZE_UNITS.length - 1) {
    formattedSize /= 1024;
    i++;
  }
  return `${formattedSize.toFixed(1)} ${FILE_SIZE_UNITS[i]}`;
}

/**
 * Render a cell value the way the grids display it. Nested columns
 * (LIST / MAP / STRUCT) arrive as arrays and objects, which would otherwise
 * stringify to "[object Object]". Returns null for an absent value so callers
 * can render their own NULL marker.
 */
export function formatCellValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const FILE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

/**
 * Format a byte count for display (e.g. 1024 -> "1.0 KB").
 * Returns an empty string for undefined or zero so callers can omit the label.
 */
export function formatFileSize(size?: number): string {
  if (!size) return '';
  let i = 0;
  let formattedSize = size;
  while (formattedSize >= 1024 && i < FILE_SIZE_UNITS.length - 1) {
    formattedSize /= 1024;
    i++;
  }
  return `${formattedSize.toFixed(1)} ${FILE_SIZE_UNITS[i]}`;
}

export function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
}

export const PARQUET_EXTENSION = 'parquet';

// Case-sensitive, matching the backend's `is_parquet` check. Extension
// stripping below stays case-insensitive, as it was at its only call site.
export function isParquetPath(filePath: string): boolean {
  return filePath.endsWith(`.${PARQUET_EXTENSION}`);
}

export function stripParquetExtension(filePath: string): string {
  return filePath.replace(new RegExp(`\\.${PARQUET_EXTENSION}$`, 'i'), '');
}

export function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
}

export const PARQUET_EXTENSION = 'parquet';

// Case-insensitive, matching the backend's `is_parquet` check.
export function isParquetPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(`.${PARQUET_EXTENSION}`);
}

export function stripParquetExtension(filePath: string): string {
  return filePath.replace(new RegExp(`\\.${PARQUET_EXTENSION}$`, 'i'), '');
}

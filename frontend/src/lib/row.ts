/**
 * One row of a grid: cell values keyed by column name.
 *
 * Both grids and everything that measures or searches them read rows this
 * way. The values are `unknown` on purpose: `batches_to_rows` on the Rust
 * side has already rendered whatever the webview cannot represent (decimals,
 * non-finite floats, integers past 2^53) as a string, so the only thing the
 * frontend may do with a cell is hand it to `formatCellValue`.
 */
export type RowData = Record<string, unknown>;

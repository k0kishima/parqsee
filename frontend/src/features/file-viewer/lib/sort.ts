import type { ColumnInfo } from '../../../bindings/ipc/ColumnInfo';
import type { SortSpec } from '../../../bindings/ipc/SortSpec';

/**
 * Whether the header offers to sort by this column. Nested values (lists,
 * structs, maps) and the types with no order (intervals) are left out; the
 * backend's `is_sortable` refuses the same kinds, so what the header offers
 * always runs — and a kind only one of the two learned about would either
 * hide a sort that works or offer one the backend rejects.
 * `contracts/sortable-kinds-cases.json` is the shared list both are tested
 * against, and it has to name every kind for either side to ship it.
 */
export function isSortableColumn(column: Pick<ColumnInfo, 'kind'>): boolean {
  return column.kind !== 'nested' && column.kind !== 'other';
}

/**
 * The sort after a click on `column`'s header: a column not sorted by
 * starts ascending, a second click turns it descending, a third goes back
 * to file order. Clicking another column starts over ascending on it.
 */
export function nextSort(current: SortSpec | null, column: string): SortSpec | null {
  if (current?.column !== column) return { column, direction: 'asc' };
  if (current.direction === 'asc') return { column, direction: 'desc' };
  return null;
}

import React, { useEffect, useMemo, RefObject } from 'react';
import type { ColumnInfo } from '../api';
import type { TypeDisplay } from '../../../lib/settings-storage';
import { useColumnVirtualizer } from '../../../hooks/useVirtualRange';
import { measureColumnWidths, MAX_COLUMN_WIDTH } from '../../../lib/column-widths';

export interface SearchMatch {
  /** -1 for a column header match. */
  rowIndex: number;
  colIndex: number;
  value: string;
}

interface DataTableProps {
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  selectedRow: number | null;
  onSelectRow: (rowIndex: number) => void;
  searchTerm: string;
  searchMatches: SearchMatch[];
  currentMatchIndex: number;
  typeDisplay: TypeDisplay;
  /** The horizontally/vertically scrolling container; owned by the parent. */
  scrollerRef: RefObject<HTMLDivElement>;
}

interface VisibleColumn {
  index: number;
  name: string;
  /** True when the column hit the width cap, so values may be clipped. */
  mayTruncate: boolean;
}

const stripPhysical = (physicalType: string) =>
  physicalType.replace('PhysicalType(', '').replace(')', '');

export function formatTypeLabel(col: ColumnInfo, typeDisplay: TypeDisplay): string {
  if (typeDisplay === 'both' && col.logical_type) {
    return `${col.logical_type} / ${stripPhysical(col.physical_type)}`;
  }
  if (typeDisplay === 'physical') {
    return stripPhysical(col.physical_type);
  }
  return col.logical_type || stripPhysical(col.physical_type);
}

/** Wrap the first case-insensitive occurrence of the search term in a highlight. */
function highlight(text: string, searchTerm: string): React.ReactNode {
  if (!searchTerm || !text) return text;
  const index = text.toLowerCase().indexOf(searchTerm.toLowerCase());
  if (index === -1) return text;
  return (
    <>
      {text.slice(0, index)}
      <span className="bg-yellow-300 text-slate-900 font-semibold">
        {text.slice(index, index + searchTerm.length)}
      </span>
      {text.slice(index + searchTerm.length)}
    </>
  );
}

interface DataRowProps {
  row: Record<string, unknown>;
  rowIndex: number;
  visibleColumns: VisibleColumn[];
  padLeft: number;
  padRight: number;
  selected: boolean;
  searchTerm: string;
  /** Column index of the current search match if it is on this row, else -1. */
  activeMatchCol: number;
  onSelect: (rowIndex: number) => void;
}

const DataRow = React.memo(function DataRow({
  row,
  rowIndex,
  visibleColumns,
  padLeft,
  padRight,
  selected,
  searchTerm,
  activeMatchCol,
  onSelect,
}: DataRowProps) {
  const lowerSearchTerm = searchTerm.toLowerCase();

  return (
    <tr
      onClick={() => onSelect(rowIndex)}
      className={`
        border-b cursor-pointer transition-colors
        border-slate-100 dark:border-gray-700
        ${selected
          ? 'bg-blue-50 hover:bg-blue-100 dark:bg-blue-900 dark:hover:bg-blue-800'
          : 'hover:bg-slate-50 dark:hover:bg-gray-700'
        }
      `}
    >
      {padLeft > 0 && <td aria-hidden="true" />}
      {visibleColumns.map(({ index, name, mayTruncate }) => {
        const cellValue = row[name];
        const cellValueStr = cellValue !== null && cellValue !== undefined ? String(cellValue) : null;
        const hasSearchMatch = Boolean(searchTerm && cellValueStr && cellValueStr.toLowerCase().includes(lowerSearchTerm));

        return (
          <td
            key={index}
            title={mayTruncate && cellValueStr !== null ? cellValueStr : undefined}
            className={`px-4 py-2.5 text-sm border-r whitespace-nowrap overflow-hidden text-ellipsis border-slate-100 dark:border-gray-700 ${activeMatchCol === index
              ? 'bg-orange-200'
              : hasSearchMatch
                ? 'bg-yellow-100'
                : ''
              }`}
          >
            {cellValueStr !== null ? (
              <span className="font-mono text-xs text-slate-900 dark:text-gray-200">
                {hasSearchMatch ? highlight(cellValueStr, searchTerm) : cellValueStr}
              </span>
            ) : (
              <span className="italic font-mono text-xs text-slate-400 dark:text-gray-500">NULL</span>
            )}
          </td>
        );
      })}
      {padRight > 0 && <td aria-hidden="true" />}
    </tr>
  );
});

/**
 * The paginated data grid. Only the columns that overlap the scroll viewport
 * are rendered; spacer cells keep the scroll width and positions intact.
 */
export const DataTable = React.memo(function DataTable({
  columns,
  rows,
  selectedRow,
  onSelectRow,
  searchTerm,
  searchMatches,
  currentMatchIndex,
  typeDisplay,
  scrollerRef,
}: DataTableProps) {
  const typeLabels = useMemo(
    () => columns.map(col => formatTypeLabel(col, typeDisplay)),
    [columns, typeDisplay]
  );

  const widths = useMemo(
    () => measureColumnWidths(columns.map((col, i) => ({ name: col.name, typeLabel: typeLabels[i] })), rows),
    [columns, typeLabels, rows]
  );

  const virt = useColumnVirtualizer(widths, scrollerRef);
  const { start, end, padStart: padLeft, totalSize: totalWidth, viewportSize: viewportWidth } = virt;
  // Let the right spacer absorb any slack so row backgrounds span the viewport
  // when the columns do not fill it.
  const padRight = virt.padEnd + Math.max(0, viewportWidth - totalWidth);
  const tableWidth = Math.max(totalWidth, viewportWidth);

  const visibleColumns = useMemo<VisibleColumn[]>(
    () => columns.slice(start, end).map((col, i) => ({
      index: start + i,
      name: col.name,
      mayTruncate: widths[start + i] >= MAX_COLUMN_WIDTH,
    })),
    [columns, widths, start, end]
  );

  const matchedColumns = useMemo(() => {
    const set = new Set<number>();
    for (const match of searchMatches) {
      if (match.rowIndex === -1) set.add(match.colIndex);
    }
    return set;
  }, [searchMatches]);

  const activeMatch: SearchMatch | undefined = searchMatches[currentMatchIndex];

  // Bring the current match into view. Its cell may not be rendered yet, so
  // scroll by computed column offset rather than by DOM lookup.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !activeMatch) return;

    let colLeft = 0;
    for (let i = 0; i < activeMatch.colIndex; i++) colLeft += widths[i];
    const colWidth = widths[activeMatch.colIndex] ?? 0;
    const left = Math.max(0, colLeft - (scroller.clientWidth - colWidth) / 2);

    let top = scroller.scrollTop;
    if (activeMatch.rowIndex >= 0) {
      const tr = scroller.querySelector<HTMLTableRowElement>(`tbody tr:nth-child(${activeMatch.rowIndex + 1})`);
      if (tr) top = Math.max(0, tr.offsetTop - (scroller.clientHeight - tr.offsetHeight) / 2);
    }

    scroller.scrollTo({ left, top, behavior: 'smooth' });
  }, [activeMatch, widths, scrollerRef]);

  return (
    <div
      ref={scrollerRef}
      onScroll={virt.onScroll}
      className="flex-1 overflow-auto shadow-inner bg-white dark:bg-gray-800"
    >
      <table className="text-sm" style={{ tableLayout: 'fixed', width: tableWidth }}>
        <colgroup>
          {padLeft > 0 && <col style={{ width: padLeft }} />}
          {visibleColumns.map(({ index }) => (
            <col key={index} style={{ width: widths[index] }} />
          ))}
          {padRight > 0 && <col style={{ width: padRight }} />}
        </colgroup>
        <thead className="sticky top-0 z-10 border-b bg-slate-100 border-slate-200 dark:bg-gray-700 dark:border-gray-600">
          <tr>
            {padLeft > 0 && <th aria-hidden="true" />}
            {visibleColumns.map(({ index, name }) => (
              <th
                key={index}
                title={name}
                className={`px-4 py-3 text-left font-medium border-r whitespace-nowrap overflow-hidden text-ellipsis text-slate-700 border-slate-200 dark:text-gray-200 dark:border-gray-600 ${matchedColumns.has(index) ? 'bg-yellow-100' : ''
                  }`}
              >
                <div className="font-semibold">
                  {matchedColumns.has(index) ? highlight(name, searchTerm) : name}
                </div>
                <div className="font-normal text-xs mt-0.5 text-slate-500 dark:text-gray-400">
                  {typeLabels[index]}
                </div>
              </th>
            ))}
            {padRight > 0 && <th aria-hidden="true" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <DataRow
              key={rowIndex}
              row={row}
              rowIndex={rowIndex}
              visibleColumns={visibleColumns}
              padLeft={padLeft}
              padRight={padRight}
              selected={selectedRow === rowIndex}
              searchTerm={searchTerm}
              activeMatchCol={activeMatch && activeMatch.rowIndex === rowIndex ? activeMatch.colIndex : -1}
              onSelect={onSelectRow}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
});

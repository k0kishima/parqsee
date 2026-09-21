import React, { useEffect, useMemo, RefObject } from 'react';
import { ChartBar, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ColumnInfo, SortSpec } from '../api';
import { isSortableColumn } from '../lib/sort';
import { ROW_DENSITY_CLASSES, type RowDensity, type TypeDisplay } from '../../../lib/settings-storage';
import { useColumnVirtualizer } from '../../../hooks/useVirtualRange';
import { measureColumnWidths, MAX_COLUMN_WIDTH } from '../../../lib/column-widths';
import { formatCellValue } from '../../../lib/format';
import { SearchMatch, indexOfTerm } from '../lib/search';
import type { RowData } from '../../../lib/row';

interface DataTableProps {
  columns: ColumnInfo[];
  rows: RowData[];
  selectedRow: number | null;
  onSelectRow: (rowIndex: number) => void;
  searchTerm: string;
  searchMatches: SearchMatch[];
  currentMatchIndex: number;
  typeDisplay: TypeDisplay;
  density: RowDensity;
  /** The horizontally/vertically scrolling container; owned by the parent. */
  scrollerRef: RefObject<HTMLDivElement>;
  /** The column whose profile panel is open, if any; its header is marked. */
  profiledColumn?: string | null;
  /** The header's chart button; without it the header has none. */
  onProfileColumn?: (name: string) => void;
  /** The column the rows are sorted by, if any; its header shows the direction. */
  sort?: SortSpec | null;
  /** A click on a sortable column's name; without it the names are plain text. */
  onSort?: (name: string) => void;
}

/**
 * Width the chart button adds to a header, counted into the column's
 * measured width so a short name is not clipped by it: the button sits in
 * the cell's right padding and reaches this far past it (`pr-7` on the
 * cell against the `px-4` of the rest).
 */
export const PROFILE_BUTTON_WIDTH = 12;

/**
 * Width the sort chevron takes beside a sorted column's name (the mark
 * and its gap), counted into every column's measured width so the mark
 * does not clip the name of a column that was measured without it.
 */
export const SORT_INDICATOR_WIDTH = 16;

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
  const index = indexOfTerm(text, searchTerm);
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
  row: RowData;
  rowIndex: number;
  visibleColumns: VisibleColumn[];
  padLeft: number;
  padRight: number;
  selected: boolean;
  searchTerm: string;
  /** Column index of the current search match if it is on this row, else -1. */
  activeMatchCol: number;
  /** The vertical padding class of the density in force. */
  cellPadding: string;
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
  cellPadding,
  onSelect,
}: DataRowProps) {
  return (
    <tr
      onClick={() => onSelect(rowIndex)}
      className={`
        border-b cursor-pointer transition-colors
        border-subtle
        ${selected
          ? 'bg-blue-50 hover:bg-blue-100 dark:bg-blue-900 dark:hover:bg-blue-800'
          : 'hover:bg-slate-50 dark:hover:bg-gray-700'
        }
      `}
    >
      {padLeft > 0 && <td aria-hidden="true" />}
      {visibleColumns.map(({ index, name, mayTruncate }) => {
        const cellValueStr = formatCellValue(row[name]);
        const hasSearchMatch = cellValueStr !== null && indexOfTerm(cellValueStr, searchTerm) !== -1;

        return (
          <td
            key={index}
            title={mayTruncate && cellValueStr !== null ? cellValueStr : undefined}
            className={`px-4 ${cellPadding} text-sm border-r whitespace-nowrap overflow-hidden text-ellipsis border-subtle ${activeMatchCol === index
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
  density,
  scrollerRef,
  profiledColumn = null,
  onProfileColumn,
  sort = null,
  onSort,
}: DataTableProps) {
  const { t } = useTranslation();
  const typeLabels = useMemo(
    () => columns.map(col => formatTypeLabel(col, typeDisplay)),
    [columns, typeDisplay]
  );

  const widths = useMemo(
    () => measureColumnWidths(
      columns.map((col, i) => ({ name: col.name, typeLabel: typeLabels[i] })),
      rows,
      {
        format: formatCellValue,
        headerExtra: (onProfileColumn ? PROFILE_BUTTON_WIDTH : 0) + (onSort ? SORT_INDICATOR_WIDTH : 0),
      }
    ),
    [columns, typeLabels, rows, onProfileColumn, onSort]
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
        <thead className="sticky top-0 z-10 border-b bg-slate-100 border-primary dark:bg-gray-700">
          <tr>
            {padLeft > 0 && <th aria-hidden="true" />}
            {visibleColumns.map(({ index, name }) => {
              const sortedBy = sort?.column === name ? sort.direction : null;
              const label = matchedColumns.has(index) ? highlight(name, searchTerm) : name;
              return (
              <th
                key={index}
                title={name}
                aria-sort={sortedBy ? (sortedBy === 'asc' ? 'ascending' : 'descending') : undefined}
                className={`relative px-4 ${onProfileColumn ? 'pr-7' : ''} ${ROW_DENSITY_CLASSES[density].header} text-left font-medium border-r whitespace-nowrap overflow-hidden text-ellipsis text-slate-700 border-primary dark:text-gray-200 ${matchedColumns.has(index) ? 'bg-yellow-100' : profiledColumn === name ? 'bg-selected' : ''
                  }`}
              >
                {/* The name stays the cell's first element: the e2e harness
                    reads the headers by it. */}
                <div className="font-semibold">
                  {onSort && isSortableColumn(columns[index]) ? (
                    <button
                      type="button"
                      onClick={() => onSort(name)}
                      title={t('viewer.sort.toggle', { column: name })}
                      className="inline-flex items-center gap-1 max-w-full rounded group"
                    >
                      {/* Only the name carries the sorted colour: the
                          chevron says which way, the colour says which
                          column, and colouring both makes the mark the
                          louder of the two. */}
                      <span
                        className={`truncate transition-colors group-hover:text-blue-600 dark:group-hover:text-blue-400 ${sortedBy ? 'text-blue-600 dark:text-blue-400' : ''}`}
                      >
                        {label}
                      </span>
                      {sortedBy === 'asc' && (
                        <ChevronUp size={12} strokeWidth={2.5} aria-hidden="true" className="shrink-0 text-slate-500 dark:text-gray-400" />
                      )}
                      {sortedBy === 'desc' && (
                        <ChevronDown size={12} strokeWidth={2.5} aria-hidden="true" className="shrink-0 text-slate-500 dark:text-gray-400" />
                      )}
                    </button>
                  ) : label}
                </div>
                <div className="font-normal text-xs mt-0.5 text-slate-500 dark:text-gray-400">
                  {typeLabels[index]}
                </div>
                {onProfileColumn && (
                  <button
                    type="button"
                    onClick={() => onProfileColumn(name)}
                    aria-pressed={profiledColumn === name}
                    aria-label={t('viewer.profile.open', { column: name })}
                    title={t('viewer.profile.open', { column: name })}
                    className={`absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded transition-colors hover:bg-slate-200 dark:hover:bg-gray-600 ${profiledColumn === name
                      ? 'text-blue-600 dark:text-blue-400'
                      : 'text-slate-400 hover:text-slate-600 dark:text-gray-500 dark:hover:text-gray-300'}`}
                  >
                    <ChartBar size={14} />
                  </button>
                )}
              </th>
              );
            })}
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
              cellPadding={ROW_DENSITY_CLASSES[density].cell}
              onSelect={onSelectRow}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
});

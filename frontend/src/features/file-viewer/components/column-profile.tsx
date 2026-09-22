import { useCallback } from 'react';
import { ColumnProfileView } from '../../../components/column-profile';
import { profileColumnChart, profileColumnCounts, type ColumnCounts, type ColumnInfo } from '../api';
import type { ProfileCondition } from '../../../lib/filter-sql';

interface ColumnProfilePanelProps {
  filePath: string;
  column: ColumnInfo;
  /** The grid's WHERE fragment; the profile describes the rows it keeps. */
  filter: string;
  onClose: () => void;
  /** A click on a value or a bucket, as conditions for the filter bar. */
  onAddConditions: (conditions: ProfileCondition[]) => void;
}

/**
 * The profile of a file column: the shared panel, asking the backend
 * about the file's own table under the grid's filter. A condition names
 * the column by name here — a file's columns are addressable that way,
 * unlike a query result's.
 */
export function ColumnProfilePanel({ filePath, column, filter, onClose, onAddConditions }: ColumnProfilePanelProps) {
  const loadCounts = useCallback(
    (requestId: string) => profileColumnCounts(filePath, column.name, filter || undefined, requestId),
    [filePath, column.name, filter],
  );
  const loadChart = useCallback(
    (requestId: string, counts: ColumnCounts) =>
      profileColumnChart(filePath, column.name, filter || undefined, counts, requestId),
    [filePath, column.name, filter],
  );
  return (
    <ColumnProfileView
      name={column.name}
      typeLabel={column.column_type}
      columnRef={column.name}
      requestKey={JSON.stringify([filePath, column.name, filter])}
      loadCounts={loadCounts}
      loadChart={loadChart}
      onClose={onClose}
      onAddConditions={onAddConditions}
    />
  );
}

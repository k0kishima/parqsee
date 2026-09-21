import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ColumnProfileView, type ProfileCondition } from '../../../components/column-profile';
import type { ColumnKind } from '../../../bindings/ipc/ColumnKind';
import { conditionSql } from '../../../lib/filter-sql';
import { profileQueryColumn } from '../api/result-profile';
import type { QueryColumn } from '../types';
import { columnAlias } from '../lib/result-filter';
import type { AppliedCondition } from '../lib/result-filter';

interface ResultProfilePanelProps {
  resultId: string;
  column: QueryColumn;
  /** Where the column sits in the result — how the backend addresses it. */
  columnIndex: number;
  /** The conditions already narrowing the result, as SQL. */
  filter?: string;
  /** How many rows the profile describes, and whether that is all the query matched. */
  rows: number;
  truncated: boolean;
  onClose: () => void;
  onNarrow: (conditions: AppliedCondition[]) => void;
}

/**
 * The profile of a result column: the shared panel over the rows the
 * query returned. It says how many rows those are whenever that is not
 * the whole answer — a result cut at the row limit is a sample, and a
 * distribution of a sample presented as the distribution of the data
 * would be the panel's own lie, not the query's.
 *
 * A click narrows the result the user already has. It does not touch
 * their SQL: the text in the editor is theirs, and rewriting it would
 * also mean running it again, which answers differently for a query that
 * is not deterministic.
 */
export function ResultProfilePanel({
  resultId, column, columnIndex, filter, rows, truncated, onClose, onNarrow,
}: ResultProfilePanelProps) {
  const { t } = useTranslation();
  // The kind the backend decided for this column, kept from the profile
  // it answered with: it is what says whether a clicked value is written
  // as a number, a quoted literal, or isnan() for a NaN.
  const kind = useRef<ColumnKind>('other');

  const load = useCallback(async (requestId: string) => {
    const profile = await profileQueryColumn(resultId, columnIndex, filter, requestId);
    kind.current = profile.kind;
    return profile;
  }, [resultId, columnIndex, filter]);

  const onAddConditions = useCallback((conditions: ProfileCondition[]) => {
    const applied = conditions.flatMap(condition => {
      // A click always means the value it landed on, empty string included.
      const sql = conditionSql({ ...condition, kind: kind.current, explicitValue: true });
      // The chip reads like the panel's bar: an empty value is shown as
      // "" rather than as nothing after the operator.
      const shown = condition.value.trim() === '' ? JSON.stringify(condition.value) : condition.value;
      return sql === null ? [] : [{
        columnIndex,
        operator: condition.operator,
        label: `${column.name} ${condition.operator}${condition.operator === 'IS NULL' ? '' : ` ${shown}`}`,
        sql,
      }];
    });
    if (applied.length > 0) onNarrow(applied);
  }, [column.name, columnIndex, onNarrow]);

  return (
    <ColumnProfileView
      name={column.name}
      typeLabel={column.data_type}
      columnRef={columnAlias(columnIndex)}
      requestKey={JSON.stringify([resultId, columnIndex, filter ?? ''])}
      load={load}
      notice={truncated ? t('viewer.query.result.partialProfile', { rows: rows.toLocaleString() }) : null}
      onClose={onClose}
      onAddConditions={onAddConditions}
    />
  );
}

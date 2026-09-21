import type { QueryChartType, QueryResult } from '../../types';

/** Every chart type a column can carry, short enough to read in a case. */
export const T = {
  integer: { kind: 'integer' } as QueryChartType,
  float: { kind: 'float' } as QueryChartType,
  decimal: { kind: 'decimal' } as QueryChartType,
  date: { kind: 'date' } as QueryChartType,
  timestamp: { kind: 'timestamp', timezone: null } as QueryChartType,
  category: { kind: 'category' } as QueryChartType,
  unsupported: { kind: 'unsupported' } as QueryChartType,
};

/**
 * A query result from its columns and rows alone. `data_type` is a display
 * string the chart never reads, so it follows the chart type rather than
 * being given per case; `extra` is for the fields a case is actually about
 * (`truncated`, `max_rows`).
 */
export function result(
  columns: [string, QueryChartType][],
  rows: Record<string, unknown>[],
  extra: Partial<QueryResult> = {},
): QueryResult {
  return {
    columns: columns.map(([name, chart_type]) => ({ name, data_type: chart_type.kind, chart_type })),
    rows,
    execution_time_ms: 1,
    truncated: false,
    max_rows: 10_000,
    result_id: 'r1',
    ...extra,
  };
}

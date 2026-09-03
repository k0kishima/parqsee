import { RowData } from '../../lib/row';

export interface QueryColumn {
    name: string;
    data_type: string;
}

export interface QueryResult {
    columns: QueryColumn[];
    rows: RowData[];
    execution_time_ms: number;
    /** True when the backend cut the result at `max_rows`. */
    truncated: boolean;
    max_rows: number;
}

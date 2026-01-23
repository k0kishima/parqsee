export interface QueryColumn {
    name: string;
    data_type: string;
}

export interface QueryResult {
    columns: QueryColumn[];
    rows: Array<Record<string, any>>;
    execution_time_ms: number;
}

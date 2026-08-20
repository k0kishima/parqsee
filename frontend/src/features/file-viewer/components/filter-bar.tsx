import React, { useState, useEffect } from "react";
import { Filter, X, Plus, Minus, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ColumnInfo } from "../api";

interface FilterBarProps {
    columns: ColumnInfo[];
    onFilterChange: (filter: string) => void;
    activeFilter: string;
}

export interface FilterRow {
    id: number;
    column: string;
    operator: string;
    value: string;
}

/**
 * Column types that compare against a bare literal. Everything else — text,
 * dates, timestamps, UUIDs, INT96 legacy timestamps — needs a quoted string
 * literal, which DataFusion coerces to the column type.
 */
const BARE_LITERAL_TYPE = /^(BOOLEAN|FLOAT|DOUBLE|DECIMAL|INT(8|16|32|64))/;
const TEXT_TYPE = /^(STRING|UTF8)/;

/** DataFusion lower-cases bare identifiers, so `MixedCase` resolves to nothing. */
const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;
const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

function formatLiteral(columnType: string, value: string): string {
    // Text comparisons keep the value verbatim — spaces can be meaningful
    // there. Everything else is parsed by DataFusion (dates, timestamps,
    // numbers), whose parsers do not trim, so a stray space from a paste
    // would fail the whole filter.
    if (TEXT_TYPE.test(columnType)) return quoteLiteral(value);
    const trimmed = value.trim();
    if (BARE_LITERAL_TYPE.test(columnType)) {
        const isBare = /^BOOLEAN/.test(columnType)
            ? /^(true|false)$/i.test(trimmed)
            : trimmed !== "" && Number.isFinite(Number(trimmed));
        // A value that does not parse still goes in quoted, so the backend
        // reports a cast error instead of "no field named abc".
        if (isBare) return trimmed;
    }
    return quoteLiteral(trimmed);
}

/** Build the WHERE fragment the backend appends to `SELECT * FROM t`. */
export function buildFilterExpression(filters: FilterRow[], columns: ColumnInfo[]): string {
    const conditions: string[] = [];

    for (const filter of filters) {
        if (!filter.column) continue;

        const needsValue = filter.operator !== "IS NULL" && filter.operator !== "IS NOT NULL";
        if (needsValue && !filter.value.trim()) continue;

        const columnType = columns.find(c => c.name === filter.column)?.column_type ?? "";
        const columnRef = quoteIdentifier(filter.column);

        if (!needsValue) {
            conditions.push(`${columnRef} ${filter.operator}`);
        } else if (filter.operator === "LIKE") {
            // LIKE only applies to text, so cast anything else to keep partial
            // matches working on numbers and dates.
            const target = TEXT_TYPE.test(columnType) ? columnRef : `CAST(${columnRef} AS TEXT)`;
            conditions.push(`${target} LIKE ${quoteLiteral(filter.value)}`);
        } else {
            conditions.push(`${columnRef} ${filter.operator} ${formatLiteral(columnType, filter.value)}`);
        }
    }

    return conditions.join(" AND ");
}

export function FilterBar({ columns, onFilterChange, activeFilter }: FilterBarProps) {
    const { t } = useTranslation();

    // Initialize with one row
    const [filters, setFilters] = useState<FilterRow[]>([
        { id: Date.now(), column: columns[0]?.name || "", operator: "=", value: "" }
    ]);

    // Update selected column of the first row if columns change and it's invalid
    useEffect(() => {
        if (columns.length > 0) {
            setFilters(prevFilters => prevFilters.map(f => {
                if (!columns.find(c => c.name === f.column)) {
                    return { ...f, column: columns[0].name };
                }
                return f;
            }));
        }
    }, [columns]);

    const handleAddRow = () => {
        setFilters([
            ...filters,
            { id: Date.now(), column: columns[0]?.name || "", operator: "=", value: "" }
        ]);
    };

    const handleRemoveRow = (id: number) => {
        const newFilters = filters.filter(f => f.id !== id);
        // Always keep at least one row
        if (newFilters.length === 0) {
            setFilters([{ id: Date.now(), column: columns[0]?.name || "", operator: "=", value: "" }]);
            // Also clear the filter
            onFilterChange("");
        } else {
            setFilters(newFilters);
            // We don't automatically submit on remove; user must press Apply
            // Or we could auto-apply. Let's stick to "Apply" button for consistency/safety.
        }
    };

    const handleChange = (id: number, field: keyof FilterRow, newValue: string) => {
        setFilters(filters.map(f => (f.id === id ? { ...f, [field]: newValue } : f)));
    };

    const handleClear = () => {
        setFilters([{ id: Date.now(), column: columns[0]?.name || "", operator: "=", value: "" }]);
        onFilterChange("");
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onFilterChange(buildFilterExpression(filters, columns));
    };

    const inputBg = 'bg-white border-slate-300 text-slate-800 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100';
    const iconButtonClass = `p-1 rounded transition-colors text-slate-400 hover:text-slate-600 hover:bg-slate-200 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700`;

    const operators = ["=", "!=", ">", "<", ">=", "<=", "LIKE", "IS NULL", "IS NOT NULL"];

    return (
        <div className="px-6 py-2 border-t flex flex-col gap-2 border-slate-200 bg-slate-50 dark:border-gray-700 dark:bg-gray-800/50">
            <form onSubmit={handleSubmit}>
                {filters.map((filter, index) => {
                    const needsValue = filter.operator !== "IS NULL" && filter.operator !== "IS NOT NULL";

                    return (
                        <div key={filter.id} className="flex items-center gap-2 mb-2 last:mb-0">
                            {index === 0 ? (
                                <div className="flex items-center gap-2 min-w-[80px]">
                                    <Filter size={14} className="text-slate-400 dark:text-gray-400" />
                                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-gray-500">
                                        {t('viewer.filter')}:
                                    </span>
                                </div>
                            ) : (
                                <div className="min-w-[80px] flex justify-end pr-2">
                                    <span className="text-xs font-bold uppercase text-slate-500 dark:text-gray-500">AND</span>
                                </div>
                            )}

                            {/* Column Selector */}
                            <select
                                value={filter.column}
                                onChange={(e) => handleChange(filter.id, "column", e.target.value)}
                                className={`px-2 py-1 text-sm rounded border focus:outline-none focus:ring-1 focus:ring-blue-500 ${inputBg}`}
                            >
                                {columns.map(col => (
                                    <option key={col.name} value={col.name}>{col.name}</option>
                                ))}
                            </select>

                            {/* Operator Selector */}
                            <select
                                value={filter.operator}
                                onChange={(e) => handleChange(filter.id, "operator", e.target.value)}
                                className={`px-2 py-1 text-sm rounded border focus:outline-none focus:ring-1 focus:ring-blue-500 w-24 ${inputBg}`}
                            >
                                {operators.map(op => (
                                    <option key={op} value={op}>{op}</option>
                                ))}
                            </select>

                            {/* Value Input */}
                            <input
                                type="text"
                                value={filter.value}
                                onChange={(e) => handleChange(filter.id, "value", e.target.value)}
                                disabled={!needsValue}
                                placeholder={!needsValue ? "" : t('viewer.filterValuePlaceholder', { defaultValue: 'Value' })}
                                className={`flex-1 px-2 py-1 text-sm rounded border focus:outline-none focus:ring-1 focus:ring-blue-500 ${inputBg} ${!needsValue ? 'opacity-50 cursor-not-allowed' : ''}`}
                            />

                            {/* Remove Button (if > 1 rows) */}
                            <button
                                type="button"
                                onClick={() => handleRemoveRow(filter.id)}
                                className={iconButtonClass}
                                title="Remove condition"
                            >
                                <Minus size={16} />
                            </button>
                        </div>
                    );
                })}

                <div className="flex items-center justify-between mt-2 pl-[80px]">
                    <button
                        type="button"
                        onClick={handleAddRow}
                        className="flex items-center text-xs font-medium px-2 py-1 rounded transition-colors text-slate-600 hover:bg-slate-100 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                        <Plus size={14} className="mr-1" />
                        {t('common.addCondition', { defaultValue: 'Add Condition' })}
                    </button>

                    <div className="flex gap-2">
                        <button
                            type="submit"
                            className="btn-primary px-3 py-1 text-sm h-8 gap-2"
                        >
                            <Play size={14} className="fill-current" />
                            {t('common.apply', { defaultValue: 'Apply' })}
                        </button>

                        {activeFilter && (
                            <button
                                type="button"
                                onClick={handleClear}
                                className="p-1 rounded transition-colors text-slate-400 hover:text-slate-600 hover:bg-slate-200 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700"
                                title={t('common.clear', { defaultValue: 'Clear' })}
                            >
                                <X size={16} />
                            </button>
                        )}
                    </div>
                </div>
            </form>
        </div>
    );
}

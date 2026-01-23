import React, { useState, useEffect } from "react";
import { Filter, X, Plus, Minus, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ColumnInfo } from "../api";
import { useSettings } from "../../../contexts/SettingsContext";

interface FilterBarProps {
    columns: ColumnInfo[];
    onFilterChange: (filter: string) => void;
    activeFilter: string;
}

interface FilterRow {
    id: number;
    column: string;
    operator: string;
    value: string;
}

export function FilterBar({ columns, onFilterChange, activeFilter }: FilterBarProps) {
    const { t } = useTranslation();
    const { effectiveTheme } = useSettings();

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

        const validConditions: string[] = [];

        for (const filter of filters) {
            if (!filter.column) continue;

            // Skip rows requiring value but having none
            const needsValue = filter.operator !== "IS NULL" && filter.operator !== "IS NOT NULL";
            if (needsValue && !filter.value.trim()) continue;

            let filterString = "";

            if (!needsValue) {
                filterString = `${filter.column} ${filter.operator}`;
            } else {
                // Find column type
                const col = columns.find(c => c.name === filter.column);
                const isString = col?.column_type === "STRING" || col?.column_type === "UTF8";

                let formattedValue = filter.value;
                if (isString || filter.operator === "LIKE") {
                    formattedValue = `'${filter.value.replace(/'/g, "''")}'`;
                }

                let columnExpr = filter.column;
                if (filter.operator === "LIKE" && !isString) {
                    columnExpr = `CAST(${filter.column} AS TEXT)`;
                }

                filterString = `${columnExpr} ${filter.operator} ${formattedValue}`;
            }

            validConditions.push(filterString);
        }

        if (validConditions.length === 0) {
            onFilterChange("");
        } else {
            onFilterChange(validConditions.join(" AND "));
        }
    };

    const inputBg = effectiveTheme === 'dark' ? 'bg-gray-800 border-gray-700 text-gray-100' : 'bg-white border-slate-300 text-slate-800';
    const iconButtonClass = `p-1 rounded transition-colors ${effectiveTheme === 'dark' ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-200'}`;

    const operators = ["=", "!=", ">", "<", ">=", "<=", "LIKE", "IS NULL", "IS NOT NULL"];

    return (
        <div className={`px-6 py-2 border-t flex flex-col gap-2 ${effectiveTheme === 'dark' ? 'border-gray-700 bg-gray-800/50' : 'border-slate-200 bg-slate-50'}`}>
            <form onSubmit={handleSubmit}>
                {filters.map((filter, index) => {
                    const needsValue = filter.operator !== "IS NULL" && filter.operator !== "IS NOT NULL";

                    return (
                        <div key={filter.id} className="flex items-center gap-2 mb-2 last:mb-0">
                            {index === 0 ? (
                                <div className="flex items-center gap-2 min-w-[80px]">
                                    <Filter size={14} className={effectiveTheme === 'dark' ? 'text-gray-400' : 'text-slate-400'} />
                                    <span className={`text-xs font-semibold uppercase tracking-wider ${effectiveTheme === 'dark' ? 'text-gray-500' : 'text-slate-500'}`}>
                                        {t('viewer.filter')}:
                                    </span>
                                </div>
                            ) : (
                                <div className="min-w-[80px] flex justify-end pr-2">
                                    <span className={`text-xs font-bold uppercase ${effectiveTheme === 'dark' ? 'text-gray-500' : 'text-slate-500'}`}>AND</span>
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
                        className={`flex items-center text-xs font-medium px-2 py-1 rounded transition-colors ${effectiveTheme === 'dark' ? 'text-gray-300 hover:bg-gray-700' : 'text-slate-600 hover:bg-slate-100'}`}
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
                                className={`p-1 rounded transition-colors ${effectiveTheme === 'dark' ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-200'}`}
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

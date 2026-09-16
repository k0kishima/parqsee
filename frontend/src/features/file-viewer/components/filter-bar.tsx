import React, { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { Filter, X, Plus, Minus, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ColumnInfo, ColumnKind } from "../api";
import { assertNever } from "../../../lib/exhaustive";

interface FilterBarProps {
    columns: ColumnInfo[];
    onFilterChange: (filter: string) => void;
    activeFilter: string;
}

/** A condition another part of the viewer asks the bar to add. */
export interface FilterCondition {
    column: string;
    operator: FilterOperator;
    /** The value as the user would type it; ignored by a unary operator. */
    value: string;
}

/**
 * What the bar does on request from outside its form: the column profile
 * panel adds the value or the bucket that was clicked as a condition. An
 * imperative handle rather than a prop, because it is an action with a
 * moment — a prop would have to be cleared again after each use.
 */
export interface FilterBarHandle {
    /**
     * Add the conditions and apply the filter at once. Rows that are not
     * filled in are dropped, and so is a row on the same column with the
     * same operator: a click on a narrower bucket replaces the range the
     * previous click set instead of stacking on it. The upper-bound operators
     * < and <= also replace each other when a time bucket ends at day-end.
     */
    addConditions: (conditions: FilterCondition[]) => void;
}

export const FILTER_OPERATORS = ["=", "!=", ">", "<", ">=", "<=", "LIKE", "IS NULL", "IS NOT NULL"] as const;
export type FilterOperator = typeof FILTER_OPERATORS[number];

export function isFilterOperator(value: string): value is FilterOperator {
    return (FILTER_OPERATORS as readonly string[]).includes(value);
}

/**
 * How an operator uses the typed value: compared against a literal of the
 * column's type, matched as a text pattern, or not at all.
 */
type OperatorForm = 'compare' | 'pattern' | 'unary';

const OPERATOR_FORM = {
    "=": 'compare',
    "!=": 'compare',
    ">": 'compare',
    "<": 'compare',
    ">=": 'compare',
    "<=": 'compare',
    "LIKE": 'pattern',
    "IS NULL": 'unary',
    "IS NOT NULL": 'unary',
} satisfies Record<FilterOperator, OperatorForm>;

export function operatorTakesValue(operator: FilterOperator): boolean {
    return OPERATOR_FORM[operator] !== 'unary';
}

export interface FilterRow {
    /** A profile click or restored literal can deliberately select an empty value. */
    explicitValue?: boolean;
    id: number;
    column: string;
    operator: FilterOperator;
    value: string;
}

let nextFilterRowSerial = 0;
/**
 * An empty condition on `column` (the first column, or none). The id is a
 * serial and only has to be unique among the rows of one bar; `Date.now()`
 * gave two rows added within a millisecond the same id, and one − then
 * removed both.
 */
function newFilterRow(column: string | undefined): FilterRow {
    return { id: nextFilterRowSerial++, column: column ?? "", operator: "=", value: "" };
}

/**
 * How a typed value becomes the literal a column of this kind is compared
 * with. Numbers and booleans go in bare; text keeps the value verbatim
 * (spaces can be meaningful there); binary compares the lowercase hex the
 * grid shows; everything else — dates, timestamps, nested values — is
 * trimmed and quoted so DataFusion coerces it to the column type (its
 * parsers do not trim, so a stray space from a paste would fail the filter).
 */
type LiteralKind = 'number' | 'boolean' | 'text' | 'hex' | 'quoted';

const KIND_LITERAL = {
    boolean: 'boolean',
    integer: 'number',
    float: 'number',
    decimal: 'number',
    text: 'text',
    temporal: 'quoted',
    binary: 'hex',
    nested: 'quoted',
    other: 'quoted',
} satisfies Record<ColumnKind, LiteralKind>;

/** DataFusion lower-cases bare identifiers, so `MixedCase` resolves to nothing. */
const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;
const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

const isBooleanLiteral = (value: string) => /^(true|false)$/i.test(value);
const isNumericLiteral = (value: string) => value !== "" && Number.isFinite(Number(value));

function formatLiteral(literal: LiteralKind, value: string): string {
    // A value that does not parse still goes in quoted, so the backend
    // reports a cast error instead of "no field named abc".
    switch (literal) {
        case 'text': return quoteLiteral(value);
        case 'hex': return quoteLiteral(value.trim().toLowerCase());
        case 'boolean': { const trimmed = value.trim(); return isBooleanLiteral(trimmed) ? trimmed : quoteLiteral(trimmed); }
        case 'number': { const trimmed = value.trim(); return isNumericLiteral(trimmed) ? trimmed : quoteLiteral(trimmed); }
        case 'quoted': return quoteLiteral(value.trim());
        default: return assertNever(literal, 'literal kind');
    }
}

const kindOf = (columns: ColumnInfo[], name: string): ColumnKind =>
    columns.find(c => c.name === name)?.kind ?? 'other';

/** A filter whose value can never match its column, found before it is run. */
export interface InvalidFilterValue {
    column: string;
    value: string;
    /** What the column accepts, for the message. */
    expects: 'number' | 'boolean';
}

const EXPECTS_MESSAGE_KEY = {
    number: 'viewer.filterNeedsNumber',
    boolean: 'viewer.filterNeedsBoolean',
} satisfies Record<InvalidFilterValue['expects'], string>;

function invalidValueOf(filter: FilterRow, kind: ColumnKind): InvalidFilterValue | null {
    if (!filter.column || OPERATOR_FORM[filter.operator] !== 'compare') return null;
    const value = filter.value.trim();
    if (!value) return null;
    if (filter.explicitValue && kind === 'float' && ['NaN', 'Infinity', '-Infinity'].includes(value)) return null;
    const literal = KIND_LITERAL[kind];
    switch (literal) {
        case 'number': return isNumericLiteral(value) ? null : { column: filter.column, value, expects: 'number' };
        case 'boolean': return isBooleanLiteral(value) ? null : { column: filter.column, value, expects: 'boolean' };
        case 'text':
        case 'hex':
        case 'quoted':
            return null;
        default: return assertNever(literal, 'literal kind');
    }
}

/**
 * Catch values that DataFusion would silently cast to NULL — `id = 'abc'`
 * returned "0 rows" with no hint that the value was the problem.
 */
export function findInvalidFilterValue(filters: FilterRow[], columns: ColumnInfo[]): InvalidFilterValue | null {
    return filters
        .map(filter => invalidValueOf(filter, kindOf(columns, filter.column)))
        .find((problem): problem is InvalidFilterValue => problem !== null) ?? null;
}

/** The SQL condition for one row, or null for a row that is not filled in. */
function conditionOf(filter: FilterRow, kind: ColumnKind): string | null {
    if (!filter.column) return null;
    const form = OPERATOR_FORM[filter.operator];
    if (form !== 'unary' && !filter.value.trim() && !filter.explicitValue) return null;

    const literal = KIND_LITERAL[kind];
    // The grid shows binary as lowercase hex, so that is what gets typed
    // back in; compare the same rendering rather than the raw bytes. The
    // cast folds fixed-size and large binary into the one type encode()
    // accepts.
    const columnRef = literal === 'hex'
        ? `encode(CAST(${quoteIdentifier(filter.column)} AS BYTEA), 'hex')`
        : quoteIdentifier(filter.column);

    switch (form) {
        case 'unary':
            return `${columnRef} ${filter.operator}`;
        case 'pattern': {
            // Patterns only apply to text, so cast anything else to keep
            // partial matches working on numbers and dates.
            const target = literal === 'text' || literal === 'hex' ? columnRef : `CAST(${columnRef} AS TEXT)`;
            return `${target} ${filter.operator} ${quoteLiteral(filter.value)}`;
        }
        case 'compare':
            return `${columnRef} ${filter.operator} ${formatLiteral(literal, filter.value)}`;
        default:
            return assertNever(form, 'operator form');
    }
}

/** Build the WHERE fragment the backend appends to `SELECT * FROM t`. */
export function buildFilterExpression(filters: FilterRow[], columns: ColumnInfo[]): string {
    return filters
        .map(filter => conditionOf(filter, kindOf(columns, filter.column)))
        .filter((condition): condition is string => condition !== null)
        .join(" AND ");
}

/**
 * Read only the SQL this form emits. A round trip through the generator
 * verifies every condition; older or hand-written SQL remains an opaque
 * base predicate rather than being discarded or partially interpreted.
 */
function restoreFilter(expression: string, columns: ColumnInfo[]): { filters: FilterRow[]; base: string } {
    const filters: FilterRow[] = [];
    let rest = expression;
    const identifier = '"(?:[^"]|"")*"';
    const target = `(${identifier}|encode\\(CAST\\(${identifier} AS BYTEA\\), 'hex'\\)|CAST\\(${identifier} AS TEXT\\))`;
    const rowPattern = new RegExp(`^${target} (IS NOT NULL|IS NULL|>=|<=|!=|=|>|<|LIKE)(?: ('(?:[^']|'')*'|(?!AND(?: |$))[^ ]+))?(?= AND |$)`);
    while (rest) {
        const match = rest.match(rowPattern);
        if (!match) break;
        const name = match[1].match(/"((?:[^"]|"")*)"/)?.[1].replace(/""/g, '"');
        const operator = match[2];
        const raw = match[3];
        if (!name || !columns.some(c => c.name === name) || !isFilterOperator(operator)) break;
        const value = raw?.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw ?? '';
        const row = { ...newFilterRow(name), operator, value, explicitValue: true };
        if (conditionOf(row, kindOf(columns, name)) !== match[0]) break;
        filters.push(row);
        rest = rest.slice(match[0].length);
        if (rest.startsWith(' AND ')) rest = rest.slice(5);
        else break;
    }
    if (rest || buildFilterExpression(filters, columns) !== expression) {
        return { filters: [newFilterRow(columns[0]?.name)], base: expression };
    }
    return { filters: filters.length ? filters : [newFilterRow(columns[0]?.name)], base: '' };
}

function withBase(base: string, expression: string): string {
    return base && expression ? `(${base}) AND ${expression}` : base || expression;
}

export const FilterBar = forwardRef<FilterBarHandle, FilterBarProps>(function FilterBar(
    { columns, onFilterChange, activeFilter },
    ref
) {
    const { t } = useTranslation();

    // Initialize with one row. A lazy initializer: taking a serial is impure
    // and must not run on every render (react.dev/reference/rules).
    const [initial] = useState(() => restoreFilter(activeFilter, columns));
    const [filters, setFilters] = useState<FilterRow[]>(initial.filters);
    const [baseFilter, setBaseFilter] = useState(initial.base);
    const submitted = useRef(activeFilter);
    const [previousActive, setPreviousActive] = useState(activeFilter);
    if (previousActive !== activeFilter) {
        setPreviousActive(activeFilter);
        // Our own submission already has editable rows. External changes,
        // including rollback after a failed query, must restore their rows.
        if (activeFilter !== submitted.current) {
            const restored = restoreFilter(activeFilter, columns);
            setFilters(restored.filters);
            setBaseFilter(restored.base);
        }
    }
    const apply = useCallback((expression: string) => {
        submitted.current = expression;
        onFilterChange(expression);
    }, [onFilterChange]);
    const [invalid, setInvalid] = useState<InvalidFilterValue | null>(null);

    useImperativeHandle(ref, () => ({
        addConditions(conditions) {
            const replaced = (row: FilterRow) =>
                conditions.some(c => c.column === row.column && (
                    c.operator === row.operator ||
                    (['<', '<='].includes(c.operator) && ['<', '<='].includes(row.operator))
                ));
            const kept = filters.filter(row =>
                conditionOf(row, kindOf(columns, row.column)) !== null && !replaced(row)
            );
            const added = conditions.map(c => ({ ...newFilterRow(c.column), operator: c.operator, value: c.value, explicitValue: true }));
            const next = [...kept, ...added];
            setFilters(next);
            const problem = findInvalidFilterValue(next, columns);
            setInvalid(problem);
            if (!problem) apply(withBase(baseFilter, buildFilterExpression(next, columns)));
        },
    }), [filters, columns, apply, baseFilter]);

    // Point rows at the first column when the columns change and theirs is
    // gone. Adjusted during render from the previous columns, not in an
    // effect (react.dev/learn/you-might-not-need-an-effect).
    const [prevColumns, setPrevColumns] = useState(columns);
    if (prevColumns !== columns) {
        setPrevColumns(columns);
        if (prevColumns.length === 0 && columns.length > 0 && baseFilter === activeFilter &&
            filters.every(f => conditionOf(f, kindOf(columns, f.column)) === null)) {
            const restored = restoreFilter(activeFilter, columns);
            setFilters(restored.filters);
            setBaseFilter(restored.base);
        } else if (columns.length > 0) {
            setFilters(prevFilters => prevFilters.map(f => {
                if (!columns.find(c => c.name === f.column)) {
                    return { ...f, column: columns[0].name };
                }
                return f;
            }));
        }
    }

    const handleAddRow = () => {
        setFilters([...filters, newFilterRow(columns[0]?.name)]);
    };

    const handleRemoveRow = (id: number) => {
        const newFilters = filters.filter(f => f.id !== id);
        // Always keep at least one row
        if (newFilters.length === 0) {
            setFilters([newFilterRow(columns[0]?.name)]);
            // Also clear the filter
            setBaseFilter("");
            apply("");
        } else {
            setFilters(newFilters);
            // We don't automatically submit on remove; user must press Apply
            // Or we could auto-apply. Let's stick to "Apply" button for consistency/safety.
        }
    };

    const handleChange = (id: number, patch: Partial<Omit<FilterRow, 'id'>>) => {
        setFilters(filters.map(f => (f.id === id ? { ...f, ...patch, explicitValue: patch.value === undefined ? f.explicitValue : false } : f)));
    };

    const handleClear = () => {
        setFilters([newFilterRow(columns[0]?.name)]);
        setInvalid(null);
        setBaseFilter("");
        apply("");
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const problem = findInvalidFilterValue(filters, columns);
        setInvalid(problem);
        if (problem) return;
        apply(withBase(baseFilter, buildFilterExpression(filters, columns)));
    };

    const inputBg = 'bg-white border-slate-300 text-slate-800 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100';
    const iconButtonClass = `p-1 rounded transition-colors text-slate-400 hover:text-slate-600 hover:bg-slate-200 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700`;

    // One grid for every condition, so the value inputs line up whatever
    // the last row carries: `[FILTER: | AND] column operator value [−, and
    // on the last row + Apply ×]`. Add Condition and Apply used to have a
    // row of their own under the conditions, which cost the grid a line.
    // Each row keeps an element of its own (`contents`, so its cells still
    // sit in the form's grid): a row is a unit to a reader of the DOM, the
    // e2e suite included.
    return (
        <div className="px-6 py-2 bg-slate-50 dark:bg-gray-800/50">
            {baseFilter && <p className="text-xs text-tertiary mb-2 break-words">{t('viewer.restoredFilter')}: <code>{baseFilter}</code></p>}
            <form onSubmit={handleSubmit} className="grid grid-cols-[auto_auto_6rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2">
                {filters.map((filter, index) => {
                    const needsValue = operatorTakesValue(filter.operator);
                    const isLast = index === filters.length - 1;

                    return (
                        <div key={filter.id} className="contents">
                            {index === 0 ? (
                                <div className="flex items-center gap-2">
                                    <Filter size={14} className="text-slate-400 dark:text-gray-400" />
                                    <span className="text-xs font-semibold uppercase tracking-wider whitespace-nowrap text-slate-500 dark:text-gray-500">
                                        {t('viewer.filter')}:
                                    </span>
                                </div>
                            ) : (
                                <div className="flex justify-end pr-2">
                                    <span className="text-xs font-bold uppercase text-slate-500 dark:text-gray-500">AND</span>
                                </div>
                            )}

                            {/* Column Selector */}
                            <select
                                value={filter.column}
                                onChange={(e) => handleChange(filter.id, { column: e.target.value })}
                                className={`h-8 px-2 text-sm rounded border focus:outline-none focus:ring-1 focus:ring-blue-500 ${inputBg}`}
                            >
                                {columns.map(col => (
                                    <option key={col.name} value={col.name}>{col.name}</option>
                                ))}
                            </select>

                            {/* Operator Selector */}
                            <select
                                value={filter.operator}
                                onChange={(e) => {
                                    const operator = e.target.value;
                                    if (isFilterOperator(operator)) handleChange(filter.id, { operator });
                                }}
                                className={`h-8 px-2 text-sm rounded border focus:outline-none focus:ring-1 focus:ring-blue-500 ${inputBg}`}
                            >
                                {FILTER_OPERATORS.map(op => (
                                    <option key={op} value={op}>{op}</option>
                                ))}
                            </select>

                            {/* Value Input */}
                            <input
                                type="text"
                                value={filter.value}
                                onChange={(e) => handleChange(filter.id, { value: e.target.value })}
                                disabled={!needsValue}
                                placeholder={!needsValue ? "" : t('viewer.filterValuePlaceholder', { defaultValue: 'Value' })}
                                className={`w-full h-8 px-2 text-sm rounded border focus:outline-none focus:ring-1 focus:ring-blue-500 ${inputBg} ${!needsValue ? 'opacity-50 cursor-not-allowed' : ''}`}
                            />

                            <div className="flex items-center gap-1">
                                <button
                                    type="button"
                                    onClick={() => handleRemoveRow(filter.id)}
                                    className={iconButtonClass}
                                    title={t('common.removeCondition')}
                                >
                                    <Minus size={16} />
                                </button>
                                {isLast && (
                                    <>
                                        <button
                                            type="button"
                                            onClick={handleAddRow}
                                            className={iconButtonClass}
                                            title={t('common.addCondition', { defaultValue: 'Add Condition' })}
                                        >
                                            <Plus size={16} />
                                        </button>
                                        <button
                                            type="submit"
                                            className="btn-primary px-3 py-1 text-sm h-8 gap-2 ml-1"
                                        >
                                            <Play size={14} className="fill-current" />
                                            {t('common.apply', { defaultValue: 'Apply' })}
                                        </button>
                                        {activeFilter && (
                                            <button
                                                type="button"
                                                onClick={handleClear}
                                                className={iconButtonClass}
                                                title={t('common.clear', { defaultValue: 'Clear' })}
                                            >
                                                <X size={16} />
                                            </button>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                    );
                })}

                {invalid && (
                    <p className="col-start-2 col-span-4 text-xs text-red-600 dark:text-red-400" role="alert">
                        {t(EXPECTS_MESSAGE_KEY[invalid.expects], {
                            column: invalid.column,
                            value: invalid.value,
                        })}
                    </p>
                )}
            </form>
        </div>
    );
});

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Filter, X, Plus, Minus, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ColumnInfo, ColumnKind } from "../api";
import { assertNever } from "../../../lib/exhaustive";
import {
    conditionSql,
    FILTER_OPERATORS,
    isBooleanLiteral,
    isFilterOperator,
    isNumericLiteral,
    KIND_LITERAL,
    operatorCompares,
    operatorsForKind,
    operatorTakesValue,
    quoteIdentifier,
    type FilterOperator,
} from "../../../lib/filter-sql";

interface FilterBarProps {
    columns: ColumnInfo[];
    onFilterChange: (filter: string) => void;
    activeFilter: string;
    /**
     * The filter the viewer's last load failed with, while its banner is
     * up; null otherwise. The viewer rolls `activeFilter` back to the one
     * in force before it, and this is what tells the bar that the change
     * is a rollback of its own submission rather than a filter arriving
     * from outside — so the rows stay as typed, unapplied, for the user to
     * correct and apply again instead of vanishing with the banner's SQL
     * as the only trace of them.
     */
    rejectedFilter?: string | null;
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
     *
     * The new rows light up once (`.filter-arrived`) and the first one
     * takes focus: the click happened in a panel beside the grid, and its
     * effect lands here, in the grid and in the footer at once with nothing
     * to say so — and the button that was clicked may be gone, the panel
     * closing on a value, so focus has to land somewhere anyway.
     */
    addConditions: (conditions: FilterCondition[]) => void;
}

export {
    FILTER_OPERATORS,
    isFilterOperator,
    operatorTakesValue,
    quoteIdentifier,
    type FilterOperator,
} from "../../../lib/filter-sql";

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
 * An empty condition on `column`, or on no column at all — which is what a
 * row nobody has touched carries. A new row starts without a column because
 * the bar is on screen from the moment a file opens: a column filled in for
 * the user reads as a condition they never stated, on whichever column the
 * file happens to begin with, and it leaves the value box as the only empty
 * field in the row, which is how a value gets applied to a column nobody
 * chose. The operator does start at `=`, what almost every filter wants;
 * unlike the column it is not decided by the file's column order.
 *
 * The id is a serial and only has to be unique among the rows of one bar;
 * `Date.now()` gave two rows added within a millisecond the same id, and
 * one − then removed both.
 */
function newFilterRow(column?: string): FilterRow {
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
    if (!filter.column || !operatorCompares(filter.operator)) return null;
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
    // A row with no column picked states no condition. The check is here
    // rather than inside `conditionSql`, which is handed a column already
    // written as SQL — and `""` is a name, not an empty one.
    if (!filter.column) return null;
    return conditionSql({
        column: quoteIdentifier(filter.column),
        operator: filter.operator,
        value: filter.value,
        kind,
        explicitValue: filter.explicitValue,
    });
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
        const nan = rest.match(/^(NOT )?isnan\(CAST\("((?:[^"]|"")*)" AS DOUBLE\)\)(?= AND |$)/);
        if (nan) {
            const name = nan[2].replace(/""/g, '"');
            const row: FilterRow = { ...newFilterRow(name), operator: nan[1] ? '!=' : '=', value: 'NaN', explicitValue: true };
            if (kindOf(columns, name) !== 'float') break;
            filters.push(row);
            rest = rest.slice(nan[0].length);
            if (rest.startsWith(' AND ')) rest = rest.slice(5);
            continue;
        }
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
        return { filters: [newFilterRow()], base: expression };
    }
    return { filters: filters.length ? filters : [newFilterRow()], base: '' };
}

function withBase(base: string, expression: string): string {
    return base && expression ? `(${base}) AND ${expression}` : base || expression;
}

export const FilterBar = forwardRef<FilterBarHandle, FilterBarProps>(function FilterBar(
    { columns, onFilterChange, activeFilter, rejectedFilter = null },
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
        // Our own submission already has editable rows, and so does one the
        // backend refused: the viewer rolls the filter back and names the
        // refused one, and the rows are the draft to correct. Not when the
        // refused filter carried a base predicate — SQL the bar could only
        // show, not edit, restored with the tab onto a file that no longer
        // takes it: kept, it would go back out with the next Apply and be
        // refused again, with no ✕ to clear it while no filter is in force.
        // Any other change from outside must restore its rows.
        const rolledBack = rejectedFilter !== null && rejectedFilter === submitted.current && !baseFilter;
        if (activeFilter !== submitted.current && !rolledBack) {
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

    // Rows that came in through addConditions and are still lit; a row's
    // id leaves the list when its animation ends.
    const [arrived, setArrived] = useState<number[]>([]);
    const settleRow = (id: number) => setArrived(ids => (ids.includes(id) ? ids.filter(i => i !== id) : ids));
    // The row to focus once it is rendered. The wrapper has `display:
    // contents`, but it is still a DOM node, so its controls are reachable.
    const rowElements = useRef(new Map<number, HTMLDivElement>());
    const [focusRow, setFocusRow] = useState<number | null>(null);
    useEffect(() => {
        if (focusRow === null) return;
        const row = rowElements.current.get(focusRow);
        // The value input, or the operator when the operator takes none.
        const target = row?.querySelector<HTMLElement>('input:enabled') ?? row?.querySelectorAll<HTMLElement>('select')[1];
        target?.focus();
        setFocusRow(null);
    }, [focusRow]);

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
            setArrived(ids => [...ids, ...added.map(row => row.id)]);
            if (added.length > 0) setFocusRow(added[0].id);
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
            // A row whose column the new columns do not have goes back to no
            // column rather than to the first one: its value would otherwise
            // be read against a column the user never picked. The row is then
            // unfilled, and unfilled rows are dropped from the expression.
            setFilters(prevFilters => prevFilters.map(f =>
                f.column && !columns.find(c => c.name === f.column) ? { ...f, column: "" } : f
            ));
        }
    }

    const handleAddRow = () => {
        setFilters([...filters, newFilterRow()]);
    };

    const handleRemoveRow = (id: number) => {
        const newFilters = filters.filter(f => f.id !== id);
        // Always keep at least one row
        if (newFilters.length === 0) {
            setFilters([newFilterRow()]);
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

    /**
     * Picking a column also settles the operator, because the offered ones
     * depend on the column: a comparison carried over onto a nested column
     * would stay on screen as a condition the column cannot be asked, and
     * the select would show a value that is no longer among its options.
     */
    const handleColumnChange = (id: number, column: string) => {
        const operators = column ? operatorsForKind(kindOf(columns, column)) : FILTER_OPERATORS;
        setFilters(filters.map(f => (f.id === id
            ? { ...f, column, operator: operators.includes(f.operator) ? f.operator : operators[0] }
            : f)));
    };

    const handleClear = () => {
        setFilters([newFilterRow()]);
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

    const inputBg = 'bg-white border-secondary text-slate-800 dark:bg-gray-800 dark:text-gray-100';
    // The same field with its text dimmed, for a select that has nothing
    // picked yet. A whole class string rather than a text colour appended to
    // `inputBg`: two text colours on one element are resolved by the order of
    // the stylesheet, not the order of the attribute.
    const unsetInputBg = 'bg-white border-secondary text-slate-400 dark:bg-gray-800 dark:text-gray-500';
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
                    // A row with no column picked offers every operator: the
                    // kind is not known yet. The row's own operator stays on
                    // the list even when its column's kind no longer offers
                    // it — a filter saved by an earlier version can carry
                    // one, and a select whose value is not among its options
                    // renders blank.
                    const offered = filter.column ? operatorsForKind(kindOf(columns, filter.column)) : FILTER_OPERATORS;
                    const operators = offered.includes(filter.operator)
                        ? offered
                        : FILTER_OPERATORS.filter(op => offered.includes(op) || op === filter.operator);
                    const isLast = index === filters.length - 1;
                    const lit = arrived.includes(filter.id) ? ' filter-arrived' : '';

                    return (
                        <div
                            key={filter.id}
                            className="contents"
                            ref={el => { if (el) rowElements.current.set(filter.id, el); else rowElements.current.delete(filter.id); }}
                            onAnimationEnd={() => settleRow(filter.id)}
                        >
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

                            {/* Column Selector. With no column picked it
                                shows a dimmed placeholder instead of the first
                                column, so an untouched bar claims nothing and
                                the row is filled left to right. The
                                placeholder is offered only while it is what
                                the select shows: a row is emptied with −,
                                not by picking "Column..." again. A column
                                whose name is empty is the one thing the
                                select cannot tell from the placeholder, and
                                an unfilled row has always been an empty
                                `column`, so such a column could never be
                                filtered on either way. */}
                            <select
                                value={filter.column}
                                onChange={(e) => handleColumnChange(filter.id, e.target.value)}
                                className={`h-8 px-2 text-sm rounded border focus:outline-none focus:ring-1 focus:ring-blue-500 ${filter.column ? inputBg : unsetInputBg}${lit}`}
                            >
                                {!filter.column && <option value="">{t('viewer.filterColumnPlaceholder')}</option>}
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
                                className={`h-8 px-2 text-sm rounded border focus:outline-none focus:ring-1 focus:ring-blue-500 ${inputBg}${lit}`}
                            >
                                {operators.map(op => (
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
                                className={`w-full h-8 px-2 text-sm rounded border focus:outline-none focus:ring-1 focus:ring-blue-500 ${inputBg} ${!needsValue ? 'opacity-50 cursor-not-allowed' : ''}${lit}`}
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

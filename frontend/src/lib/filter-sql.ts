import { assertNever } from './exhaustive';
import type { ColumnKind } from '../bindings/ipc/ColumnKind';

/**
 * How a condition becomes SQL. One place decides it because two grids ask:
 * the browse table's filter bar over a file's columns, and the SQL view's
 * profile over the rows a query returned. A value that became one
 * comparison here and another there would show the user two different row
 * counts for the same click.
 *
 * What a column is *called* is the caller's business — a file column is
 * its quoted name, a query result's is its position — so every function
 * here takes the column already written as SQL addresses it.
 */

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

/** True when the operator compares its value against a literal of the column's type. */
export function operatorCompares(operator: FilterOperator): boolean {
    return OPERATOR_FORM[operator] === 'compare';
}

const NULL_OPERATORS = FILTER_OPERATORS.filter(op => !operatorTakesValue(op));

/**
 * The operators worth offering for a column of this kind. A nested column —
 * a list, a struct, a map — and one whose type this app has no handling for
 * have no value form the planner will take: comparing one against a literal
 * has no ordering to use, and `CAST(x AS TEXT)` for LIKE has no text form to
 * cast to, so either way the filter comes back as a plan error rather than
 * as rows. What is left is the null checks, which ask about the row and
 * never about the value.
 */
export function operatorsForKind(kind: ColumnKind): readonly FilterOperator[] {
    return kind === 'nested' || kind === 'other' ? NULL_OPERATORS : FILTER_OPERATORS;
}


/** How a value of a column's kind is written as a literal. */
export type LiteralKind = 'text' | 'number' | 'boolean' | 'hex' | 'quoted';

export const KIND_LITERAL = {
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

/**
 * DataFusion lower-cases bare identifiers, so `MixedCase` resolves to
 * nothing. The backend's `quote_identifier` escapes the same way, and it
 * has to: what this builds is sent as a `WHERE` fragment for that side to
 * plan, so a column name the two spell differently resolves in one and not
 * the other. `contracts/identifier-quoting-cases.json` is the shared list
 * both are tested against.
 */
export const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;
const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

export const isBooleanLiteral = (value: string) => /^(true|false)$/i.test(value);
/**
 * True when the value is written the way SQL writes a number, so it can go
 * into the fragment bare. `Number()` is not that test: it also reads
 * JavaScript's own spellings — `0x10` is 16, `0b11` is 3, `Infinity` is
 * finite in nobody's arithmetic but passes for a literal — and none of them
 * are numbers to the planner, which reads `0x10` as a hex *string* and
 * answers a filter on an integer column with an error banner.
 */
export const isNumericLiteral = (value: string) => /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value);

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


export interface Condition {
    /** The column as SQL addresses it: a quoted name, or a result's alias. */
    column: string;
    operator: FilterOperator;
    value: string;
    kind: ColumnKind;
    /** A profile click or a restored literal can deliberately select an empty value. */
    explicitValue?: boolean;
}

/**
 * One condition as SQL, or null when it is not filled in enough to mean
 * anything.
 */
export function conditionSql({ column, operator, value, kind, explicitValue }: Condition): string | null {
    if (!column) return null;
    const form = OPERATOR_FORM[operator];
    if (form !== 'unary' && !value.trim() && !explicitValue) return null;

    if (kind === 'float' && value.trim() === 'NaN' && (operator === '=' || operator === '!=')) {
        // NaN equality is not portable across Arrow's comparison kernels.
        return `${operator === '!=' ? 'NOT ' : ''}isnan(CAST(${column} AS DOUBLE))`;
    }
    const literal = KIND_LITERAL[kind];
    // The grid shows binary as lowercase hex, so that is what gets typed
    // back in; compare the same rendering rather than the raw bytes. The
    // cast folds fixed-size and large binary into the one type encode()
    // accepts.
    const columnRef = literal === 'hex'
        ? `encode(CAST(${column} AS BYTEA), 'hex')`
        : column;

    switch (form) {
        case 'unary':
            return `${columnRef} ${operator}`;
        case 'pattern': {
            // Patterns only apply to text, so cast anything else to keep
            // partial matches working on numbers and dates.
            const target = literal === 'text' || literal === 'hex' ? columnRef : `CAST(${columnRef} AS TEXT)`;
            return `${target} ${operator} ${quoteLiteral(value)}`;
        }
        case 'compare':
            return `${columnRef} ${operator} ${formatLiteral(literal, value)}`;
        default:
            return assertNever(form, 'operator form');
    }
}

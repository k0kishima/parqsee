import { sameConditionSlot, type ProfileCondition } from '../../../lib/filter-sql';

/**
 * How the backend addresses column `index` of a kept result. It matches
 * `column_alias` in `services::query_results`: the result's own names
 * cannot be used, because two columns may share one and an expression's
 * name is not an identifier.
 */
export const columnAlias = (index: number) => `c${index}`;

/** One condition narrowing the result, as the chip shows it and as SQL. */
export interface AppliedCondition {
  /** Which column of the result it is on, by position. */
  columnIndex: number;
  operator: ProfileCondition['operator'];
  /** What the chip reads. */
  label: string;
  /** The `WHERE` fragment, over the result's positional aliases. */
  sql: string;
}

/** How a result names the column a condition is on: by position, never by name. */
const slotOf = (condition: AppliedCondition) =>
  ({ column: condition.columnIndex, operator: condition.operator });

/**
 * The conditions after a click in the profile: the new ones replace any
 * on the same column in the same slot, and the rest are kept in the
 * order they were applied. A click narrows what is on screen; it never
 * contradicts itself with two bounds from two different buckets.
 */
export function applyConditions(
  existing: readonly AppliedCondition[],
  incoming: readonly AppliedCondition[],
): AppliedCondition[] {
  const taken = (condition: AppliedCondition) =>
    incoming.some(other => sameConditionSlot(slotOf(other), slotOf(condition)));
  return [...existing.filter(condition => !taken(condition)), ...incoming];
}

/** The `WHERE` fragment for every applied condition, or undefined for none. */
export const filterSqlOf = (conditions: readonly AppliedCondition[]): string | undefined =>
  conditions.length === 0 ? undefined : conditions.map(c => c.sql).join(' AND ');

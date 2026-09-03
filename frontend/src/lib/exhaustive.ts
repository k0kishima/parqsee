/**
 * Exhaustiveness check for `switch` statements over a union: put it in the
 * `default` branch so that a case added to the union fails to compile here
 * instead of falling through silently at runtime.
 */
export function assertNever(value: never, what = 'value'): never {
  throw new Error(`Unhandled ${what}: ${String(value)}`);
}

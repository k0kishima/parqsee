import { createContext, useContext, type Context } from 'react';

/**
 * A context whose value only exists under its provider, paired with the hook
 * that reads it.
 *
 * The hook throws naming the provider rather than handing back `undefined`,
 * which would surface far from the mistake as a property read on nothing.
 * `name` is the bare concept — `License` gives `useLicense must be used
 * within a LicenseProvider` — so the four contexts cannot drift apart in how
 * they word it.
 */
export function createRequiredContext<T>(name: string): [Context<T | undefined>, () => T] {
    const context = createContext<T | undefined>(undefined);
    context.displayName = `${name}Context`;

    const useRequiredContext = (): T => {
        const value = useContext(context);
        if (value === undefined) {
            throw new Error(`use${name} must be used within a ${name}Provider`);
        }
        return value;
    };

    return [context, useRequiredContext];
}

import { vi } from 'vitest';
import { TEST_SETTINGS } from './settings';

/**
 * A stand-in for `SettingsContext`, for the tests that render a component
 * reading the settings but are not about the settings themselves.
 *
 * A test file installs it whole:
 *
 * ```ts
 * vi.mock('<path>/contexts/SettingsContext', () => import('<path>/test/settings-context-mock'));
 * ```
 *
 * The module *is* the replacement, rather than a factory each file spells
 * out, because `vi.mock` hoists its factory above the file's own imports:
 * a shared object could not be closed over, and every file that tried
 * ended up writing the same three lines again.
 */

/** What a control the user pressed asked to change. Cleared per test. */
export const updateSettings = vi.fn();

export const useSettings = () => ({ settings: TEST_SETTINGS, updateSettings });

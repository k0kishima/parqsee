/**
 * The settings a component sees in a test that does not care which they
 * are. Spelled out rather than taken from `defaultSettings`, so that
 * changing what the app ships with cannot quietly change what these tests
 * assert — a grid whose page size moved would start counting different
 * rows without a single test saying so.
 */
export const TEST_SETTINGS = { rowsPerPage: 50, typeDisplay: 'logical', rowDensity: 'comfortable' } as const;

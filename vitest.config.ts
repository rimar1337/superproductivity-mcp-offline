import { defineConfig } from 'vitest/config';

/**
 * Three isolated test projects, deliberately separated by what they touch:
 *
 * - `unit`        — pure functions, no I/O. Milliseconds.
 * - `integration` — full stack against an in-memory WebDAV double. No network.
 * - `e2e`         — real Nextcloud over the network. Opt-in only, because it
 *                   needs credentials and writes to a remote folder.
 *
 * `npm test` runs unit + integration. E2E is a separate, explicit command so a
 * missing `.env` can never turn into a red build for a contributor.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/cli/**', 'src/**/index.ts', 'src/**/*.types.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});

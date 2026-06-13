import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    // evals/ is the live claude -p harness (run via `npm run eval`, not vitest).
    // include already scopes to tests/, but exclude it explicitly so a stray
    // *.test.ts under evals/ can never enter the deterministic suite.
    exclude: [...configDefaults.exclude, 'evals/**'],
    fixtureDirs: ['fixtures'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
      include: ['src/**/*.ts'],
      exclude: ['src/cli/index.ts'],
    },
  },
});

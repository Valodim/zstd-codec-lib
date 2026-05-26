import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 360000,
    includeSource: ['./**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['../src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/node_modules/**'],
    },
  },
});

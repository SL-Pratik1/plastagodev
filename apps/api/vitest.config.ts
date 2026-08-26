import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Integration tests touch Mongo/Redis; keep them serial so they don't race
    // on shared state once real fixtures land.
    fileParallelism: false,
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/scripts/**', 'src/**/*.d.ts'],
    },
  },
});

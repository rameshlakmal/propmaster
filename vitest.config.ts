import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration test files share the propmaster_test database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});

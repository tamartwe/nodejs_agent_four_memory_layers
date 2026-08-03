import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      // --expose-gc is required by the leak tests in test/l1-leak and test/l3-leak.
      forks: { execArgv: ['--expose-gc'] },
    },
    testTimeout: 30_000,
  },
});

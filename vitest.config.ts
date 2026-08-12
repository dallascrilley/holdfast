import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Every test file shares one ledger and one hash chain. Running files in
    // parallel would interleave appends with the chain assertions, so the suite
    // is deliberately sequential.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

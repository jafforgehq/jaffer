import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/electron/**/*.test.ts'],
    environment: 'node',
    testTimeout: 90_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // the kill switch: no test, and no daemon or CLI a test starts (they inherit it), can ever run the real launchctl
    env: { JAFFER_NO_LAUNCHCTL: '1' },
    fileParallelism: false,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    // the kill switch: no test, and no daemon or CLI a test starts (they inherit it), can ever run the real launchctl
    env: { JAFFER_NO_LAUNCHCTL: '1' },
  },
});

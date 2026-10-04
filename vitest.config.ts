import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Fixture repos contain their own *.test.* files: they are inputs to CtxKeep, not tests of it.
    exclude: [...configDefaults.exclude, 'test/fixtures/**'],
    testTimeout: 30_000,
  },
});

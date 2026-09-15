import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Everything that is unit-testable. `src/main.ts` and `src/shell/settings.ts`
    // are Obsidian shells and `src/shell/vault.ts`'s adapter class is exempted by
    // spec §H; the pure helpers in that file are covered by tests/vault.test.ts.
    coverage: { include: ['src/core/**', 'src/shell/**'] },
  },
});

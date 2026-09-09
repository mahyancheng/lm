/**
 * `provider.tsx` reaches the model through `@/lib/llm/client`, and the `@/`
 * alias lives in tsconfig `paths`, which Next honours and vitest does not — so
 * without this mapping the provider cannot be imported by a test at all. The
 * alias is declared for the modules *under* test; test files themselves keep
 * to relative imports.
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // The app's tsconfig sets `jsx: preserve` for Next's compiler; vitest's
  // transform must be told to compile it instead, or importing any `.tsx`
  // module fails at import analysis.
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
});

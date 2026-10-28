import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/native.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts', 'test/wide/*.test.mjs'] },
});

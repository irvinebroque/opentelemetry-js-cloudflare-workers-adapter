import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig(({ mode }) => ({
  plugins: [cloudflare({
    persistState: mode.startsWith('test') ? false : undefined,
    inspectorPort: mode.startsWith('test') ? false : undefined,
    types: { includeRuntime: false },
  })],
  server: { host: '127.0.0.1', port: Number(process.env.OTEL_TEST_PORT ?? 8799), strictPort: true },
  build: { outDir: 'dist-worker' },
}));

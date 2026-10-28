import { defineConfig, exports, bindings } from 'cf/config';

export default defineConfig(({ mode }) => ({
  worker: {
    name: 'otel-native-bridge-example',
    entrypoint: mode?.startsWith('test') ? './test/runtime-worker.ts' : './examples/worker.ts',
    ...(mode?.startsWith('test') && { exports: { TestObject: exports.durableObject({ storage: 'sqlite' }), SentryObject: exports.durableObject({ storage: 'sqlite' }) } }),
    ...(mode?.startsWith('test') && { env: { TEST_DB: bindings.d1() } }),
    compatibilityDate: '2026-10-26',
    compatibilityFlags: ['nodejs_compat'],
    observability: {
      enabled: mode !== 'test-disabled',
      logs: { enabled: mode !== 'test-disabled' },
      traces: { enabled: mode !== 'test-disabled', headSamplingRate: 1 },
    },
  },
}));

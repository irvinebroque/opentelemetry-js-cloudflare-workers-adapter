import assert from 'node:assert/strict';
import { trace } from '@opentelemetry/api';
// Static specifiers let Vite resolve the same packages a customer's bundle uses.
const loaders = {
  azure: () => import('@azure/opentelemetry-instrumentation-azure-sdk'),
  redis: () => import('@opentelemetry/instrumentation-redis'),
  ioredis: () => import('@opentelemetry/instrumentation-ioredis'),
  mongodb: () => import('@opentelemetry/instrumentation-mongodb'),
  knex: () => import('@opentelemetry/instrumentation-knex'),
  aws: () => import('@opentelemetry/instrumentation-aws-sdk'),
  kafkajs: () => import('@opentelemetry/instrumentation-kafkajs'),
  amqplib: () => import('@opentelemetry/instrumentation-amqplib'),
  winston: () => import('@opentelemetry/instrumentation-winston'),
  undici: () => import('@opentelemetry/instrumentation-undici'),
  fetch: () => import('@opentelemetry/instrumentation-fetch'),
};
export async function bundleProbes(url) {
  const root = trace.getActiveSpan().spanContext();
  const results = {};
  for (const [name, load] of Object.entries(loaders)) {
    const module = await load();
    const Constructor = Object.values(module).find(value => typeof value === 'function' && value.name.endsWith('Instrumentation'));
    try {
      const instrumentation = new Constructor({ disableLogSending: true });
      instrumentation.setTracerProvider(trace.getTracerProvider());
      instrumentation.disable();
      results[name] = 'initialized';
    } catch (error) {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /enable is not a function/);
      results[name] = 'node-loader-unavailable';
    }
  }
  assert.deepEqual(trace.getActiveSpan().spanContext(), root);
  // Workers provides PerformanceObserver, so web fetch instrumentation wraps
  // fetch. CLIENT spans must fall back without duplicating the native HTTP span.
  const { FetchInstrumentation } = await loaders.fetch();
  let attempts = 0;
  const instrumentation = new FetchInstrumentation();
  instrumentation.setTracerProvider({ getTracer: () => ({ ...trace.getTracer('bundle'), startSpan(...args) { attempts++; const span = trace.getTracer('bundle').startSpan(...args); assert.equal(span.isRecording(), false); assert.deepEqual(span.spanContext(), root); return span; } }) });
  try {
    assert.equal((await fetch(url)).ok, true);
    assert.equal(attempts, 1);
  } finally { instrumentation.disable(); }
  return { ...results, fetchAttempts: attempts };
}

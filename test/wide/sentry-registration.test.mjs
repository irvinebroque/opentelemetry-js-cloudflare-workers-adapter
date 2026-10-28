import { beforeEach, afterEach, expect, test } from 'vitest';
import { context, trace, ROOT_CONTEXT } from '@opentelemetry/api';
import { withSentry } from '@sentry/cloudflare';
import { invocation } from '../native.js';
import { register } from '../../src/index.js';

beforeEach(() => { context.disable(); trace.disable(); });
afterEach(() => { context.disable(); trace.disable(); });
async function initialize(callback) {
  const pending = [];
  const worker = withSentry(() => ({ dsn: 'https://synthetic@example.invalid/1', cacheClient: false,
    defaultIntegrations: false, enableOpenTelemetrySetup: true,
    transport: () => ({ send: async () => ({}), flush: async () => true }) }), {
    fetch() { callback(); return new Response('ok'); },
  });
  await worker.fetch(new Request('https://example.test'), {}, { waitUntil: p => pending.push(p), passThroughOnException() {} });
  await Promise.all(pending);
}
test('Sentry OTel setup after the bridge cannot replace its provider or active IDs', async () => {
  register();
  const provider = trace.getTracerProvider();
  await invocation(root => initialize(() => {
    expect(trace.getTracerProvider()).toBe(provider);
    expect(trace.getActiveSpan().spanContext()).toEqual(root.spanContext());
  }));
});
test('Sentry OTel setup before the bridge produces a clear conflict and rolls back our context manager', async () => {
  await initialize(() => {});
  const provider = trace.getTracerProvider();
  expect(register).toThrow('tracer provider is already registered');
  expect(trace.getTracerProvider()).toBe(provider);
  expect(context.active()).toBe(ROOT_CONTEXT);
});

import { expect, test } from 'vitest';
import { trace } from '@opentelemetry/api';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { register } from '../../src/index.js';
import { invocation, recorded } from '../native.js';
import { httpFixture } from './servers.mjs';
register();
test('web fetch wrapper preserves responses, errors and native parents with CLIENT-span fallback', async () => {
  const server = await httpFixture();
  const instrumentation = new FetchInstrumentation();
  const spans = [];
  const tracer = trace.getTracer('web-fetch');
  instrumentation.setTracerProvider({ getTracer: () => ({ ...tracer, startSpan(...args) {
    const span = tracer.startSpan(...args); spans.push(span); return span;
  } }) });
  try {
    await invocation(async root => {
      recorded.length = 0;
      expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe('ok');
      expect((await fetch(`http://127.0.0.1:${server.port}/error`)).status).toBe(500);
      expect(spans).toHaveLength(2);
      for (const span of spans) {
        expect(span.isRecording()).toBe(false);
        expect(span.spanContext()).toEqual(root.spanContext());
      }
      expect(recorded).toHaveLength(0);
      expect(trace.getActiveSpan().spanContext()).toEqual(root.spanContext());
    });
  } finally { instrumentation.disable(); await server.close(); }
});

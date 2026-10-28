import { expect, test } from 'vitest';
import { context, trace, INVALID_SPAN_CONTEXT } from '@opentelemetry/api';
import { suppressTracing, unsuppressTracing } from '@opentelemetry/core';
import { register } from '../src/index.js';
import { invocation, recorded } from './native.js';

register();
const tracer = trace.getTracer('suppression');

test('core suppressTracing prevents native spans, preserves callbacks, and restores context', async () => {
  await invocation(async root => {
    recorded.length = 0;
    const suppressed = suppressTracing(context.active());
    expect(tracer.startSpan('explicit', {}, suppressed).spanContext()).toEqual(INVALID_SPAN_CONTEXT);
    await context.with(suppressed, async () => {
      expect(tracer.startSpan('ambient').isRecording()).toBe(false);
      expect(await tracer.startActiveSpan('active', async span => {
        expect(span.spanContext()).toEqual(INVALID_SPAN_CONTEXT);
        await Promise.resolve();
        expect(trace.getActiveSpan()).toBe(span);
        expect(tracer.startSpan('nested').spanContext()).toEqual(INVALID_SPAN_CONTEXT);
        return 42;
      })).toBe(42);
      const error = new Error('application failure');
      await expect(tracer.startActiveSpan('error', async () => { throw error; })).rejects.toBe(error);
    });
    expect(recorded).toHaveLength(0);
    expect(trace.getActiveSpan()?.spanContext()).toEqual(root.spanContext());
    const span = tracer.startSpan('restored', {}, unsuppressTracing(suppressed));
    expect(span.isRecording()).toBe(true);
    span.end();
  });
});

test('suppression is honored when no native parent is exposed', () => {
  const span = tracer.startSpan('hidden-parent', {}, suppressTracing(context.active()));
  expect(span.spanContext()).toEqual(INVALID_SPAN_CONTEXT);
});

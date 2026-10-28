import assert from 'node:assert/strict';
import { trace, SpanStatusCode } from '@opentelemetry/api';
const tracer = trace.getTracer('limits');

export function exerciseLimits() {
  const root = trace.getActiveSpan().spanContext();
  const names = ['x'.repeat(64), 'x'.repeat(65), '界'.repeat(22), '🙂'.repeat(17), '\uFEFF' + 'x'.repeat(64)];
  const spans = names.map(name => {
    const span = tracer.startSpan(name);
    assert.equal(span.isRecording(), true);
    const ids = span.spanContext();
    span.setAttribute('limit.sentinel', 'name');
    span.end();
    return { ids, name };
  });
  for (const kind of ['attribute', 'exception', 'total']) {
    const span = tracer.startSpan(`lifecycle.limit.${kind}`);
    // Huge input must not break application behavior or poison later spans.
    span.setAttribute('limit.before', true);
    if (kind === 'attribute') span.setAttribute('large', '界'.repeat(65536));
    if (kind === 'exception') span.recordException(new Error('🙂'.repeat(65536)));
    if (kind === 'total') for (let i = 0; i < 100; i++) span.setAttribute(`payload.${i}`, 'x'.repeat(1024));
    span.setAttribute('limit.after', true).setStatus({ code: SpanStatusCode.OK });
    span.end();
    spans.push({ ids: span.spanContext(), name: `lifecycle.limit.${kind}` });
  }
  const survivor = tracer.startSpan('lifecycle.limit.survivor');
  survivor.setAttribute('result', 42); survivor.end();
  assert.deepEqual(trace.getActiveSpan().spanContext(), root);
  return { root, spans, survivor: survivor.spanContext() };
}

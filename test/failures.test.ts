import { afterEach, expect, test, vi } from 'vitest';
import { context, trace, diag, ROOT_CONTEXT, INVALID_SPAN_CONTEXT, type Attributes, type Context, type SpanOptions, type SpanStatus } from '@opentelemetry/api';
import { register } from '../src/index.js';
import { invocation, recorded, tracing } from './native.js';

register();
const tracer = trace.getTracer('failures');
afterEach(() => vi.restoreAllMocks());

test('logs-only invocations retain correlation in non-recording child spans', () => invocation(root => {
  const parent = root.spanContext();
  const child = tracer.startSpan('logs-only');
  expect(child.isRecording()).toBe(false);
  expect(child.spanContext()).toEqual(parent);
  tracer.startActiveSpan('logs-only-active', span => {
    expect(span.spanContext()).toEqual(parent);
    expect(trace.getActiveSpan()).toBe(span);
    expect(tracer.startSpan('nested').spanContext()).toEqual(parent);
  });
}, false));

test('span identity remains readable when the native request object expires', () => invocation(() => {
  const span = tracer.startSpan('retained');
  const ids = span.spanContext();
  const native = recorded.at(-1)!;
  const expired = () => { throw new Error('Cannot perform I/O on behalf of a different request'); };
  vi.spyOn(native, 'spanContext').mockImplementation(expired);
  vi.spyOn(native, 'isTraced', 'get').mockImplementation(expired);
  for (const method of ['setAttribute', 'setStatus', 'updateName', 'recordException', 'end'] as const) {
    vi.spyOn(native, method).mockImplementation(expired);
  }
  expect(span.spanContext()).toEqual(ids);
  expect(span.isRecording()).toBe(false);
  expect(() => {
    span.setAttribute('key', 'value').setStatus({ code: 2 }).updateName('late');
    span.recordException('late'); span.end();
  }).not.toThrow();
}));

test('malformed telemetry and throwing property getters cannot break application work', () => invocation(() => {
  const span = tracer.startSpan('input');
  const attributes = { get bad(): string { throw new Error('secret attribute payload'); } };
  expect(() => span.setAttributes(attributes)).not.toThrow();
  expect(() => span.setAttributes(null as unknown as Attributes)).not.toThrow();
  expect(() => span.setStatus(null as unknown as SpanStatus)).not.toThrow();
  const options = { get attributes(): Attributes { throw new Error('secret options payload'); } };
  let calls = 0;
  expect(tracer.startActiveSpan('input', options, () => ++calls)).toBe(1);
  expect(calls).toBe(1);
  expect(tracer.startActiveSpan('input', {}, null as unknown as Context, () => 42)).toBe(42);
  expect(() => tracer.startSpan('input', null as unknown as SpanOptions)).not.toThrow();
}));

test('native creation failures still run application callbacks exactly once', () => invocation(root => {
  vi.spyOn(tracing, 'startSpan').mockImplementation(() => { throw new Error('native failure'); });
  expect(tracer.startSpan('failed').spanContext()).toEqual(root.spanContext());
  const promise = Promise.resolve('application result');
  const callback = vi.fn(() => promise);
  expect(tracer.startActiveSpan('failed', callback)).toBe(promise);
  expect(callback).toHaveBeenCalledOnce();
  const error = new Error('application failure');
  const throwing = vi.fn(() => { throw error; });
  expect(() => tracer.startActiveSpan('failed', throwing)).toThrow(error);
  expect(throwing).toHaveBeenCalledOnce();
}));

test('diagnostic logger failures do not escape and messages omit telemetry payloads', () => invocation(() => {
  const warn = vi.spyOn(diag, 'warn').mockImplementation(() => { throw new Error('logger failed'); });
  expect(() => tracer.startSpan('private name').addEvent('private event')).not.toThrow();
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
}));

test('overridden parent trace flags are never silently replaced by native flags', () => invocation(root => {
  const parent = { ...root.spanContext(), traceFlags: 1 };
  const span = tracer.startSpan('flags', {}, trace.setSpanContext(context.active(), parent));
  expect(span.isRecording()).toBe(false);
  expect(span.spanContext()).toEqual(parent);
}));

test('status precedence also holds for invocation spans that emit independent native updates', () => invocation(root => {
  const set = vi.spyOn(root, 'setStatus').mockImplementation(() => root);
  const span = trace.getActiveSpan()!;
  span.setStatus({ code: 2, message: 'error' }).setStatus({ code: 0 });
  span.setStatus({ code: 1 }).setStatus({ code: 2, message: 'late error' });
  expect(set.mock.calls).toEqual([[{ code: 'error', message: 'error' }], [{ code: 'ok', message: undefined }]]);
}));

test('native failures after entering the callback never retry it or replace its error', () => invocation(() => {
  const applicationError = new Error('original application error');
  const callback = vi.fn(() => { throw applicationError; });
  expect(() => tracer.startActiveSpan('callback', callback)).toThrow(applicationError);
  expect(callback).toHaveBeenCalledOnce();
  const promise = Promise.reject(applicationError);
  promise.catch(() => {});
  expect(tracer.startActiveSpan('async-callback', () => promise)).toBe(promise);
}));

test('malformed status codes cannot reach native validation through array prototype keys', () => invocation(() => {
  const span = tracer.startSpan('status');
  const set = vi.spyOn(recorded.at(-1)!, 'setStatus');
  for (const code of ['toString', 'constructor', -1, 0.5, 3, NaN, null]) {
    span.setStatus({ code } as unknown as SpanStatus);
  }
  expect(set).not.toHaveBeenCalled();
}));

test('mutating a returned span context cannot corrupt later correlation', () => invocation(() => {
  const span = tracer.startSpan('immutable-ids');
  const expected = span.spanContext();
  span.spanContext().spanId = '0'.repeat(16);
  expect(span.spanContext()).toEqual(expected);
}));

test('an unexposed native ambient parent permits default creation but not explicit detached contexts', () => invocation(root => {
  const getActive = tracing.getActiveSpan;
  vi.spyOn(tracing, 'getActiveSpan').mockImplementation(() => {
    const active = getActive();
    return active === root ? undefined : active;
  });
  expect(trace.getActiveSpan()).toBeUndefined();
  tracer.startActiveSpan('websocket', span => {
    expect(span.isRecording()).toBe(true);
    expect(trace.getActiveSpan()).toBe(span);
    const child = tracer.startSpan('child');
    expect(recorded.at(-1)?.parent?.spanContext()).toEqual(span.spanContext());
    child.end(); span.end();
  });
  const manual = tracer.startSpan('manual-websocket');
  expect(manual.isRecording()).toBe(true); manual.end();
  expect(tracer.startSpan('explicit', {}, ROOT_CONTEXT).spanContext()).toEqual(INVALID_SPAN_CONTEXT);
  context.with(ROOT_CONTEXT, () => {
    expect(tracer.startSpan('overridden').spanContext()).toEqual(INVALID_SPAN_CONTEXT);
  });
  expect(tracer.startSpan('detached', { root: true }).spanContext()).toEqual(INVALID_SPAN_CONTEXT);
}));

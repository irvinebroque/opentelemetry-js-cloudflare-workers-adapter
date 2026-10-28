import { beforeEach, expect, test, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  context, trace, ROOT_CONTEXT, SpanStatusCode, createContextKey, propagation, diag,
  INVALID_SPAN_CONTEXT, createTraceState, SpanKind, type Span,
} from '@opentelemetry/api';
import { register } from '../src/index.js';
import { invocation, recorded, tracing } from './native.js';

const earlyTracer = trace.getTracer('before-registration');
const provider = register();
const tracer = trace.getTracer('tests', '1.0');
const key = createContextKey('test-value');
beforeEach(() => { recorded.length = 0; });

test('register is idempotent and activates previously acquired tracers', () => {
  expect(register()).toBe(provider);
  invocation(() => {
    const span = earlyTracer.startSpan('early');
    expect(span.spanContext().traceId).toBe(trace.getActiveSpan()?.spanContext().traceId);
    expect(recorded.at(-1)?.name).toBe('early');
    span.end();
  });
});

test('native invocation IDs are visible to ordinary OTel loggers', () => {
  expect(trace.getActiveSpan()).toBeUndefined();
  invocation(root => {
    const span = trace.getActiveSpan()!;
    expect(span.spanContext()).toEqual(root.spanContext());
    expect(trace.getActiveSpan()).toBe(span);
    span.setAttribute('root', true).end();
    expect(root.ended).toBe(false);
    expect(root.attributes.root).toBe(true);
  });
  expect(trace.getActiveSpan()).toBeUndefined();
});

test('all startActiveSpan overloads preserve sync return values and native nesting', () => invocation(root => {
  const parent = context.active().setValue(key, 123);
  expect(tracer.startActiveSpan('one', span => {
    expect(trace.getActiveSpan()).toBe(span);
    expect(tracing.getActiveSpan()?.spanContext()).toEqual(span.spanContext());
    span.end();
    return 1;
  })).toBe(1);
  expect(tracer.startActiveSpan('two', { attributes: { a: true } }, span => { span.end(); return 2; })).toBe(2);
  expect(tracer.startActiveSpan('three', {}, parent, span => {
    expect(context.active().getValue(key)).toBe(123);
    const child = tracer.startSpan('child');
    expect(recorded.at(-1)?.parent?.spanContext()).toEqual(span.spanContext());
    expect(trace.getActiveSpan()).toBe(span);
    child.end(); span.end(); return 3;
  })).toBe(3);
  expect(trace.getActiveSpan()?.spanContext()).toEqual(root.spanContext());
}));

test('async nesting, native calls, and baggage share the active span', async () => invocation(async () => {
  const baggage = propagation.createBaggage({ tenant: { value: 'test' } });
  const ctx = propagation.setBaggage(context.active(), baggage);
  await context.with(ctx, () => tracer.startActiveSpan('parent', async parent => {
    await Promise.resolve();
    expect(propagation.getBaggage(context.active())).toBe(baggage);
    expect(trace.getActiveSpan()).toBe(parent);
    await tracing.startActiveSpan('native', async native => {
      await Promise.resolve();
      expect(trace.getActiveSpan()?.spanContext()).toEqual(native.spanContext());
      expect(propagation.getBaggage(context.active())).toBe(baggage);
      tracer.startSpan('otel-child').end();
      expect(recorded.at(-1)?.parent).toBe(native);
      native.end();
    });
    expect(trace.getActiveSpan()).toBe(parent);
    parent.end();
  }));
}));

test('concurrent requests and concurrent sibling operations cannot leak context', async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => invocation(async root => {
    await context.with(context.active().setValue(key, i), async () => {
      await Promise.all(['a', 'b'].map(name => tracer.startActiveSpan(name, async span => {
        await new Promise(resolve => setTimeout(resolve, i % 3));
        expect(context.active().getValue(key)).toBe(i);
        expect(trace.getActiveSpan()).toBe(span);
        expect(span.spanContext().traceId).toBe(root.traceId);
        span.end();
      })));
      expect(trace.getActiveSpan()?.spanContext()).toEqual(root.spanContext());
    });
  })));
  expect(context.active().getValue(key)).toBeUndefined();
});

test('context.with and bind preserve this, arguments, values, and thrown errors', () => invocation(() => {
  const ctx = context.active().setValue(key, 'bound');
  const receiver = { n: 3 };
  function callback(this: typeof receiver, n: number) {
    expect(context.active()).toBe(ctx);
    return this.n + n;
  }
  expect(context.with(ctx, callback, receiver, 4)).toBe(7);
  expect(context.bind(ctx, callback).call(receiver, 5)).toBe(8);
  const error = new Error('unchanged');
  expect(() => context.with(ctx, () => { throw error; })).toThrow(error);
  expect(context.active().getValue(key)).toBeUndefined();
}));

test('startSpan does not activate or auto-end; startActiveSpan does not auto-end even on errors', async () => invocation(async () => {
  const previous = trace.getActiveSpan();
  const manual = tracer.startSpan('manual');
  expect(trace.getActiveSpan()).toBe(previous);
  let opened!: Span;
  expect(() => tracer.startActiveSpan('sync-error', span => { opened = span; throw new Error('sync'); })).toThrow('sync');
  expect(opened.isRecording()).toBe(true);
  opened.end();
  await expect(tracer.startActiveSpan('async-error', async span => { opened = span; throw new Error('async'); })).rejects.toThrow('async');
  expect(opened.isRecording()).toBe(true);
  opened.end(); manual.end();
  expect(trace.getActiveSpan()).toBe(previous);
}));

test('scalar attributes, status mapping, exception recording, and lifetime', () => invocation(() => {
  const span = tracer.startSpan('old', { attributes: { scalar: 1, array: ['x', null, 'y'], skipped: undefined } });
  const native = recorded.at(-1)!;
  expect(span.setAttributes({ yes: true }).setAttribute('', 'ignored').updateName('new')).toBe(span);
  expect(native.attributes).toEqual({ scalar: 1, yes: true });
  span.setStatus({ code: SpanStatusCode.ERROR, message: 'failed' });
  expect(native.status).toEqual({ code: 'error', message: 'failed' });
  span.setStatus({ code: SpanStatusCode.UNSET });
  expect(native.status.code).toBe('error');
  span.setStatus({ code: SpanStatusCode.OK, message: 'ignored' }).setStatus({ code: SpanStatusCode.ERROR });
  expect(native.status.code).toBe('ok');
  expect(native.status.message).toBeUndefined();
  const error = new Error('original');
  span.recordException(error);
  expect(native.exceptions).toEqual([error]);
  const ids = span.spanContext();
  span.end(); span.end(); span.setAttribute('late', true).updateName('late');
  expect(span.isRecording()).toBe(false);
  expect(span.spanContext()).toEqual(ids);
  expect(native.name).toBe('new');
  expect(native.attributes.late).toBeUndefined();
}));

test('unsupported parents use no-op propagation and never export incorrect relationships', () => invocation(root => {
  const remote = {
    traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1, isRemote: true,
    traceState: createTraceState('vendor=value'),
  };
  const remoteContext = trace.setSpanContext(context.active().setValue(key, 'remote'), remote);
  context.with(remoteContext, () => {
    expect(trace.getActiveSpan()?.spanContext()).toEqual(remote);
    const child = tracer.startSpan('unsupported');
    expect(child.isRecording()).toBe(false);
    expect(child.spanContext()).toEqual(remote);
    expect(tracer.startActiveSpan('unsupported-active', span => {
      expect(trace.getActiveSpan()).toBe(span);
      expect(context.active().getValue(key)).toBe('remote');
      expect(tracer.startSpan('descendant').isRecording()).toBe(false);
      return 42;
    })).toBe(42);
  });
  for (const parent of [ROOT_CONTEXT, trace.deleteSpan(context.active())]) {
    context.with(parent, () => {
      expect(trace.getActiveSpan()).toBeUndefined();
      expect(tracer.startSpan('detached').spanContext()).toEqual(INVALID_SPAN_CONTEXT);
    });
  }
  tracer.startActiveSpan('root', { root: true }, span => {
    expect(span.spanContext()).toEqual(INVALID_SPAN_CONTEXT);
    expect(tracer.startSpan('root-child').spanContext()).toEqual(INVALID_SPAN_CONTEXT);
  });
  expect(recorded).toEqual([root]);
}));

test('reactivating a manual span keeps OTel context but does not record a wrongly parented child', () => invocation(() => {
  const manual = tracer.startSpan('manual');
  const bound = context.bind(trace.setSpan(context.active(), manual), () => {
    expect(trace.getActiveSpan()).toBe(manual);
    const child = tracer.startSpan('child');
    expect(child.isRecording()).toBe(false);
    expect(child.spanContext()).toEqual(manual.spanContext());
  });
  bound();
  expect(recorded.map(span => span.name)).toEqual(['invocation', 'manual']);
  manual.end();
}));

test('unsupported creation options yield non-recording spans with parent context', () => invocation(root => {
  for (const options of [
    { kind: SpanKind.CLIENT }, { startTime: 0 }, { links: [{ context: root.spanContext() }] },
  ]) {
    const span = tracer.startSpan('unsupported', options);
    expect(span.isRecording()).toBe(false);
    expect(span.spanContext()).toEqual(root.spanContext());
  }
  const withState = { ...root.spanContext(), traceState: createTraceState('vendor=value') };
  const span = tracer.startSpan('with-state', {}, trace.setSpanContext(context.active(), withState));
  expect(span.isRecording()).toBe(false);
  expect(span.spanContext()).toEqual(withState);
  expect(recorded).toEqual([root]);
}));

test('outside an invocation and invalid parent contexts cannot create native spans', () => {
  expect(tracer.startSpan('outside').spanContext()).toEqual(INVALID_SPAN_CONTEXT);
  expect(recorded).toEqual([]);
  invocation(root => {
    const invalid = { traceId: 'invalid', spanId: 'bad', traceFlags: 0 };
    const span = tracer.startSpan('invalid', {}, trace.setSpanContext(context.active(), invalid));
    expect(span.spanContext()).toEqual(INVALID_SPAN_CONTEXT);
    expect(recorded).toEqual([root]);
  });
});

test('non-scalar attributes are dropped without serializing, executing hooks, or throwing', () => invocation(() => {
  const span = tracer.startSpan('attributes');
  const native = recorded.at(-1)!;
  const toJSON = vi.fn(() => { throw new Error('must not execute'); });
  const cycle: unknown[] = []; cycle.push(cycle);
  const set = span.setAttribute.bind(span) as (key: string, value: unknown) => Span;
  for (const value of [cycle, Object.assign([1], { toJSON }), [1n], { nested: true }, null]) {
    expect(set('unsupported', value)).toBe(span);
  }
  span.setAttributes({ empty: '', no: false, zero: 0, nan: NaN, infinity: Infinity });
  expect(toJSON).not.toHaveBeenCalled();
  expect(native.attributes).toEqual({ empty: '', no: false, zero: 0, nan: NaN, infinity: Infinity });
  span.end();
}));

test('unsupported annotations remain callable and diagnostics contain no user payloads', () => invocation(() => {
  const warn = vi.spyOn(diag, 'warn');
  const span = tracer.startSpan('private-name');
  expect(span.addEvent('private-event', { private: 'secret' }).addLink({ context: span.spanContext() }).addLinks([])).toBe(span);
  span.recordException('private-error', 0);
  span.end(0);
  expect(warn).toHaveBeenCalled();
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  warn.mockRestore();
}));

test('disabled tracing keeps correlation readable and recording false', () => invocation(root => {
  const span = trace.getActiveSpan()!;
  expect(span.isRecording()).toBe(false);
  span.setAttribute('ignored', true);
  expect(root.attributes).toEqual({});
  expect(span.spanContext()).toEqual(root.spanContext());
}, false));

test('activating an OTel context never rewinds unrelated application async state', () => invocation(() => {
  const application = new AsyncLocalStorage<string>();
  const captured = application.run('old', () => context.active().setValue(key, 'otel'));
  application.run('new', () => context.with(captured, () => {
    expect(application.getStore()).toBe('new');
    expect(context.active().getValue(key)).toBe('otel');
  }));
}));

test('ending an active span does not deactivate it or end its children', () => invocation(() => {
  tracer.startActiveSpan('parent', parent => {
    const first = tracer.startSpan('first');
    const native = tracing.getActiveSpan();
    parent.end();
    expect(trace.getActiveSpan()).toBe(parent);
    expect(first.isRecording()).toBe(true);
    const second = tracer.startSpan('second');
    expect(recorded.at(-1)?.parent).toBe(native);
    first.end(); second.end();
  });
}));

test('no-op active spans preserve promise identity and synchronous errors', () => invocation(() => {
  const promise = Promise.resolve(1);
  expect(tracer.startActiveSpan('root', { root: true }, () => promise)).toBe(promise);
  const error = new Error('application failure');
  expect(() => tracer.startActiveSpan('root', { root: true }, () => { throw error; })).toThrow(error);
}));

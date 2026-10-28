import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { context, trace, ROOT_CONTEXT, ProxyTracerProvider, type ContextManager } from '@opentelemetry/api';
let invocation: typeof import('./native.js').invocation;

beforeEach(async () => {
  context.disable(); trace.disable(); vi.resetModules();
  ({ invocation } = await import('./native.js'));
});
afterEach(() => { context.disable(); trace.disable(); });

function otherManager(): ContextManager {
  return {
    active: () => ROOT_CONTEXT,
    with: (_context, fn, receiver, ...args) => fn.apply(receiver, args),
    bind: (_context, target) => target,
    enable() { return this; },
    disable() { return this; },
  };
}

test('refuses to replace another context manager', async () => {
  expect(context.setGlobalContextManager(otherManager())).toBe(true);
  const before = trace.getTracerProvider();
  const { register } = await import('../src/index.js');
  expect(register).toThrow('context manager is already registered');
  expect(trace.getTracerProvider()).toBe(before);
  invocation(() => expect(context.active()).toBe(ROOT_CONTEXT));
});

test('provider conflict rolls back only our context manager and permits retry', async () => {
  expect(trace.setGlobalTracerProvider(new ProxyTracerProvider())).toBe(true);
  const before = trace.getTracerProvider();
  const { register } = await import('../src/index.js');
  expect(register).toThrow('tracer provider is already registered');
  expect(trace.getTracerProvider()).toBe(before);
  expect(context.setGlobalContextManager(otherManager())).toBe(true);
  context.disable(); trace.disable();
  expect(register()).toBeDefined();
});

test('register works again after global teardown without returning a stale success', async () => {
  const { register } = await import('../src/index.js');
  const first = register();
  expect(register()).toBe(first);
  context.disable(); trace.disable();
  expect(register()).toBe(first);
  invocation(root => expect(trace.getActiveSpan()?.spanContext()).toEqual(root.spanContext()));
});

test('module reload reuses its installed provider and context, then permits a fresh registration after teardown', async () => {
  const firstModule = await import('../src/index.js');
  const first = firstModule.register();
  const originalInvocation = invocation;
  vi.resetModules();
  const secondModule = await import('../src/index.js');
  expect(secondModule.register).not.toBe(firstModule.register);
  expect(secondModule.register()).toBe(first);
  originalInvocation(root => expect(trace.getActiveSpan()?.spanContext()).toEqual(root.spanContext()));
  context.disable(); trace.disable();
  expect(secondModule.register()).not.toBe(first);
  const { invocation: reloadedInvocation } = await import('./native.js');
  reloadedInvocation(root => expect(trace.getActiveSpan()?.spanContext()).toEqual(root.spanContext()));
});

test('reloaded modules still reject a competing context manager', async () => {
  const { register } = await import('../src/index.js');
  register();
  context.disable();
  expect(context.setGlobalContextManager(otherManager())).toBe(true);
  vi.resetModules();
  const reloaded = await import('../src/index.js');
  expect(reloaded.register).toThrow('context manager is already registered');
});

test.each(['context', 'trace'])('partial %s teardown does not report a successful registration', async which => {
  const { register } = await import('../src/index.js');
  register();
  if (which === 'context') context.disable(); else trace.disable();
  expect(register).toThrow('already registered');
  context.disable(); trace.disable();
  register();
  invocation(root => expect(trace.getActiveSpan()?.spanContext()).toEqual(root.spanContext()));
});

test('missing native APIs fail during initialization without installing OTel globals', async () => {
  const { tracing } = await import('./native.js');
  const original = tracing.startActiveSpan;
  Object.defineProperty(tracing, 'startActiveSpan', { value: undefined, writable: true, configurable: true });
  try {
    const { register } = await import('../src/index.js');
    expect(register).toThrow('runtime lacks required native tracing APIs');
    expect(context.setGlobalContextManager(otherManager())).toBe(true);
    expect(trace.setGlobalTracerProvider(new ProxyTracerProvider())).toBe(true);
  } finally { tracing.startActiveSpan = original; }
});

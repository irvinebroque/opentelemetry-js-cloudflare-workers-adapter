import { AsyncLocalStorage } from 'node:async_hooks';
import { tracing } from 'cloudflare:workers';
import {
  context, trace, diag, ROOT_CONTEXT, INVALID_SPAN_CONTEXT, SpanKind, createContextKey,
  type Attributes, type Context, type ContextManager, type Exception, type Link,
  type Span, type SpanContext, type SpanOptions, type SpanStatus, type TimeInput, type Tracer, type TracerProvider,
} from '@opentelemetry/api';

type NativeSpan = ReturnType<typeof tracing.startSpan>;
type Scope = { context: Context; native: NativeSpan | undefined };
const spans = new WeakMap<NativeSpan, Span>();
const reported = new Set<string>();
// Shared with @opentelemetry/core's suppressTracing(), without an SDK dependency.
const suppressionKey = createContextKey('OpenTelemetry SDK Context Key SUPPRESS_TRACING');
const suppressed = (parent: Context) => parent.getValue(suppressionKey) === true;

function unsupported(feature: string): void {
  if (reported.has(feature)) return;
  reported.add(feature);
  try { diag.warn(`[workers-otel] Unsupported: ${feature}. See the adapter's compatibility notes.`); } catch {}
}

// Catch telemetry failures only. Application callbacks must stay outside this boundary.
function safely<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { unsupported('telemetry operation failed (ignored)'); }
}

function wrap(native: NativeSpan): Span {
  let span = spans.get(native);
  if (!span) spans.set(native, span = new WorkersSpan(native));
  return span;
}

class WorkersSpan implements Span {
  private readonly ids: SpanContext;
  private status = 0;
  constructor(private readonly native: NativeSpan) { this.ids = native.spanContext(); }
  // Native spans are request-owned I/O objects. IDs must outlive that request.
  spanContext() { return { ...this.ids }; }
  isRecording() { return safely(() => this.native.isTraced) ?? false; }

  setAttribute(key: string, value: unknown): this {
    if (!this.isRecording() || typeof key !== 'string' || !key || value === undefined) return this;
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
      safely(() => this.native.setAttribute(key, value));
    } else {
      unsupported('non-scalar attributes (dropped)');
    }
    return this;
  }
  setAttributes(attributes: Attributes): this {
    if (this.isRecording()) safely(() => {
      for (const [key, value] of Object.entries(attributes ?? {})) this.setAttribute(key, value);
    });
    return this;
  }
  setStatus(status: SpanStatus): this {
    safely(() => {
      const code = status?.code === 2 ? 'error' : status?.code === 1 ? 'ok' : undefined;
      if (code && this.status !== 1) {
        this.native.setStatus({ code,
          message: code === 'error' && typeof status.message === 'string' ? status.message : undefined });
        this.status = status.code;
      }
    });
    return this;
  }
  updateName(name: string): this {
    if (typeof name === 'string') safely(() => this.native.updateName(name));
    return this;
  }
  recordException(exception: Exception, time?: TimeInput): void {
    if (time !== undefined) unsupported('custom exception timestamps (using runtime time)');
    safely(() => this.native.recordException(exception));
  }
  end(time?: TimeInput): void {
    if (time !== undefined) unsupported('custom end timestamps (using runtime time)');
    safely(() => this.native.end());
  }
  addEvent(_name: string, _attributesOrTime?: Attributes | TimeInput, _time?: TimeInput): this {
    unsupported('span events other than recordException (dropped)');
    return this;
  }
  addLink(_link: Link): this { unsupported('span links (dropped)'); return this; }
  addLinks(links: Link[]): this {
    safely(() => { if (links?.length) unsupported('span links (dropped)'); });
    return this;
  }
}

class WorkersContextManager implements ContextManager {
  storage?: AsyncLocalStorage<Scope>;

  active(): Context {
    if (!this.storage) return ROOT_CONTEXT;
    const scope = this.storage.getStore();
    const native = safely(() => tracing.getActiveSpan());
    // Explicit OTel overrides win until code enters a new native span scope.
    if (scope && native === scope.native) return scope.context;
    const base = scope?.context ?? ROOT_CONTEXT;
    return native ? safely(() => trace.setSpan(base, wrap(native))) ?? base : base;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A
  ): ReturnType<F> {
    const run = () => Reflect.apply(fn, thisArg, args);
    return this.storage ? this.storage.run({ context: context ?? ROOT_CONTEXT,
      native: safely(() => tracing.getActiveSpan()) }, run) : run();
  }
  bind<T>(context: Context, target: T): T {
    if (typeof target !== 'function') {
      unsupported('context.bind on non-functions (unchanged)');
      return target;
    }
    const manager = this;
    return function (this: unknown, ...args: unknown[]) {
      return manager.with(context, () => Reflect.apply(target, this, args));
    } as T;
  }
  enable(): this { this.storage ??= new AsyncLocalStorage<Scope>(); return this; }
  // Workers has no ALS.disable(). Drop access to old scopes instead.
  disable(): this { this.storage = undefined; return this; }
}

/** Use OTel's no-op propagation semantics when native creation cannot be faithful. */
function nonRecording(options: SpanOptions, parent: Context): Span {
  const wanted = safely(() => options?.root || suppressed(parent) ? undefined : trace.getSpanContext(parent));
  return trace.wrapSpanContext(wanted && safely(() => trace.isSpanContextValid(wanted)) ? wanted : INVALID_SPAN_CONTEXT);
}

function canCreate(options: SpanOptions, noop: Span, implicit: boolean): boolean {
  const wanted = noop.spanContext();
  const actual = tracing.getActiveSpan()?.spanContext();
  const scope = manager.storage?.getStore();
  // Hibernatable WebSocket events can have a native parent without exposing an
  // active span. Only default ambient creation may ask the runtime to use it.
  const hiddenParent = !actual && implicit && !options.root && !trace.isSpanContextValid(wanted) &&
    (!scope || (scope.context !== ROOT_CONTEXT && !trace.getSpan(scope.context)));
  if (!hiddenParent && (!actual || !trace.isSpanContextValid(actual))) return false;
  let reason: string | undefined;
  if (!hiddenParent && (!trace.isSpanContextValid(wanted) || wanted.isRemote || wanted.traceState?.serialize() ||
      wanted.traceId !== actual?.traceId || wanted.spanId !== actual?.spanId || wanted.traceFlags !== actual?.traceFlags)) {
    reason = 'parent context';
  } else if (options.kind !== undefined && options.kind !== SpanKind.INTERNAL) {
    reason = 'span kind';
  } else if (options.startTime !== undefined) {
    reason = 'custom start timestamp';
  } else if (options.links?.length) {
    reason = 'links at span creation';
  }
  if (!reason) return true;
  unsupported(`${reason} (span will not record)`);
  return false;
}

function created(native: NativeSpan, options: SpanOptions, noop: Span): Span {
  const span = safely(() => wrap(native));
  // Native non-recording children may have zero IDs even in a logs-only invocation.
  if (!span || !trace.isSpanContextValid(span.spanContext())) {
    safely(() => native.end());
    return noop;
  }
  safely(() => span.setAttributes(options.attributes ?? {}));
  return span;
}

const tracer: Tracer = {
  startSpan(name, options = {}, parent) {
    options ??= {};
    const implicit = parent === undefined;
    parent ??= context.active();
    const noop = nonRecording(options, parent);
    return safely(() => !suppressed(parent) && canCreate(options, noop, implicit)
      ? created(tracing.startSpan(typeof name === 'string' ? name : 'unnamed'), options, noop) : noop) ?? noop;
  },
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string, optionsOrFn: SpanOptions | F | undefined,
    parentOrFn?: Context | F, maybeFn?: F,
  ): ReturnType<F> {
    const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn ?? {};
    const parent = parentOrFn && typeof parentOrFn === 'object' ? parentOrFn : context.active();
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn
      : typeof parentOrFn === 'function' ? parentOrFn : maybeFn;
    if (typeof fn !== 'function') return undefined as ReturnType<F>;
    const run = (span: Span) => context.with(safely(() => trace.setSpan(parent, span)) ??
      trace.setSpan(ROOT_CONTEXT, span), () => fn(span)) as ReturnType<F>;
    const noop = nonRecording(options, parent);
    if (!safely(() => !suppressed(parent) && canCreate(options, noop, !parentOrFn || typeof parentOrFn !== 'object'))) return run(noop);
    // The native callback activates platform children; OTel owns span.end().
    let entered = false;
    try {
      return tracing.startActiveSpan(typeof name === 'string' ? name : 'unnamed', native => {
        const span = created(native, options, noop);
        entered = true;
        return run(span);
      });
    } catch (error) {
      if (entered) throw error; // Never swallow/retry application callbacks.
      unsupported('telemetry operation failed (ignored)');
      return run(noop);
    }
  },
};

const manager = new WorkersContextManager();
const provider: TracerProvider = { getTracer: () => tracer };
let registered: TracerProvider | undefined;
// Dev module reloads and duplicate bundles can share an isolate's OTel globals.
// Only reuse this exact adapter version while its provider remains installed.
const registrationKey = Symbol.for('opentelemetry-js-cloudflare-workers-adapter@0.1.3');
type Registration = { provider: TracerProvider; register: () => TracerProvider };

/** Register once at Worker module scope. Conflicting OTel registrations throw. */
export function register(): TracerProvider {
  const previous = Reflect.get(globalThis, registrationKey) as Registration | undefined;
  if (previous?.provider === trace.getTracerProvider() && previous.register !== register) return previous.register();
  if (manager.storage && registered === trace.getTracerProvider()) return provider;
  if (['getActiveSpan', 'startSpan', 'startActiveSpan'].some(key => typeof Reflect.get(tracing, key) !== 'function') ||
      ['spanContext', 'setStatus', 'updateName'].some(key => typeof Reflect.get(tracing.Span?.prototype ?? {}, key) !== 'function')) {
    throw new Error('Workers OTel adapter: this runtime lacks required native tracing APIs. Update your Workers runtime and local development tools.');
  }
  if (!context.setGlobalContextManager(manager)) {
    throw new Error('Workers OTel adapter: a context manager is already registered. Remove the previous OTel setup.');
  }
  manager.enable();
  if (!trace.setGlobalTracerProvider(provider)) {
    context.disable(); // Roll back only the manager we just installed.
    throw new Error('Workers OTel adapter: a tracer provider is already registered. Remove the previous OTel setup.');
  }
  registered = trace.getTracerProvider();
  Reflect.set(globalThis, registrationKey, { provider: registered, register } satisfies Registration);
  return provider;
}

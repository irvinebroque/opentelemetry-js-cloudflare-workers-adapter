// A deliberately independent model of the published runtime contract. Real
// workerd smoke tests live separately; this model lets us inspect emitted data.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Exception } from '@opentelemetry/api';

const storage = new AsyncLocalStorage<NativeSpan>();
let nextId = 0;
export const recorded: NativeSpan[] = [];

export class NativeSpan {
  readonly attributes: Record<string, string | number | boolean> = {};
  readonly exceptions: Exception[] = [];
  readonly id = (++nextId).toString(16).padStart(16, '0');
  readonly traceId: string;
  ended = false;
  status = { code: 'unset' } as { code: 'unset' | 'ok' | 'error'; message?: string };

  constructor(public name: string, readonly parent?: NativeSpan, readonly root = false, readonly traced = true) {
    this.traceId = parent?.traceId ?? this.id.padStart(32, '0');
    if (root || traced) recorded.push(this);
  }
  get isTraced() { return this.traced && !this.ended; }
  spanContext() { return this.root || this.traced
    ? { traceId: this.traceId, spanId: this.id, traceFlags: 0 }
    : { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 }; }
  setAttribute(key: string, value: string | number | boolean) {
    if (typeof value === 'object') throw new TypeError('Native attributes must be scalar');
    if (this.isTraced) this.attributes[key] = value;
    return this;
  }
  setAttributes(values: Record<string, string | number | boolean | undefined>) {
    for (const [key, value] of Object.entries(values)) if (value !== undefined) this.setAttribute(key, value);
    return this;
  }
  setStatus(status: typeof this.status) {
    if (this.isTraced && this.status.code !== 'ok' && status.code !== 'unset') this.status = status;
    return this;
  }
  updateName(name: string) { if (this.isTraced) this.name = name; return this; }
  recordException(exception: Exception) { if (this.isTraced) this.exceptions.push(exception); }
  end() { if (!this.root) this.ended = true; }
}

export const tracing = {
  Span: NativeSpan,
  getActiveSpan: () => storage.getStore(),
  startSpan(name: string) { return new NativeSpan(name, storage.getStore(), false, storage.getStore()?.traced ?? false); },
  startActiveSpan<T>(name: string, fn: (span: NativeSpan) => T): T {
    const span = this.startSpan(name);
    return storage.run(span, () => fn(span));
  },
};

export function invocation<T>(fn: (root: NativeSpan) => T, traced = true): T {
  const root = new NativeSpan('invocation', undefined, true, traced);
  return storage.run(root, () => fn(root));
}

import assert from 'node:assert/strict';
import { DurableObject, tracing } from 'cloudflare:workers';
import { context, createContextKey, trace, INVALID_SPAN_CONTEXT } from '@opentelemetry/api';
import { exerciseLibrary, libraries } from './integrations.js';
import { exerciseBundledInstrumentation } from './bundled-instrumentation.js';
import { exercisePrisma } from './prisma.js';

const tracer = trace.getTracer('durable-test');
const requestKey = createContextKey('durable-request');

export class TestObject extends DurableObject<Env> {
  async wideBundled(url: string) {
    // @ts-expect-error JS bundle-resolution fixture.
    return (await import('./wide/bundled.mjs')).bundleProbes(url);
  }
  async wide(name: string) {
    // @ts-expect-error JS integration fixtures intentionally use published JS internals.
    const { runtimeExercise } = await import('./wide/producers.mjs');
    return runtimeExercise(name);
  }
  async integrations() { return Promise.all(libraries.map(exerciseLibrary)); }
  async bundled(port: number, errors: number) { return exerciseBundledInstrumentation(port, errors); }
  async prisma() { return exercisePrisma(this.env.TEST_DB); }
  async probe(value: string) {
    const root = tracing.getActiveSpan();
    assert.deepEqual(trace.getActiveSpan()?.spanContext(), root?.spanContext());
    assert.equal(context.active().getValue(requestKey), undefined);
    return context.with(context.active().setValue(requestKey, value), () =>
      tracer.startActiveSpan('runtime.do', async span => {
        try {
          await scheduler.wait(5);
          assert.equal(context.active().getValue(requestKey), value);
          assert.equal(trace.getActiveSpan(), span);
          const child = tracer.startSpan('runtime.do.child');
          child.end();
          await this.ctx.storage.put(value, span.spanContext());
          assert.deepEqual(await this.ctx.storage.get(value), span.spanContext());
          return { root: root?.spanContext() ?? INVALID_SPAN_CONTEXT, span: span.spanContext(), child: child.spanContext() };
        } finally { span.end(); }
      }));
  }

  async fetch(request: Request) {
    if (new URL(request.url).pathname === '/websocket') {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return Response.json(await this.probe(new URL(request.url).pathname));
  }
  async webSocketMessage(socket: WebSocket) {
    const native = tracing.startSpan('runtime.ws-native');
    const nativeIds = native.spanContext(); native.end();
    socket.send(JSON.stringify({ ...await this.probe('websocket'), nativeIds }));
  }
  webSocketClose(socket: WebSocket, code: number, reason: string) { socket.close(code === 1005 ? 1000 : code, reason); }
  async schedule() { await this.ctx.storage.delete('alarm-result'); await this.ctx.storage.setAlarm(Date.now() + 20); }
  async alarm() { await this.ctx.storage.put('alarm-result', await this.probe('alarm')); }
  async alarmResult() { return this.ctx.storage.get('alarm-result'); }
}

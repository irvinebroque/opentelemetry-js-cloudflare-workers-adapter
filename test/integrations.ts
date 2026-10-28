// Actual published producers, shared by model tests and workerd. Framework
// helpers are exercised directly; these are not full framework deployment tests.
import assert from 'node:assert/strict';
import { context, trace, type Span, type SpanContext } from '@opentelemetry/api';
import { tracing } from 'cloudflare:workers';
import { Hono } from 'hono';
import { httpInstrumentationMiddleware } from '@hono/otel';
import { startActiveObservation, startObservation } from '@langfuse/tracing';
import * as Effect from 'effect/Effect';
import * as OtelTracer from '@effect/opentelemetry/OtelTracer';
import { BraintrustState, TestBackgroundLogger, initLogger } from 'braintrust';
import { setupOtelCompat } from '@braintrust/otel';
import { getTracer } from 'next/dist/server/lib/trace/tracer.js';
import { BaseServerSpan } from 'next/dist/server/lib/trace/constants.js';
// SvelteKit does not export this helper; pin its package and import its real source.
// @ts-expect-error Published JS internal has no declaration file.
import { init_tracing, record_span } from '../node_modules/@sveltejs/kit/src/exports/internal/server/telemetry.js';

setupOtelCompat();
init_tracing(import('@opentelemetry/api'));
const tracer = trace.getTracer('integration-tests');
export const libraries = ['hono', 'langfuse', 'effect', 'braintrust', 'sveltekit', 'next'] as const;
export type Library = typeof libraries[number];
export type Report = { root: SpanContext; spans: { ids: SpanContext; parent: string; name: string }[] };

export async function exerciseLibrary(library: Library): Promise<Report> {
  const root = trace.getActiveSpan()!.spanContext();
  const spans: Report['spans'] = [];
  const remember = (name: string, span: Span, parent = root.spanId) => {
    assert.equal(span.isRecording(), true, name);
    const ids = span.spanContext();
    assert.equal(ids.traceId, root.traceId);
    assert.notEqual(ids.spanId, parent);
    spans.push({ ids, parent, name });
    return ids;
  };
  const child = async (name: string, parent = root.spanId) => tracer.startActiveSpan(name, async span => {
    try {
      remember(name, span, parent);
      await Promise.resolve();
      assert.deepEqual(trace.getActiveSpan()?.spanContext(), tracing.getActiveSpan()?.spanContext());
      return 42;
    } finally { span.end(); }
  });

  switch (library) {
    case 'hono': {
      const app = new Hono();
      app.use(httpInstrumentationMiddleware());
      app.onError(() => new Response('handled', { status: 500 }));
      app.get('/items/:id', async c => {
        assert.equal(trace.getActiveSpan()?.isRecording(), false); // SERVER kind
        assert.deepEqual(trace.getActiveSpan()?.spanContext(), root);
        return c.json({ value: await child('integration.hono.child'), id: c.req.param('id') });
      });
      app.get('/error', () => { throw new Error('hono failure'); });
      const response = await app.request('https://example.test/items/one');
      assert.deepEqual(await response.json(), { value: 42, id: 'one' });
      const failed = await app.request('https://example.test/error');
      assert.equal(failed.status, 500);
      assert.equal(await failed.text(), 'handled');
      break;
    }
    case 'langfuse': {
      assert.equal(await startActiveObservation('integration.langfuse', async observation => {
        const parent = remember('integration.langfuse', trace.getActiveSpan()!);
        observation.update({ input: { synthetic: true }, metadata: { test: true } });
        const manual = startObservation('integration.langfuse.manual');
        remember('integration.langfuse.manual', manual.otelSpan, parent.spanId);
        manual.end();
        assert.equal(manual.otelSpan.isRecording(), false);
        return child('integration.langfuse.child', parent.spanId);
      }), 42);
      const error = new Error('langfuse failure');
      await assert.rejects(startActiveObservation('integration.langfuse.error', async () => {
        remember('integration.langfuse.error', trace.getActiveSpan()!);
        throw error;
      }), error);
      break;
    }
    case 'effect': {
      const task = (index: number) => Effect.promise(async () => {
        await Promise.resolve();
        assert.equal(trace.getActiveSpan()?.isRecording(), false); // Explicit timestamp
        assert.deepEqual(trace.getActiveSpan()?.spanContext(), root);
        return child(`integration.effect.child.${index}`);
      }).pipe(Effect.withSpan(`integration.effect.unsupported.${index}`));
      const result = await Effect.runPromise(Effect.all([task(0), task(1)], { concurrency: 2 })
        .pipe(Effect.provide(OtelTracer.layerGlobal)));
      assert.deepEqual(result, [42, 42]);
      await assert.rejects(Effect.runPromise(Effect.fail(new Error('effect failure')).pipe(
        Effect.withSpan('integration.effect.unsupported.error'), Effect.provide(OtelTracer.layerGlobal))), /effect failure/);
      break;
    }
    case 'braintrust': {
      // Use Braintrust's own in-memory sink; neither credentials nor network I/O.
      const state = new BraintrustState({ fetch: async () => { throw new Error('Unexpected Braintrust network request'); } });
      const sink = new TestBackgroundLogger();
      let queued = 0;
      const enqueue = sink.log.bind(sink);
      sink.log = items => { queued += items.length; enqueue(items); };
      state.setOverrideBgLogger(sink);
      const logger = initLogger({ state, setCurrent: false, projectId: 'test-project',
        orgProjectMetadata: { org_id: 'test-org', project: { id: 'test-project', name: 'test', fullInfo: {} } } });
      assert.equal(await logger.traced(async span => {
        await Promise.resolve();
        assert.equal(span.rootSpanId, root.traceId);
        assert.notEqual(span.spanId, root.spanId);
        assert.equal(trace.getActiveSpan()?.spanContext().spanId, span.spanId);
        const nested = tracer.startSpan('integration.braintrust.unsupported');
        assert.equal(nested.isRecording(), false); // Braintrust's parent isn't a native span
        assert.equal(nested.spanContext().spanId, span.spanId);
        nested.end();
        return 42;
      }, { name: 'integration.braintrust' }), 42);
      const error = new Error('braintrust failure');
      await assert.rejects(logger.traced(async () => { throw error; }, { name: 'integration.braintrust.error' }), error);
      assert.ok(queued > 0); // Leave lazy export metadata unevaluated (no login).
      await child('integration.braintrust.restored');
      break;
    }
    case 'sveltekit': {
      assert.equal(await record_span({ name: 'integration.sveltekit', attributes: { route: '/test' }, fn: async (span: Span) => {
        const parent = remember('integration.sveltekit', span);
        return child('integration.sveltekit.child', parent.spanId);
      } }), 42);
      const error = new Error('sveltekit failure');
      await assert.rejects(record_span({ name: 'integration.sveltekit.error', attributes: {}, fn: async (span: Span) => {
        remember('integration.sveltekit.error', span);
        throw error;
      } }), error);
      break;
    }
    case 'next': {
      const next = getTracer();
      assert.equal(next.hasActiveSpanContext(), true);
      assert.equal(await next.trace(BaseServerSpan.handleRequest, { spanName: 'integration.next' }, async span => {
        const parent = remember('integration.next', span!);
        return child('integration.next.child', parent.spanId);
      }), 42);
      const error = new Error('next failure');
      await assert.rejects(next.trace(BaseServerSpan.handleRequest, { spanName: 'integration.next.error' }, async span => {
        remember('integration.next.error', span!);
        throw error;
      }), error);
      break;
    }
  }
  assert.deepEqual(trace.getActiveSpan()?.spanContext(), root, `${library} leaked context`);
  return { root, spans };
}

// Published library paths are pinned. Helper-level tests are explicitly labelled;
// none claim that a complete cloud service or framework deployment was tested.
import assert from 'node:assert/strict';
import { context, trace, INVALID_SPAN_CONTEXT } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';

const sentrySent = []; // Test transport shared by Sentry's isolate-wide cached client.
export const names = ['langsmith', 'firestore', 'pubsub', 'bullmq', 'openinference-openai', 'openinference-langchain', 'fastify', 'inngest', 'sentry', 'mastra'];
export async function exercise(name) {
  const root = trace.getActiveSpan().spanContext();
  const expected = [];
  const remember = (span = trace.getActiveSpan(), parent = root.spanId) => {
    assert.equal(span.isRecording(), true);
    const ids = span.spanContext();
    assert.equal(ids.traceId, root.traceId);
    assert.notEqual(ids.spanId, parent);
    expected.push({ ids, parent });
    return ids;
  };
  const tracer = trace.getTracer('wide');
  const failure = new Error(`synthetic ${name} failure`);
  switch (name) {
    case 'langsmith': {
      const { initializeOTEL } = await import('langsmith/experimental/otel/setup');
      const { traceable } = await import('langsmith/traceable');
      const { Client } = await import('langsmith');
      initializeOTEL({ globalTracerProvider: trace.getTracerProvider(), skipGlobalContextManagerSetup: true });
      // Capture the SDK's own API writes locally, independently of native export.
      let writes = 0;
      const client = new Client({ apiKey: 'test-only', autoBatchTracing: false, tracingMode: 'otel',
        fetchImplementation: async () => { writes++; return new Response('{}'); } });
      const lsSpans = [];
      const config = { tracingEnabled: true, client, tracer: { ...tracer, startActiveSpan(name, options, callback) {
        return tracer.startActiveSpan(name, options, span => { lsSpans.push(span); return callback(); });
      } } };
      const child = traceable(async () => { remember(); await Promise.resolve(); return 42; }, { ...config, name: 'wide.langsmith.child' });
      const parent = traceable(async () => {
        const ids = remember();
        const start = expected.length;
        const result = await child();
        expected[start].parent = ids.spanId;
        return result;
      }, { ...config, name: 'wide.langsmith.parent' });
      assert.equal(await parent(), 42);
      await assert.rejects(traceable(async () => { remember(); throw failure; }, { ...config, name: 'wide.langsmith.error' })(), failure);
      const stream = traceable(async function* () { assert.deepEqual(trace.getActiveSpan().spanContext(), root); yield 1; await Promise.resolve(); yield 2; }, { ...config, name: 'wide.langsmith.stream' });
      assert.deepEqual(await Array.fromAsync(stream()), [1, 2]);
      await client.awaitPendingTraceBatches();
      assert.ok(writes > 0);
      // LangSmith 0.11.3 never ends these OTel spans. Preserve the reproduction
      // and clean up test-owned handles; the adapter must not auto-end spans.
      assert.ok(lsSpans.every(span => span.isRecording()));
      lsSpans.forEach(span => span.end());
      break;
    }
    case 'firestore': {
      const { Firestore } = await import('@google-cloud/firestore');
      for (const openTelemetry of [undefined, { tracerProvider: trace.getTracerProvider() }]) {
        const db = new Firestore({ projectId: 'synthetic', openTelemetry });
        const helper = db._traceUtil;
        assert.equal(await helper.startActiveSpan('wide.firestore', async () => {
          const parent = remember();
          await Promise.resolve();
          return helper.startActiveSpan('wide.firestore.child', () => { remember(undefined, parent.spanId); return 42; });
        }), 42);
        await assert.rejects(helper.startActiveSpan('wide.firestore.error', async () => { remember(); throw failure; }), failure);
      }
      break;
    }
    case 'pubsub': {
      const { PubSub } = await import('@google-cloud/pubsub');
      const client = new PubSub({ projectId: 'synthetic', enableOpenTelemetryTracing: true });
      const topic = client.topic('synthetic');
      const message = { attributes: {}, data: Buffer.from('synthetic') };
      // Published publisher helper, with no authentication or service calls.
      const span = topic.publisher.getParentSpan(message, 'test');
      assert.equal(span.isRecording(), false);
      assert.deepEqual(span.spanContext(), root);
      assert.ok(Object.values(message.attributes).some(value => value.includes(root.traceId)));
      span.end();
      await client.close();
      break;
    }
    case 'bullmq': {
      const { BullMQOtel } = await import('bullmq-otel');
      const { trace: run, SpanKind: Kind } = await import('bullmq');
      const telemetry = new BullMQOtel();
      for (const kind of [Kind.PRODUCER, Kind.CONSUMER, Kind.INTERNAL]) {
        assert.equal(await run(telemetry, kind, 'test-queue', 'wide.bullmq', 'test', async span => {
          await Promise.resolve();
          const active = trace.getActiveSpan();
          assert.ok(span);
          if (kind === Kind.INTERNAL) remember(active);
          else { assert.equal(active.isRecording(), false); assert.deepEqual(active.spanContext(), root); }
          return 42;
        }), 42);
      }
      await assert.rejects(run(telemetry, Kind.PRODUCER, 'test-queue', 'error', 'test', async () => { throw failure; }), failure);
      // This bridge does not install message propagation or a metrics provider.
      assert.equal(telemetry.contextManager.getMetadata(context.active()), '{}');
      break;
    }
    case 'openinference-openai': {
      const { OpenAIInstrumentation } = await import('@arizeai/openinference-instrumentation-openai');
      const openai = await import('openai');
      const instrumentation = new OpenAIInstrumentation({ enabled: false });
      instrumentation.setTracerProvider(trace.getTracerProvider());
      instrumentation.manuallyInstrument(openai);
      let requests = 0;
      const client = new openai.OpenAI({ apiKey: 'synthetic', maxRetries: 0, fetch: async (_url, init) => {
        requests++;
        const span = trace.getActiveSpan();
        remember(span);
        // Manual activation cannot change the native parent: no fabricated child.
        assert.equal(tracer.startSpan('wide.openai.unsupported').isRecording(), false);
        const body = JSON.parse(init.body);
        if (body.model === 'error') return Response.json({ error: { message: 'synthetic failure' } }, { status: 500 });
        if (body.stream) return new Response('data: {"id":"test","object":"chat.completion.chunk","model":"test","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
        return Response.json({ id: 'test', object: 'chat.completion', model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] });
      } });
      try {
        const params = { model: 'test', messages: [{ role: 'user', content: 'synthetic' }] };
        assert.equal((await client.chat.completions.create(params)).choices[0].message.content, 'hello');
        assert.equal((await Array.fromAsync(await client.chat.completions.create({ ...params, stream: true })))[0].choices[0].delta.content, 'hello');
        await assert.rejects(client.chat.completions.create({ ...params, model: 'error' }), /synthetic failure/);
        assert.equal(requests, 3);
      } finally { instrumentation.disable(); }
      break;
    }
    case 'openinference-langchain': {
      const { LangChainInstrumentation } = await import('@arizeai/openinference-instrumentation-langchain');
      const callbacks = await import('@langchain/core/callbacks/manager');
      const { RunnableLambda } = await import('@langchain/core/runnables');
      const instrumentation = new LangChainInstrumentation({ enabled: false });
      instrumentation.setTracerProvider({ getTracer: () => ({ ...tracer, startSpan(...args) {
        const span = tracer.startSpan(...args);
        if (span.isRecording()) remember(span);
        return span;
      } }) });
      instrumentation.manuallyInstrument(callbacks);
      try {
        const chain = RunnableLambda.from(async value => value + 1).pipe(RunnableLambda.from(async value => value * 2));
        assert.equal(await chain.invoke(20), 42);
        await assert.rejects(RunnableLambda.from(async () => { throw failure; }).invoke(0), failure);
        await (await import('@langchain/core/callbacks/promises')).awaitAllCallbacks();
      } finally { instrumentation.disable(); }
      break;
    }
    case 'fastify': {
      const { default: Fastify } = await import('fastify');
      const { default: FastifyOtel } = await import('@fastify/otel');
      const instrumentation = new FastifyOtel({ enabled: false });
      instrumentation.setTracerProvider(trace.getTracerProvider());
      const app = Fastify();
      try {
        await app.register(instrumentation.plugin());
        app.get('/', async () => { await Promise.resolve(); assert.deepEqual(trace.getActiveSpan().spanContext(), root); return { answer: 42 }; });
        app.get('/error', async () => { throw failure; });
        assert.deepEqual((await app.inject('/')).json(), { answer: 42 });
        assert.equal((await app.inject('/error')).statusCode, 500);
      } finally { await app.close(); instrumentation.disable(); }
      break;
    }
    case 'inngest': {
      const { Inngest } = await import('inngest');
      const { serve } = await import('inngest/edge');
      const client = new Inngest({ id: 'test', isDev: true });
      const fn = client.createFunction({ id: 'test', triggers: [{ event: 'test/run' }] }, async () => { remember(); return 42; });
      const handler = serve({ client, functions: [fn] });
      const response = await handler(new Request('http://localhost/api/inngest?fnId=test-test&stepId=step', {
        method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify({ event: { name: 'test/run', data: {} }, events: [], steps: {}, ctx: { run_id: 'test', attempt: 0 } }),
      }));
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(await response.json(), 42);
      break;
    }
    case 'sentry': {
      const Sentry = await import('@sentry/cloudflare');
      const provider = trace.getTracerProvider();
      const sent = sentrySent;
      const before = sent.length;
      const pending = [];
      const worker = Sentry.withSentry(() => ({ dsn: 'https://synthetic@example.invalid/1', defaultIntegrations: false,
        transport: () => ({ send: async envelope => { sent.push(envelope); return {}; }, flush: async () => true }) }), {
        async fetch() {
          assert.deepEqual(trace.getActiveSpan().spanContext(), root);
          Sentry.captureException(failure); await Sentry.flush(1000);
          assert.deepEqual(trace.getActiveSpan().spanContext(), root);
          return new Response('ok');
        },
      });
      const response = await worker.fetch(new Request('https://example.test/'), {}, { waitUntil: p => pending.push(p), passThroughOnException() {} });
      await Promise.all(pending);
      assert.equal(await response.text(), 'ok');
      assert.equal(sent.length, before + 1);
      assert.equal(trace.getTracerProvider(), provider);
      assert.deepEqual(trace.getActiveSpan().spanContext(), root);
      break;
    }
    case 'mastra': {
      const { SpanConverter } = await import('@mastra/otel-exporter');
      const { SpanType } = await import('@mastra/core/observability');
      const converter = new SpanConverter({ format: 'GenAI_v1_38_0', packageName: 'test' });
      const converted = await converter.convertSpan({ id: '1'.repeat(16), traceId: '2'.repeat(32), name: 'synthetic', type: SpanType.GENERIC,
        startTime: new Date(0), endTime: new Date(1), attributes: {}, metadata: {}, isEvent: false });
      assert.equal(converted.spanContext().traceId, '2'.repeat(32));
      assert.equal(trace.getActiveSpan().spanContext().traceId, root.traceId);
      // ReadableSpan conversion bypasses the global provider; no native spans.
      break;
    }
    default: throw new Error(`Unknown integration: ${name}`);
  }
  assert.deepEqual(trace.getActiveSpan().spanContext(), root);
  // Every producer must also respect OTel's suppression convention via the bridge.
  context.with(suppressTracing(context.active()), () => {
    assert.deepEqual(tracer.startSpan('wide.suppressed').spanContext(), INVALID_SPAN_CONTEXT);
  });
  return { name, root, spans: expected };
}

// Return errors as data only at the test endpoint. The harness asserts exact
// expected failures; an unexpected failure still fails the integration test.
export async function runtimeExercise(name) {
  let timer;
  try {
    if (name === 'fastify') {
      const { default: Fastify } = await import('fastify');
      const baseline = Fastify();
      baseline.get('/', () => 'ok');
      try {
        await Promise.race([baseline.inject('/'), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Uninstrumented Fastify inject timed out')), 10000);
        })]);
      } finally { clearTimeout(timer); void baseline.close(); }
    }
    return await Promise.race([exercise(name), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Library operation timed out')), 10000);
    })]);
  } catch (error) { return { name, error: { name: error.name, message: error.message } }; }
  finally { clearTimeout(timer); }
}

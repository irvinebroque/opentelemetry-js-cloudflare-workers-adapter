import assert from 'node:assert/strict';
import { context, trace, createContextKey, SpanStatusCode, INVALID_SPAN_CONTEXT, type Span } from '@opentelemetry/api';
import { tracing, exports as workerExports } from 'cloudflare:workers';
import { generateText, streamText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { register } from 'opentelemetry-js-cloudflare-workers-adapter';
import { exerciseLibrary, libraries } from './integrations.js';
import { exercisePrisma } from './prisma.js';
import { exerciseBundledInstrumentation } from './bundled-instrumentation.js';
import { reloadToken } from './generated/reload.js';
export { SentryObject } from './wide/sentry-durable.js';
export { TestObject } from './runtime-durable.js';

register();
const tracer = trace.getTracer('runtime-test');
const key = createContextKey('request-value');
const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const telemetry = { isEnabled: true, recordInputs: false, recordOutputs: false };
let retained: Span | undefined;
let escapedContext: ReturnType<typeof context.active> | undefined;
let retainedNative: ReturnType<typeof tracing.startSpan> | undefined;

export default {
  async fetch(request: Request, _env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/wide-bundled') {
      // @ts-expect-error JS bundle-resolution fixture.
      return Response.json(await (await import('./wide/bundled.mjs')).bundleProbes(`${url.origin}/ready`));
    }
    if (url.pathname === '/do/wide-bundled') return Response.json(await workerExports.TestObject.getByName('wide').wideBundled(`${url.origin}/ready`));
    if (url.pathname === '/wide') {
      // @ts-expect-error JS integration fixtures intentionally use published JS internals.
      const { runtimeExercise } = await import('./wide/producers.mjs');
      return Response.json(await runtimeExercise(url.searchParams.get('name')));
    }
    if (url.pathname === '/do/sentry') return Response.json(await workerExports.SentryObject.getByName('sentry').probe());
    if (url.pathname === '/do/wide') return Response.json(await workerExports.TestObject.getByName('wide').wide(url.searchParams.get('name')!));
    if (url.pathname === '/lifecycle') {
      // @ts-expect-error Shared JS fixture uses both published AI SDK majors.
      return Response.json(await (await import('./lifecycle/ai.mjs')).exerciseAI(url.searchParams.get('variant'), url.searchParams.get('scenario')));
    }
    if (url.pathname === '/do/lifecycle') return Response.json(await workerExports.TestObject.getByName('lifecycle').lifecycle(url.searchParams.get('variant')!, url.searchParams.get('scenario')!));
    if (url.pathname === '/limits') {
      // @ts-expect-error Runtime-only size-boundary fixture.
      return Response.json((await import('./lifecycle/limits.mjs')).exerciseLimits());
    }
    if (url.pathname === '/response-stream') {
      return tracer.startActiveSpan('lifecycle.response', span => {
        const ids = span.spanContext();
        let sent = false;
        return new Response(new ReadableStream({
          async pull(controller) {
            assert.equal(trace.getActiveSpan(), span);
            if (sent) { span.end(); controller.close(); return; }
            await scheduler.wait(5);
            const child = tracer.startSpan('lifecycle.response.chunk');
            child.end();
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ parent: ids, child: child.spanContext() })));
            sent = true;
          },
          cancel() { span.end(); },
        }));
      });
    }
    if (url.pathname === '/ready') return new Response(reloadToken);
    if (url.pathname === '/integrations') return Response.json(await Promise.all(libraries.map(exerciseLibrary)));
    if (url.pathname === '/prisma') return Response.json(await exercisePrisma(_env.TEST_DB));
    if (url.pathname === '/bundled') return Response.json(await exerciseBundledInstrumentation(Number(url.searchParams.get('port')), Number(url.searchParams.get('errors'))));
    if (url.pathname.startsWith('/do')) {
      const object = workerExports.TestObject.getByName(url.searchParams.get('id') ?? 'test');
      if (url.pathname === '/do/background') return Response.json(await object.background());
      if (url.pathname === '/do/escape') return Response.json(await object.escape());
      if (url.pathname === '/do/resume') return Response.json(await object.resume());
      if (url.pathname === '/do/fetch') return object.fetch('https://example.com/fetch');
      if (url.pathname === '/do/websocket') return object.fetch(new Request('https://example.com/websocket', request));
      if (url.pathname === '/do/schedule') { await object.schedule(); return new Response('scheduled'); }
      if (url.pathname === '/do/alarm') return Response.json(await object.alarmResult() ?? null);
      if (url.pathname === '/do/integrations') return Response.json(await object.integrations());
      if (url.pathname === '/do/bundled') return Response.json(await object.bundled(Number(url.searchParams.get('port')), Number(url.searchParams.get('errors'))));
      if (url.pathname === '/do/prisma') return Response.json(await object.prisma());
      return Response.json(await object.probe(crypto.randomUUID()));
    }
    if (url.pathname === '/escape') {
      const escaped = tracer.startSpan('lifecycle.escaped');
      escapedContext = trace.setSpan(context.active(), escaped);
      return Response.json(escaped.spanContext()); // Deliberate unended-span misuse.
    }
    if (url.pathname === '/resume') {
      const current = trace.getActiveSpan()!.spanContext();
      assert.ok(escapedContext);
      context.with(escapedContext, () => {
        const escaped = trace.getActiveSpan()!;
        escaped.setAttribute('late', true); escaped.recordException('late'); escaped.end();
        tracer.startActiveSpan('lifecycle.invalid-resume', child => {
          assert.equal(child.isRecording(), false);
          assert.deepEqual(child.spanContext(), escaped.spanContext());
        });
      });
      assert.deepEqual(trace.getActiveSpan()!.spanContext(), current);
      return Response.json(current);
    }
    if (url.pathname === '/retain') {
      // Deliberate misuse regression: only IDs can safely survive an invocation.
      retained = tracer.startSpan('runtime.retained'); retained.end();
      retainedNative = tracing.startSpan('runtime.native-retained'); retainedNative.end();
      return Response.json(retained.spanContext());
    }
    if (url.pathname === '/reuse') {
      assert.ok(retained);
      assert.throws(() => retainedNative!.spanContext());
      assert.equal(retained.isRecording(), false);
      retained.setAttribute('late', true).setStatus({ code: 2 }).updateName('late');
      retained.recordException('late'); retained.end();
      return Response.json(retained.spanContext());
    }
    if (url.pathname === '/background') {
      return tracer.startActiveSpan('runtime.background.parent', span => {
        const parent = span.spanContext();
        ctx.waitUntil((async () => {
          try {
            await scheduler.wait(20);
            assert.equal(trace.getActiveSpan(), span);
            tracer.startSpan('runtime.background.child').end();
          } finally { span.end(); }
        })());
        return Response.json(parent);
      });
    }
    if (url.pathname === '/correlation') {
      const root = trace.getActiveSpan()!.spanContext();
      const child = tracer.startSpan('runtime.correlation');
      assert.equal(child.isRecording(), false);
      assert.deepEqual(child.spanContext(), root);
      return tracer.startActiveSpan('runtime.correlation.active', span => {
        assert.deepEqual(span.spanContext(), root);
        assert.equal(trace.getActiveSpan(), span);
        assert.deepEqual(tracer.startSpan('runtime.correlation.nested').spanContext(), root);
        return Response.json(root);
      });
    }
    const root = tracing.getActiveSpan()!;
    assert.deepEqual(trace.getActiveSpan()?.spanContext(), root.spanContext());
    const remote = { traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1, isRemote: true };
    tracer.startActiveSpan('runtime.unsupported-remote', {}, trace.setSpanContext(context.active(), remote), span => {
      assert.equal(span.isRecording(), false);
      assert.deepEqual(span.spanContext(), remote);
      assert.equal(trace.getActiveSpan(), span);
    });
    const detached = tracer.startSpan('runtime.unsupported-root', { root: true });
    assert.equal(detached.isRecording(), false);
    assert.deepEqual(detached.spanContext(), INVALID_SPAN_CONTEXT);
    const requestValue = crypto.randomUUID();
    return context.with(context.active().setValue(key, requestValue), () =>
      tracer.startActiveSpan('runtime.parent', async parent => {
        try {
          await scheduler.wait(1);
          assert.equal(context.active().getValue(key), requestValue);
          assert.equal(trace.getActiveSpan(), parent);
          assert.deepEqual(parent.spanContext(), tracing.getActiveSpan()?.spanContext());
          parent.setAttributes({ text: 'yes', number: 1, array: [1, 2], nan: NaN, infinity: Infinity });
          parent.setStatus({ code: SpanStatusCode.OK });
          parent.updateName('runtime.renamed');

          const manual = tracer.startSpan('runtime.manual');
          assert.equal(trace.getActiveSpan(), parent);
          manual.end();
          assert.equal(manual.isRecording(), false);

          const nested = await tracing.enterSpan('runtime.native', async native => {
            await Promise.resolve();
            assert.deepEqual(trace.getActiveSpan()?.spanContext(), native.spanContext());
            const child = tracer.startSpan('runtime.child');
            const ids = child.spanContext();
            child.recordException(new Error('test exception'));
            child.setStatus({ code: SpanStatusCode.ERROR, message: 'test error' });
            child.end();
            return { native: native.spanContext(), child: ids };
          });
          assert.equal(trace.getActiveSpan(), parent);

          const model = new MockLanguageModelV3({
            doGenerate: async () => {
              assert.deepEqual(trace.getActiveSpan()?.spanContext(), tracing.getActiveSpan()?.spanContext());
              return { content: [{ type: 'text', text: 'Hello' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
            },
            doStream: async () => ({ stream: new ReadableStream({ start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: '1' });
              controller.enqueue({ type: 'text-delta', id: '1', delta: 'Hello' });
              controller.enqueue({ type: 'text-end', id: '1' });
              controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
              controller.close();
            } }) }),
          });
          assert.equal((await generateText({ model, prompt: 'Hello', experimental_telemetry: telemetry })).text, 'Hello');
          const stream = streamText({ model, prompt: 'Hello', experimental_telemetry: telemetry });
          let text = '';
          for await (const chunk of stream.textStream) text += chunk;
          assert.equal(text, 'Hello');
          await stream.usage;
          parent.end();
          assert.equal(parent.isRecording(), false);
          assert.equal(trace.getActiveSpan(), parent);
          const afterEnd = tracer.startSpan('runtime.after-end');
          afterEnd.end();
          return Response.json({ root: root.spanContext(), parent: parent.spanContext(), manual: manual.spanContext(), afterEnd: afterEnd.spanContext(), ...nested });
        } finally {
          parent.end();
        }
      }),
    );
  },
} satisfies ExportedHandler<Env>;

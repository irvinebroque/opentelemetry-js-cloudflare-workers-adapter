import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';
import { tracing } from 'cloudflare:workers';
import * as v6 from 'ai';
import * as v7 from 'ai-v7';
import { MockLanguageModelV3 } from 'ai/test';
import { MockLanguageModelV4 } from 'ai-v7/test';
import { OpenTelemetry } from '@ai-sdk/otel';
import { wrapAISDK } from 'agents/observability/ai';

export const variants = ['otel6', 'otel7', 'agents6', 'agents7', 'both6', 'both7'];
const tracer = trace.getTracer('lifecycle');
const auth = new AsyncLocalStorage();
const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const finishReason = { unified: 'stop', raw: 'stop' };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// Published producers, synthetic models, no network or exporters. Shared by
// native-model tests and actual Worker/DO invocations.
export async function exerciseAI(variant, scenario = 'generate') {
  assert.ok(variants.includes(variant));
  const sdk = variant.endsWith('7') ? v7 : v6;
  const Model = variant.endsWith('7') ? MockLanguageModelV4 : MockLanguageModelV3;
  const wrapped = !variant.startsWith('otel');
  const otel = !variant.startsWith('agents');
  const ai = wrapped ? wrapAISDK(sdk) : sdk;
  const token = crypto.randomUUID();
  const observations = [];
  const observe = where => {
    const expectedToken = sdk === v7 && otel ? `${token}:${where.startsWith('tool') ? 'tool' : 'model'}` : token;
    assert.equal(auth.getStore(), expectedToken, `${where}: application ALS changed`);
    const native = tracing.getActiveSpan().spanContext();
    const logical = trace.getActiveSpan().spanContext();
    const child = tracer.startSpan(`lifecycle.${where}`);
    observations.push({ where, native, logical, child: child.spanContext(), recording: child.isRecording() });
    child.end();
  };
  const created = [];
  // Observe public calls without changing activation or lifetime semantics.
  const producerTracer = {
    startSpan(...args) {
      const span = tracer.startSpan(...args);
      created.push({ name: args[0], span });
      return span;
    },
    startActiveSpan(...args) {
      const fn = args.pop();
      return tracer.startActiveSpan(...args, span => {
        created.push({ name: args[0], span });
        return fn(span);
      });
    },
  };
  const authIntegration = {
    executeLanguageModelCall: ({ execute }) => auth.run(`${token}:model`, execute),
    executeTool: ({ execute }) => auth.run(`${token}:tool`, execute),
  };
  const telemetry = { isEnabled: otel, recordInputs: false, recordOutputs: false,
    ...(sdk === v7 ? { integrations: otel ? [new OpenTelemetry({ tracer: producerTracer }), authIntegration] : [] } : { tracer: producerTracer }) };
  const abort = new AbortController();
  let cleaned = 0;
  let toolRuns = 0;
  let modelCalls = 0;
  const failure = new Error('synthetic model failure');
  const model = new Model({ modelId: 'lifecycle-model', provider: 'test-provider',
    doGenerate: async () => {
      observe('model');
      if (scenario === 'tools' && modelCalls++ === 0) return {
        content: [{ type: 'tool-call', toolCallId: 'tool-1', toolName: 'count', input: '{}' }],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage, warnings: [],
      };
      if (scenario === 'failure') throw failure;
      return { content: [{ type: 'text', text: 'hello' }], finishReason, usage, warnings: [] };
    },
    doStream: async () => {
      observe('model');
      return { stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: '1' });
          controller.enqueue({ type: 'text-delta', id: '1', delta: 'hello' });
          if (scenario === 'abort' || scenario === 'early') {
            abort.signal.addEventListener('abort', () => controller.error(abort.signal.reason), { once: true });
          } else {
            if (scenario === 'stream-error') controller.enqueue({ type: 'error', error: failure });
            controller.enqueue({ type: 'text-end', id: '1' });
            controller.enqueue({ type: 'finish', finishReason, usage });
            controller.close();
          }
        },
      }) };
    },
  });
  return auth.run(token, () => tracer.startActiveSpan(`lifecycle.${variant}.${scenario}`, async parent => {
    const root = parent.spanContext();
    let errors = 0;
    try {
      const options = { model, prompt: 'synthetic prompt', maxRetries: 0, abortSignal: abort.signal,
        ...(sdk === v7 ? { telemetry } : { experimental_telemetry: telemetry }),
        onError: () => { errors++; },
        ...(scenario === 'tools' ? {
          stopWhen: (sdk.stepCountIs ?? sdk.isStepCount)(2),
          tools: { count: sdk.tool({
            inputSchema: sdk.jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
            async *execute() {
              toolRuns++;
              try {
                observe('tool-start');
                yield 'partial';
                await tick();
                observe('tool-resume');
                yield 'complete';
              } finally { cleaned++; }
            },
          }) },
        } : {}),
      };
      if (scenario === 'generate' || scenario === 'failure' || scenario === 'tools') {
        if (scenario === 'failure') await assert.rejects(ai.generateText(options), /synthetic model failure/);
        else assert.equal((await ai.generateText(options)).text, 'hello');
      } else {
        // Create inside the span, consume after an async handoff; consumption
        // must not accidentally end or replace the surrounding application span.
        const result = ai.streamText(options);
        await tick();
        let text = '';
        await tracer.startActiveSpan('lifecycle.consumer', async consumer => {
          try {
            for await (const chunk of result.textStream) {
              text += chunk;
              if (scenario === 'abort') abort.abort(new DOMException('synthetic cancellation', 'AbortError'));
              if (scenario === 'early') break;
            }
          } finally { consumer.end(); }
        });
        assert.equal(text, 'hello');
        if (scenario === 'stream-error') assert.equal(errors, 1);
        // Early textStream exit doesn't necessarily cancel AI SDK's other
        // branches. Explicit abort settles the producer's remaining work.
        if (scenario === 'early') abort.abort(new DOMException('consumer stopped', 'AbortError'));
        await result.consumeStream();
        await tick();
      }
      assert.equal(auth.getStore(), token);
      assert.equal(trace.getActiveSpan(), parent);
      assert.ok(observations.length);
      for (const entry of observations) {
        assert.equal(entry.logical.traceId, root.traceId);
        // v7's OTel producer manually activates a span which the runtime
        // cannot reactivate. Native children must fall back, never mis-parent.
        if (entry.native.spanId !== entry.logical.spanId) {
          assert.equal(entry.recording, false);
          assert.deepEqual(entry.child, entry.logical);
        } else assert.equal(entry.recording, true);
      }
      if (scenario === 'tools') { assert.equal(toolRuns, 1); assert.equal(cleaned, 1); }
      const producerSpans = created.map(({ name, span }) => ({ name, ids: span.spanContext(), recording: span.isRecording() }));
      return { variant, scenario, root, observations, cleaned, toolRuns, producerSpans };
    } finally {
      // AI SDK v6 aborts leave doStream open even with the reference SDK.
      // Report this first, then clean up test-owned spans (not adapter behavior).
      for (const { span } of created) if (span.isRecording()) span.end();
      parent.end();
    }
  }));
}

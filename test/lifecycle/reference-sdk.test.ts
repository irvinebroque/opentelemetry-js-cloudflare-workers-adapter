import { expect, test } from 'vitest';
import { BasicTracerProvider, AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';
import { streamText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { Span, Tracer } from '@opentelemetry/api';
import { register } from '../../src/index.js';
import { invocation } from '../native.js';
register();

test('AI SDK v6 cancellation also leaves its model span open with the reference OTel SDK', () => invocation(async () => {
  const provider = new BasicTracerProvider({ sampler: new AlwaysOnSampler() });
  const tracer = provider.getTracer('reference');
  const spans: { name: string; span: Span }[] = [];
  const observing: Tracer = {
    startSpan: tracer.startSpan.bind(tracer),
    startActiveSpan: ((...args: unknown[]) => {
      const fn = args.pop() as (span: Span) => unknown;
      // Match the producer's public overload, preserving SDK-owned activation.
      return Reflect.apply(tracer.startActiveSpan, tracer, [...args, (span: Span) => {
        spans.push({ name: args[0] as string, span });
        return fn(span);
      }]);
    }) as Tracer['startActiveSpan'],
  };
  const abort = new AbortController();
  const model = new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'text-start', id: '1' });
      controller.enqueue({ type: 'text-delta', id: '1', delta: 'hello' });
      abort.signal.addEventListener('abort', () => controller.error(abort.signal.reason), { once: true });
    },
  }) }) });
  try {
    const result = streamText({ model, prompt: 'synthetic', abortSignal: abort.signal,
      experimental_telemetry: { isEnabled: true, tracer: observing, recordInputs: false, recordOutputs: false } });
    for await (const _ of result.textStream) abort.abort(new DOMException('synthetic', 'AbortError'));
    await result.consumeStream();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(spans.filter(({ span }) => span.isRecording()).map(({ name }) => name)).toEqual(['ai.streamText.doStream']);
  } finally {
    for (const { span } of spans) span.end();
    await provider.shutdown();
  }
}));

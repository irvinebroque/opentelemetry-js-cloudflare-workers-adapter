import { expect, test } from 'vitest';
import { generateText, streamText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { trace } from '@opentelemetry/api';
import { register } from '../src/index.js';
import { invocation, recorded, tracing } from './native.js';

register();
const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const telemetry = { isEnabled: true, recordInputs: false, recordOutputs: false };

function assertNativeAndOtelAgree() {
  expect(trace.getActiveSpan()?.spanContext()).toEqual(tracing.getActiveSpan()?.spanContext());
}

test('unmodified AI SDK generateText emits native spans beneath the invocation', async () => invocation(async root => {
  recorded.length = 0;
  const model = new MockLanguageModelV3({ doGenerate: async () => {
    assertNativeAndOtelAgree();
    return { content: [{ type: 'text', text: 'Hello' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
  } });
  const result = await generateText({ model, prompt: 'Hello', experimental_telemetry: telemetry });
  expect(result.text).toBe('Hello');
  const top = recorded.find(span => span.name === 'ai.generateText')!;
  const call = recorded.find(span => span.name === 'ai.generateText.doGenerate')!;
  expect(top.parent).toBe(root);
  expect(call.parent).toBe(top);
  expect(recorded.every(span => span.ended)).toBe(true);
  expect(call.attributes['ai.usage.outputTokens']).toBe(1);
  expect(trace.getActiveSpan()?.spanContext()).toEqual(root.spanContext());
}));

test('unmodified AI SDK streamText retains native parentage and ends spans after consumption', async () => invocation(async root => {
  recorded.length = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    assertNativeAndOtelAgree();
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'text-start', id: 'text-1' });
      controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'Hello' });
      controller.enqueue({ type: 'text-end', id: 'text-1' });
      controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
      controller.close();
    } }) };
  } });
  const result = streamText({ model, prompt: 'Hello', experimental_telemetry: telemetry });
  let output = '';
  for await (const chunk of result.textStream) output += chunk;
  expect(output).toBe('Hello');
  await result.usage;
  const top = recorded.find(span => span.name === 'ai.streamText')!;
  const call = recorded.find(span => span.name === 'ai.streamText.doStream')!;
  expect(top.parent).toBe(root);
  expect(call.parent).toBe(top);
  expect(recorded.every(span => span.ended)).toBe(true);
}));

test('AI SDK failures record a native exception and error status', async () => invocation(async () => {
  recorded.length = 0;
  const error = new Error('Model failed');
  const model = new MockLanguageModelV3({ doGenerate: async () => { throw error; } });
  await expect(generateText({ model, prompt: 'Hello', maxRetries: 0, experimental_telemetry: telemetry })).rejects.toThrow(error);
  const call = recorded.find(span => span.name === 'ai.generateText.doGenerate')!;
  expect(call.status.code).toBe('error');
  expect(call.exceptions).toHaveLength(1);
  expect(recorded.every(span => span.ended)).toBe(true);
}));

import { expect, test } from 'vitest';
import { register } from '../../src/index.js';
import { invocation, recorded } from '../native.js';
// @ts-expect-error Shared JS fixture also runs in Workers.
import { exerciseAI, variants } from './ai.mjs';
register();
for (const variant of variants) for (const scenario of ['generate', 'failure', 'stream', 'stream-error', 'abort', 'early', 'tools']) {
  test(`${variant}: ${scenario}`, () => invocation(async () => {
    recorded.length = 0;
    const report = await exerciseAI(variant, scenario);
    const leaked = report.producerSpans.filter((span: { recording: boolean }) => span.recording).map((span: { name: string }) => span.name);
    expect(leaked).toEqual(variant.endsWith('6') && !variant.startsWith('agents') && ['abort', 'early'].includes(scenario)
      ? ['ai.streamText.doStream'] : []);
    if (scenario === 'generate') {
      const names = recorded.map(span => span.name);
      // Enabling both producers really creates duplicate operation/model instrumentation.
      expect(names.filter(name => name.startsWith('invoke_agent')).length).toBe(variant === 'both7' ? 2 : variant === 'otel6' ? 0 : 1);
      if (variant === 'otel7') expect(names.some(name => name.startsWith('chat '))).toBe(false);
    }
    expect(recorded.filter(span => !span.ended).map(span => span.name)).toEqual([]);
  }));
}

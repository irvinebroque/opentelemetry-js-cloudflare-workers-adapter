import { expect, test } from 'vitest';
import { register } from '../../src/index.js';
import { invocation, recorded } from '../native.js';
import { exercise, names } from './producers.mjs';
register();
for (const name of names) test(name, async () => {
  recorded.length = 0;
  const report = await invocation(() => exercise(name));
  for (const expected of report.spans) {
    const span = recorded.find(span => span.id === expected.ids.spanId);
    expect(span?.parent?.id).toBe(expected.parent);
    expect(span?.ended).toBe(true);
  }
  expect(recorded.filter(span => !span.root).every(span => span.ended)).toBe(true);
  if (['mastra', 'pubsub'].includes(name)) expect(recorded.filter(span => !span.root)).toHaveLength(0);
  if (['openinference-langchain'].includes(name)) expect(recorded.filter(span => !span.root).length).toBeGreaterThan(0);
}, 15000);

for (const name of ['langsmith', 'firestore', 'pubsub', 'bullmq', 'inngest', 'mastra']) {
  test(`${name}: overlapping invocations keep distinct trace IDs`, async () => {
    const reports = await Promise.all(Array.from({ length: 3 }, () => invocation(() => exercise(name))));
    expect(new Set(reports.map(report => report.root.traceId)).size).toBe(3);
  }, 15000);
}

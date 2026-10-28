import { expect, test } from 'vitest';
import { register } from '../src/index.js';
import { invocation, recorded } from './native.js';
import { exerciseLibrary, libraries } from './integrations.js';

register();

test.each(libraries)('%s: published tracing code, failures, native parents, concurrent invocations', async library => {
  recorded.length = 0;
  const reports = await Promise.all(Array.from({ length: 3 }, () => invocation(() => exerciseLibrary(library))));
  expect(new Set(reports.map(report => report.root.traceId)).size).toBe(3);
  for (const report of reports) for (const expected of report.spans) {
    const span = recorded.find(span => span.id === expected.ids.spanId)!;
    expect(span.name).toBe(expected.name);
    expect(span.parent?.id).toBe(expected.parent);
    expect(span.ended).toBe(true);
    if (expected.name.endsWith('.error')) {
      expect(span.status.code).toBe('error');
      // Langfuse sets status/message without calling recordException.
      expect(span.exceptions).toHaveLength(library === 'langfuse' ? 0 : 1);
    }
  }
  expect(recorded.filter(span => !span.root).every(span => span.ended)).toBe(true);
  expect(recorded.some(span => span.name.includes('.unsupported'))).toBe(false);
});

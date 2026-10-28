import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startRuntime, json, query } from './runtime-harness.mjs';

async function exported(base, ids) {
  for (let i = 0; i < 60; i++) {
    const rows = await query(base, "SELECT trace_id, span_id, parent_id, name, duration_ms, outcome, json_extract(attributes, '$.result') AS result, length(json_extract(attributes, '$.large')) AS large_length, (SELECT count(*) FROM json_each(spans.attributes)) AS attribute_count FROM spans");
    if (ids.every(id => rows.some(row => row.span_id === id && row.duration_ms !== null))) return rows;
    await delay(100);
  }
  assert.fail(`Missing exported spans: ${ids.join(', ')}`);
}

test('workerd: AI lifecycle, Agents coexistence, SDK v7, and native limits', { timeout: 120000 }, async t => {
  const base = await startRuntime(t);
  for (const variant of ['otel6', 'otel7', 'agents6', 'agents7', 'both6', 'both7']) {
    await t.test(variant, async () => {
      const reports = [];
      for (const scenario of ['generate', 'failure', 'stream', 'stream-error', 'abort', 'early', 'tools']) {
        for (const path of ['/lifecycle', '/do/lifecycle']) {
          const report = await json(base, `${path}?variant=${variant}&scenario=${scenario}`);
          const leaked = report.producerSpans.filter(span => span.recording).map(span => span.name);
          assert.deepEqual(leaked, variant.endsWith('6') && !variant.startsWith('agents') && ['abort', 'early'].includes(scenario)
            ? ['ai.streamText.doStream'] : []);
          reports.push(report);
        }
      }
      const rows = await exported(base, reports.map(report => report.root.spanId));
      for (const report of reports) {
        for (const observed of report.observations) {
          if (!observed.recording) continue;
          const child = rows.find(row => row.span_id === observed.child.spanId);
          assert.ok(child, JSON.stringify(observed));
          assert.equal(child.parent_id, observed.native.spanId);
        }
        if (report.scenario === 'generate') {
          // Isolate this operation's direct children even when DO calls share a root trace.
          const children = rows.filter(row => row.parent_id === report.root.spanId);
          const operation = children.find(row => row.name.startsWith(variant === 'otel6' ? 'ai.generateText' : 'invoke_agent'));
          assert.ok(operation, JSON.stringify(children));
          if (variant === 'otel7') assert.equal(rows.some(row => row.parent_id === operation.span_id), false);
          if (variant.startsWith('both')) {
            assert.ok(rows.some(row => row.parent_id === operation.span_id && row.name.startsWith(variant === 'both6' ? 'ai.generateText' : 'invoke_agent')),
              'Dual instrumentation must be documented as duplicate operations');
          }
        }
      }
    });
  }
  for (const prefix of ['', '/do']) {
    const escaped = await json(base, `${prefix}/escape`);
    await json(base, `${prefix}/resume`);
    const escapedRows = await exported(base, [escaped.spanId]);
    assert.equal(escapedRows.some(row => row.name.endsWith('invalid-resume')), false);
  }
  for (const path of ['/background', '/do/background']) {
    const parent = await json(base, path);
    const background = await exported(base, [parent.spanId]);
    assert.ok(background.some(row => row.parent_id === parent.spanId && row.name.endsWith('background.child') && row.duration_ms >= 0));
  }
  const stream = await json(base, '/response-stream');
  const streamed = await exported(base, [stream.parent.spanId, stream.child.spanId]);
  assert.equal(streamed.find(row => row.span_id === stream.child.spanId).parent_id, stream.parent.spanId);
  const limits = await json(base, '/limits');
  const rows = await exported(base, [...limits.spans.map(span => span.ids.spanId), limits.survivor.spanId]);
  for (const expected of limits.spans) {
    const span = rows.find(row => row.span_id === expected.ids.spanId);
    assert.equal(span.parent_id, limits.root.spanId);
    assert.ok(Buffer.byteLength(span.name, 'utf8') <= 64, span.name);
    assert.equal(span.name.includes('\uFFFD'), false, 'Names must not split a UTF-8 code point');
  }
  const survivor = rows.find(row => row.span_id === limits.survivor.spanId);
  assert.equal(survivor.parent_id, limits.root.spanId);
  assert.equal(survivor.result, 42);
  const total = rows.find(row => row.name === 'lifecycle.limit.total');
  assert.ok(total.attribute_count > 1 && total.attribute_count < 102, JSON.stringify(total));
  const large = rows.find(row => row.name === 'lifecycle.limit.attribute');
  assert.equal(large.large_length, null, 'Oversized attribute must be dropped');
});

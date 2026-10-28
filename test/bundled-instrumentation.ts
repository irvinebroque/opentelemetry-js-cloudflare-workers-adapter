import assert from 'node:assert/strict';
import { trace, type TracerProvider } from '@opentelemetry/api';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { GraphQLInstrumentation } from '@opentelemetry/instrumentation-graphql';
import pino from 'pino';
import { Client } from 'pg';
import { buildSchema, graphql } from 'graphql';

// Exercise the published bundles without reaching into private patch methods.
// These Node module-loader integrations inherit a browser base in the default
// Worker bundle, so their constructors cannot install the Node loader hooks.
export async function exerciseBundledInstrumentation(port: number, expectedLoaderErrors: number) {
  const root = trace.getActiveSpan()!.spanContext();
  let loaderErrors = 0;
  let attempts = 0;
  const provider: TracerProvider = { getTracer: (...args) => {
    const tracer = trace.getTracerProvider().getTracer(...args);
    return { ...tracer, startSpan(...args) { attempts++; return tracer.startSpan(...args); } };
  } };
  const installed: { disable(): void }[] = [];
  for (const create of [() => new PinoInstrumentation({ disableLogSending: true }),
    () => new PgInstrumentation(), () => new GraphQLInstrumentation()]) {
    try {
      const instrumentation = create();
      installed.push(instrumentation);
      instrumentation.setTracerProvider(provider);
    } catch (error) {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /this.enable is not a function/);
      loaderErrors++;
    }
  }
  try {
    assert.equal(loaderErrors, expectedLoaderErrors);
    const lines: Record<string, unknown>[] = [];
    const logger = pino({ browser: { asObject: true, write: line => lines.push({ ...line }) } }, {
      write: line => { lines.push(JSON.parse(line)); },
    });
    logger.info('unpatched');
    assert.equal(lines[0]?.trace_id, undefined);
    // Explicit correlation still works in the bundled logger.
    logger.info({ trace_id: root.traceId, span_id: root.spanId }, 'correlated');
    assert.equal(lines[1]?.trace_id, root.traceId);
    assert.equal(lines[1]?.span_id, root.spanId);

    const result = await graphql({ schema: buildSchema('type Query { answer: Int }'),
      source: '{ answer }', rootValue: { answer: async () => 42 } });
    assert.equal(result.data?.answer, 42);

    const client = new Client({ host: '127.0.0.1', port, user: 'test', database: 'test', ssl: false });
    try {
      await client.connect();
      assert.deepEqual((await client.query('SELECT 42 AS answer')).rows, [{ answer: 42 }]);
      await assert.rejects(client.query('SELECT fail'), /synthetic query failure/);
    } finally { await client.end(); }
    assert.deepEqual(trace.getActiveSpan()?.spanContext(), root);
    assert.equal(attempts, 0, 'Node hooks now activate in Workers; review compatibility expectations');
    return { root, loaderErrors, libraries: ['pino', 'pg', 'graphql'] };
  } finally { for (const instrumentation of installed) instrumentation.disable(); }
}

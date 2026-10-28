import { createRequire } from 'node:module';
import { afterAll, expect, test, vi } from 'vitest';
import { context, trace, SpanKind } from '@opentelemetry/api';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { GraphQLInstrumentation } from '@opentelemetry/instrumentation-graphql';
import { register } from '../src/index.js';
import { invocation, recorded } from './native.js';
import { postgresServer } from './postgres-server.js';

const provider = register();
// Node loader hooks must be installed before requiring the actual libraries.
const instrumentations = [new PinoInstrumentation({ disableLogSending: true }),
  new PgInstrumentation(), new GraphQLInstrumentation()];
for (const instrumentation of instrumentations) instrumentation.setTracerProvider(provider);
const require = createRequire(import.meta.url);
const pino: typeof import('pino').default = require('pino');
const pg: typeof import('pg') = require('pg');
const graphql: typeof import('graphql') = require('graphql');
afterAll(() => { for (const instrumentation of instrumentations) instrumentation.disable(); });
const tracer = trace.getTracer('node-integration');

test('Pino instrumentation correlates native IDs across overlapping invocations and restores context', async () => {
  const lines: { trace_id?: string; span_id?: string; trace_flags?: string; msg: string }[] = [];
  const logger = pino({}, { write: line => { lines.push(JSON.parse(line)); } });
  await Promise.all(Array.from({ length: 3 }, (_, index) => invocation(async root => {
    logger.info(`root-${index}`);
    await tracer.startActiveSpan('pino.child', async span => {
      try {
        await Promise.resolve();
        logger.child({ request: index }).info(`child-${index}`);
        expect(lines.find(line => line.msg === `child-${index}`)).toMatchObject({
          trace_id: root.traceId, span_id: span.spanContext().spanId, trace_flags: '00',
        });
      } finally { span.end(); }
    });
    logger.info(`restored-${index}`);
    for (const msg of [`root-${index}`, `restored-${index}`]) {
      expect(lines.find(line => line.msg === msg)).toMatchObject({ trace_id: root.traceId, span_id: root.id });
    }
  })));
  logger.info('outside');
  expect(lines.at(-1)).not.toHaveProperty('trace_id');
});

test('pg real queries and callback errors survive unsupported CLIENT spans without changing native parentage', async () => {
  const server = await postgresServer();
  const started = vi.spyOn(tracer, 'startSpan');
  try {
    await invocation(async root => {
      recorded.length = 0;
      const client = new pg.Client({ host: '127.0.0.1', port: server.port, user: 'test', database: 'test', ssl: false });
      try {
        await client.connect();
        expect((await client.query('SELECT 42 AS answer')).rows).toEqual([{ answer: 42 }]);
        await new Promise<void>(resolve => client.query('SELECT fail', error => {
          expect(error?.message).toBe('synthetic query failure');
          expect(trace.getActiveSpan()?.spanContext()).toEqual(root.spanContext());
          resolve();
        }));
        expect(server.queries).toEqual(['SELECT 42 AS answer', 'SELECT fail']);
        expect(started.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(started.mock.calls.every(([, options]) => options?.kind === SpanKind.CLIENT)).toBe(true);
        expect(recorded).toHaveLength(0);
        expect(trace.getActiveSpan()?.spanContext()).toEqual(root.spanContext());
      } finally { await client.end(); }
    });
  } finally { started.mockRestore(); await server.close(); }
});

test('GraphQL instrumentation records operations, preserves errors, and declines unrepresentable resolver parents', async () => {
  const started = vi.spyOn(tracer, 'startSpan');
  try {
    await invocation(async root => {
      const schema = graphql.buildSchema('type Query { answer: Int!, fail: Int }');
      recorded.length = 0; started.mockClear();
      const result = await graphql.graphql({ schema, source: 'query Test { answer fail }', rootValue: {
        answer: async () => {
          await Promise.resolve();
          const active = trace.getActiveSpan()!;
          // Resolver spans use startSpan + context.with. No fake native parenting.
          expect(active.spanContext().traceId).toBe(root.traceId);
          const child = tracer.startSpan('graphql.unsupported.child');
          expect(child.isRecording()).toBe(false);
          expect(child.spanContext()).toEqual(active.spanContext());
          child.end();
          return 42;
        },
        fail: () => { throw new Error('resolver failure'); },
      } });
      expect(result.data?.answer).toBe(42);
      expect(result.data?.fail).toBeNull();
      expect(result.errors?.[0]?.message).toBe('resolver failure');
      expect(recorded.map(span => span.name)).toEqual(['graphql.parse', 'graphql.validate', 'query Test']);
      expect(recorded.every(span => span.parent === root && span.ended)).toBe(true);
      expect(started.mock.calls.length).toBeGreaterThan(3); // Hooks really ran, including resolvers.
      expect(trace.getSpan(context.active())?.spanContext()).toEqual(root.spanContext());
    });
  } finally { started.mockRestore(); }
});

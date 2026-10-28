import { createRequire } from 'node:module';
import { afterAll, beforeEach, expect, test, vi } from 'vitest';
import { context, trace, SpanKind } from '@opentelemetry/api';
import { register } from '../../src/index.js';
import { invocation, recorded } from '../native.js';
import { postgresServer } from '../postgres-server.js';
import { redisFixture, mongoFixture, httpFixture } from './servers.mjs';

const provider = register();
const require = createRequire(import.meta.url);
const packages = ['redis', 'ioredis', 'mongodb', 'knex', 'aws-sdk', 'kafkajs', 'amqplib', 'winston', 'undici'];
const installed = packages.map(name => {
  const exports = require(`@opentelemetry/instrumentation-${name}`);
  const Constructor = Object.values(exports).find(value => typeof value === 'function' && value.name.endsWith('Instrumentation'));
  const instance = new Constructor({ disableLogSending: true });
  instance.setTracerProvider(provider);
  return instance;
});
const { AzureSdkInstrumentation } = require('@azure/opentelemetry-instrumentation-azure-sdk');
installed.push(new AzureSdkInstrumentation());
for (const instrumentation of installed) instrumentation.setTracerProvider(provider);
afterAll(() => { for (const instrumentation of installed) instrumentation.disable(); });
const tracer = provider.getTracer('node-wide');
let started;
beforeEach(() => { recorded.length = 0; started?.mockRestore(); started = vi.spyOn(tracer, 'startSpan'); });
afterAll(() => started?.mockRestore());
const attempts = kind => {
  expect(started.mock.calls.length).toBeGreaterThan(0);
  expect(started.mock.calls.some(([, opts]) => opts?.kind === kind)).toBe(true);
};

for (const name of ['redis', 'ioredis']) test(`${name}: real commands, pipeline, server error and context isolation`, async () => {
  const fixture = await redisFixture();
  try {
    await Promise.all(Array.from({ length: 3 }, () => invocation(async root => {
      const client = name === 'redis'
        ? require('redis').createClient({ url: `redis://127.0.0.1:${fixture.port}`, socket: { reconnectStrategy: false } })
        : new (require('ioredis'))({ host: '127.0.0.1', port: fixture.port, enableReadyCheck: false, lazyConnect: true, retryStrategy: () => null });
      client.on('error', () => {});
      try {
        await client.connect();
        expect(await Promise.all([client.get('one'), client.get('two')])).toEqual(['42', '42']);
        await expect(client.get('fail')).rejects.toThrow('synthetic failure');
        expect(trace.getActiveSpan().spanContext()).toEqual(root.spanContext());
      } finally { await client.quit(); }
    })));
    attempts(SpanKind.CLIENT);
    expect(recorded.filter(span => !span.root)).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('mongodb: real wire handshake, command and error with native correlation', async () => {
  const { MongoClient, BSON } = require('mongodb');
  const fixture = await mongoFixture(BSON);
  try {
    await invocation(async root => {
      const client = new MongoClient(`mongodb://127.0.0.1:${fixture.port}/test`, { directConnection: true, serverSelectionTimeoutMS: 1000 });
      try {
        await client.connect();
        expect((await client.db().command({ ping: 1 })).answer).toBe(42);
        await expect(client.db().command({ fail: 1 })).rejects.toThrow('synthetic failure');
        expect(trace.getActiveSpan().spanContext()).toEqual(root.spanContext());
      } finally { await client.close(); }
    });
    attempts(SpanKind.CLIENT);
    expect(recorded.filter(span => !span.root)).toHaveLength(0);
  } finally { await fixture.close(); }
});

test('knex: real PostgreSQL driver query and errors', async () => {
  const server = await postgresServer();
  const knex = require('knex')({ client: 'pg', connection: { host: '127.0.0.1', port: server.port, user: 'test', database: 'test', ssl: false },
    pool: { min: 0, max: 1 }, version: '16' });
  try {
    await invocation(async root => {
      expect((await knex.raw('SELECT 42 AS answer')).rows).toEqual([{ answer: 42 }]);
      await expect(knex.raw('SELECT fail')).rejects.toThrow('synthetic query failure');
      expect(trace.getActiveSpan().spanContext()).toEqual(root.spanContext());
    });
    attempts(SpanKind.CLIENT);
  } finally { await knex.destroy(); await server.close(); }
});

test('AWS SDK: actual S3 command middleware, injected HTTP responses, errors', async () => {
  const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
  let calls = 0;
  const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, maxAttempts: 1,
    requestHandler: { handle: async request => {
      calls++;
      return { response: { statusCode: request.path.includes('fail') ? 404 : 200, headers: {}, body: Buffer.alloc(0) } };
    } } });
  try {
    await invocation(async root => {
      expect((await client.send(new HeadObjectCommand({ Bucket: 'synthetic', Key: 'ok' }))).$metadata.httpStatusCode).toBe(200);
      await expect(client.send(new HeadObjectCommand({ Bucket: 'synthetic', Key: 'fail' }))).rejects.toThrow();
      expect(trace.getActiveSpan().spanContext()).toEqual(root.spanContext());
    });
    expect(calls).toBe(2); attempts(SpanKind.CLIENT);
  } finally { client.destroy(); }
});

test('KafkaJS: producer and batched send errors end spans and preserve parent', async () => {
  const { Kafka, logLevel } = require('kafkajs');
  const producer = new Kafka({ clientId: 'synthetic', brokers: ['127.0.0.1:1'], logLevel: logLevel.NOTHING }).producer();
  await invocation(async root => {
    await expect(producer.send({ topic: 'synthetic', messages: [{ value: 'test' }] })).rejects.toThrow(/disconnected/i);
    await expect(producer.sendBatch({ topicMessages: [{ topic: 'synthetic', messages: [{ value: 'one' }, { value: 'two' }] }] })).rejects.toThrow(/disconnected/i);
    expect(trace.getActiveSpan().spanContext()).toEqual(root.spanContext());
  });
  attempts(SpanKind.PRODUCER);
});

test('amqplib: real channel publish, confirms and errors with a transport double', async () => {
  require('amqplib'); // install the actual module-loader patch, including its submodule
  const { ConfirmChannel } = require('../../node_modules/amqplib/lib/channel_model.js');
  const sent = [];
  const channel = new ConfirmChannel({ sendMessage: (...args) => { if (args.at(-1).toString() === 'fail') throw new Error('synthetic failure'); sent.push(args); return true; } });
  await invocation(async root => {
    let confirmed = false;
    expect(channel.publish('synthetic', 'key', Buffer.from('ok'), {}, error => { expect(error).toBeNull(); confirmed = true; })).toBe(true);
    channel.emit('ack', { deliveryTag: 1, multiple: false });
    expect(confirmed).toBe(true);
    expect(() => channel.publish('synthetic', 'key', Buffer.from('fail'), {}, () => {})).toThrow('synthetic failure');
    channel.emit('close');
    expect(trace.getActiveSpan().spanContext()).toEqual(root.spanContext());
  });
  expect(sent).toHaveLength(1); attempts(SpanKind.PRODUCER);
});

test('Winston: hook adds invocation and nested IDs, without stale IDs outside requests', async () => {
  const winston = require('winston');
  const logs = [];
  const transport = new winston.transports.Console({ silent: true });
  const logger = winston.createLogger({ transports: [transport], format: winston.format(info => { logs.push({ ...info }); return info; })() });
  await invocation(async root => {
    logger.info('root');
    await tracer.startActiveSpan('wide.winston', async span => { try { await Promise.resolve(); logger.info('child'); expect(logs.at(-1).span_id).toBe(span.spanContext().spanId); } finally { span.end(); } });
    logger.info('restored');
    expect(logs.at(-1).span_id).toBe(root.id);
  });
  logger.info('outside'); expect(logs.at(-1).trace_id).toBeUndefined(); logger.close();
});

test('Undici: actual Node fetch success/error, suppression and restored native parent', async () => {
  const { suppressTracing } = await import('@opentelemetry/core');
  const server = await httpFixture();
  try {
    await invocation(async root => {
      expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe('ok');
      expect((await fetch(`http://127.0.0.1:${server.port}/error`)).status).toBe(500);
      attempts(SpanKind.CLIENT);
      const before = started.mock.calls.length;
      await context.with(suppressTracing(context.active()), async () => { await (await fetch(`http://127.0.0.1:${server.port}/`)).text(); });
      expect(started.mock.calls.length).toBe(before + 1);
      expect(started.mock.results.at(-1).value.spanContext().traceId).toBe('0'.repeat(32));
      expect(trace.getActiveSpan().spanContext()).toEqual(root.spanContext());
    });
  } finally { await server.close(); }
});

test('Azure: installed core-tracing hook, manual parent activation, error and CLIENT fallback', async () => {
  const { createTracingClient } = require('@azure/core-tracing');
  const client = createTracingClient({ namespace: 'test', packageName: 'test', packageVersion: '1' });
  await invocation(async root => {
    expect(await client.withSpan('wide.azure', {}, async () => {
      const span = trace.getActiveSpan(); expect(span.isRecording()).toBe(true);
      expect(span.spanContext().spanId).not.toBe(root.id);
      expect(tracer.startSpan('unsupported.azure.child').isRecording()).toBe(false);
      await Promise.resolve(); return 42;
    })).toBe(42);
    await expect(client.withSpan('wide.azure.error', {}, async () => { throw new Error('synthetic failure'); })).rejects.toThrow('synthetic failure');
    await client.withSpan('wide.azure.client', {}, async () => {
      expect(trace.getActiveSpan().isRecording()).toBe(false);
      expect(trace.getActiveSpan().spanContext()).toEqual(root.spanContext());
    }, { spanKind: 'client' });
    expect(trace.getActiveSpan().spanContext()).toEqual(root.spanContext());
  });
  expect(recorded.filter(span => !span.root)).toHaveLength(2);
  expect(recorded.filter(span => !span.root).every(span => span.ended)).toBe(true);
});

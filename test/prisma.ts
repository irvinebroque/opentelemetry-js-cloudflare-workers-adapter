import assert from 'node:assert/strict';
import { trace } from '@opentelemetry/api';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { PrismaD1 } from '@prisma/adapter-d1';
import { PrismaClient } from './generated/prisma/client.js';

const instrumentation = new PrismaInstrumentation();
instrumentation.setTracerProvider(trace.getTracerProvider());

export async function exercisePrisma(db: D1Database) {
  const root = trace.getActiveSpan()!.spanContext();
  await db.exec('CREATE TABLE IF NOT EXISTS Item (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const id = crypto.randomUUID();
  const operations: { operation: string; spanId: string; traceId: string; recording: boolean }[] = [];
  const client = new PrismaClient({ adapter: new PrismaD1(db) }).$extends({
    query: { item: { async $allOperations({ operation, args, query }) {
      const span = trace.getActiveSpan()!;
      operations.push({ operation, ...span.spanContext(), recording: span.isRecording() });
      return query(args);
    } } },
  });
  try {
    assert.deepEqual(await client.item.create({ data: { id, value: 'synthetic' } }), { id, value: 'synthetic' });
    assert.equal((await client.item.findUniqueOrThrow({ where: { id } })).value, 'synthetic');
    await assert.rejects(client.item.create({ data: { id, value: 'duplicate' } }), /Unique constraint/);
    await client.item.delete({ where: { id } });
    assert.equal(operations.length, 4);
    for (const operation of operations) {
      assert.equal(operation.traceId, root.traceId);
      assert.equal(operation.recording, true);
      assert.notEqual(operation.spanId, root.spanId);
    }
    assert.deepEqual(trace.getActiveSpan()?.spanContext(), root);
    return { root, operations };
  } finally { await client.$disconnect(); }
}
